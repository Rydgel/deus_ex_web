/** Original GOTY native mesh construction/loading; docs/script-mesh-load-graph.md. */
export class MeshLoadBoundaryError extends Error {
  constructor(message) { super(message); this.name = 'MeshLoadBoundaryError'; this.code = 'UNSUPPORTED_MESH_LOAD'; }
}
const fail = message => { throw new MeshLoadBoundaryError(message); };
const call = (services, name, ...args) => {
  if (typeof services[name] !== 'function') fail(`Mesh loading requires ${name}`);
  const result = services[name](...args);
  if (result && typeof result.then === 'function') fail(`Mesh ${name} suspended`);
  return result;
};
const read = (object, offset, s) => call(s, 'read', object, offset);
const write = (object, offset, value, s, type = 'u32') => call(s, 'write', object, offset, value, type);
const dv = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const float = bits => { const b = new ArrayBuffer(4), v = new DataView(b); v.setUint32(0, bits, true); return v.getFloat32(0, true); };
const count = n => { if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) fail(`Invalid mesh array count ${n}`); return n; };
const array = elementSize => ({data: null, num: 0, max: 0, elementSize});
export const MESH_ARRAY_LAYOUTS = new Map([
  [0x60, [4, 4]], [0x78, [2, 2, 2, 1, 1, 1, 1, 1, 1, 4, 4]],
  [0x9c, [4, 4]], [0xcc, [4]], [0xa8, [4, 4, 4, 4, 4, 4, 1]],
  [0xb4, [4, 4, 4, 4]], [0xe4, [4]], [0x12c, [2]], [0x138, [2]],
  [0x144, [2, 2, 2, 2]], [0x150, [2]], [0x15c, [2, 1, 1]],
  [0x168, [4, 4]], [0x174, [2, 2, 2, 2]], [0x1a0, [2]],
]);
const LAZY = [[0x54, 8, 0x10429188], [0x6c, 20, 0x10429228],
  [0x90, 8, 0x104292c8], [0xc0, 4, 0x10429368]];

/** UMesh::UMesh (0x103a6130): UPrimitive base, the UMesh member arrays, the
 * UMesh vtable and its scalar defaults. ULodMesh's constructor continues from
 * here (constructLodMesh). Defaults were copied by InitProperties. */
export function constructMesh(object, s) {
  call(s, 'objectConstructor', object);
  for (let offset = 0x28; offset <= 0x50; offset += 4) write(object, offset, 0, s, offset === 0x40 ? 'u8' : 'u32');
  write(object, 0, 0x1042655c, s);
  const makeLazy = offset => {
    const [, size, vtable] = LAZY.find(row => row[0] === offset);
    const a = array(size);
    // All four count-taking FArray constructors invoke Realloc even empty.
    call(s, 'arrayRealloc', a, size);
    const lazy = {vtable, archive: null, savedPosition: 0, array: a, offset: offset + 12};
    write(object, offset, lazy, s, 'lazy');
    write(object, offset + 12, a, s, 'array');
  };
  makeLazy(0x54); makeLazy(0x6c);
  write(object, 0x84, array(32), s, 'array');
  makeLazy(0x90);
  for (const offset of [0xa8, 0xb4]) write(object, offset, array(offset === 0xa8 ? 28 : 16), s, 'array');
  makeLazy(0xc0);
  for (const [offset, size] of [[0xd8, 4], [0xe4, 4]])
    write(object, offset, array(size), s, 'array');
  write(object, 0, 0x104290b8, s);
  write(object, 0xf8, 0xffffffff, s); write(object, 0xfc, 0, s);
  for (const offset of [0x100, 0x104, 0x108]) write(object, offset, 0x3f800000, s);
  for (let offset = 0x10c; offset <= 0x120; offset += 4) write(object, offset, 0, s);
}

/** Defaults have already been copied by InitProperties. Preserve untouched fields. */
export function constructLodMesh(object, s) {
  constructMesh(object, s);
  for (const [offset, size] of [[0x12c, 2], [0x138, 2], [0x144, 8], [0x150, 2],
    [0x15c, 4], [0x168, 8], [0x174, 8], [0x1a0, 2]]) write(object, offset, array(size), s, 'array');
  write(object, 0, 0x1042942c, s);
}

function beginArray(a, archive, s) {
  archive.countBytes(a.num * a.elementSize, a.max * a.elementSize);
  const num = count(archive.readCompact());
  a.num = 0; a.max = num;
  call(s, 'arrayRealloc', a, a.elementSize);
  return num;
}
function rawArray(a, archive, s, layout) {
  const num = beginArray(a, archive, s);
  for (let i = 0; i < num; i++) {
    a.num++;
    let at = i * a.elementSize;
    for (const size of layout) { a.data.set(archive.readRaw(size), at); at += size; }
  }
}
export function loadMeshLazyArray(lazy, s) {
  if (lazy.savedPosition <= 0) return lazy.array;
  const saved = lazy.archive.tell();
  lazy.archive.seek(lazy.savedPosition);
  rawArray(lazy.array, lazy.archive, s, MESH_ARRAY_LAYOUTS.get(lazy.offset));
  lazy.savedPosition = -lazy.savedPosition;
  lazy.archive.seek(saved);
  return lazy.array;
}
function serializeLazy(lazy, archive, s) {
  const end = archive.readU32();
  call(s, 'attach', archive, lazy);
  if (!call(s, 'getLazyLoad')) loadMeshLazyArray(lazy, s);
  archive.seek(end);
}
function bounds(object, archive, s) {
  for (let offset = 0x28; offset <= 0x50; offset += 4)
    write(object, offset, offset === 0x40 ? archive.readRaw(1)[0] : archive.readU32(), s,
      offset === 0x40 ? 'u8' : 'u32');
}
function sequences(a, archive, s) {
  // FMeshAnimSeq destroys its previous notify FArray before rebuilding entries.
  for (const notify of a.notifyArrays ?? []) {
    notify.num = notify.max = 0; call(s, 'arrayRealloc', notify, 8);
  }
  const num = beginArray(a, archive, s);
  a.notifyArrays = []; a.sequences = []; a.nameReferences = [];
  const name = slot => {
    const ref = archive.readName();
    a.nameReferences.push({slot, index: ref.index, name: ref.text, globalIndex: ref.name});
    return ref;
  };
  for (let i = 0; i < num; i++) {
    a.num++;
    const v = dv(a.data), at = i * 32;
    v.setUint32(at + 16, 0x41f00000, true);
    const seq = name(`sequences[${i}].name`), group = name(`sequences[${i}].group`);
    v.setUint32(at, seq.name, true); v.setUint32(at + 4, group.name, true);
    const start = archive.readU32(), frames = archive.readU32();
    v.setUint32(at + 8, start, true); v.setUint32(at + 12, frames, true);
    const notify = array(8), notifies = [];
    a.notifyArrays.push(notify);
    const n = beginArray(notify, archive, s);
    for (let j = 0; j < n; j++) {
      notify.num++;
      const time = archive.readU32(), fn = name(`sequences[${i}].notifies[${j}]`);
      const nv = dv(notify.data); nv.setUint32(j * 8, time, true); nv.setUint32(j * 8 + 4, fn.name, true);
      notifies.push({time: float(time), name: fn.text});
    }
    const rate = archive.readU32();
    v.setUint32(at + 16, rate, true);
    // Pointer identity is the notifyArrays entry, never a fabricated raw address.
    v.setUint32(at + 20, 0, true); v.setUint32(at + 24, n, true); v.setUint32(at + 28, n, true);
    a.sequences.push({name: seq.text, group: group.text, startFrame: start | 0,
      numFrames: frames | 0, notifyCount: n, notifies, rate: float(rate)});
  }
}

/** Native loading branch only, preserving the supplied archive and object. */
/** UMesh::Serialize (0x103a63b0), which ULodMesh::Serialize (0x10354ab0)
 * calls first (0x10354b03) before its own arrays at +0x12c onward. */
export function serializeMesh(object, archive, s) {
  if (!archive.ar0c || archive.ar10 || archive.ar04 !== 68)
    fail('Mesh serializer currently requires the version 68 loading archive');
  call(s, 'objectSerialize', object, archive);
  bounds(object, archive, s);
  serializeLazy(read(object, 0x54, s), archive, s);
  serializeLazy(read(object, 0x6c, s), archive, s);
  const tris = read(object, 0x78, s), verts = read(object, 0x60, s);
  if (tris.num && dv(tris.data).getUint16(0, true) >= verts.num) fail('Original UMesh triangle/vertex assertion failed');
  sequences(read(object, 0x84, s), archive, s);
  object.meshSequenceEnd = archive.tell();
  serializeLazy(read(object, 0x90, s), archive, s);
  bounds(object, archive, s);
  serializeLazy(read(object, 0xc0, s), archive, s);
  const textures = read(object, 0xd8, s), n = beginArray(textures, archive, s);
  textures.references = [];
  for (let i = 0; i < n; i++) {
    textures.num++;
    const ref = archive.readObject();
    textures.references.push({slot: `textures[${i}]`, index: ref.index, object: ref.object});
    dv(textures.data).setUint32(i * 4, call(s, 'referenceToken', ref.object), true);
  }
  const raw = offset => rawArray(read(object, offset, s), archive, s, MESH_ARRAY_LAYOUTS.get(offset));
  raw(0xa8); raw(0xb4);
  for (let offset = 0xf0; offset <= 0x128; offset += 4) write(object, offset, archive.readU32(), s);
  raw(0xe4);
  // A classic UMesh ends here; ULodMesh::Serialize continues and moves this to its own end.
  object.meshSerializedEnd = archive.tell();
}

export function serializeLodMesh(object, archive, s) {
  serializeMesh(object, archive, s);
  const verts = read(object, 0x60, s);
  const raw = offset => rawArray(read(object, offset, s), archive, s, MESH_ARRAY_LAYOUTS.get(offset));
  for (const offset of [0x12c, 0x138, 0x144, 0x150, 0x15c, 0x168, 0x174]) raw(offset);
  for (const offset of [0x180, 0x184, 0x188, 0x19c, 0x18c, 0x190, 0x194, 0x198])
    write(object, offset, archive.readU32(), s);
  raw(0x1a0); write(object, 0x1ac, archive.readU32(), s);
  const remap = read(object, 0x1a0, s);
  if (remap.num) {
    loadMeshLazyArray(read(object, 0x54, s), s);
    const frameCount = read(object, 0xf4, s) | 0, frameVertices = read(object, 0xf0, s) | 0;
    const num = count(Math.imul(frameCount, frameVertices)), sourceStride = read(object, 0x1ac, s) | 0;
    if (frameCount < 0 || frameVertices < 0 || remap.num < frameVertices) fail('Invalid mesh remap dimensions');
    const target = array(8); target.num = num; target.max = num ? num + Math.trunc(num * 3 / 8) + 32 : 0;
    call(s, 'arrayRealloc', target, 8);
    for (let frame = 0; frame < frameCount; frame++) for (let vertex = 0; vertex < frameVertices; vertex++) {
      const source = frame * sourceStride + dv(remap.data).getUint16(vertex * 2, true);
      if (source < 0 || source >= verts.num) fail('LodMesh vertex remap is out of bounds');
      target.data.set(verts.data.subarray(source * 8, source * 8 + 8), (frame * frameVertices + vertex) * 8);
    }
    verts.num = verts.max = 0; call(s, 'arrayRealloc', verts, 8);
    verts.num = num; verts.max = target.max; call(s, 'arrayRealloc', verts, 8);
    // Original appMemswap swaps the FArray's three words, then clears the temp.
    const oldData = verts.data; verts.data = target.data; target.data = oldData;
    target.num = target.max = 0; call(s, 'arrayRealloc', target, 8);
    remap.num = remap.max = 0; call(s, 'arrayRealloc', remap, 2);
  }
  object.meshSerializedEnd = archive.tell();
}

/* Destruction: docs/mesh-destruction.md. PurgeGarbage's second pass calls the scalar deleting destructor (vtable +0x0c: UMesh
 * 0x1031c120, ULodMesh 0x1031c930), which runs the complete destructor below and then UObject::operator delete. Its first pass has
 * already destroyed the object (ConditionalDestroy: UObject::Destroy, neither mesh class overrides it) and, for a package the same
 * collection unloads, run ULinkerLoad::Destroy, whose DetachAllLazyLoaders(0) left the mesh's lazy arrays with no archive. */
const LAZY_DESTRUCTORS = new Map([[0x54, 0x1031a150], [0x6c, 0x1031a550], [0x90, 0x1031aab0], [0xc0, 0x1031af90]]);
// ~UMesh 0x10319ed0: the members in reverse declaration order, each with its element size.
const UMESH_MEMBERS = [[0xe4, 4], [0xd8, 4], [0xc0, 'lazy'], [0xb4, 16], [0xa8, 28], [0x90, 'lazy'], [0x84, 'sequences'],
  [0x6c, 'lazy'], [0x54, 'lazy']];
// ~ULodMesh 0x1031c1f0, before its call to ~UMesh.
const LODMESH_MEMBERS = [[0x1a0, 2], [0x174, 8], [0x168, 8], [0x15c, 4], [0x150, 2], [0x144, 8], [0x138, 2], [0x12c, 2]];

/** Core FArray::Remove 0x101454f0 over a mesh array's byte storage: nothing for a zero count; the shift, Num, and the shrink to
 * Num with Realloc when 3*Num < 2*Max or the slack is 16 KB or more, and the slack is over 64 elements or Num is 0. */
export function removeMeshArray(a, index, amount, size, s) {
  if (!amount) return;
  if (index < 0 || amount < 0 || index + amount > a.num) fail('FArray::Remove outside a mesh array');
  a.data.copyWithin(index * size, (index + amount) * size, a.num * size);
  a.num -= amount;
  if ((a.num * 3 < a.max * 2 || (a.max - a.num) * size >= 0x4000) && (a.max - a.num > 64 || a.num === 0)) {
    a.max = a.num;
    call(s, 'arrayRealloc', a, size);
  }
}

// TArray<T>::~TArray (inline, or Core FArray::~FArray 0x10107200 after an inline Remove): Remove(0, Num), GMalloc Free of a nonzero
// Data, then Data, Max and Num zeroed in that order.
function destroyArray(a, size, s) {
  call(s, 'arrayRemove', a, 0, a.num, size);
  if (a.data) call(s, 'freeArray', a, size);
  a.data = null; a.max = 0; a.num = 0;
}
// TLazyArray<T>::~TLazyArray (four bodies identical but for the vtable and sizeof(T)): the vtable, DetachLazyLoader through the
// archive's vtable +0x3c when SavedAr is nonzero, then the TArray at +0xc.
function destroyLazy(offset, lazy, s) {
  const [, size, vtable] = LAZY.find(row => row[0] === offset);
  lazy.vtable = vtable;
  if (lazy.archive) call(s, 'detach', lazy.archive, lazy);
  destroyArray(lazy.array, size, s);
}
// TArray<FMeshAnimSeq>::Remove 0x1031bb40 runs ~FMeshAnimSeq (0x1031bf10: its Notifys TArray at +0x14, 8-byte elements) on each
// removed sequence in index order before FArray::Remove(…, 0x20); then the member's Free and zeroing.
function destroySequences(a, s) {
  const notifies = a.notifyArrays ?? [];
  for (let i = 0; i < a.num; i++) destroyArray(notifies[i], 8, s);
  call(s, 'arrayRemove', a, 0, a.num, 32);
  if (a.data) call(s, 'freeArray', a, 32);
  a.data = null; a.max = 0; a.num = 0;
  // Play's projections of the freed sequences (their names and notifies) go with them.
  a.notifyArrays = []; a.sequences = []; a.nameReferences = [];
}

/** UMesh::~UMesh 0x10319ed0: the UMesh vtable and ConditionalDestroy, the members (each lazy array's destructor detaching it
 * from its linker), then ~UPrimitive inlined (its vtable and ConditionalDestroy) and ~UObject (Core, IAT 0x10599b04). */
export function destroyMesh(object, s) {
  write(object, 0, 0x104290b8, s);
  call(s, 'conditionalDestroy', object);
  for (const [offset, size] of UMESH_MEMBERS) {
    const member = read(object, offset, s);
    if (size === 'lazy') destroyLazy(offset, member, s);
    else if (size === 'sequences') destroySequences(member, s);
    else {
      destroyArray(member, size, s);
      // the Textures array's projection (its texture references) goes with its data
      if (offset === 0xd8) member.references = [];
    }
  }
  write(object, 0, 0x1042655c, s);
  call(s, 'conditionalDestroy', object);
  call(s, 'objectDestructor', object);
}

/** ULodMesh::~ULodMesh 0x1031c1f0: the ULodMesh vtable and ConditionalDestroy, its own arrays from +0x1a0 down to +0x12c, then
 * ~UMesh. */
export function destroyLodMesh(object, s) {
  write(object, 0, 0x1042942c, s);
  call(s, 'conditionalDestroy', object);
  for (const [offset, size] of LODMESH_MEMBERS) destroyArray(read(object, offset, s), size, s);
  destroyMesh(object, s);
}

export const MESH_DESTRUCTION = Object.freeze({
  umesh: Object.freeze({body: 0x10319ed0, thunk: 0x1030280b, deleting: 0x1031c120, size: 0x12c}),
  lodmesh: Object.freeze({body: 0x1031c1f0, thunk: 0x10303922, deleting: 0x1031c930, size: 0x1b0}),
  lazyDestructors: LAZY_DESTRUCTORS,
});

/** Typed host storage service; native Num/Max decisions remain above. */
export function reallocateMeshArray(a, size) {
  const old = a.data;
  a.data = a.max ? new Uint8Array(a.max * size) : null;
  if (old && a.data) a.data.set(old.subarray(0, Math.min(old.length, a.data.length)));
}
