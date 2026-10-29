/**
 * AActor's native flag words as the actor's object-image bytes (stage 1e
 * step 1, docs/rust-core.md "1e-1").
 *
 * Retail AActor (sdk-layouts.mjs, checked against the GOTY DLLs) packs these
 * script bools into three dwords that native code reads as members:
 *   +0x028  bStatic 0x1, bHidden 0x2, bDeleteMe 0x80, bCollideWhenPlacing
 *           0x20000, bMovable 0x80000 (with bNoDelete, ... in other bits)
 *   +0x1dc  bCollideActors 0x1, bCollideWorld 0x2, bBlockActors 0x4,
 *           bBlockPlayers 0x8, bProjTarget 0x10
 *   +0x1ec  bSpecialLit 0x1 ... bBounce 0x10, bFixedRotationDir 0x20,
 *           bRotateToDesired 0x40, bInterpolating 0x80, bJustTeleported 0x100
 *
 * The linker places the script bools at exactly these offsets and masks
 * (validated per class below), so a host member that reads the dword is the
 * same storage as the script fields. A map actor's `flags`, `actorFlags` and
 * `motionFlags` are accessors over its image; the script fields need no host
 * binding, and the Rust interpreter reads them from memory.
 *
 * Each accessor keeps the bits the host model used before:
 *   `flags`       the whole +0x1dc word (bits 0-4);
 *   `actorFlags`  bStatic | bDeleteMe | bCollideWhenPlacing | bMovable, the
 *                 bits the level-load host word carried (the spawned-actor
 *                 view composes the same four). A native test of another
 *                 +0x28 bit reads the whole image word (`actorWordOf`), as
 *                 execVisibleActors does for bHidden;
 *   `motionFlags` the whole +0x1ec word (bits 0-8).
 * The per-bit members the collision code reads (`collisionBits`,
 * `collideActors`, `collideWorld`, `blockActors`, `blockPlayers`,
 * `blocking`, `static`, `movable`) derive from the same words.
 *
 * The image range is fixed for the object's life, and every access re-reads
 * the arena's current view, so no view outlives a memory growth.
 */
import {scalarCell} from './script-object-image.mjs';

export const COLLISION_WORD = Object.freeze({name: 'collision', offset: 0x1dc, mask: 0x1f,
  bits: Object.freeze({bcollideactors: 0x1, bcollideworld: 0x2, bblockactors: 0x4, bblockplayers: 0x8, bprojtarget: 0x10})});
// `mask` is the host `actorFlags` accessor's; `bits` are the bools whose
// linked cells are checked, bHidden (SDK AActor +0x028 bit 1) included for
// actorWordOf.
export const ACTOR_WORD = Object.freeze({name: 'actor', offset: 0x28, mask: 0xa0081,
  bits: Object.freeze({bstatic: 0x1, bhidden: 0x2, bdeleteme: 0x80, bcollidewhenplacing: 0x20000, bmovable: 0x80000})});
export const MOTION_WORD = Object.freeze({name: 'motion', offset: 0x1ec, mask: 0x1ff,
  bits: Object.freeze({bspeciallit: 0x1, bactorshadows: 0x2, bcorona: 0x4, blensflare: 0x8, bbounce: 0x10,
    bfixedrotationdir: 0x20, brotatetodesired: 0x40, binterpolating: 0x80, bjustteleported: 0x100})});
const WORDS = [COLLISION_WORD, ACTOR_WORD, MOTION_WORD];

// The installed words of a host (non-enumerable, so no host walk sees it).
const FLAG_WORDS = Symbol('actorFlagWords');

// Classes whose linked cells were checked against the words above.
const checkedClasses = new WeakSet();
/** Every bool of the three words must be linked at its native offset and
 * mask; a class whose layout differs has no flag-word storage here. */
function checkLayout(instance) {
  const cls = instance.cls;
  if (checkedClasses.has(cls)) return;
  if (!instance.cells || !instance.base) throw new Error(`Actor flag words need an object image: ${cls?.record?.key}`);
  for (const word of WORDS) for (const [name, mask] of Object.entries(word.bits)) {
    const cell = scalarCell(instance.cells.get(`engine.actor.${name}`));
    if (!cell || cell.kind !== 'bool' || cell.offset !== word.offset || cell.mask !== mask)
      throw new Error(`Actor ${name} is not linked at +0x${word.offset.toString(16)} mask 0x${mask.toString(16)}: ${JSON.stringify(cell)}`);
  }
  checkedClasses.add(cls);
}

/** One flag word of one actor image: the masked dword at its offset. */
class FlagWord {
  constructor(instance, word) {
    this.instance = instance; this.offset = word.offset; this.mask = word.mask;
  }
  get() {
    const instance = this.instance;
    if (instance.imageToken?.released) throw new Error('Script object allocation has been released');
    return (instance.arena.view.getUint32(instance.base + this.offset, true) & this.mask) >>> 0;
  }
  set(value) {
    const instance = this.instance;
    if (instance.imageToken?.released) throw new Error('Script object allocation has been released');
    const view = instance.arena.view, at = instance.base + this.offset;
    view.setUint32(at, ((view.getUint32(at, true) & ~this.mask) | (value & this.mask)) >>> 0, true);
  }
}

/** The instance's flag word (validated layout), for hosts outside the
 * installer (the Player's motion word). */
export function flagWord(instance, word) {
  checkLayout(instance);
  return new FlagWord(instance, word);
}

/** The whole +0x28 dword of an actor image, unmasked: what a native body
 * reads as `[actor+0x28]` (execVisibleActors 0x103e5394 `test byte ptr
 * [edi+0x28], 2` skips a bHidden candidate). Any actor with an image,
 * installed host or not; the host `actorFlags` keeps only its four bits. */
export function actorWordOf(instance) {
  checkLayout(instance);
  if (instance.imageToken?.released) throw new Error('Script object allocation has been released');
  return instance.arena.view.getUint32(instance.base + ACTOR_WORD.offset, true) >>> 0;
}


/** What an installed host keeps of its flag words: its instance, and for each of the three words its description (the same
 * constant for every host) when it is installed, else null. The readers test truthiness (docs/live-heap.md, "Actor hosts
 * and mesh bindings"). */
class ActorWords {
  constructor(instance, collision, actor, motion) { this.instance = instance; this.collision = collision; this.actor = actor; this.motion = motion; }
}

/** Whether `host` carries image-backed flag words, and which. */
export const flagWordsOf = host => host?.[FLAG_WORDS] ?? null;

// The masked dword of a word at an instance's image (the FlagWord of a host outside the installer does the same).
const readWord = (instance, word) => {
  if (instance.imageToken?.released) throw new Error('Script object allocation has been released');
  return (instance.arena.view.getUint32(instance.base + word.offset, true) & word.mask) >>> 0;
};
const writeWord = (instance, word, value) => {
  if (instance.imageToken?.released) throw new Error('Script object allocation has been released');
  const view = instance.arena.view, at = instance.base + word.offset;
  view.setUint32(at, ((view.getUint32(at, true) & ~word.mask) | (value & word.mask)) >>> 0, true);
};

// The members' functions are shared by every host and find the host's words through `this` (host-accessors.mjs).
const wordMember = word => Object.freeze({
  get() { return readWord(this[FLAG_WORDS].instance, word); },
  set(value) { writeWord(this[FLAG_WORDS].instance, word, value >>> 0); },
});
const bitMember = (word, mask) => Object.freeze({get() { return Boolean(readWord(this[FLAG_WORDS].instance, word) & mask); }});
const SHARED = Object.freeze({
  flags: wordMember(COLLISION_WORD),
  collisionBits: Object.freeze({get() { return readWord(this[FLAG_WORDS].instance, COLLISION_WORD) & ~0x2; }}),
  collideActors: bitMember(COLLISION_WORD, 0x1), collideWorld: bitMember(COLLISION_WORD, 0x2),
  blockActors: bitMember(COLLISION_WORD, 0x4), blockPlayers: bitMember(COLLISION_WORD, 0x8), blocking: bitMember(COLLISION_WORD, 0x8),
  actorFlags: wordMember(ACTOR_WORD), static: bitMember(ACTOR_WORD, 0x1), movable: bitMember(ACTOR_WORD, 0x80000),
  motionFlags: wordMember(MOTION_WORD),
});
const member = (prop, {get, set}) => ({get, set, enumerable: true, configurable: false});
const shared = props => Object.fromEntries(props.map(prop => [prop, member(prop, SHARED[prop])]));

/** Replace a map host's flag members by accessors over its image. The
 * host's current values must already equal the image (level load writes
 * both from the same serialized properties); a difference is an error, not
 * something to reconcile. */
export function installActorFlagWords(host, instance, {collision = false, actor = false, motion = false}) {
  checkLayout(instance);
  if (host[FLAG_WORDS]) throw new Error(`Actor flag words are already installed: ${host.name}`);
  const expect = (prop, word, value) => {
    const stored = readWord(instance, word);
    if ((value >>> 0) !== stored)
      throw new Error(`${host.name}.${prop} 0x${(value >>> 0).toString(16)} differs from its image word 0x${stored.toString(16)}`);
  };
  if (collision) {
    expect('flags', COLLISION_WORD, host.flags);
    Object.defineProperties(host, shared(['flags', 'collisionBits', 'collideActors', 'collideWorld', 'blockActors', 'blockPlayers', 'blocking']));
  }
  if (actor) {
    expect('actorFlags', ACTOR_WORD, host.actorFlags);
    if (host.static !== undefined && host.static !== Boolean(readWord(instance, ACTOR_WORD) & 0x1)) throw new Error(`${host.name}.static differs from bStatic`);
    if (host.movable !== undefined && host.movable !== Boolean(readWord(instance, ACTOR_WORD) & 0x80000)) throw new Error(`${host.name}.movable differs from bMovable`);
    Object.defineProperties(host, shared(['actorFlags', 'static', 'movable']));
  }
  if (motion) {
    if (host.motionFlags !== undefined) expect('motionFlags', MOTION_WORD, host.motionFlags);
    // A reset returns bJustTeleported to the serialized value
    // (player-scene.mjs prepareActor), which is where the image starts.
    if (Boolean(readWord(instance, MOTION_WORD) & 0x100) !== Boolean(host.values?.bJustTeleported))
      throw new Error(`${host.name}.bJustTeleported image differs from its serialized value`);
    Object.defineProperty(host, 'motionFlags', member('motionFlags', SHARED.motionFlags));
  }
  const words = Object.freeze(new ActorWords(instance, collision ? COLLISION_WORD : null, actor ? ACTOR_WORD : null, motion ? MOTION_WORD : null));
  Object.defineProperty(host, FLAG_WORDS, {value: words});
  return words;
}
