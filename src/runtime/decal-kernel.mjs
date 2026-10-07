/** ADecal::execAttachDecal and execDetachDecal in the Rust core
 * (native/script-vm/src/decal.rs, docs/decals.md): the FDecal lists that
 * FBspSurf.Decals holds for the renderer, kept in the script-VM kernel
 * instance next to the BSP occlusion that draws them.
 *
 * A level's model is uploaded once (`uploadDecalModel`): the nodes, verts,
 * points, vectors, surfaces with their Surf.Nodes lists as UModel::PostLoad
 * builds them (0x103ace90: every node, ascending), and a trace model for
 * UModel::LineCheck. Each loaded level owns one store (`createDecalStore`):
 * LoadMap loads the model fresh, so a Player-start reload starts empty. */
import { traceModelLayout } from './trace-kernel.mjs';
import { setDecalHost } from './script-vm-kernel.mjs';

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export const f32Bits = v => (f32[0] = v, u32[0]);
export const bitsF32 = b => (u32[0] = b, f32[0]);

/** decal.rs status words and exits. */
export const DECAL_OK = 0, DECAL_FULL = 1, DECAL_FAULT = 2;
export const DECAL_EXITS = Object.freeze(['attached', 'traceMiss', 'noItem', 'noSurface', 'rotationParallel',
  'offPlane', 'polyFlags']);
export const DECAL_FAULTS = Object.freeze({1: 'model index out of range', 2: 'trace fallback',
  3: 'GatherNodes clip buffer assert (24 points, line 0x836)', 4: 'more than 64 nodes on one FDecal',
  5: 'SurfList longer than 64 entries', 7: 'record store exhausted'});

export class DecalKernelFault extends Error {
  constructor(code, operation) {
    super(`${operation}: ${DECAL_FAULTS[code] ?? `fault ${code}`}`);
    this.name = 'DecalKernelFault'; this.code = 'DECAL_BOUNDARY'; this.fault = code; this.operation = operation;
  }
}

const HEADER_WORDS = 16, NODE_WORDS = 4, SURF_WORDS = 9;
const IO_ACTOR = 0, IO_SURFLIST_COUNT = 15, IO_SURFLIST = 64, IO_RESULT = 32, IO_EXIT = 33, IO_APPENDED = 34,
  IO_APPENDED_AT = 35, IO_RANDS = 52, IO_FAULT = 53, IO_SET_BASE = 54, SURFLIST_MAX = 64;

/** The decal model of `model` (src/unreal/model.mjs readModel) in `kernel`
 * (the script-VM kernel's `decals` facade). `surfaceFlags` overrides
 * the surfaces' PolyFlags (validators' synthetic cases); `isMover(surface)` gives a surface whose Actor is a Mover: that Mover's
 * Rotation ([pitch, yaw, roll]; any other truthy value reads as zeros), or
 * a falsy value. With the moving brush tracker these are its surfaces.
 * `pointCapacity` leaves room for the points a tracked model can reach
 * (the model's `sync()` then follows the tracker, decal.rs
 * `decal_model_sync`). */
export function uploadDecalModel(kernel, model, { surfaceFlags = null, isMover = () => false, pointCapacity = 0 } = {}) {
  const nodes = model.nodes, surfaces = model.surfaces;
  // UModel::PostLoad's Surf.Nodes, at load: a tracked model's fragments
  // (past `originalNodes`) are not in any surface's list.
  const surfNodes = surfaces.map(() => []), original = model.originalNodes ?? nodes.length;
  nodes.forEach((node, k) => { if (k < original && surfNodes[node.surface]) surfNodes[node.surface].push(k); });
  const trace = traceModelLayout(model);
  if (!trace) throw new Error('The decal model needs a traceable BSP');
  const points = Math.max(pointCapacity, model.points.length);
  const nodeAt = 4 * HEADER_WORDS, vertAt = nodeAt + 4 * NODE_WORDS * nodes.length,
    pointAt = vertAt + 4 * model.vertices.length, vectorAt = pointAt + 12 * points,
    surfAt = vectorAt + 12 * model.vectors.length, listAt = surfAt + 4 * SURF_WORDS * surfaces.length,
    listWords = surfNodes.reduce((total, list) => total + list.length, 0),
    traceAt = (listAt + 4 * listWords + 15) & ~15, size = traceAt + trace.size;
  const base = kernel.alloc(size);
  const words = new Uint32Array(kernel.memory.buffer, base, (traceAt - 0) >>> 2);
  const header = [nodes.length, base + nodeAt, base + vertAt, base + pointAt, base + vectorAt, base + surfAt,
    base + listAt, base + traceAt, surfaces.length, model.vertices.length, model.points.length, model.vectors.length, listWords];
  words.set(header.map(v => v >>> 0), 0);
  nodes.forEach((node, i) => words.set([node.vertexPool, node.surface, node.coplanar, node.vertexCount].map(v => v >>> 0),
    (nodeAt >>> 2) + NODE_WORDS * i));
  model.vertices.forEach((v, i) => { words[(vertAt >>> 2) + i] = v.point >>> 0; });
  model.points.forEach((p, i) => words.set(p.map(f32Bits), (pointAt >>> 2) + 3 * i));
  model.vectors.forEach((p, i) => words.set(p.map(f32Bits), (vectorAt >>> 2) + 3 * i));
  let list = 0;
  surfaces.forEach((surface, i) => {
    const flags = surfaceFlags?.[i] ?? surface.flags;
    const mover = isMover(i), rotation = Array.isArray(mover) ? mover : [0, 0, 0];
    words.set([flags, surface.base, surface.normal, list, surfNodes[i].length, mover ? 1 : 0, ...rotation].map(v => v >>> 0),
      (surfAt >>> 2) + SURF_WORDS * i);
    words.set(surfNodes[i], (listAt >>> 2) + list);
    list += surfNodes[i].length;
  });
  trace.write(kernel.memory.buffer, base + traceAt);
  const surfWords = (base + surfAt) >>> 2;
  return { base, surfaceCount: surfaces.length,
    /** Follow the moving brush tracker's arrays (a model uploaded from
     * brush-tracker.mjs trackedModel); false when a count no longer fits. */
    sync: () => kernel.modelSync(base, points) === 0,
    /** Surface `s`'s Actor Rotation (a Mover surface's; ClipDecal and the
     * Mover branch read Surf.Actor->Rotation at their call). */
    setRotation(s, rotation) {
      const u = new Uint32Array(kernel.memory.buffer), o = surfWords + SURF_WORDS * s + 6;
      u[o] = rotation[0] >>> 0; u[o + 1] = rotation[1] >>> 0; u[o + 2] = rotation[2] >>> 0;
    },
    dispose: () => kernel.free(base) };
}

/** One level's FDecal lists over `decalModel`. `textureOf(actorId)` is a
 * decal actor's live Texture id (0 for None); `rand()` the shared stream's
 * rand(). Actor ids are the host's nonzero u32 handles. */
export function createDecalStore(kernel, decalModel, { capacity = 256 } = {}) {
  let surfaceCount = decalModel.surfaceCount;
  let at = kernel.alloc(kernel.storeSize(surfaceCount, capacity));
  kernel.storeInit(at, surfaceCount, capacity);
  const recordWords = kernel.recordWords();
  const io = () => new Uint32Array(kernel.memory.buffer, kernel.ioPtr(), 128);
  function grow() {
    const next = capacity * 2, to = kernel.alloc(kernel.storeSize(surfaceCount, next));
    kernel.storeGrow(at, to, next);
    kernel.free(at);
    at = to; capacity = next;
  }
  function putSurfList(words, surfList) {
    if (surfList.length > SURFLIST_MAX) throw new DecalKernelFault(5, 'AttachDecal');
    words[IO_SURFLIST_COUNT] = surfList.length;
    for (let k = 0; k < surfList.length; k++) words[IO_SURFLIST + k] = surfList[k] >>> 0;
  }
  return {
    get capacity() { return capacity; },
    get surfaceCount() { return surfaceCount; },
    /** Whether any surface from `first` on holds an FDecal. */
    anyFrom(first) {
      const words = new Uint32Array(kernel.memory.buffer, at, HEADER_WORDS + 2 * surfaceCount);
      for (let s = first; s < surfaceCount; s++) if ((words[HEADER_WORDS + 2 * s] | 0) >= 0) return true;
      return false;
    },
    /** Attach over `model` from now on (the same level model, uploaded
     * anew: the moving brush tracker's). Its added surfaces start with
     * empty lists. */
    setModel(model) {
      decalModel = model;
      if (model.surfaceCount <= surfaceCount) return;
      const to = kernel.alloc(kernel.storeSize(model.surfaceCount, capacity));
      kernel.storeResize(at, to, model.surfaceCount, capacity);
      kernel.free(at);
      at = to; surfaceCount = model.surfaceCount;
    },
    /** The FDecal records in use (every surface's). */
    get count() { return new Uint32Array(kernel.memory.buffer, at, HEADER_WORDS)[3]; },
    /** execAttachDecal's surface path after the gates: `level` is the
     * clamped MultiDecalLevel. Returns the result word, the exit, the
     * surfaces SurfList gains (in order), the rand() calls made and
     * `setBase`: the Mover branch asks for this->SetBase(Owner, 1). */
    attach({ actor, location, rotation, traceDistance, decalDir, drawScale, uSize, level, texture, surfList }, { rand, textureOf }) {
      for (;;) {
        const words = io();
        words[IO_ACTOR] = actor >>> 0;
        words.set(location.map(f32Bits), 1);
        words.set(rotation.map(v => v >>> 0), 4);
        words[7] = f32Bits(traceDistance);
        words.set(decalDir.map(f32Bits), 8);
        words[11] = f32Bits(drawScale);
        words[12] = uSize | 0; words[13] = level | 0; words[14] = texture >>> 0;
        putSurfList(words, surfList);
        setDecalHost({ rand, texture: textureOf });
        let status;
        try { status = kernel.attach(decalModel.base, at); } finally { setDecalHost(null); }
        const out = io();
        if (status === DECAL_FULL) { grow(); continue; }
        if (status === DECAL_FAULT) throw new DecalKernelFault(out[IO_FAULT], 'AttachDecal');
        return { result: out[IO_RESULT], exit: DECAL_EXITS[out[IO_EXIT]],
          appended: Array.from(out.subarray(IO_APPENDED_AT, IO_APPENDED_AT + out[IO_APPENDED])), rands: out[IO_RANDS],
          setBase: out[IO_SET_BASE] === 1 };
      }
    },
    /** execDetachDecal: one FDecal of this actor per SurfList entry, last first. */
    detach({ actor, surfList }) {
      const words = io();
      words[IO_ACTOR] = actor >>> 0;
      putSurfList(words, surfList);
      if (kernel.detach(at) !== DECAL_OK) throw new DecalKernelFault(io()[IO_FAULT], 'DetachDecal');
    },
    /** Surface `s`'s FDecal list in TArray order: actor, Vertices (f32 bit
     * patterns, relative to the surface base), MoverRotation and Nodes. */
    surfaceDecals(s) {
      const words = new Uint32Array(kernel.memory.buffer, at, HEADER_WORDS + 2 * surfaceCount + recordWords * capacity);
      const records = HEADER_WORDS + 2 * surfaceCount, out = [];
      for (let r = words[HEADER_WORDS + 2 * s] | 0, guard = 0; r >= 0; r = words[records + recordWords * r + 1] | 0) {
        if (++guard > capacity) throw new Error('Cyclic decal list');
        const o = records + recordWords * r;
        out.push({ actor: words[o + 3], verticesBits: [0, 1, 2, 3].map(k => Array.from(words.subarray(o + 4 + 3 * k, o + 7 + 3 * k))),
          moverRotation: Array.from(new Int32Array(words.buffer, words.byteOffset + 4 * (o + 16), 3)),
          nodes: Array.from(words.subarray(o + 20, o + 20 + words[o + 19])) });
      }
      return out;
    },
    /** The store's byte address in the kernel memory (the renderer's input). */
    get address() { return at; },
    dispose() { kernel.free(at); at = 0; },
  };
}
