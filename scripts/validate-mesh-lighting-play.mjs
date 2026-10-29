/** Stage 4: Play's mesh-lighting composition against the original code.
 * Runs Training in Play (Node, no browser), lets src/viewer/mesh-lighting-view
 * light the nearest LOD-mesh actors for two frames, then replays exactly the
 * inputs that pass used (live light fields, the leaf's permeating run, the
 * moving-light leaf list, zone ambient, Frame coordinates, camera-space
 * vertices and normal planes) through the original SetupForActor and Light in
 * scripts/native-mesh-light-oracle.py. Contract: docs/mesh-lighting.md. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createMeshLightingView } from '../src/viewer/mesh-lighting-view.mjs';
import { createLodMeshFrameCache, getLodMeshFrame } from '../src/runtime/lodmesh-frame.mjs';
import { loadLodMeshKernel } from '../src/runtime/lodmesh-wasm.mjs';
import { traceRay } from '../src/runtime/ray.mjs';
import { accumulateFaceNormal, d3dDiffuse } from '../src/runtime/mesh-lighting.mjs';
import { gameDirectory } from './game-directory.mjs';
import { createPlayerInputFixture } from './player-input-fixture.mjs';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
await loadTraceKernel(); // Rust BSP traces; TRACE_KERNEL=js runs the JavaScript bodies

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get('00_Training'), map = decodeMap(asset.bytes);
const game = await createGame(map, asset, assets, { randomSeed: 1 });
const input = createPlayerInputFixture(game, { tickSeconds: 1 / 120 });
input.tick(60);
const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
const level = runtime.levelFor(player), model = level.model;
const read = (object, name) => { try { return runtime.readNamed(object, name); } catch { return undefined; } };
const exportIndexByName = new Map(asset.pkg.exports.map((entry, i) => [entry.name, i + 1]));
const lightingOptions={exportName: ref => asset.pkg.exports[ref - 1]?.name, exportIndex: name => exportIndexByName.get(name)};
const lighting = createMeshLightingView(runtime, () => runtime.levelFor(player),lightingOptions);
const lightingWasm=createMeshLightingView(runtime,()=>runtime.levelFor(player),{...lightingOptions,kernel:await loadLodMeshKernel()});
const view = game.view(), f = Math.fround, bits = new DataView(new ArrayBuffer(4));
const u32 = value => { bits.setFloat32(0, value, true); return bits.getUint32(0, true); };
const float = value => { bits.setUint32(0, value >>> 0, true); return bits.getFloat32(0, true); };

// The nearest visible LOD-mesh actors to the player's view.
const candidates = [];
for (const actor of level.actors) {
  if (!actor || actor === player || read(actor, 'bHidden') || read(actor, 'bDeleteMe')) continue;
  const mesh = read(actor, 'Mesh');
  if (mesh?.kind !== 'LodMesh') continue;
  const location = read(actor, 'Location');
  candidates.push({ actor, distance: Math.hypot(...location.map((c, i) => c - view.location[i])) });
}
candidates.sort((a, b) => a.distance - b.distance);
// The nearest actor of each of the first twelve classes by distance.
const classOf = actor => runtime.instance(actor)?.cls?.record?.name ?? actor.name.replace(/\d+$/, '');
const seenClasses = new Set(), chosen = [];
for (const { actor } of candidates) {
  if (chosen.length >= 12) break;
  if (seenClasses.has(classOf(actor))) continue;
  seenClasses.add(classOf(actor)); chosen.push(actor);
}
const meshes = new Map();
for (const actor of chosen) {
  const payload = await runtime.prepareMesh(actor);
  const services = { cache: createLodMeshFrameCache(), kernel: null, read: (object, name) => runtime.readNamed(object, name),
    objectIndex: () => 0x60000000 + chosen.indexOf(actor) };
  const frame = getLodMeshFrame(payload, actor, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], services);
  const data = new DataView(frame.output.buffer, frame.output.byteOffset, frame.output.byteLength);
  const points = Array.from({ length: frame.output.byteLength / 12 }, (_, i) => [0, 4, 8].map(o => data.getFloat32(i * 12 + o, true)));
  const faces=runtime.getActorMeshSurfaces(actor),packedPoints=Float32Array.from(points.flat());
  const faceWords=new Uint32Array(faces.length*4);faces.forEach((face,i)=>faceWords.set([...face.vertices,face.flags>>>0],i*4));
  meshes.set(actor, { points,packedPoints,faces,faceWords });
}

// Two Play frames: a new visibility cache, then a cached one.
const frames = [{ seconds: 20 }, { seconds: 20.02 }];
const passes = new Map(chosen.map(actor => [actor, []]));
for (const frame of frames) {
  // Play hands beginFrame game.movingLights() (one SetupDynamics scan per
  // frame); the JavaScript instance keeps its own scan, so both sources are
  // compared: same leaf lists, records and colours.
  const scanned = game.movingLights();
  lighting.beginFrame({ location: view.location, rotation: view.rotation, seconds: frame.seconds });
  lightingWasm.beginFrame({ location: view.location, rotation: view.rotation, seconds: frame.seconds, lights: scanned });
  const leafLists = view => [...view.frame.leafLights].map(([leaf, list]) => [leaf, list.map(record =>
    [record.actor.name, record.index, ...record.location.map(u32), ...['LightType', 'LightBrightness', 'LightRadius',
      'LightEffect', 'LightHue', 'LightSaturation', 'bSpecialLit'].map(name => record.values[name])])]);
  assert.ok(scanned.length > 0 && lighting.frame.leafLights.size > 0, 'moving lights reach BSP leaves');
  assert.deepEqual(leafLists(lightingWasm), leafLists(lighting), 'scanned moving lights give the scan\'s leaf lists');
  frame.viewport = { ...lighting.frame.viewport };
  for (const actor of chosen) {
    const { points,packedPoints,faces,faceWords } = meshes.get(actor);
    const pass=lighting.lightMesh(actor, points, faces),wasm=lightingWasm.lightMesh(actor,packedPoints,faces,faceWords);
    assert.deepEqual(new Uint32Array(wasm.colors.buffer,wasm.colors.byteOffset,wasm.colors.length),
      new Uint32Array(pass.colors.buffer,pass.colors.byteOffset,pass.colors.length),`${actor.name}: Wasm diffuse colours`);
    passes.get(actor).push(pass);
  }
}

// A mirror's child frame (OccludeFrame's reflected Coords: Origin and all three
// axes reflected across the mirror's plane, Frame.Mirror -1) lights the same
// actors again in the same frame, with the frame's own LeafLights. Two child
// frames: one that keeps every moving-light candidate (no ViewPlanes) and one
// whose ViewPlanes put them all outside, so its sprites' LeafLights are empty.
const reflect = (plane, point, vector) => {
  const [nx, ny, nz, w] = plane, d = (point ? nx * point[0] + ny * point[1] + nz * point[2] - w : nx * vector[0] + ny * vector[1] + nz * vector[2]) * 2;
  return (point ?? vector).map((c, i) => f(c - d * [nx, ny, nz][i]));
};
const mirrorPlane = (() => { const n = [0.6, 0.8, 0], length = Math.hypot(...n);
  const unit = n.map(c => c / length); return [...unit, unit[0] * view.location[0] + unit[1] * view.location[1] + 150]; })();
const { origin: mainOrigin, axes: mainAxes } = lighting.frame;
const childCoords = [...reflect(mirrorPlane, mainOrigin), ...mainAxes.flatMap(axis => reflect(mirrorPlane, null, axis))];
const rejectAll = new Uint32Array(new Float32Array([0, 0, 1, 1e9, 0, 0, 1, 1e9, 0, 0, 1, 1e9, 0, 0, 1, 1e9]).buffer);
const childFrames = [{ name: 'reflected', planes: null }, { name: 'reflected, no candidate in view', planes: Array.from(rejectAll) }];
const childPasses = new Map(chosen.map(actor => [actor, []]));
for (const child of childFrames) {
  const ctx = lighting.childFrame({ coords: childCoords, mirror: -1, planes: child.planes });
  const ctxWasm = lightingWasm.childFrame({ coords: childCoords, mirror: -1, planes: child.planes });
  child.leafLights = ctx.leafLights;
  for (const actor of chosen) {
    const { points, packedPoints, faces, faceWords } = meshes.get(actor);
    const pass = lighting.lightMesh(actor, points, faces, null, null, ctx);
    const wasm = lightingWasm.lightMesh(actor, packedPoints, faces, faceWords, null, ctxWasm);
    assert.deepEqual(new Uint32Array(wasm.colors.buffer, wasm.colors.byteOffset, wasm.colors.length),
      new Uint32Array(pass.colors.buffer, pass.colors.byteOffset, pass.colors.length), `${actor.name}: Wasm diffuse colours in ${child.name}`);
    childPasses.get(actor).push(pass);
  }
}
assert.ok(childFrames[0].leafLights.size > 0 && childFrames[1].leafLights.size === 0,
  'the ViewPlanes decide the child frame\'s LeafLights');
// The faces the child frame keeps: DrawLodMesh's `dot * Mirror < 0` against the
// original's own compare, on every face's real normal (child camera space).
const faceCases = [], faceOwners = [];
for (const actor of chosen) {
  const { faces } = meshes.get(actor), { camera } = childPasses.get(actor)[0].vertices;
  faces.forEach((face, i) => {
    const [a, b, c] = face.vertices, sums = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const unit = accumulateFaceNormal(camera[a], camera[b], camera[c], ...sums);
    faceCases.push({ face: unit.map(u32), point: camera[a].map(u32), mirror: u32(-1) });
    faceOwners.push([actor, i]);
  });
}
const keptByOriginal = JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-mesh-light-oracle.py', root], { input: JSON.stringify({ faceDots: faceCases }), encoding: 'utf8', maxBuffer: 1 << 30 })).faceDots;
const expectedLit = new Map(chosen.map(actor => [actor, new Set()]));
faceOwners.forEach(([actor, i], n) => {
  const face = meshes.get(actor).faces[i];
  if (!(face.flags & 1) && (face.flags & 0x100 || keptByOriginal[n].kept)) for (const v of face.vertices) expectedLit.get(actor).add(v);
});
let keptFacesChild = 0, litVerticesChild = 0;
for (const actor of chosen) {
  const { light } = childPasses.get(actor)[0].vertices;
  const lit = new Set(); light.forEach((value, i) => { if (value) lit.add(i); });
  assert.deepEqual([...lit].sort((x, y) => x - y), [...expectedLit.get(actor)].sort((x, y) => x - y),
    `${actor.name}: the child frame's lit vertices equal the original's face test with Mirror -1`);
  litVerticesChild += lit.size;
}
keptFacesChild = keptByOriginal.filter(entry => entry.kept).length;

const ambientOf = zone => [read(zone, 'AmbientBrightness') ?? 0, read(zone, 'AmbientHue') ?? 0, read(zone, 'AmbientSaturation') ?? 0];
const bytes = name => (value => (value ?? 0) & 255);
const cases = { setups: [] }, expectations = [];
for (const actor of chosen) {
  const region = read(actor, 'Region'), iLeaf = region['engine.actor.pointregion.ileaf'];
  const zone = region['engine.actor.pointregion.zone'], location = read(actor, 'Location').map(f);
  const leaf = model.leaves.at(iLeaf), run = [];
  if (leaf && leaf.permeating >= 0)
    for (let i = leaf.permeating; i < model.lights.length && model.lights[i]; i++) run.push(model.lights[i]);
  const records = lighting.frame.lights, byActor = new Map();
  const idOf = record => { if (!byActor.has(record.actor)) byActor.set(record.actor, byActor.size + 1); return byActor.get(record.actor); };
  const runRecords = run.map(ref => lighting.lightRecordOf(lighting.frame.byName.get(asset.pkg.exports[ref - 1].name)));
  const leafRecords = lighting.frame.leafLights.get(iLeaf) ?? [];
  const all = [...new Set([...runRecords, ...leafRecords])];
  assert.equal(new Set(all.map(record => record.index)).size, all.length, `${actor.name}: unique light indices`);
  const lights = all.map(record => {
    const v = record.values;
    return { id: idOf(record), index: record.index, location: record.location.map(u32),
      type: bytes()(v.LightType), effect: bytes()(v.LightEffect), brightness: bytes()(v.LightBrightness),
      hue: bytes()(v.LightHue), saturation: bytes()(v.LightSaturation), radius: bytes()(v.LightRadius),
      period: bytes()(v.LightPeriod), phase: bytes()(v.LightPhase), bStatic: Boolean(v.bStatic),
      bMovable: Boolean(v.bMovable), bSpecialLit: Boolean(v.bSpecialLit), bDeleteMe: Boolean(v.bDeleteMe) };
  });
  const byLocation = new Map(all.map(record => [record.location.map(u32).join(','), record]));
  assert.equal(byLocation.size, all.length, `${actor.name}: light locations are distinct for the LineCheck fixture`);
  const lineChecks = Object.fromEntries(all.map(record => [idOf(record), traceRay(model, location, record.location) === null]));
  const levelInfo = level.actors[0];
  const { axes, origin } = lighting.frame;
  cases.setups.push({
    levelInfo: { ambient: ambientOf(levelInfo), brightness: u32(f(read(levelInfo, 'Brightness') ?? 1)),
      timeSeconds: read(levelInfo, 'TimeSeconds') ?? 0 },
    zones: zone ? { zone: { ambient: ambientOf(zone) } } : {},
    lights, model: { leaves: [0], lights: [...runRecords.map(idOf), 0] },
    leafLights: leafRecords.map(idOf),
    coords: { origin: origin.map(u32), x: axes[0].map(u32), y: axes[1].map(u32), z: axes[2].map(u32) },
    actor: { index: 0x7000 + chosen.indexOf(actor), location: location.map(u32), zone: zone ? 'zone' : null, iLeaf: 0,
      zoneNumber: region['engine.actor.pointregion.zonenumber'] || 1, scaleGlow: u32(f(read(actor, 'ScaleGlow') ?? 1)),
      ambientGlow: (read(actor, 'AmbientGlow') ?? 0) & 255, bUnlit: Boolean(read(actor, 'bUnlit')),
      bSpecialLit: Boolean(read(actor, 'bSpecialLit')) },
    frames: [...frames.map((frame, k) => ({ frame, pass: passes.get(actor)[k], child: null })),
      ...childFrames.map((child, k) => ({ frame: frames.at(-1), pass: childPasses.get(actor)[k], child }))].map(({ frame, pass, child }) => {
      const lit = [];
      pass.vertices.light.forEach((value, i) => { if (value) lit.push(i); });
      expectations.push({ actor, pass, lit, ids: byActor, child });
      return { currentTime: frame.viewport.currentTime, lastUpdateTime: frame.viewport.lastUpdateTime,
        frameCount: frame.viewport.frameCount, lineChecks,
        ...(child ? { coords: { origin: childCoords.slice(0, 3).map(u32), x: childCoords.slice(3, 6).map(u32),
            y: childCoords.slice(6, 9).map(u32), z: childCoords.slice(9, 12).map(u32) }, mirror: u32(-1),
          leafLights: (child.leafLights.get(iLeaf) ?? []).map(idOf) } : {}),
        vertices: lit.map(i => ({ point: pass.vertices.camera[i].map(u32), normal: pass.vertices.planes[i].map(u32),
          flags: pass.flags })) };
    }),
  });
}
const original = JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-mesh-light-oracle.py', root], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 30 })).setups;

let vertices = 0, channelsOff = 0, maxUlps = 0, bytesOff = 0, lights = 0;
expectations.forEach((expected, n) => {
  const perActor = frames.length + childFrames.length;
  const native = original[Math.floor(n / perActor)][n % perActor], { pass, lit, ids, actor, child } = expected;
  const label = `${actor.name} ${child ? `child frame (${child.name})` : `frame ${n % perActor}`}`;
  assert.deepEqual(pass.setup.ambient.map(u32), native.ambient.slice(0, 3), `${label}: ambient`);
  assert.deepEqual(pass.setup.lights.map(info => ids.get(info.light.actor)), native.infos.map(info => Number(info.light)),
    `${label}: selected lights`);
  pass.setup.lights.forEach((info, i) => {
    assert.deepEqual(info.location.map(u32), native.infos[i].location, `${label}: camera-space light`);
    assert.deepEqual(info.color.map(u32), native.infos[i].color, `${label}: light colour`);
  });
  lit.forEach((vertex, i) => {
    const play = pass.vertices.light[vertex], light = native.vertices[i].slice(0, 3).map(float);
    play.forEach((value, c) => {
      const ulps = Math.abs(u32(value) - native.vertices[i][c]);
      if (ulps) { channelsOff++; maxUlps = Math.max(maxUlps, ulps); }
    });
    if (d3dDiffuse(play) !== d3dDiffuse(light)) bytesOff++;
    vertices++;
  });
  lights += pass.setup.lights.length;
});
assert.equal(bytesOff, 0, 'every Play vertex diffuse byte equals the original Light result');
// Cost of the Play pass (JavaScript, one thread): 30 more frames over the
// same actors, after the checked frames warmed the caches.
const started = performance.now();
for (let k = 0; k < 30; k++) {
  lighting.beginFrame({ location: view.location, rotation: view.rotation, seconds: 21 + k / 60 });
  for (const actor of chosen) { const { points, faces } = meshes.get(actor); lighting.lightMesh(actor, points, faces); }
}
const perFrame = (performance.now() - started) / 30;
console.log(JSON.stringify({ actors: chosen.map(actor => actor.name), passes: expectations.length, lights, vertices,
  childFrames: { frames: childFrames.map(child => child.name), leafLists: childFrames.map(child => child.leafLights.size),
    facesTested: faceCases.length, kept: keptFacesChild, litVertices: litVerticesChild },
  wasm:{passes:expectations.length,diffuseBytesOff:0},
  doublePath: { channelsOff, maxUlps, diffuseBytesOff: bytesOff },
  cost: { actors: chosen.length, vertices: [...meshes.values()].reduce((n, m) => n + m.points.length, 0),
    faces: [...meshes.values()].reduce((n, m) => n + m.faces.length, 0), msPerFrame: Number(perFrame.toFixed(2)) } }));
console.log('Play mesh lighting matches the original SetupForActor/Light on its live inputs.');
