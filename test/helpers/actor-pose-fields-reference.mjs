// Verbatim copy of src/runtime/actor-pose-fields.mjs at ca8ab34e (before docs/live-heap.md "Actor hosts and mesh bindings"), the reference the differential in
// test/host-members.test.mjs compares the shared-entry modules with. Only the import paths differ.
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
 * no view outlives a memory growth. A vector or rotator read returns a fresh
 * array (the host members were only ever replaced, never mutated in place);
 * a write stores through the field's codec (float32 components, int32
 * rotator components, a float32), which in both maps' runs never changed a
 * host value: every host write was already exact.
 */
import {readCell, writeCell, scalarCell, vectorCell} from '../../src/runtime/script-object-image.mjs';
import {propertyCodec} from '../../src/runtime/script-values.mjs';
import {defineEntryAccessor} from './host-accessors-reference.mjs';

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

// Installed entries of a host (non-enumerable, so no host walk sees them), by the spec's index: the host's accessors find
// theirs through it (host-accessors.mjs).
const POSES = Symbol('actorPoseFields');

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
class Pose {
  constructor(host, instance, item, cell, field, values) {
    this.host = host; this.instance = instance; this.spec = item; this.cell = cell;
    this.codec = propertyCodec(field); this.values = values;
    this.stored = null; // OldLocation: the image value the binding fell back to
  }
  read() {
    const instance = this.instance;
    return readCell(this.cell, instance.arena.view, instance.refs, instance.base);
  }
  write(value) {
    const instance = this.instance;
    writeCell(this.cell, instance.arena.view, instance.refs, this.codec.copy(value), instance.base);
  }
  get() {
    if (released(this.instance)) throw new Error('Script object allocation has been released');
    return this.read();
  }
  set(value) {
    if (released(this.instance)) throw new Error('Script object allocation has been released');
    this.write(value);
  }
  /** The value makeBinding's getter gave while the host member was absent:
   * a mover's interpolation state, the `values` slot, else zero; for
   * OldLocation, the image cell as the attach built it (a property reset
   * restores the same value). */
  fallback() {
    const {prop, name, zero} = this.spec;
    if (!name) return this.codec.copy(this.stored);
    const interpolation = prop === 'position' || prop === 'rotation' ? this.host?.interpolation?.[prop] : undefined;
    return this.codec.copy(interpolation ?? this.values[name] ?? zero);
  }
}

/** Replace `host`'s pose members by accessors over its image. Each cell first
 * takes the member's current value (or, while it is absent, the binding's
 * fallback): the host member was that field's storage until now. OldLocation
 * is installed only where makeBinding bound it (`oldLocation`: a map move
 * host); elsewhere it already was the image's. The accessors are
 * non-configurable, so a leftover `delete` throws instead of splitting the
 * storage again. Returns the installed props. */
export function installPoseFields(host, instance, fields, {values = {}, oldLocation = false} = {}) {
  const installed = host[POSES] ?? [];
  const added = [];
  for (const field of fields) {
    const item = BY_KEY.get(field.key);
    if (!item || (item.prop === 'oldLocation' && !oldLocation)) continue;
    const cell = poseCell(instance, field.key);
    if (!cell) continue;
    if (installed[item.index] !== undefined) throw new Error(`Pose ${item.prop} is already installed: ${host.name}`);
    const existing = Object.getOwnPropertyDescriptor(host, item.prop);
    if (existing && !('value' in existing)) throw new Error(`${host.name}.${item.prop} is not a host data member`);
    const entry = new Pose(host, instance, item, cell, field, values);
    if (!item.name) entry.stored = entry.read();   // only OldLocation's fallback reads it
    entry.write(existing?.value === undefined ? entry.fallback() : existing.value);
    defineEntryAccessor(host, item.prop, POSES, item.index);
    installed[item.index] = entry; added.push(item.prop);
  }
  if (!host[POSES] && installed.length) Object.defineProperty(host, POSES, {value: installed});
  return added;
}

/** Return a pose member to the value makeBinding showed after `delete`: the
 * binding's fallback. A member that is not installed is deleted. */
export function resetPoseField(host, prop) {
  const entry = host?.[POSES]?.[BY_PROP.get(prop)?.index];
  if (!entry) { delete host[prop]; return; }
  entry.set(entry.fallback());
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
  const entries = host?.[POSES]?.filter(entry => LIVE_ACROSS_RESET.has(entry.spec.prop) && !released(entry.instance));
  if (!entries?.length) return () => {};
  const saved = entries.map(entry => entry.read());
  return () => { entries.forEach((entry, index) => entry.write(saved[index])); };
}

/** One pose field of an attached instance as a {spec, get, set} triple over
 * its cell, for a member kept outside the host object (the Player's
 * position, body rotation, collision size and OldLocation: player.mjs
 * linkPose). Null when the field has no such cell. */
export function imagePoseField(instance, field) {
  const item = BY_KEY.get(field.key), cell = item && poseCell(instance, field.key);
  if (!cell) return null;
  const entry = new Pose(null, instance, item, cell, field, {});
  return {spec: item, get: () => entry.get(), set: value => entry.set(value)};
}
