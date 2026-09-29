/** Stage 4: LOD-mesh lighting against unchanged Render.dll/D3DDrv.dll code.
 * The oracle (scripts/native-mesh-light-oracle.py) runs the whole
 * FLightManager::SetupForActor, Light and FinishActor on Training's real mesh
 * actors, leaf light lists and light actors over several frames, plus the
 * reciprocal-root tables, DrawLodMesh's normal blocks and D3D's diffuse
 * packing. --reference-only records the original results before the
 * JavaScript translation is exercised. Contract: docs/mesh-lighting.md. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { pointRegion } from '../src/runtime/zone.mjs';
import { traceRay } from '../src/runtime/ray.mjs';
import { worldLightRadius } from '../src/runtime/dynamic-lighting.mjs';
import { gameDirectory } from './game-directory.mjs';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
await loadTraceKernel(); // Rust BSP traces; TRACE_KERNEL=js runs the JavaScript bodies

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get('00_Training'), map = decodeMap(asset.bytes);
const defaults = new ClassDefaults(assets), model = map.model, f = Math.fround, view = new DataView(new ArrayBuffer(4));
const u32 = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
const float = value => { view.setUint32(0, value >>> 0, true); return view.getFloat32(0, true); };
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const original = cases => JSON.parse(execFileSync(python, ['scripts/native-mesh-light-oracle.py', root],
  { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 30 }));

let seed = 0x5eed;
const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;

// Resolved actor values (class defaults plus the map's serialized overrides).
const values = new Map();
for (const actor of map.actors) values.set(actor.index, await defaults.forActor(asset, actor));
const levelInfo = map.actors.find(actor => actor.className === 'LevelInfo');
const levelValues = values.get(levelInfo.index);
const zoneRefs = model.zones.map(zone => zone.actor);
const ambientOf = v => [v.AmbientBrightness ?? 0, v.AmbientHue ?? 0, v.AmbientSaturation ?? 0];

// Light identities: the export ref is the fixture id; the stagger index is a
// deterministic stand-in (both sides read the same value).
const lightRecord = ref => {
  const v = values.get(ref);
  return { id: ref, index: 40000 + ref, location: v.Location.map(f), values: v };
};
const LIGHT_BYTES = ['LightType', 'LightEffect', 'LightBrightness', 'LightHue', 'LightSaturation', 'LightRadius',
  'LightPeriod', 'LightPhase'];
const oracleLight = light => {
  const v = light.values;
  // Defaults are delta-serialized against zero: a missing byte is 0, which is
  // also what the JavaScript side reads.
  const [type, effect, brightness, hue, saturation, radius, period, phase] = LIGHT_BYTES.map(name => (v[name] ?? 0) & 255);
  return { id: light.id, index: light.index, location: light.location.map(u32), type, effect, brightness, hue,
    saturation, radius, period, phase, bStatic: Boolean(v.bStatic),
    bMovable: Boolean(v.bMovable), bSpecialLit: Boolean(v.bSpecialLit) };
};
const locationKey = light => light.location.map(u32).join(',');

// Moving lights: Training's four SecurityCamera lights plus an AugLight-like
// Beam placed next to each sampled actor.
const cameraLights = map.actors.filter(actor => actor.className === 'SecurityCamera').map(actor => lightRecord(actor.index));

// Every visible mesh actor in Training, every fifth one sampled.
const meshActors = map.actors.filter(actor => {
  const v = values.get(actor.index);
  return v && v.DrawType === 2 && !v.bHidden && Array.isArray(v.Location);
}).filter((_, i) => i % 5 === 0);

const cases = { tables: true, setups: [], faceNormals: [], vertexNormals: [], diffuse: [] };
const scenes = [];
for (const [actorNumber, source] of meshActors.entries()) {
  const v = values.get(source.index), location = v.Location.map(f);
  const region = pointRegion(model, location, levelInfo.index, zoneRefs);
  if (region.leaf === -1) continue;
  const leaf = model.leaves[region.leaf];
  const lights = new Map();
  if (leaf.permeating >= 0)
    for (let i = leaf.permeating; i < model.lights.length && model.lights[i]; i++)
      lights.set(model.lights[i], lightRecord(model.lights[i]));
  const leafLights = cameraLights.filter(light =>
    Math.hypot(...light.location.map((c, i) => c - location[i])) < worldLightRadius(light.values));
  const beamId = 900000 + actorNumber;
  const beam = { id: beamId, index: 50000 + actorNumber,
    location: location.map((c, i) => f(c + [40, -30, 20][i] * (1 + random()))),
    values: { LightType: 1, LightEffect: 13, LightBrightness: 192, LightHue: 32, LightSaturation: 140,
      LightRadius: 4 + Math.floor(random() * 5), LightPeriod: 0, LightPhase: 0, bMovable: true, bStatic: false } };
  leafLights.push(beam);
  for (const light of leafLights) lights.set(light.id, light);
  // The model's light list, restricted to this leaf's run (other entries are
  // never read); ids not in this leaf are dropped.
  const run = [];
  if (leaf.permeating >= 0)
    for (let i = leaf.permeating; i < model.lights.length && model.lights[i]; i++) run.push(model.lights[i]);
  const leaves = [0];
  const zoneRef = region.zoneNumber ? zoneRefs[region.zoneNumber] : 0;
  const zoneValues = zoneRef ? values.get(zoneRef) : null;
  // Camera 180-260 units away, yawed towards the actor.
  const yaw = random() * Math.PI * 2, pitch = (random() - .5) * .6, distance = 180 + random() * 80;
  const forward = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
  const origin = location.map((c, i) => f(c - forward[i] * distance));
  const right = [-Math.sin(yaw), Math.cos(yaw), 0];
  const up = [forward[1] * right[2] - forward[2] * right[1], forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0]];
  const axes = { x: right.map(f), y: up.map(f), z: forward.map(f) };
  const toCamera = point => {
    const d = point.map((c, i) => c - origin[i]);
    return [axes.x, axes.y, axes.z].map(axis => f(d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]));
  };
  // Vertices within 40 units of the actor, random unit normals, W = N·P.
  const vertices = [];
  for (let i = 0; i < 24; i++) {
    const point = toCamera(location.map(c => f(c + (random() - .5) * 80)));
    let n = [random() - .5, random() - .5, random() - .5];
    const length = Math.hypot(...n);
    n = n.map(c => f(c / length));
    vertices.push({ point, normal: [...n, f(n[0] * point[0] + n[1] * point[1] + n[2] * point[2])] });
  }
  // Visibility per light location (the oracle's LineCheck sees only the end
  // point); every third location flips in frames 1-2 to exercise the fades.
  const byLocation = new Map();
  for (const light of lights.values()) if (!byLocation.has(locationKey(light)))
    byLocation.set(locationKey(light), traceRay(model, location, light.location) === null);
  const perLight = choose => Object.fromEntries([...lights.values()].map(light => {
    const key = locationKey(light), order = [...byLocation.keys()].indexOf(key);
    return [light.id, choose(byLocation.get(key), order)];
  }));
  const visibility = perLight(visible => visible), flipped = perLight((visible, i) => (i % 3 === 0 ? !visible : visible));
  const frames = [
    { currentTime: 10, lastUpdateTime: 9.98, frameCount: 32, lineChecks: visibility },
    { currentTime: 10.02, lastUpdateTime: 10, frameCount: 48, lineChecks: flipped },
    { currentTime: 10.05, lastUpdateTime: 10.02, frameCount: 49, lineChecks: flipped },
    { currentTime: 10.3, lastUpdateTime: 10.05, frameCount: 64, lineChecks: visibility },
  ].map(frame => ({ ...frame, vertices }));
  const scene = {
    levelInfo: { ambient: ambientOf(levelValues), brightness: u32(f(levelValues.Brightness ?? 1)),
      timeSeconds: 10 },
    zones: zoneValues ? { zone: { ambient: ambientOf(zoneValues) } } : {},
    lights: [...lights.values()].map(oracleLight),
    model: { leaves, lights: [...run, 0] },
    leafLights: leafLights.map(light => light.id),
    coords: { origin: origin.map(u32), x: axes.x.map(u32), y: axes.y.map(u32), z: axes.z.map(u32) },
    actor: { index: 30000 + source.index, location: location.map(u32), zone: zoneValues ? 'zone' : null, iLeaf: 0,
      zoneNumber: region.zoneNumber || 1, scaleGlow: u32(f(v.ScaleGlow ?? 1)), ambientGlow: v.AmbientGlow ?? 0,
      bUnlit: Boolean(v.bUnlit), bSpecialLit: Boolean(v.bSpecialLit) },
    frames: frames.map(frame => ({ ...frame, vertices: frame.vertices.map(vertex =>
      ({ point: vertex.point.map(u32), normal: vertex.normal.map(u32) })) })),
  };
  cases.setups.push(scene);
  scenes.push({ name: source.name, scene, lights, frames, run, zoneValues, v, location, origin, axes, source });
}

// DrawLodMesh normal blocks on random triangles and summed normals.
for (let i = 0; i < 400; i++) {
  const point = () => [0, 1, 2].map(() => f((random() - .5) * 400 + (i % 3) * 300));
  cases.faceNormals.push({ vertices: [0, 1, 2].map(() => ({ point: point().map(u32),
    normal: [0, 1, 2].map(() => u32(f((random() - .5) * 3))) })) });
  cases.vertexNormals.push({ point: point().map(u32), normal: [0, 1, 2].map(() => u32(f((random() - .5) * 6))) });
}
for (let i = 0; i <= 2048; i++) cases.diffuse.push([i / 2048, f(random()), f(i / 2048 - 1 / 510)].map(c => u32(f(c))));

// FDynamicLight::Filter's leaf lists for the moving lights (the dynamic-light
// oracle's Filter driver, now given the real FBspNode.iLeaf values).
const movingLights = [...cameraLights, ...scenes.map(entry => [...entry.lights.values()].find(light => light.id >= 900000))];
const filterCases = { model: { nodes: model.nodes.map(n => [...n.plane, n.surface, n.back, n.front, n.coplanar, ...n.leaves]),
  surfaces: model.surfaces.map(s => [s.flags >>> 0, s.lightMap]), lightMaps: model.lightMaps.length },
  filters: movingLights.map(light => ({ location: light.location, radius: light.values.LightRadius & 255,
    brightness: light.values.LightBrightness & 255, type: 1, effect: light.values.LightEffect & 255,
    specialLit: Boolean(light.values.bSpecialLit) })) };
const filterReference = JSON.parse(execFileSync(python, ['scripts/native-dynamic-light-oracle.py', root],
  { input: JSON.stringify(filterCases), encoding: 'utf8', maxBuffer: 1 << 30 })).filters;

const reference = original(cases);
if (process.argv.includes('--reference-only')) {
  await writeFile('.cache/stage4-mesh-light-original.json', JSON.stringify({ cases, reference }));
  const frames = reference.setups.flat();
  console.log(`Original reference recorded: ${scenes.length} Training mesh actors, ${frames.length} SetupForActor calls, ` +
    `${frames.reduce((n, frame) => n + frame.infos.length, 0)} light infos, ` +
    `${frames.reduce((n, frame) => n + frame.vertices.length, 0)} lit vertices.`);
  process.exit(0);
}

const { rsqrtTables, accumulateFaceNormal, vertexNormalPlane, d3dDiffuse, createMeshLightManager, setupForActor,
  lightVertex, lightVertexX87 } = await import('../src/runtime/mesh-lighting.mjs');
const { squareRootTable, movingLightLeaves } = await import('../src/runtime/dynamic-lighting.mjs');
let leafHits = 0;
movingLights.forEach((light, i) => {
  const leaves = movingLightLeaves(model, light.location, worldLightRadius(light.values));
  assert.deepEqual([...leaves].sort((a, b) => a - b), [...filterReference[i].leaves].sort((a, b) => a - b),
    `moving light ${light.id}: LeafLights leaves`);
  leafHits += leaves.length;
});
const report = {};
assert.deepEqual([...squareRootTable()], reference.sqrtTable, 'light-manager square-root table');
const tables = rsqrtTables();
assert.deepEqual(tables.mantissa, reference.power.mantissa, 'reciprocal-root mantissa table');
assert.deepEqual(tables.exponent, reference.power.exponent, 'reciprocal-root exponent table');
// CRT pow is serviced by the host in the oracle. Check that every entry's
// double lies far from a float rounding midpoint, so any pow within a few
// double ulps of the true value stores the same float.
let nearMidpoint = 0;
const checkPow = (x, stored) => {
  const exact = Math.pow(x, -.5);
  if (!Number.isFinite(exact) || exact === 0) return;
  const next = float(u32(stored) + (exact > stored ? 1 : -1)), midpoint = (stored + next) / 2;
  if (Math.abs(exact - midpoint) <= 8 * Math.abs(exact) * Number.EPSILON) nearMidpoint++;
};
for (let i = 0; i < 1024; i++) checkPow(float(0x3f800000 + (i << 13)), float(tables.mantissa[i]));
for (let i = 0; i < 512; i++) checkPow(Math.abs(float(i << 23)), float(tables.exponent[i]));
assert.equal(nearMidpoint, 0, 'no table entry depends on the CRT pow last-ulp behaviour');
report.leafLights = { lights: movingLights.length, leaves: leafHits };
report.tables = { sqrt: 2048, mantissa: 1024, exponent: 512, nearMidpoint };

let faceBits = 0;
for (const [i, c] of cases.faceNormals.entries()) {
  const points = c.vertices.map(vertex => vertex.point.map(float)), normals = c.vertices.map(vertex => vertex.normal.map(float));
  const face = accumulateFaceNormal(...points, ...normals);
  assert.deepEqual(face.map(u32), reference.faceNormals[i].face, `face normal ${i}`);
  assert.deepEqual(normals.map(normal => normal.map(u32)), reference.faceNormals[i].normals, `accumulated normals ${i}`);
  faceBits += 12;
}
for (const [i, c] of cases.vertexNormals.entries())
  assert.deepEqual(vertexNormalPlane(c.point.map(float), c.normal.map(float)).map(u32), reference.vertexNormals[i],
    `vertex normal plane ${i}`);
report.normals = { faces: cases.faceNormals.length, vertices: cases.vertexNormals.length, floats: faceBits };
assert.deepEqual(reference.diffuse.scale, [0x3f800000, 0x3f800000, 0x3f800000], '8888 stage MaxColor scale is 1');
cases.diffuse.forEach((light, i) =>
  assert.equal(d3dDiffuse(light.map(float)), reference.diffuse.diffuse[i], `D3D diffuse ${i}`));
report.diffuse = cases.diffuse.length;

let setupCalls = 0, infos = 0, vertexCount = 0, traces = 0, floatMismatch = 0, maxUlps = 0, byteMismatch = 0;
let fastVertices = 0;
for (const [s, entry] of scenes.entries()) {
  const manager = createMeshLightManager(), expectedFrames = reference.setups[s];
  const lightObjects = new Map([...entry.lights.values()].map(light =>
    [light.id, { actor: light.id, index: light.index, location: light.location, values: light.values }]));
  const camera = point => {
    const d = point.map((c, i) => c - entry.origin[i]);
    return [entry.axes.x, entry.axes.y, entry.axes.z].map(axis => f(d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]));
  };
  for (const [frameIndex, frame] of entry.frames.entries()) {
    const expected = expectedFrames[frameIndex], label = `${entry.name} frame ${frameIndex}`;
    const setup = setupForActor(manager, {
      self: 'sink', index: entry.scene.actor.index, location: entry.location, iLeaf: 0,
      zone: entry.zoneValues ? { ambient: ambientOf(entry.zoneValues) } : null,
      AmbientGlow: entry.v.AmbientGlow ?? 0, ScaleGlow: f(entry.v.ScaleGlow ?? 1), bUnlit: Boolean(entry.v.bUnlit),
      bSpecialLit: Boolean(entry.v.bSpecialLit),
    }, {
      levelInfo: { ambient: ambientOf(levelValues), brightness: f(levelValues.Brightness ?? 1), timeSeconds: 10 },
      model: { leaves: [{ permeating: 0 }], lights: [...entry.run, 0] },
      lightOf: ref => lightObjects.get(ref),
      leafLights: entry.scene.leafLights.map(id => lightObjects.get(id)),
      lineCheck: light => frame.lineChecks[light.actor],
      viewport: frame, rendMap: 5, noLighting: false, alive: () => true,
      worldToCamera: camera,
    });
    assert.deepEqual(setup.ambient.map(u32), expected.ambient.slice(0, 3), `${label}: ambient`);
    assert.deepEqual(setup.traced.map(locationKey), expected.traced.map(id => locationKey(entry.lights.get(id))),
      `${label}: traced light locations`);
    assert.deepEqual(setup.lights.map(info => info.light.actor), expected.infos.map(info => info.light), `${label}: light order`);
    setup.lights.forEach((info, i) => {
      const native = expected.infos[i];
      assert.equal(native.class, 2, `${label}: actor lights are class 2`);
      assert.deepEqual(info.location.map(u32), native.location, `${label}: camera-space light ${info.light.actor}`);
      assert.equal(u32(info.rradius), native.rradius, `${label}: 1/R ${info.light.actor}`);
      assert.deepEqual(info.color.map(u32), native.color, `${label}: colour ${info.light.actor}`);
    });
    const cache = manager.caches.get(entry.scene.actor.index)?.map(item => [item.light.actor, item.fade, item.index]) ?? null;
    assert.deepEqual(cache, expected.cache, `${label}: visibility cache`);
    frame.vertices.forEach((vertex, i) => {
      const exact = lightVertexX87(setup, vertex.point, vertex.normal, 0x4000);
      assert.deepEqual(exact.map(u32), expected.vertices[i].slice(0, 3), `${label}: vertex ${i} (x87 model)`);
    });
    // The double-precision Play path against the exact translation, on the
    // oracle's vertices and 400 more around the actor.
    const extra = [];
    for (let i = 0; i < 400; i++) {
      const point = camera(entry.location.map(c => f(c + (random() - .5) * 120)));
      let n = [random() - .5, random() - .5, random() - .5];
      const length = Math.hypot(...n);
      n = n.map(c => f(c / length));
      extra.push({ point, normal: [...n, f(n[0] * point[0] + n[1] * point[1] + n[2] * point[2])] });
    }
    for (const vertex of [...frame.vertices, ...extra]) {
      const exact = lightVertexX87(setup, vertex.point, vertex.normal, 0x4000);
      const fast = lightVertex(setup, vertex.point, vertex.normal, 0x4000);
      fast.forEach((value, c) => {
        const ulps = Math.abs(u32(value) - u32(exact[c]));
        if (ulps) { floatMismatch++; maxUlps = Math.max(maxUlps, ulps); }
      });
      if (d3dDiffuse(fast) !== d3dDiffuse(exact)) byteMismatch++;
      fastVertices++;
    }
    setupCalls++; infos += setup.lights.length; vertexCount += frame.vertices.length; traces += setup.traced.length;
  }
}
report.setup = { actors: scenes.length, calls: setupCalls, lightInfos: infos, traces, vertices: vertexCount };
report.doublePath = { vertices: fastVertices, channelsOff: floatMismatch, maxUlps, diffuseBytesOff: byteMismatch };
console.log(JSON.stringify(report));
console.log('Mesh lighting matches the original Render.dll/D3DDrv.dll bodies on these cases.');
