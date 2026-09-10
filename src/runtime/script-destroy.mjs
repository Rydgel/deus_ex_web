/*
 * Source-backed Actor.Destroy/ULevel.DestroyActor orchestration.
 *
 * This module owns the ordering and gates recovered from Engine.dll.  The
 * object model and native/script services remain caller-owned so a browser
 * host cannot accidentally turn an unsupported branch into a guessed one.
 */

const AUTHORITY_ROLE = 4;

const present = value => value !== null && value !== undefined;
const flag = value => Boolean(value);

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`DestroyActor requires ${name}`);
  return value;
}

function requireLevel(level) {
  if (!level || !Array.isArray(level.actors)) {
    throw new TypeError('DestroyActor levelFor(receiver) must provide an actors array');
  }
  if (!('pendingDeleted' in level)) {
    throw new TypeError('DestroyActor level must provide pendingDeleted');
  }
  if (!level.engine || typeof level.engine !== 'object' || !('audio' in level.engine)) {
    throw new TypeError('DestroyActor level must provide engine.audio');
  }
  if (present(level.engine.audio) && typeof level.engine.audio !== 'object') {
    throw new TypeError('DestroyActor level.engine.audio must be null or an object');
  }
  if (!('collisionHash' in level)) {
    throw new TypeError('DestroyActor level must provide collisionHash');
  }
  if (present(level.collisionHash) && typeof level.collisionHash !== 'object') {
    throw new TypeError('DestroyActor level.collisionHash must be null or an object');
  }
  return level;
}

function touchSlot(read, actor, index) {
  const touching = read(actor, 'Touching');
  if (!present(touching)) return undefined;
  if (!Array.isArray(touching) || touching.length !== 4) {
    throw new Error('DestroyActor requires four original Touching slots');
  }
  return touching[index];
}

function deleted(read, receiver) {
  return flag(read(receiver, 'bDeleteMe'));
}

function unsupported(branch) {
  throw new Error(`Unsupported original DestroyActor branch: ${branch}`);
}

/**
 * Run the recovered script-visible Actor.Destroy path.
 *
 * `levelFor` returns the live level record
 * `{actors,pendingDeleted,engine:{audio},collisionHash}`. `read` and `write`
 * operate on original Actor property names. `validate` must return `true`;
 * it is the host boundary for class/world/network/editor eligibility. The
 * other callbacks are required at the native branch where they are reached.
 */
export function destroyScriptActor(receiver, options, netForce = false) {
  if (!present(receiver)) throw new TypeError('DestroyActor requires an actor receiver');
  const callbacks = options ?? {};
  const levelFor = requireFunction(callbacks.levelFor, 'levelFor');
  const read = requireFunction(callbacks.read, 'read');
  const write = requireFunction(callbacks.write, 'write');
  const validate = requireFunction(callbacks.validate, 'validate');
  const level = requireLevel(levelFor(receiver));

  // A false/absent eligibility result is an unsupported host boundary, not a
  // native DestroyActor rejection. This prevents silently entering editor,
  // proxy, Pawn, or subclass paths whose contracts are not in this adapter.
  if (validate(receiver, level) !== true) unsupported('host eligibility validation');
  if (flag(level.editor)) unsupported('editor cleanup');

  const actors = level.actors;

  // Play gates at 10395c1f–10395c44. The script native wrapper supplies
  // bNetForce=false, but callers may exercise the native helper explicitly.
  if (flag(read(receiver, 'bStatic')) || flag(read(receiver, 'bNoDelete'))) return false;
  if (deleted(read, receiver)) return true;
  if (Number(read(receiver, 'Role')) !== AUTHORITY_ROLE &&
      !Boolean(netForce) && !flag(read(receiver, 'bNetTemporary'))) return false;

  // Native GetActorIndex saves this position only after the play gates.  It is
  // therefore valid for a repeated request on an already-deleting actor to
  // return before that actor has a live array slot.
  const index = actors.indexOf(receiver);
  if (index < 0) throw new Error('DestroyActor receiver is absent from level.actors');

  const isProbing = requireFunction(callbacks.isProbing, 'isProbing');
  const modify = requireFunction(callbacks.modify, 'modify');

  // Native GetActorIndex saves this position and asserts the same identity at
  // removal time. No caller callback is allowed to substitute another actor.
  modify(receiver);

  // The current state's EndState is probed before the dynamic event call.
  if (isProbing(receiver, 'EndState')) {
    const processEvent = requireFunction(callbacks.processEvent, 'processEvent');
    processEvent(receiver, 'EndState', []);
    if (deleted(read, receiver)) return true;
  }

  // Detach the target and its based children. StandingCount is a native byte;
  // if a host exposes based children it must expose that byte as well.
  const targetBase = read(receiver, 'Base');
  const standingBeforeBase = read(receiver, 'StandingCount');
  if (standingBeforeBase === undefined) {
    // Refuse a host that has a based child but no native standing-count
    // evidence before touching the target's own Base relationship.
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i];
      if (present(actor) && read(actor, 'Base') === receiver)
        unsupported('based-child scan without StandingCount');
    }
  }
  if (present(targetBase)) {
    requireFunction(callbacks.setBase, 'setBase');
    callbacks.setBase(receiver, null, true);
    if (deleted(read, receiver)) return true;
  }
  // Native reads StandingCount after the target SetBase callback. Preserve a
  // callback's update while retaining the preflight above for missing data.
  const standing = present(targetBase) ? read(receiver, 'StandingCount') : standingBeforeBase;
  if (Number(standing) > 0) {
    for (let i = 0; i < actors.length; i++) {
      const child = actors[i];
      if (!present(child) || read(child, 'Base') !== receiver) continue;
      requireFunction(callbacks.setBase, 'setBase');
      callbacks.setBase(child, null, true);
    }
  }

  // Collision hash removal is gated by bCollideActors, while the original
  // CheckActorNotReferenced call is unconditional whenever the hash exists.
  const hash = level.collisionHash;
  if (present(hash)) {
    if (typeof hash !== 'object') throw new TypeError('DestroyActor level.collisionHash must be null or an object');
    if (flag(read(receiver, 'bCollideActors'))) {
      requireFunction(hash.removeActor, 'collisionHash.removeActor');
      hash.removeActor(receiver);
    }
    requireFunction(hash.checkActorNotReferenced, 'collisionHash.checkActorNotReferenced');
    hash.checkActorNotReferenced(receiver);
  }

  const processEvent = requireFunction(callbacks.processEvent, 'processEvent');
  processEvent(receiver, 'Destroyed', []);
  if (deleted(read, receiver)) return true;

  // Re-read the live array on every iteration. SetOwner and EndTouch are one
  // combined native scan: callbacks can synchronously alter ownership, touch
  // slots, actor slots, and script state before the next scan entry.
  for (let i = 0; i < actors.length; i++) {
    const child = actors[i];
    if (!present(child)) continue;
    if (read(child, 'Owner') === receiver) {
      requireFunction(callbacks.setOwner, 'setOwner');
      callbacks.setOwner(child, null);
      if (deleted(read, receiver)) return true;
    }
    for (let slot = 0; slot < 4; slot++) {
      if (touchSlot(read, child, slot) !== receiver) continue;
      requireFunction(callbacks.endTouch, 'endTouch');
      callbacks.endTouch(receiver, child, 1);
      if (deleted(read, receiver)) return true;
    }
  }

  const owner = read(receiver, 'Owner');
  if (present(owner)) {
    processEvent(owner, 'LostChild', [receiver]);
    if (deleted(read, receiver)) return true;
  }

  // Assert the original saved slot immediately before mutating the array.
  if (actors[index] !== receiver) throw new Error('DestroyActor saved actor slot changed during callbacks');
  actors[index] = null;
  write(receiver, 'bDeleteMe', true);

  // XLevel+0x40 is UEngine*, +0x4c is optional UAudioSubsystem*, and +0x7c
  // is NoteDestroy. A null audio subsystem is the original no-audio path.
  const audio = level.engine.audio;
  if (present(audio)) {
    if (typeof audio !== 'object') throw new TypeError('DestroyActor level.engine.audio must be null or an object');
    requireFunction(audio.noteDestroy, 'engine.audio.noteDestroy');
    audio.noteDestroy(receiver);
  }

  const conditionalDestroy = requireFunction(callbacks.conditionalDestroy, 'conditionalDestroy');
  conditionalDestroy(receiver);

  // In play, insertion into the pending chain follows ConditionalDestroy.
  write(receiver, 'Deleted', present(level.pendingDeleted) ? level.pendingDeleted : null);
  level.pendingDeleted = receiver;
  return true;
}
