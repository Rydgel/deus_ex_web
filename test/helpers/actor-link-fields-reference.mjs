// Verbatim copy of src/runtime/actor-link-fields.mjs at ca8ab34e (before docs/live-heap.md "Actor hosts and mesh bindings"), the reference the differential in
// test/host-members.test.mjs compares the shared-entry modules with. Only the import paths differ.
/**
 * An actor's Base and Touching as its object-image cells (stage 1e step 4,
 * docs/rust-core.md "1e-4").
 *
 * script-doors' makeBinding bound these two properties of every attached map
 * actor onto host members (`base` and `touching`: the AActor pointers the
 * recovered IsBasedOn/SetBase walks, the rider pass and BeginTouch/EndTouch
 * read and write), and the image cells under the bindings went stale. Here
 * the host members are accessors over the cells, so the script field, the
 * host member and the Rust interpreter read one storage. Retail AActor
 * offsets (sdk-layouts.mjs, checked per class below):
 *
 *   +0x0c4 Base (object pointer)
 *   +0x0e8 Touching[4] (object pointers at a 4-byte stride)
 *
 * `base` reads the pointer cell's identity and stores a handle; every store
 * bumps the base epoch (base-epoch.mjs), as the binding's setter did.
 * `touching` is one Array of length 4 created per host whose elements are
 * accessors over the four pointer cells, so actor-touch.mjs's `slots()`
 * (Array.isArray, length 4, indexOf, element stores, fill) and the
 * binding-era `host.touching = [...]` assignments keep working. Each access
 * reads or writes through the arena's current view, so no view outlives a
 * memory growth.
 *
 * The controlled player keeps both bindings: its `base` is the movement
 * port's (player.mjs), stage 1e step 6.
 */
import {readCell, writeCell, readFixedElement, writeFixedElement, isFixedCell, scalarCell, cellKind}
  from '../../src/runtime/script-object-image.mjs';
import {propertyCodec} from '../../src/runtime/script-values.mjs';
import {bumpBaseEpoch} from '../../src/runtime/base-epoch.mjs';
import {defineEntryAccessor} from './host-accessors-reference.mjs';

export const BASE_KEY = 'engine.actor.base';
export const TOUCHING_KEY = 'engine.actor.touching';
const SPECS = Object.freeze({
  [BASE_KEY]: Object.freeze({prop: 'base', key: BASE_KEY, offset: 0xc4, kind: 'object', index: 0}),
  [TOUCHING_KEY]: Object.freeze({prop: 'touching', key: TOUCHING_KEY, offset: 0xe8, kind: 'fixed', index: 1}),
});

// Installed entries of a host (non-enumerable, so no host walk sees them), by the spec's index: the host's accessors find
// theirs through it (host-accessors.mjs).
const LINKS = Symbol('actorLinkFields');

// Cells (one per class and field) checked against the retail layout.
const checkedCells = new WeakSet();
/** The cell `key` of an attached instance when it holds the field as a link:
 * linked at its retail offset with its kind, not poisoned. A field the
 * linker placed elsewhere is an error, not a host member. */
function linkCell(instance, key) {
  const item = SPECS[key], cell = item && instance?.cells?.get(key);
  if (!cell || !instance.base || instance.poison?.has(key)) return null;
  if (!checkedCells.has(cell)) {
    if (item.kind === 'object') {
      const scalar = scalarCell(cell);
      if (scalar?.kind !== 'object' || scalar.offset !== item.offset)
        throw new Error(`${key} is not linked as an object pointer +0x${item.offset.toString(16)}: ${scalar?.kind} +0x${scalar?.offset?.toString(16)}`);
    } else if (!isFixedCell(cell) || cell.offset !== item.offset || cell.dim !== 4 || cell.stride !== 4 ||
      cellKind(cell.element) !== 'pointer' || cell.element.offset !== 0) {
      throw new Error(`${key} is not linked as four object pointers +0x${item.offset.toString(16)}`);
    }
    checkedCells.add(cell);
  }
  return cell;
}

/** Whether `field` of an attached instance is Base or Touching held in its
 * image: makeBinding binds nothing for it. */
export function linksField(instance, field) {
  return Boolean(SPECS[field.key]) && Boolean(linkCell(instance, field.key));
}

const released = instance => Boolean(instance.imageToken?.released);
function check(instance) {
  if (released(instance)) throw new Error('Script object allocation has been released');
}
const SLOT_ACCESSORS = [0, 1, 2, 3].map(index => Object.freeze({
  get() {
    const link = this[TOUCH_LINK], instance = link.instance;
    check(instance);
    return readFixedElement(link.cell, instance.arena.view, instance.refs, index, instance.base);
  },
  set(value) {
    const link = this[TOUCH_LINK], instance = link.instance;
    check(instance);
    writeFixedElement(link.cell, instance.arena.view, instance.refs, index, pointer(value), instance.base);
  },
}));
/** The `base` member: the pointer cell as a handle. */
class BaseLink {
  constructor(spec, instance, cell, codec) { this.spec = spec; this.cell = cell; this.instance = instance; this.codec = codec; }
  get() { const instance = this.instance; check(instance); return readCell(this.cell, instance.arena.view, instance.refs, instance.base); }
  set(value) {
    const instance = this.instance;
    check(instance);
    // writeCell counts the Base change for the rider lists.
    writeCell(this.cell, instance.arena.view, instance.refs, this.codec.copy(pointer(value)), instance.base);
  }
}
/** The `touching` member: one array of four elements over the pointer cells; the member reads the same array. The array
 * finds its link through TOUCH_LINK, so its four element accessors are shared by every host's array. */
const TOUCH_LINK = Symbol('actorTouchingLink');
class TouchingLink {
  constructor(spec, instance, cell) { this.spec = spec; this.instance = instance; this.cell = cell; this.array = null; }
  get() { return this.array; }
  set(value) {
    if (!Array.isArray(value) || value.length !== 4) throw new Error('Original Touching requires four explicit slots');
    const array = this.array;
    for (let index = 0; index < 4; index++) array[index] = value[index];
  }
}
const pointer = value => {
  if (value !== null && value !== undefined && typeof value !== 'object')
    throw new TypeError(`An actor pointer cannot hold a ${typeof value} value (${String(value)})`);
  return value ?? null;
};

/** Replace `host`'s `base` and `touching` members by accessors over its
 * image. `base` first takes the member's current value, or None while the
 * member is absent: the binding read `host.base ?? null`. `touching` is
 * installed only where the host already has its four live slots (so
 * isMapMoveHost's predicate is unchanged); the slots move into the cells.
 * The accessors are non-configurable, so a leftover `delete` throws instead
 * of splitting the storage again. Returns the installed props. */
export function installLinkFields(host, instance, fields) {
  const installed = host[LINKS] ?? [];
  const added = [];
  for (const field of fields) {
    const item = SPECS[field.key];
    if (!item) continue;
    const cell = linkCell(instance, field.key);
    if (!cell) continue;
    if (installed[item.index] !== undefined) throw new Error(`Link ${item.prop} is already installed: ${host.name}`);
    const existing = Object.getOwnPropertyDescriptor(host, item.prop);
    if (existing && !('value' in existing)) throw new Error(`${host.name}.${item.prop} is not a host data member`);
    const codec = propertyCodec(field);
    let entry;
    if (item.kind === 'object') {
      writeCell(cell, instance.arena.view, instance.refs, codec.copy(pointer(existing?.value)), instance.base);
      bumpBaseEpoch();
      entry = new BaseLink(item, instance, cell, codec);
    } else {
      if (!Array.isArray(existing?.value) || existing.value.length !== 4) continue;
      const array = new Array(4);
      entry = new TouchingLink(item, instance, cell);
      entry.array = array;
      Object.defineProperty(array, TOUCH_LINK, {value: entry});
      for (let index = 0; index < 4; index++) Object.defineProperty(array, index, {enumerable: true, ...SLOT_ACCESSORS[index]});
      for (let index = 0; index < 4; index++) array[index] = existing.value[index];
    }
    defineEntryAccessor(host, item.prop, LINKS, item.index);
    installed[item.index] = entry;
    added.push(item.prop);
  }
  if (!host[LINKS] && installed.length) Object.defineProperty(host, LINKS, {value: installed});
  return added;
}

/** Whether `host` has its `prop` (base or touching) installed as a link. */
export const hasLinkField = (host, prop) => Boolean(host?.[LINKS]?.some(entry => entry?.spec.prop === prop));

/** Whether `prop` is a link member name. */
export const isLinkProp = prop => prop === 'base' || prop === 'touching';

/** Return a link member to the value makeBinding showed after `delete`
 * (the NPC startup reset, script-doors NPC_HOST_PROPS): `base` read
 * `host.base ?? null`, so its cell takes None; `touching` read the stored
 * field, which the property reset has just restored, so its cells stay. A
 * member that is not installed is deleted, as the other resets do. */
export function resetLinkField(host, prop) {
  const entry = host?.[LINKS]?.find(item => item?.spec.prop === prop);
  if (!entry) { delete host[prop]; return; }
  if (prop === 'base') host.base = null;
}
