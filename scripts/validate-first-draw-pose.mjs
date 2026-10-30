#!/usr/bin/env node
/** The first GetFrame of an actor mesh binding is the first draw's (docs/script-lodmesh-frame.md "The first GetFrame is the first
 * draw's"), on the scene that showed it: 00_Intro's clinic shot, where the waiting pawns appeared in a T-pose and recovered.
 *
 * The original: ULodMesh::GetFrame's only reached call is DrawLodMesh's (Render 0x10b0ee0f), so a pawn never drawn has no cache item, and
 * the first draw takes GetFrame's normal path (a negative AnimFrame clamps to the sequence's first frame). The clinic pawns are authored
 * bForceStasis; Standing's bStasis holds them at BreatheLight -0.2, the start of PlayWaiting's tween, until the camera cuts to them (the
 * original's trace in2: unfrozen ticks 52 to 2088, LastRenderTime -10), so that first draw is all the frame shows.
 *
 * Boots the map through createSimHost (the worker's code) and runs `session.frame()` as the worker does, with the page's first-frame
 * preTick and no input (the intro's CameraPoints move the camera). Checks:
 *   1. the intro's first frame, whose render viewport is empty (drawWorld false), draws no binding: no record is visible;
 *   2. at the first frame whose Frame->Sprite holds each clinic pawn, the pawn is at BreatheLight -0.2 (the original's state) and the
 *      binding's pose is, word for word, GetFrame's on an empty cache at that frame; the pose a cache made at the admission (the pawn's
 *      Fighter frame 0) tweens from is reported, and must differ (the T-pose the check stands against).
 *
 *   node scripts/validate-first-draw-pose.mjs [--frames 3000]
 * Host check of the integration boundary only (the GetFrame body itself is validate-lodmesh-frame's, against the original). */
import { readFile, readdir } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-first-draw-pose: no installed game data'); process.exit(0); }
const argv = process.argv.slice(2);
const maxFrames = Number(argv.includes('--frames') ? argv[argv.indexOf('--frames') + 1] : 3000);
const [width, height] = [1440, 960];
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', { value: () => simulatedMs, configurable: true });

const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createSimHost } = await import('../src/viewer/sim-host.mjs');
const { createGpuMeshLayout, GPU_MESH_CAPACITIES, WEAPON_GPU_MESH_CAPACITIES } = await import('../src/viewer/gpu-mesh-layout.mjs');
const { createLodMeshFrameCache, getLodMeshFrame } = await import('../src/runtime/lodmesh-frame.mjs');

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('00_Intro');
const host = await createSimHost(decodeMap(asset.bytes, { triangles: false }), asset, assets, { randomSeed: 1, subtitles: false,
  stampScene: null, panZones: [], childFrames: false,
  gpu: createGpuMeshLayout(GPU_MESH_CAPACITIES).capacities, weaponGpu: createGpuMeshLayout(WEAPON_GPU_MESH_CAPACITIES).capacities,
  onProgress: () => {} });
if (!host.game) throw new Error(`No game: ${host.notes.join('; ')}`);
const { game, session, actorSim } = host;
const runtime = game.doors.scriptRuntime.runtime, level = runtime.levelFor(game.player.collisionActor);
const read = (object, name) => runtime.readNamed(object, name);
const failures = [];

const CLINIC = ['BumMale1', 'Doctor0', 'BumFemale1', 'JunkieMale0', 'BumMale7', 'Hooker1'];
const pawns = new Map(CLINIC.map(name => [name, level.actors.find(actor => actor?.name === name)]));
for (const [name, actor] of pawns) if (!actor || !actorSim.bindings.get(actor)) failures.push(`${name}: no actor or no mesh binding at the load`);
// The fields the admission's GetFrame read (the pawns' serialized pose until StartUp's FollowOrders).
const admitted = new Map([...pawns].map(([name, actor]) => [name, { AnimSequence: read(actor, 'AnimSequence'), AnimFrame: read(actor, 'AnimFrame') }]));

const IDENTITY = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
/** GetFrame on a cache of its own, in world space (the binding's Coords), for the binding's returned count; `primed` first runs one
 * call with those fields read in place of the actor's (the cache the admission's call left). */
function freshPose(binding, actor, count, primed = null) {
  const services = { cache: createLodMeshFrameCache(), kernel: null, read, objectIndex: () => 1 };
  if (primed) getLodMeshFrame(binding.payload, actor, IDENTITY,
    { ...services, read: (object, name) => object === actor && name in primed ? primed[name] : read(object, name) }, { vertexCount: count });
  return getLodMeshFrame(binding.payload, actor, IDENTITY, services, { vertexCount: count }).output;
}
const words = bytes => new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
const floats = bytes => new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);

let seconds = 0;
function step(frame) {
  simulatedMs += 1000 / 60; seconds += 1 / 60;
  const ahead = frame === 1 ? session.preTick({ dt: 1 / 60, width, height, aspect: width / height, resizes: 1 }) : false;
  const snapshot = session.frame({ play: true, dt: ahead ? 0 : 1 / 60, preTicked: ahead, run: true, halted: false, size: [width, height],
    aspect: width / height, resizes: 1, seconds, mirrors: true, pixelRatio: 1, now: seconds, inspect: null });
  if (snapshot.errors.length) throw new Error(`frame ${frame}: ${snapshot.errors.map(e => e.message).join('; ')}`);
  return snapshot;
}

// 1. The first frame.
const first = step(1);
const visibleFirst = (first.actors?.records ?? []).filter(record => record.visible).length;
console.log(`frame 1: drawWorld ${first.drawWorld}, ${first.actors?.records?.length ?? 0} binding records, ${visibleFirst} visible`);
if (first.drawWorld !== false) failures.push(`the intro's first frame draws the world (expected an empty render viewport): the check's premise moved`);
else if (visibleFirst) failures.push(`the first frame draws no world but ${visibleFirst} binding records are visible`);

// 2. Each clinic pawn's first drawn frame.
const done = new Map();
for (let frame = 2; frame <= maxFrames && done.size < pawns.size; frame++) {
  step(frame);
  for (const [name, actor] of pawns) {
    if (done.has(name)) continue;
    const binding = actorSim.bindings.get(actor);
    if (!binding?.lastDraw().main) continue;
    const state = binding.gpuState(), lod = binding.lodState();
    const special = binding.payload.scalarBits.get(0x184) | 0, count = lod?.returned ?? binding.payload.frameVertexCount - special;
    const drawnBytes = state.exactOutput().subarray(0, (special + count) * 12);
    const empty = freshPose(binding, actor, count).subarray(0, drawnBytes.length);
    const fromAdmission = freshPose(binding, actor, count, admitted.get(name)).subarray(0, drawnBytes.length);
    const differing = (x, y) => { let n = 0; const a = words(x), b = words(y); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
    const p = floats(empty), q = floats(fromAdmission);
    let farthest = 0;
    for (let v = 0; v < p.length; v += 3) farthest = Math.max(farthest, Math.hypot(p[v] - q[v], p[v + 1] - q[v + 1], p[v + 2] - q[v + 2]));
    const row = { frame, time: read(level.actors[0], 'TimeSeconds'), path: binding.path, AnimSequence: read(actor, 'AnimSequence'),
      AnimFrame: read(actor, 'AnimFrame'), count, words: drawnBytes.length >> 2, fromEmpty: differing(drawnBytes, empty),
      fromAdmission: differing(drawnBytes, fromAdmission), admission: admitted.get(name), apart: +farthest.toFixed(2) };
    done.set(name, row);
    console.log(`${name}: first drawn at frame ${frame} (level ${row.time.toFixed(3)} s, ${row.path}) in ${row.AnimSequence} ${row.AnimFrame}; `
      + `of ${row.words} words, ${row.fromEmpty} differ from GetFrame on an empty cache and ${row.fromAdmission} from the tween on the admission's `
      + `${row.admission.AnimSequence} ${row.admission.AnimFrame} cache (those two poses are up to ${row.apart} units apart)`);
    if (row.AnimSequence !== 'BreatheLight' || row.AnimFrame !== Math.fround(-0.2))
      failures.push(`${name}: first drawn in ${row.AnimSequence} ${row.AnimFrame} (the original's trace: BreatheLight -0.2)`);
    if (row.fromEmpty) failures.push(`${name}: the first drawn pose is not GetFrame's on an empty cache (${row.fromEmpty} words differ`
      + `${row.fromAdmission ? '' : '; it is the tween from the admission\'s cache'})`);
    if (!(farthest > 1)) failures.push(`${name}: the admission cache's pose is within ${farthest} units of the empty cache's: the check does not tell them apart`);
  }
}
for (const name of CLINIC) if (!done.has(name)) failures.push(`${name}: not drawn in ${maxFrames} frames`);
if (failures.length) { console.log(`FAIL validate-first-draw-pose:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS validate-first-draw-pose: the intro's empty first frame draws no binding; the ${CLINIC.length} clinic pawns' first drawn poses are GetFrame's on an empty cache`);
process.exit(0);
