/**
 * Actor script fields the host kept as mirror copies, as the actor's
 * object-image cells (stage 1e step 2, docs/rust-core.md "1e-2").
 *
 * script-doors' makeBinding bound these properties of every attached map
 * actor onto plain host members (`physics`, `velocity`, ...), and the image
 * cell under each binding went stale. Here the host member is an accessor
 * over the cell, so the script field, the host member and the Rust
 * interpreter read one storage. Retail offsets (sdk-layouts.mjs, checked per
 * class below):
 *
 *   AActor     +0x030 Physics (byte), +0x0d8 StandingCount (byte),
 *              +0x144 Velocity, +0x150 Acceleration (vectors)
 *   APawn      +0x45c SpecialGoal, +0x498 nextPawn (pointers)
 *   AInventory +0x398 MyMarker (pointer)
 *   AMover     +0x4dc myMarker, +0x4e8 WaitingPawn (pointers), +0x4f4
 *              SimOldPos (vector), +0x500/+0x504/+0x508 SimOldRotPitch/Yaw/
 *              Roll (ints), +0x50c SimInterpolate, +0x518 RealPosition
 *              (vectors), +0x524 RealRotation (rotator), +0x530 ClientUpdate
 *   ALevelInfo +0x54c PawnList (pointer): the scene level's `pawnList`
 *
 * Each access reads or writes the cell through the arena's current view, so
 * no view outlives a memory growth. A vector read returns a fresh array, as
 * the binding's getter did; `liveVector` is the element-writable view the
 * native reach workers mutate. A write stores through the field's codec
 * (float32 components, a byte, an int32, a handle), which in both maps' runs
 * never changed a host value: every host write was already exact.
 */
import {readCell, writeCell, scalarCell, vectorCell} from './script-object-image.mjs';
import {propertyCodec} from './script-values.mjs';
import {defineEntryAccessor, internEntries} from './host-accessors.mjs';

const ZERO = Object.freeze([0, 0, 0]);
// `name`: the host `values` slot makeBinding fell back to while the host
// member was absent (none for pointers, which fell back to None).
const spec = (prop, key, offset, kind, name, zero) => Object.freeze({prop, key, offset, kind, name, zero, index: 0});
// Each spec keeps its position in the table: the index of its member in a host's MirrorSet (host-accessors.mjs).
const indexed = list => Object.freeze(list.map((item, index) => Object.freeze({...item, index})));
export const MIRROR_FIELDS = indexed([
  spec('physics', 'engine.actor.physics', 0x30, 'byte', 'Physics', 0),
  spec('standingCount', 'engine.actor.standingcount', 0xd8, 'byte', 'StandingCount', 0),
  spec('velocity', 'engine.actor.velocity', 0x144, 'vector', 'Velocity', ZERO),
  spec('acceleration', 'engine.actor.acceleration', 0x150, 'vector', 'Acceleration', ZERO),
  spec('specialGoal', 'engine.pawn.specialgoal', 0x45c, 'object', null, null),
  spec('nextPawn', 'engine.pawn.nextpawn', 0x498, 'object', null, null),
  spec('marker', 'engine.mover.mymarker', 0x4dc, 'object', null, null),
  // makeBinding keyed its entries by name, so Inventory.MyMarker shared the
  // host `marker` member.
  spec('marker', 'engine.inventory.mymarker', 0x398, 'object', null, null),
  spec('waitingPawn', 'engine.mover.waitingpawn', 0x4e8, 'object', null, null),
  spec('simOldPosition', 'engine.mover.simoldpos', 0x4f4, 'vector', 'SimOldPos', ZERO),
  spec('simOldRotPitch', 'engine.mover.simoldrotpitch', 0x500, 'int', 'SimOldRotPitch', 0),
  spec('simOldRotYaw', 'engine.mover.simoldrotyaw', 0x504, 'int', 'SimOldRotYaw', 0),
  spec('simOldRotRoll', 'engine.mover.simoldrotroll', 0x508, 'int', 'SimOldRotRoll', 0),
  spec('simInterpolate', 'engine.mover.siminterpolate', 0x50c, 'vector', 'SimInterpolate', ZERO),
  spec('realPosition', 'engine.mover.realposition', 0x518, 'vector', 'RealPosition', ZERO),
  spec('realRotation', 'engine.mover.realrotation', 0x524, 'rotator', 'RealRotation', ZERO),
  spec('clientUpdate', 'engine.mover.clientupdate', 0x530, 'int', 'ClientUpdate', 0),
]);
export const PAWN_LIST = Object.freeze({...spec('pawnList', 'engine.levelinfo.pawnlist', 0x54c, 'object', null, null), index: MIRROR_FIELDS.length});
const BY_KEY = new Map([...MIRROR_FIELDS, PAWN_LIST].map(item => [item.key, item]));

// The controlled player's `physics` and `velocity` members are its movement
// port's (player.mjs), not host data. Its Physics stays that port's state and
// keeps its binding (stage 1e step 6); its Velocity is Player.velocity linked
// to the identity's field (imageField). See docs/rust-core.md "1e-2".
export const PLAYER_BOUND = Object.freeze(new Set(['engine.actor.physics']));
export const PLAYER_PORT = Object.freeze(new Set(['engine.actor.physics', 'engine.actor.velocity']));


// The state of a host (non-enumerable, so no host walk sees it): the host's accessors find it through this symbol
// (host-accessors.mjs) and ask it for the member at the spec's index.
const MIRRORS = Symbol('actorMirrorFields');

// Cells (one per class and field) checked against the retail layout.
const checkedCells = new WeakSet();
/** The cell `key` of an attached instance when it holds the field as a
 * mirror: linked at its retail offset with its kind, not poisoned. A field
 * the linker placed elsewhere is an error, not a host member. */
function mirrorCell(instance, key) {
  const item = BY_KEY.get(key), cell = item && instance?.cells?.get(key);
  if (!cell || !instance.base || instance.poison?.has(key)) return null;
  if (!checkedCells.has(cell)) {
    const kind = scalarCell(cell)?.kind ?? vectorCell(cell)?.kind;
    const offset = scalarCell(cell)?.offset ?? vectorCell(cell)?.offset;
    if (kind !== item.kind || offset !== item.offset)
      throw new Error(`${key} is not linked as ${item.kind} +0x${item.offset.toString(16)}: ${kind} +0x${offset?.toString(16)}`);
    checkedCells.add(cell);
  }
  return cell;
}

/** Whether `field` of `host` is stored as an image mirror: makeBinding binds
 * nothing for it, and installMirrorFields (or, for the player's Velocity,
 * imageField) gives it a host member. */
export function mirrorsField(host, instance, field, {exclude = null} = {}) {
  if (!BY_KEY.has(field.key) || exclude?.has(field.key)) return false;
  return Boolean(mirrorCell(instance, field.key));
}

const released = instance => Boolean(instance.imageToken?.released);
/** One mirrored member of a class: its spec, cell and codec, shared by every host that installs it. The instance and the
 * `values` are the host's (the caller passes them). */
class MirrorField {
  constructor(item, cell, codec) { this.spec = item; this.cell = cell; this.codec = codec; }
  get(instance) {
    if (released(instance)) throw new Error('Script object allocation has been released');
    return readCell(this.cell, instance.arena.view, instance.refs, instance.base);
  }
  set(instance, value) {
    if (released(instance)) throw new Error('Script object allocation has been released');
    writeCell(this.cell, instance.arena.view, instance.refs, this.codec.copy(value), instance.base);
  }
  /** The value makeBinding's getter gave while the host member was absent. */
  fallback(values) {
    const {name, zero} = this.spec;
    return this.codec.copy(name ? values[name] ?? zero : zero);
  }
}
// The MirrorField of a cell (and codec): one for every class that has the cell.
const mirrorFields = new WeakMap();
function mirrorFieldOf(item, cell, field) {
  const codec = propertyCodec(field);
  let list = mirrorFields.get(cell);
  if (list === undefined) mirrorFields.set(cell, list = []);
  for (const shared of list) if (shared.codec === codec && shared.spec === item) return shared;
  const shared = new MirrorField(item, cell, codec);
  list.push(shared);
  return shared;
}

/** What a host (or the level a mirrored member lives on) keeps of its mirrored members: its instance, its `values` and the
 * class's MirrorFields at the spec's indices (an interned array, holes for the members it does not have). */
class MirrorSet {
  constructor(instance, values) { this.instance = instance; this.values = values; this.fields = []; }
  get(index) { return this.fields[index].get(this.instance); }
  set(index, value) { this.fields[index].set(this.instance, value); }
  fallback(index) { return this.fields[index].fallback(this.values); }
  /** The index of the installed member named `prop` (two specs, Mover's and Inventory's MyMarker, share `marker`), or -1. */
  indexOf(prop) {
    const fields = this.fields;
    for (let index = 0; index < fields.length; index++) if (fields[index]?.spec.prop === prop) return index;
    return -1;
  }
}

/** Replace `host`'s members for its mirrored fields by accessors over the
 * image. Each cell first takes the member's current value (or, while the
 * member is absent, the binding's fallback): the host member was that
 * field's storage until now. `fields` are the class's prepared fields;
 * `target` is where the members live (the scene level for PawnList). The
 * accessors are non-configurable, so a leftover `delete` throws instead of
 * splitting the storage again. */
export function installMirrorFields(host, instance, fields, {values = {}, exclude = null, target = host} = {}) {
  let set = target[MIRRORS] ?? null;
  const installed = set ? set.fields.slice() : [];
  for (const field of fields) {
    const item = BY_KEY.get(field.key);
    if (!item || exclude?.has(field.key) || (item === PAWN_LIST) !== (target !== host)) continue;
    const cell = mirrorCell(instance, field.key);
    if (!cell) continue;
    if (installed[item.index] !== undefined) throw new Error(`Mirror ${item.prop} is already installed: ${host.name}`);
    const existing = Object.getOwnPropertyDescriptor(target, item.prop);
    if (existing && !('value' in existing)) throw new Error(`${host.name}.${item.prop} is not a host data member`);
    const entry = mirrorFieldOf(item, cell, field);
    entry.set(instance, existing?.value === undefined ? entry.fallback(values) : existing.value);
    defineEntryAccessor(target, item.prop, MIRRORS, item.index);
    installed[item.index] = entry;
    if (!set) set = new MirrorSet(instance, values);
    set.fields = installed;
  }
  if (set) { set.fields = internEntries(installed); if (!target[MIRRORS]) Object.defineProperty(target, MIRRORS, {value: set}); }
}

/** Return a host member to the value makeBinding showed after `delete`: the
 * binding's fallback. A member that is no mirror is deleted. */
export function resetMirrorField(host, prop) {
  const set = host?.[MIRRORS], index = set ? set.indexOf(prop) : -1;
  if (index >= 0) set.set(index, set.fallback(index));
  else delete host[prop];
}

/** One mirrored field of an attached instance as a {get, set} pair over its
 * cell, for a member kept outside the host object (the Player's velocity,
 * player.mjs linkVelocity). Null when the field has no such cell. */
export function imageField(instance, field) {
  const item = BY_KEY.get(field.key), cell = item && mirrorCell(instance, field.key);
  if (!cell) return null;
  const entry = mirrorFieldOf(item, cell, field);
  return {get: () => entry.get(instance), set: value => entry.set(instance, value)};
}

/** A host's mirrored vector as an array whose element writes store into the
 * field (the native reach workers restore Velocity component by component,
 * script-pawn-nav.mjs). Null when `prop` is no vector mirror of `host`. */
export function liveVector(host, prop) {
  const set = host?.[MIRRORS], index = set ? set.indexOf(prop) : -1;
  if (index < 0 || set.fields[index].spec.kind !== 'vector') return null;
  const vector = new Array(3);
  for (let element = 0; element < 3; element++) Object.defineProperty(vector, element, {enumerable: true,
    get: () => set.get(index)[element],
    set: value => { const next = set.get(index); next[element] = value; set.set(index, next); }});
  return vector;
}
