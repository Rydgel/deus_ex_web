/**
 * An actor's Location, Rotation, OldLocation and collision size as its
 * object-image cells (stage 1e step 3, docs/rust-core.md "1e-3").
 *
 * script-doors' makeBinding bound these script properties of every attached
 * map actor, and of the controlled player, onto host members (`position`,
 * `rotation`, `radius`, `height`, and `oldLocation` for a map move host), and
 * the image cell under each binding went stale. Here the host member is an
 * accessor over the cell, so the script field, the host member, the collision
 * hash's `collisionValues` getters and the Rust interpreter read one storage.
 * Retail AActor offsets (sdk-layouts.mjs, checked per class below):
 *
 *   +0x114 Location (vector)   +0x120 Rotation (rotator)
 *   +0x12c OldLocation (vector)
 *   +0x1d4 CollisionRadius     +0x1d8 CollisionHeight (floats)
 *
 * Each access reads or writes the cell through the arena's current view, so
 * no view outlives a memory growth; a vector or rotator read returns a fresh
 * array (the host members were only ever replaced, never mutated in place);
 * a write stores through the field's codec (float32 components, int32
 * rotator components, a float32), which in both maps' runs never changed a
 * host value: every host write was already exact.
 *
 * A host keeps one PoseSet: its instance, its `values` and the class's
 * PoseFields (a member's spec, cell and codec, shared by every host that has
 * the cell: docs/live-heap.md, "Actor hosts and mesh bindings").
 */
import {readCell, writeCell, scalarCell, vectorCell} from './script-object-image.mjs';
import {propertyCodec} from './script-values.mjs';
import {defineEntryAccessor, internEntries, defineBackedMember, isBackedHost, peekPending, dropPending, hostDelete} from './host-accessors.mjs';

const ZERO = Object.freeze([0, 0, 0]);
// `name`: the host `values` slot makeBinding fell back to while the host
// member was absent; OldLocation fell back to the image cell itself.
const spec = (prop, key, offset, kind, name, zero) => Object.freeze({prop, key, offset, kind, name, zero, index: 0});
const indexed = list => Object.freeze(list.map((item, index) => Object.freeze({...item, index})));
export const POSE_FIELDS = indexed([
  spec('position', 'engine.actor.location', 0x114, 'vector', 'Location', ZERO),
  spec('rotation', 'engine.actor.rotation', 0x120, 'rotator', 'Rotation', ZERO),
  spec('oldLocation', 'engine.actor.oldlocation', 0x12c, 'vector', null, null),
  spec('radius', 'engine.actor.collisionradius', 0x1d4, 'float', 'CollisionRadius', 0),
  spec('height', 'engine.actor.collisionheight', 0x1d8, 'float', 'CollisionHeight', 0),
]);
const BY_KEY = new Map(POSE_FIELDS.map(item => [item.key, item]));
const BY_PROP = new Map(POSE_FIELDS.map(item => [item.prop, item]));
// The cells a property reset keeps live (resetProperties): the host's own
// reset code restores them, inside the hash's remove/re-add where needed.
const LIVE_ACROSS_RESET = new Set(['position', 'rotation', 'radius', 'height']);

// The state of a host (non-enumerable, so no host walk sees it): the host's accessors find it through this symbol
// (host-accessors.mjs) and ask it for the member at the spec's index.
const POSES = Symbol('actorPoseFields');
// A MapActorHost's pose members (host-accessors.mjs): its pending value until the installer takes the member into the image, then the state's.
for (const item of POSE_FIELDS)
  defineBackedMember(item.prop, host => host[POSES]?.fields[item.index] !== undefined, host => host[POSES].get(item.index),
    (host, value) => host[POSES].set(item.index, value));

const checkedCells = new WeakSet();
/** The cell `key` of an attached instance when it holds a pose field: linked
 * at its retail offset with its kind, not poisoned. A field the linker placed
 * elsewhere is an error, not a host member. */
function poseCell(instance, key) {
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

/** Whether `field` of an attached instance is a pose field held in its
 * image: makeBinding binds nothing for it. */
export function posesField(instance, field) {
  return BY_KEY.has(field.key) && Boolean(poseCell(instance, field.key));
}

const released = instance => Boolean(instance.imageToken?.released);
/** One pose member of a class: its spec, cell and codec, shared by every host that installs it. The instance is the host's
 * (the caller passes it). */
class PoseField {
  constructor(item, cell, codec) { this.spec = item; this.cell = cell; this.codec = codec; }
  read(instance) {
    return readCell(this.cell, instance.arena.view, instance.refs, instance.base);
  }
  write(instance, value) {
    writeCell(this.cell, instance.arena.view, instance.refs, this.codec.copy(value), instance.base);
  }
  get(instance) {
    if (released(instance)) throw new Error('Script object allocation has been released');
    return this.read(instance);
  }
  set(instance, value) {
    if (released(instance)) throw new Error('Script object allocation has been released');
    this.write(instance, value);
  }
  /** The value makeBinding's getter gave while the host member was absent:
   * a mover's interpolation state, the `values` slot, else zero; for
   * OldLocation, the image cell as the attach built it (a property reset
   * restores the same value). `stored` is the host's. */
  fallback(host, values, stored) {
    const {prop, name, zero} = this.spec;
    if (!name) return this.codec.copy(stored);
    const interpolation = prop === 'position' || prop === 'rotation' ? host?.interpolation?.[prop] : undefined;
    return this.codec.copy(interpolation ?? values[name] ?? zero);
  }
}
// The PoseField of a codec (and cell): one for every class that has the field. keyed by the codec, which belongs to the field (a level's class graph) and goes with it: a leaf cell is shared by every level, so a cache keyed by the cell kept the first level's fields alive through the codec.
const poseFields = new WeakMap();
function poseFieldOf(item, cell, field) {
  const codec = propertyCodec(field);
  let list = poseFields.get(codec);
  if (list === undefined) poseFields.set(codec, list = []);
  for (const shared of list) if (shared.cell === cell && shared.spec === item) return shared;
  const shared = new PoseField(item, cell, codec);
  list.push(shared);
  return shared;
}

/** What a host keeps of its pose members: its instance, its `values`, OldLocation's stored image value, and the class's
 * PoseFields at the spec's indices (an interned array, holes for the members it does not have). */
class PoseSet {
  constructor(host, instance, values) {
    this.host = host; this.instance = instance; this.values = values;
    this.stored = null; // OldLocation: the image value the binding fell back to
    this.fields = [];
  }
  get(index) { return this.fields[index].get(this.instance); }
  set(index, value) { this.fields[index].set(this.instance, value); }
  fallback(index) { return this.fields[index].fallback(this.host, this.values, this.stored); }
}

/** Replace `host`'s pose members by accessors over its image. Each cell first
 * takes the member's current value (or, while it is absent, the binding's
 * fallback): the host member was that field's storage until now. OldLocation
 * is installed only where makeBinding bound it (`oldLocation`: a map move
 * host); elsewhere it already was the image's. The accessors are
 * non-configurable, so a leftover `delete` throws instead of splitting the
 * storage again. Returns the installed props. */
export function installPoseFields(host, instance, fields, {values = {}, oldLocation = false} = {}) {
  let set = host[POSES] ?? null;
  const installed = set ? set.fields.slice() : [], backed = isBackedHost(host);
  const added = [];
  for (const field of fields) {
    const item = BY_KEY.get(field.key);
    if (!item || (item.prop === 'oldLocation' && !oldLocation)) continue;
    const cell = poseCell(instance, field.key);
    if (!cell) continue;
    if (installed[item.index] !== undefined) throw new Error(`Pose ${item.prop} is already installed: ${host.name}`);
    const existing = backed ? undefined : Object.getOwnPropertyDescriptor(host, item.prop);
    if (existing && !('value' in existing)) throw new Error(`${host.name}.${item.prop} is not a host data member`);
    const current = backed ? peekPending(host, item.prop) : existing?.value;
    const entry = poseFieldOf(item, cell, field);
    let stored = null;
    if (!item.name) stored = entry.read(instance);   // only OldLocation's fallback reads it
    entry.write(instance, current === undefined ? entry.fallback(host, values, stored) : current);
    if (backed) dropPending(host, item.prop); else defineEntryAccessor(host, item.prop, POSES, item.index);
    installed[item.index] = entry; added.push(item.prop);
    if (!set) set = new PoseSet(host, instance, values);
    if (!item.name) set.stored = stored;
    set.fields = installed;
  }
  if (set) { set.fields = internEntries(installed); if (!host[POSES]) Object.defineProperty(host, POSES, {value: set}); }
  return added;
}

/** Return a pose member to the value makeBinding showed after `delete`: the
 * binding's fallback. A member that is not installed is deleted. */
export function resetPoseField(host, prop) {
  const set = host?.[POSES], index = BY_PROP.get(prop)?.index;
  if (!set?.fields[index]) { hostDelete(host, prop); return; }
  set.set(index, set.fallback(index));
}

// A map host's live collision values (linkLiveCollision, linkDecorationCollision): Location, CollisionRadius and
// CollisionHeight getters over the host's pose members. The marker names the host they read.
const LIVE_CYLINDER = Symbol('liveCylinder');
/** Mark `values`, the `collisionValues` a map host was just given, as reading `host`'s pose members. */
export function markLiveCylinder(values, host) {
  Object.defineProperty(values, LIVE_CYLINDER, {value: host});
  return values;
}
/** Whether `host`'s collision cylinder is its image's: its `collisionValues` are the live values marked for it, and its
 * position, collision radius and collision height are installed pose members (accessors over image cells). */
export function liveCylinderInImage(host) {
  const set = host[POSES];
  return host.collisionValues?.[LIVE_CYLINDER] === host && set !== undefined && !released(set.instance)
    && set.fields[BY_PROP.get('position').index] !== undefined && set.fields[BY_PROP.get('radius').index] !== undefined
    && set.fields[BY_PROP.get('height').index] !== undefined;
}

// A map mover's collision values (game.mjs): Location and Rotation getters over the host's pose members, every other
// member (PrePivot, PostScale, MainScale) a copy of the serialized values that nothing writes.
const MOVER_VALUES = Symbol('moverValues');
/** Mark `values`, the `collisionValues` a mover host was just given, as reading `host`'s pose members. */
export function markMoverValues(values, host) {
  Object.defineProperty(values, MOVER_VALUES, {value: host});
  return values;
}
/** Whether `host`'s brush pose is its image's: its `collisionValues` are the marked mover values, and its position
 * and rotation are installed pose members. */
export function moverPoseInImage(host) {
  const set = host[POSES];
  return host.collisionValues?.[MOVER_VALUES] === host && set !== undefined && !released(set.instance)
    && set.fields[BY_PROP.get('position').index] !== undefined && set.fields[BY_PROP.get('rotation').index] !== undefined;
}

/** Whether `prop` is a pose member name. */
export const isPoseProp = prop => BY_PROP.has(prop);

/** Around a property reset (restoreStorage): the Location, Rotation and
 * collision-size cells whose host members were their storage keep their
 * live values. The host's reset code restores them itself, inside the
 * collision hash's remove/re-add where the actor is registered, exactly as
 * when they were host members the restore never touched. Returns the
 * function that puts them back after the restore. */
export function keepLivePose(host) {
  const set = host?.[POSES], instance = set?.instance;
  const kept = set?.fields.filter(entry => LIVE_ACROSS_RESET.has(entry.spec.prop) && !released(instance));
  if (!kept?.length) return () => {};
  const saved = kept.map(entry => entry.read(instance));
  return () => { kept.forEach((entry, index) => entry.write(instance, saved[index])); };
}

/** One pose field of an attached instance as a {spec, get, set} triple over
 * its cell, for a member kept outside the host object (the Player's
 * position, body rotation, collision size and OldLocation: player.mjs
 * linkPose). Null when the field has no such cell. */
export function imagePoseField(instance, field) {
  const item = BY_KEY.get(field.key), cell = item && poseCell(instance, field.key);
  if (!cell) return null;
  const entry = poseFieldOf(item, cell, field);
  return {spec: item, get: () => entry.get(instance), set: value => entry.set(instance, value)};
}
