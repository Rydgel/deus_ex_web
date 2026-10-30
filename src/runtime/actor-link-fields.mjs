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
 * A host keeps one LinkSet (its instance and Touching array) over the class's BaseField and TouchingField
 * (docs/live-heap.md, "Actor hosts and mesh bindings"). The controlled player keeps both bindings: its `base` is the movement
 * port's (player.mjs), stage 1e step 6.
 */
import {readCell, writeCell, readFixedElement, writeFixedElement, isFixedCell, scalarCell, cellKind}
  from './script-object-image.mjs';
import {propertyCodec} from './script-values.mjs';
import {bumpBaseEpoch} from './base-epoch.mjs';
import {defineEntryAccessor, internEntries, slotArrayClass, defineBackedMember, isBackedHost, peekPending, dropPending, hostDelete} from './host-accessors.mjs';

export const BASE_KEY = 'engine.actor.base';
export const TOUCHING_KEY = 'engine.actor.touching';
const SPECS = Object.freeze({
  [BASE_KEY]: Object.freeze({prop: 'base', key: BASE_KEY, offset: 0xc4, kind: 'object', index: 0}),
  [TOUCHING_KEY]: Object.freeze({prop: 'touching', key: TOUCHING_KEY, offset: 0xe8, kind: 'fixed', index: 1}),
});

// The state of a host (non-enumerable, so no host walk sees it): the host's accessors find it through this symbol
// (host-accessors.mjs) and ask it for the member at the spec's index.
const LINKS = Symbol('actorLinkFields');
// A MapActorHost's base and touching (host-accessors.mjs): the pending value until the installer takes the member into the image, then the state's.
for (const item of Object.values(SPECS))
  defineBackedMember(item.prop, host => host[LINKS]?.fields[item.index] !== undefined, host => host[LINKS].get(item.index),
    (host, value) => host[LINKS].set(item.index, value));

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
// The Touching array finds its host's LinkSet through TOUCH_LINK, so its four element accessors, on the prototype of its class
// (host-accessors.mjs slotArrayClass), are shared by every host's array.
const TOUCH_LINK = Symbol('actorTouchingLink');
const SLOT_ACCESSORS = [0, 1, 2, 3].map(index => Object.freeze({
  get() {
    const link = this[TOUCH_LINK], instance = link.instance;
    check(instance);
    return readFixedElement(link.fields[1].cell, instance.arena.view, instance.refs, index, instance.base);
  },
  set(value) {
    const link = this[TOUCH_LINK], instance = link.instance;
    check(instance);
    writeFixedElement(link.fields[1].cell, instance.arena.view, instance.refs, index, pointer(value), instance.base);
  },
}));
const TouchingSlots = slotArrayClass(SLOT_ACCESSORS);
/** The `base` member of a class: the pointer cell as a handle. Shared by every host of the class that has the cell; the
 * instance is the host's LinkSet's. */
class BaseField {
  constructor(spec, cell, codec) { this.spec = spec; this.cell = cell; this.codec = codec; }
  get(link) { const instance = link.instance; check(instance); return readCell(this.cell, instance.arena.view, instance.refs, instance.base); }
  set(link, value) {
    const instance = link.instance;
    check(instance);
    // writeCell counts the Base change for the rider lists.
    writeCell(this.cell, instance.arena.view, instance.refs, this.codec.copy(pointer(value)), instance.base);
  }
}
/** The `touching` member of a class: one array of four elements per host over the pointer cells; the member reads the same
 * array (the LinkSet's). */
class TouchingField {
  constructor(spec, cell) { this.spec = spec; this.cell = cell; }
  get(link) { return link.array; }
  set(link, value) {
    if (!Array.isArray(value) || value.length !== 4) throw new Error('Original Touching requires four explicit slots');
    const array = link.array;
    for (let index = 0; index < 4; index++) array[index] = value[index];
  }
}
// The BaseField of a codec (and cell), keyed by the codec, which belongs to the field (a level's class graph) and goes with it: a leaf cell is shared by every level, so a cache keyed by the cell kept the first level's fields alive through the codec, and the TouchingField of a cell (it holds no codec).
const baseFields = new WeakMap(), touchingFields = new WeakMap();
function baseFieldOf(item, cell, codec) {
  let list = baseFields.get(codec);
  if (list === undefined) baseFields.set(codec, list = []);
  for (const shared of list) if (shared.cell === cell) return shared;
  const shared = new BaseField(item, cell, codec);
  list.push(shared);
  return shared;
}
function touchingFieldOf(item, cell) {
  let shared = touchingFields.get(cell);
  if (shared === undefined) touchingFields.set(cell, shared = new TouchingField(item, cell));
  return shared;
}
const pointer = value => {
  if (value !== null && value !== undefined && typeof value !== 'object')
    throw new TypeError(`An actor pointer cannot hold a ${typeof value} value (${String(value)})`);
  return value ?? null;
};

/** What a host keeps of its Base and Touching members: its instance, its Touching array and the class's fields at the
 * spec's indices (an interned array, a hole for a member it does not have). */
class LinkSet {
  constructor(instance) { this.instance = instance; this.array = null; this.fields = []; }
  get(index) { return this.fields[index].get(this); }
  set(index, value) { this.fields[index].set(this, value); }
}

/** Replace `host`'s `base` and `touching` members by accessors over its
 * image. `base` first takes the member's current value, or None while the
 * member is absent: the binding read `host.base ?? null`. `touching` is
 * installed only where the host already has its four live slots (so
 * isMapMoveHost's predicate is unchanged); the slots move into the cells.
 * The accessors are non-configurable, so a leftover `delete` throws instead
 * of splitting the storage again. Returns the installed props. */
export function installLinkFields(host, instance, fields) {
  let set = host[LINKS] ?? null;
  const installed = set ? set.fields.slice() : [], backed = isBackedHost(host);
  const added = [];
  for (const field of fields) {
    const item = SPECS[field.key];
    if (!item) continue;
    const cell = linkCell(instance, field.key);
    if (!cell) continue;
    if (installed[item.index] !== undefined) throw new Error(`Link ${item.prop} is already installed: ${host.name}`);
    const existing = backed ? undefined : Object.getOwnPropertyDescriptor(host, item.prop);
    if (existing && !('value' in existing)) throw new Error(`${host.name}.${item.prop} is not a host data member`);
    const current = backed ? peekPending(host, item.prop) : existing?.value;
    const codec = propertyCodec(field);
    let entry;
    if (item.kind === 'object') {
      writeCell(cell, instance.arena.view, instance.refs, codec.copy(pointer(current)), instance.base);
      bumpBaseEpoch();
      entry = baseFieldOf(item, cell, codec);
    } else {
      if (!Array.isArray(current) || current.length !== 4) continue;
      const array = new TouchingSlots(4);
      entry = touchingFieldOf(item, cell);
      if (!set) set = new LinkSet(instance);
      set.array = array;
      set.fields = installed;
      installed[item.index] = entry;
      Object.defineProperty(array, TOUCH_LINK, {value: set});
      for (let index = 0; index < 4; index++) array[index] = current[index];
    }
    if (backed) dropPending(host, item.prop); else defineEntryAccessor(host, item.prop, LINKS, item.index);
    installed[item.index] = entry;
    added.push(item.prop);
    if (!set) set = new LinkSet(instance);
    set.fields = installed;
  }
  if (set) { set.fields = internEntries(installed); if (!host[LINKS]) Object.defineProperty(host, LINKS, {value: set}); }
  return added;
}

/** Whether `host` has its `prop` (base or touching) installed as a link. */
export const hasLinkField = (host, prop) => Boolean(host?.[LINKS]?.fields.some(entry => entry?.spec.prop === prop));

/** The instance behind `host`'s installed Base link, or null: the host reads `host.base` from that instance's image (the rider
 * scan's direct reads, move-riders.mjs). */
export const baseLinkInstance = host => {
  const set = host?.[LINKS];
  return set !== undefined && set.fields[SPECS[BASE_KEY].index] !== undefined ? set.instance : null;
};

/** Whether `prop` is a link member name. */
export const isLinkProp = prop => prop === 'base' || prop === 'touching';

/** Return a link member to the value makeBinding showed after `delete`
 * (the NPC startup reset, script-doors NPC_HOST_PROPS): `base` read
 * `host.base ?? null`, so its cell takes None; `touching` read the stored
 * field, which the property reset has just restored, so its cells stay. A
 * member that is not installed is deleted, as the other resets do. */
export function resetLinkField(host, prop) {
  const entry = host?.[LINKS]?.fields.find(item => item?.spec.prop === prop);
  if (!entry) { hostDelete(host, prop); return; }
  if (prop === 'base') host.base = null;
}
