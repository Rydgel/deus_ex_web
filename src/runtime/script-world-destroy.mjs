/**
 * Live-world wiring for the recovered `ULevel::DestroyActor` contract.
 *
 * `script-destroy.mjs` owns the recovered order and gates; it deliberately
 * leaves every world-owned service to its caller so a browser host cannot turn
 * an unresolved native branch into a guessed one.  This module supplies those
 * services for the live Play level: the host eligibility boundary, Core
 * `UObject::Modify`, the level's real `FCollisionHash` view and the recovered
 * `EndTouch(other, 1)` call.  The evidence for each step is recorded in
 * docs/script-destroy.md; the live boundaries this wiring refuses and the
 * browser-side reset ledger are described in docs/script-world-destroy.md.
 */
import { modifyScriptObject } from './script-object-lifecycle.mjs';
import { endTouch as endActorTouch } from './actor-touch.mjs';

/** Native object record for a pre-placed map export.
 *
 * `name` and `flags` are the map package's own export-table values.  `index` is
 * the Core `GObjObjects` slot: an integer only when a measured capture-backed
 * provider resolves it (docs/boot-replay.md), otherwise `null` — "registered,
 * slot unmeasured".  It is never fabricated, and `-1` stays the original
 * unregistered marker that Core `ConditionalDestroy` rejects.
 *
 * `linker` is null because this host loads map packages through its own decoder
 * instead of constructing the map's `ULinkerLoad`; the recovered
 * `SetLinker(NULL, -1)` export-slot clear therefore has no live slot to clear.
 * `outer` is null for the same reason — the map's `UPackage` object is not
 * constructed here.  Both are explicit boundaries, not claims about the original.
 */
export function mapActorNativeObject(identity, entry, { index = null, destroy } = {}) {
  if (!identity || typeof identity !== 'object') throw new TypeError('Map native object requires its live actor identity');
  if (!entry || typeof entry.name !== 'string') throw new TypeError('Map native object requires its original export entry');
  if (typeof destroy !== 'function') throw new TypeError('Map native object requires its native destroy hook');
  if (index !== null && !Number.isInteger(index)) throw new TypeError('Measured global object index must be an integer or null');
  return {
    identity, index, name: entry.name, flags: entry.flags >>> 0,
    outer: null, linker: null, linkerIndex: -1, auxiliary: null, destroy,
  };
}

/**
 * Build the live-world destruction services.
 *
 * `level` is the single live level container and `hash()` returns its current
 * `FCollisionHash` (the scene rebuilds that object on reset, so it is read
 * through a function rather than captured).  `dispatch` is the scene event
 * boundary used by the recovered `EndTouch`.  `supported(receiver)` may narrow
 * the admitted classes further; it is consulted inside `validate`.
 */
export function createWorldDestroyServices({ runtime, level, hash = null, dispatch, supported = null } = {}) {
  if (!runtime || typeof runtime.instance !== 'function')
    throw new TypeError('World destruction requires the linked ScriptRuntime');
  if (!level || !Array.isArray(level.actors))
    throw new TypeError('World destruction requires the live level actor array');
  if (typeof dispatch !== 'function')
    throw new TypeError('World destruction requires the scene event dispatch boundary');
  if (hash != null && typeof hash !== 'function')
    throw new TypeError('World destruction hash() must be a function');
  if (supported != null && typeof supported !== 'function')
    throw new TypeError('World destruction supported() must be a function');

  const attached = receiver => { try { return Boolean(runtime.instance(receiver)); } catch { return false; } };
  const isA = (receiver, key) => Boolean(receiver?.lineage?.includes(key));

  /**
   * Host eligibility boundary (docs/script-destroy.md, "Gates and return
   * values").  A false result makes the adapter raise its explicit
   * unsupported-branch error instead of silently entering a native path whose
   * contract is not recovered here.
   */
  function validate(receiver, destroyLevel) {
    if (destroyLevel !== level) return false;
    if (!attached(receiver)) return false;
    if (level.editor) return false;
    // The two unresolved level-owned hooks at ULevel+0x3c/+0x88 are driver
    // objects. Standalone play with no demo recorder is the only state this
    // wiring admits.
    if (level.netMode !== 0 || level.demoRecDriver !== null) return false;
    // 0x10395c59-0x10395cd8: an APlayerPawn whose Player (+0x5d4) IsA
    // UNetConnection, with channel 0 (+0xe64) open and State (+0x60) not
    // USOCK_Closed, closes that channel and returns false. A None Player (as
    // LoadMap leaves the actor it dissociates) or a local viewport takes the
    // normal path; other Pawns skip the test. Play admits only the player
    // LoadMap retires: its NPC tick lists do not yet drop a destroyed pawn,
    // and a live player's host scene is rebuilt only by that reload.
    if (isA(receiver, 'engine.pawn')) {
      if (receiver !== level.retiringPlayer) return false;
      if (runtime.namedReference(receiver, 'Player').get() !== null) return false;
    }
    // A Mover owns a brush model plus its own encroachment and base contract;
    // that destruction path is not recovered here.
    if (receiver.movingBrush || isA(receiver, 'engine.mover')) return false;
    if (supported && !supported(receiver)) return false;
    return true;
  }

  /** Actor vtable +0x1c resolves to Core `UObject::Modify`; with no editor
   * transaction active (`level.undo` is null in play) it records nothing. */
  function modify(receiver) {
    return modifyScriptObject(runtime.instance(receiver).nativeObject ?? null, level.undo ?? null);
  }

  /** Native `target.EndTouch(other, 1)`: the target is not notified, the other
   * side still receives its synchronous `UnTouch` (docs/script-destroy.md #7). */
  function endTouch(receiver, other, noNotifySelf) {
    return endActorTouch(receiver, other, Boolean(noNotifySelf), dispatch);
  }

  /** `FCollisionHash::RemoveActor` (vtable +0x0c) and
   * `FCollisionHash::CheckActorNotReferenced` (vtable +0x20, recovered body
   * `ret $0x4`).  The original leaves `bCollideActors` set; only the hash
   * registration is dropped, before the actor leaves `Level.Actors`. */
  const collisionHash = hash ? {
    removeActor(receiver) { return hash().removeActor(receiver); },
    checkActorNotReferenced() { return undefined; },
  } : null;

  return { validate, modify, endTouch, collisionHash };
}

/**
 * Browser-side ledger of what a live destruction removed.
 *
 * The original reaches the initial map state again by reloading the level; this
 * host reuses the same actor identities across "Player start", so the slots and
 * native-object fields a destruction cleared are recorded here and restored on
 * reset.  Script property storage is authored-backed, so clearing an actor's
 * property store is what returns the owning values `ExitProperties` released.
 * The live collision hash is rebuilt wholesale by the scene reset and is
 * therefore not touched here.
 */
export function createDestroyedActorLedger({ level, runtime }) {
  if (!level || !Array.isArray(level.actors)) throw new TypeError('Destroyed-actor ledger requires the live level');
  const entries = new Map();

  /** Snapshot the browser-side state a destruction is about to clear. */
  function snapshot(receiver) {
    return {
      slot: level.actors.indexOf(receiver),
      flags: runtime.instance(receiver).nativeObject?.flags ?? null,
    };
  }

  function record(receiver, saved) {
    if (!entries.has(receiver) && saved.slot >= 0) entries.set(receiver, saved);
  }

  function restore(clearStore = null) {
    for (const [receiver, saved] of entries) {
      // The LoadMap tail compacts/partitions Level.Actors at the end of
      // startup (Engine.dll 0x1038dcd5), so a slot recorded before that pass
      // can now hold a different actor. Reinsert at the recorded position
      // when the slot is occupied — the startup partition re-derives the
      // static/dynamic order either way, and dropping the actor silently is
      // never correct.
      if (!level.actors.includes(receiver)) {
        if (level.actors[saved.slot] === null) level.actors[saved.slot] = receiver;
        else level.actors.splice(Math.min(saved.slot, level.actors.length), 0, receiver);
      }
      clearStore?.(receiver);
      const object = runtime.instance(receiver).nativeObject;
      if (object && saved.flags !== null) {
        object.flags = saved.flags; object.linker = null; object.linkerIndex = -1; object.auxiliary = null;
      }
    }
    entries.clear();
    level.pendingDeleted = null;
  }

  return { snapshot, record, restore, has: receiver => entries.has(receiver), get size() { return entries.size; } };
}

export default createWorldDestroyServices;
