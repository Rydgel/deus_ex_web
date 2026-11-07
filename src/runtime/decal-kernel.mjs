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
import {switchReader} from './switch-reader.mjs';

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export const f32Bits = v => (f32[0] = v, u32[0]);
export const bitsF32 = b => (u32[0] = b, f32[0]);

/** decal.rs status words and exits. */
export const DECAL_OK = 0, DECAL_FULL = 1, DECAL_FAULT = 2;
export const DECAL_EXITS = Object.freeze(['attached', 'traceMiss', 'noItem', 'noSurface', 'rotationParallel',
  'offPlane', 'polyFlags']);
export const DECAL_FAULTS = Object.freeze({1: 'model index out of range', 2: 'trace fallback',
  3: 'GatherNodes clip buffer assert (24 points, line 0x836)', 4: 'more than 64 nodes on one FDecal',
  5: 'SurfList longer than 64 entries', 7: 'record store exhausted',
  8: 'DECAL_FAST=verify: the fast surface finder or node gatherer differs from the x87 reference'});

/** 'on' (default), 'off' or 'verify': DECAL_FAST / DEUS_EX_DECAL_FAST (?decalFast=). 'off' runs FindSurface and GatherNodes as
 * the reference x87 expressions, 'on' with the per-edge table and the decided-sign filter (decal/fast.rs), 'verify' both on every
 * call, a difference a DecalKernelFault 8. IO word 16 of the kernel: 0 on, 1 off, 2 verify. */
export const decalFastMode = switchReader('DECAL_FAST', 'DEUS_EX_DECAL_FAST', 'on');
const DECAL_FAST_WORDS = Object.freeze({on: 0, off: 1, verify: 2});
const IO_MODE = 16;
/** Entries of the surface finder's edge table (a power of two; DECAL_FAST_TABLE / DEUS_EX_DECAL_FAST_TABLE): one per polygon vertex
 * the finder and the gatherer have met, 72 bytes each in the kernel instance's memory, shared by its levels. */
const fastTableEntries = () => Number((typeof process !== 'undefined' && process.env?.DECAL_FAST_TABLE) || globalThis.DEUS_EX_DECAL_FAST_TABLE || 16384);
const fastTables = new WeakMap();
function ensureFastTable(kernel) {
  if (fastTables.has(kernel) || !kernel.fastTable) return;
  const entries = fastTableEntries();
  fastTables.set(kernel, entries);
  if (entries >= 2) kernel.fastTable(kernel.alloc(entries * kernel.fastEntryBytes()), entries);
}

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
export function uploadDecalModel(kernel, model, options = {}) {
  const { base, points, surfAt } = writeDecalModel(kernel, model, options);
  return decalModelHandle(kernel, base, points, (base + surfAt) >>> 2, model.surfaces.length);
}

/** The upload. Its callbacks stay in this function's scope: closures that outlived it would keep that scope, `isMover` and through it
 * the model it reads (a tracked model is a JavaScript copy of the tracker's arrays built for the upload alone: about 500,000 objects
 * on the Island, which every major GC of the simulation worker marked; docs/live-heap.md). */
function writeDecalModel(kernel, model, { surfaceFlags = null, isMover = () => false, pointCapacity = 0 } = {}) {
  const nodes = model.nodes, surfaces = model.surfaces;
  // UModel::PostLoad's Surf.Nodes, at load: a tracked model's fragments
  // (past `originalNodes`) are not in any surface's list.
  // Counting sort of the nodes by surface: each surface's nodes ascending, in one list.
  const original = model.originalNodes ?? nodes.length, surfaceCount = surfaces.length, listStart = new Int32Array(surfaceCount + 1);
  for (let k = 0; k < original; k++) { const surface = nodes.surface(k); if (surface >= 0 && surface < surfaceCount) listStart[surface + 1]++; }
  for (let i = 0; i < surfaceCount; i++) listStart[i + 1] += listStart[i];
  const surfNodes = new Int32Array(listStart[surfaceCount]), filled = listStart.slice(0, surfaceCount);
  for (let k = 0; k < original; k++) { const surface = nodes.surface(k); if (surface >= 0 && surface < surfaceCount) surfNodes[filled[surface]++] = k; }
  const trace = traceModelLayout(model);
  if (!trace) throw new Error('The decal model needs a traceable BSP');
  const points = Math.max(pointCapacity, model.points.length);
  const nodeAt = 4 * HEADER_WORDS, vertAt = nodeAt + 4 * NODE_WORDS * nodes.length,
    pointAt = vertAt + 4 * model.vertices.length, vectorAt = pointAt + 12 * points,
    surfAt = vectorAt + 12 * model.vectors.length, listAt = surfAt + 4 * SURF_WORDS * surfaces.length,
    listWords = surfNodes.length,
    traceAt = (listAt + 4 * listWords + 15) & ~15, size = traceAt + trace.size;
  const base = kernel.alloc(size);
  const words = new Uint32Array(kernel.memory.buffer, base, (traceAt - 0) >>> 2);
  const header = [nodes.length, base + nodeAt, base + vertAt, base + pointAt, base + vectorAt, base + surfAt,
    base + listAt, base + traceAt, surfaces.length, model.vertices.length, model.points.length, model.vectors.length, listWords];
  words.set(header.map(v => v >>> 0), 0);
  for (let i = 0; i < nodes.length; i++) {
    const at = (nodeAt >>> 2) + NODE_WORDS * i;
    words[at] = nodes.vertexPool(i) >>> 0; words[at + 1] = nodes.surface(i) >>> 0; words[at + 2] = nodes.coplanar(i) >>> 0; words[at + 3] = nodes.vertexCount(i);
  }
  for (let i = 0; i < model.vertices.length; i++) words[(vertAt >>> 2) + i] = model.vertices.point(i) >>> 0;
  // A float32 vector's words are f32Bits of each component.
  const floatWords = table => new Uint32Array(table.data.buffer, table.data.byteOffset, table.data.length);
  words.set(floatWords(model.points), pointAt >>> 2);
  words.set(floatWords(model.vectors), vectorAt >>> 2);
  words.set(surfNodes, listAt >>> 2);
  for (let i = 0; i < surfaceCount; i++) {
    const flags = surfaceFlags?.[i] ?? surfaces.flags(i);
    const mover = isMover(i), rotation = Array.isArray(mover) ? mover : [0, 0, 0], at = (surfAt >>> 2) + SURF_WORDS * i;
    words.set([flags, surfaces.base(i), surfaces.normal(i), listStart[i], listStart[i + 1] - listStart[i], mover ? 1 : 0, ...rotation].map(v => v >>> 0), at);
  }
  trace.write(kernel.memory.buffer, base + traceAt);
  return { base, points, surfAt };
}

/** 'kept' (default), 'js' or 'verify': DECAL_FOLLOW / DEUS_EX_DECAL_FOLLOW (?decalFollow=). 'js' writes every Mover surface's Actor
 * Rotation words at each AttachDecal (followDecalTracker), as before; 'kept' writes a mover's surfaces only when its rotation is not the
 * one the last call wrote for it (nothing else writes those words after the upload: decal.rs `decal_model_sync` leaves them); 'verify'
 * skips the same writes and checks that the words in memory are the ones the call would write. */
export const decalFollowMode = switchReader('DECAL_FOLLOW', 'DEUS_EX_DECAL_FOLLOW', 'kept');

/** The uploaded model's handle: it holds only the kernel, the block's address, the point capacity and the surface records' word. */
function decalModelHandle(kernel, base, points, surfWords, surfaceCount) {
  let rotationWords = null;
  // Per mover key: the surfaces and the rotation words setRotations last wrote (a new upload is a new handle: it starts empty).
  const followed = [];
  const followMode = decalFollowMode();
  return { base, surfaceCount,
    /** Follow the moving brush tracker's arrays (a model uploaded from
     * brush-tracker.mjs trackedModel); false when a count no longer fits. */
    sync: () => kernel.modelSync(base, points) === 0,
    /** Surface `s`'s Actor Rotation (a Mover surface's; ClipDecal and the
     * Mover branch read Surf.Actor->Rotation at their call). */
    setRotation(s, rotation) {
      // One view of the memory while it is the same buffer (a view per surface per mover per AttachDecal was this function's cost).
      const buffer = kernel.memory.buffer;
      let u = rotationWords;
      if (u === null || u.buffer !== buffer) rotationWords = u = new Uint32Array(buffer);
      const o = surfWords + SURF_WORDS * s + 6;
      u[o] = rotation[0] >>> 0; u[o + 1] = rotation[1] >>> 0; u[o + 2] = rotation[2] >>> 0;
    },
    /** setRotation of each of `surfaces` (a mover's, `key` its index among the tracker's movers), unless the last call for `key` wrote
     * these words to these surfaces already. */
    setRotations(key, surfaces, rotation) {
      const r0 = rotation[0] >>> 0, r1 = rotation[1] >>> 0, r2 = rotation[2] >>> 0, last = followed[key];
      if (followMode !== 'js' && last !== undefined && last.surfaces === surfaces && last.r0 === r0 && last.r1 === r1 && last.r2 === r2) {
        if (followMode === 'verify') {
          const buffer = kernel.memory.buffer, u = new Uint32Array(buffer);
          for (const s of surfaces) {
            const o = surfWords + SURF_WORDS * s + 6;
            if (u[o] !== r0 || u[o + 1] !== r1 || u[o + 2] !== r2)
              throw new Error(`DECAL_FOLLOW=verify: surface ${s} of mover ${key} holds ${u[o]} ${u[o + 1]} ${u[o + 2]}, the rotation is ${r0} ${r1} ${r2}`);
          }
        }
        return;
      }
      for (let k = 0; k < surfaces.length; k++) this.setRotation(surfaces[k], rotation);
      if (last === undefined) followed[key] = { surfaces, r0, r1, r2 };
      else { last.surfaces = surfaces; last.r0 = r0; last.r1 = r1; last.r2 = r2; }
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
  const fastWord = DECAL_FAST_WORDS[decalFastMode()] ?? 0;
  ensureFastTable(kernel);
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
        words[IO_MODE] = fastWord;
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
    /** The fast surface finder's counters since the instance began: table hits, misses, vertex signs and distance signs the
     * filter left to the x87 expressions (null in a core without it). */
    fastStats: () => kernel.fastStats ? [0, 1, 2, 3].map(i => kernel.fastStats(i)) : null,
    /** The store's byte address in the kernel memory (the renderer's input). */
    get address() { return at; },
    dispose() { kernel.free(at); at = 0; },
  };
}
