/** Services that run the mesh destructors' translation (src/runtime/script-mesh-load.mjs destroyMesh/destroyLodMesh) and record
 * their calls the way native-mesh-load-oracle.py records the original's (docs/mesh-destruction.md): each Remove with its array, index,
 * count and element size, each Realloc with Num and Max, each Free, each Detach with the loader, the ConditionalDestroys and ~UObject
 * with the vtable then in place. For validate-mesh-load-graph.mjs and validate-mesh-payload.mjs. */
import {removeMeshArray, reallocateMeshArray} from '../src/runtime/script-mesh-load.mjs';
import {detachLinkerLazyLoader} from '../src/runtime/script-linker-lazy-loader.mjs';
import {removeResourceArray} from '../src/runtime/script-texture-load.mjs';

export const LAZY_OFFSETS = Object.freeze([0x54, 0x6c, 0x90, 0xc0]);
export const MESH_ARRAY_OFFSETS = Object.freeze([0x84, 0xa8, 0xb4, 0xd8, 0xe4]);
export const LODMESH_ARRAY_OFFSETS = Object.freeze([0x12c, 0x138, 0x144, 0x150, 0x15c, 0x168, 0x174, 0x1a0]);
export const hex = offset => `0x${offset.toString(16)}`;

/** `member(offset)` reads a mesh member (a lazy array or an FArray); `vtable()` the object's vtable word; `archive` the linker archive
 * whose lazy-loader array the original's labels call 'archive'. */
export function recordingDestroyServices({member, vtable, read, write, archive, classic = false, foreign = []}) {
  const events = [], labels = new Map([[archive.lazyLoaderArray, 'archive']]), loaders = new Map();
  for (const offset of [...MESH_ARRAY_OFFSETS, ...(classic ? [] : LODMESH_ARRAY_OFFSETS)]) labels.set(member(offset), hex(offset));
  for (const offset of LAZY_OFFSETS) { labels.set(member(offset).array, hex(offset + 12)); loaders.set(member(offset), hex(offset)); }
  (member(0x84).notifyArrays ?? []).forEach((notify, i) => labels.set(notify, `0x84[${i}].notifies`));
  foreign.forEach((loader, i) => loaders.set(loader, `foreign[${i}]`));
  const label = array => labels.get(array) ?? 'other';
  const archiveServices = {
    arrayRemove(array, index, count, size) {
      events.push({op: 'Remove', array: label(array), index, count, elementSize: size});
      removeResourceArray(array, index, count, size, archiveServices);
    },
    arrayRealloc(array, size) {
      events.push({op: 'Realloc', array: label(array), elementSize: size, num: array.num, max: array.max});
      if (!array.max) { array.data = null; return; }
      array.data.length = array.max;
    },
  };
  const services = {
    read, write,
    conditionalDestroy: () => events.push({op: 'ConditionalDestroy', vtable: vtable()}),
    objectDestructor: () => events.push({op: 'ObjectDtor', vtable: vtable()}),
    arrayRemove(array, index, count, size) {
      events.push({op: 'Remove', array: label(array), index, count, elementSize: size});
      removeMeshArray(array, index, count, size, services);
    },
    arrayRealloc(array, size) {
      events.push({op: 'Realloc', array: label(array), elementSize: size, num: array.num, max: array.max});
      reallocateMeshArray(array, size);
    },
    freeArray(array) { events.push({op: 'Free', data: label(array)}); array.data = null; },
    detach(current, lazy) {
      events.push({op: 'Detach', loader: loaders.get(lazy) ?? 'other'});
      detachLinkerLazyLoader(current, lazy, archiveServices);
    },
  };
  return {services, events, loaders};
}

/** The state the destructor leaves, in the oracle's `destroy` shape (data pointers as 0/1, the archive's entries by name). */
export function destroyedState({member, vtable, archive, loaders, classic = false}) {
  const a = archive.lazyLoaderArray;
  return {
    vtable: vtable(),
    lazy: Object.fromEntries(LAZY_OFFSETS.map(offset => {
      const lazy = member(offset);
      return [hex(offset), {vtable: lazy.vtable, archive: lazy.archive ? 1 : 0, savedPosition: lazy.savedPosition}];
    })),
    arrays: Object.fromEntries([...LAZY_OFFSETS.map(offset => [offset + 12, member(offset).array]),
      ...[...MESH_ARRAY_OFFSETS, ...(classic ? [] : LODMESH_ARRAY_OFFSETS)].map(offset => [offset, member(offset)])]
      .sort((x, y) => x[0] - y[0]).map(([offset, array]) => [hex(offset), [array.data ? 1 : 0, array.num, array.max]])),
    archive: {num: a.num, max: a.max, entries: (a.data ?? []).slice(0, a.num).map(entry => loaders.get(entry) ?? 'other')},
  };
}

/** The oracle's `destroy` result in destroyedState's shape. */
export const nativeDestroyedState = destroy => ({vtable: destroy.vtable,
  lazy: Object.fromEntries(Object.entries(destroy.lazy).map(([offset, lazy]) => [offset, {vtable: lazy.vtable,
    archive: lazy.archive ? 1 : 0, savedPosition: lazy.savedPosition}])),
  arrays: Object.fromEntries(Object.entries(destroy.arrays).map(([offset, [data, num, max]]) => [offset, [data ? 1 : 0, num, max]])),
  archive: destroy.archive});
