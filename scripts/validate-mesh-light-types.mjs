/** Mesh lighting's LightType functions (docs/mesh-lighting.md "LightType
 * functions") against the unchanged Render.dll: FLightManager::SetupForActor
 * (scripts/native-mesh-light-oracle.py) runs ComputeFromActor's
 * GlobalLighting for each light it adds, so Pulse, SubtlePulse, Blink,
 * Flicker, Strobe and BackdropLight change the light's colour per frame.
 *
 * Scenes from maps whose lights use those types (the census of
 * census-moving-lights.mjs: Wan Chai Underworld's Pulse, Flicker and Strobe
 * lights, the MJ12 lab's SubtlePulse, the canal's BackdropLight, Training's
 * Flicker): mesh actors whose leaf lists such a light, each over frames
 * with advancing, repeated and jumping Level.TimeSeconds and a fresh noise
 * table A. Each scene is a fresh emulator whose Strobe state starts at 0
 * and lives across its frames, as the original's globals do; the
 * JavaScript manager's state is reset alike. Compared per
 * frame: the added lights, their colours (and so the type functions,
 * Flicker's key and the shared flag) and the Strobe state after the call.
 * The bodies run at 0x007f (`ORACLE_CW` overrides).
 *
 *   node scripts/validate-mesh-light-types.mjs */
import { execFileSync } from 'node:child_process';
import { auditAssert, auditControlWord } from './precision-audit.mjs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { pointRegion } from '../src/runtime/zone.mjs';
import { traceRay } from '../src/runtime/ray.mjs';
import { worldLightRadius } from '../src/runtime/dynamic-lighting.mjs';
import { createMeshLightManager, setupForActor } from '../src/runtime/mesh-lighting.mjs';
import { gameDirectory } from './game-directory.mjs';
import { rotationSineTable } from '../src/runtime/coords.mjs';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
import { modelFromObjects } from '../src/unreal/bsp-model.mjs';
await loadTraceKernel();

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), defaults = new ClassDefaults(assets), f = Math.fround;
const view = new DataView(new ArrayBuffer(4));
const u32 = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const assert = auditAssert(), controlWord = auditControlWord(), cwArgs = controlWord ? [controlWord] : [];
let seed = 0x71e5;
const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
const MAPS = ['06_HongKong_WanChai_Underworld', '06_HongKong_MJ12lab', '06_HongKong_WanChai_Canal', '00_Training', '02_NYC_Hotel',
  '06_HongKong_Helibase'];
const PER_MAP = 10;
const LIGHT_BYTES = ['LightType', 'LightEffect', 'LightBrightness', 'LightHue', 'LightSaturation', 'LightRadius', 'LightPeriod', 'LightPhase'];

// Frames: an advancing clock, a repeat, a jump and an advancing tail; each
// with its own noise table A.
const sines = [...rotationSineTable()].map(u32);
const clock = [3.25, 3.25 + 1 / 60, 3.25 + 2 / 60, 3.25 + 2 / 60, 47.5, 47.5 + 1 / 35, 47.5 + 3 / 35, 1803.125].map(f);
const scenes = [], cases = { setups: [] };
for (const mapName of MAPS) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const values = new Map();
  for (const actor of map.actors) { try { values.set(actor.index, await defaults.forActor(asset, actor)); } catch { /* not an actor */ } }
  const levelInfo = map.actors.find(actor => actor.className === 'LevelInfo' || actor.className === 'DeusExLevelInfo');
  const levelValues = values.get(levelInfo.index), zoneRefs = model.zones.map(zone => zone.actor);
  const ambientOf = v => [v.AmbientBrightness ?? 0, v.AmbientHue ?? 0, v.AmbientSaturation ?? 0];
  const runOf = leaf => { const run = []; if (leaf && leaf.permeating >= 0) for (let i = leaf.permeating; i < model.lights.length && model.lights[i]; i++) run.push(model.lights[i]); return run; };
  const nonSteady = ref => { const t = (values.get(ref)?.LightType ?? 0) & 255; return t !== 1 && t !== 0; };
  let taken = 0;
  for (const source of map.actors) {
    if (taken >= PER_MAP) break;
    const v = values.get(source.index);
    if (!v || v.DrawType !== 2 || v.bHidden || !Array.isArray(v.Location)) continue;
    const location = v.Location.map(f), region = pointRegion(model, location, levelInfo.index, zoneRefs);
    if (region.leaf === -1) continue;
    const run = runOf(model.leaves.at(region.leaf));
    const near = run.filter(ref => nonSteady(ref) && Math.hypot(...values.get(ref).Location.map((c, i) => c - location[i])) < worldLightRadius(values.get(ref)));
    if (!near.length) continue;
    taken++;
    const lights = run.map(ref => {
      const lv = values.get(ref);
      const [type, effect, brightness, hue, saturation, radius, period, phase] = LIGHT_BYTES.map(name => (lv[name] ?? 0) & 255);
      return { id: ref, index: 40000 + ref, location: lv.Location.map(f), values: lv, flickerKey: ref & 0xff,
        oracle: { id: ref, index: 40000 + ref, location: lv.Location.map(f).map(u32), type, effect, brightness, hue, saturation, radius,
          period, phase, bStatic: Boolean(lv.bStatic), bMovable: Boolean(lv.bMovable), bSpecialLit: Boolean(lv.bSpecialLit), flickerKey: ref & 0xff } };
    });
    const zoneRef = region.zoneNumber ? zoneRefs[region.zoneNumber] : 0, zoneValues = zoneRef ? values.get(zoneRef) : null;
    const yaw = random() * Math.PI * 2, distance = 220;
    const forward = [Math.cos(yaw), Math.sin(yaw), 0], origin = location.map((c, i) => f(c - forward[i] * distance));
    const axes = { x: [-Math.sin(yaw), Math.cos(yaw), 0].map(f), y: [0, 0, -1].map(f), z: forward.map(f) };
    const lineChecks = Object.fromEntries(lights.map(light => [light.id, traceRay(model, location, light.location) === null]));
    const frames = clock.map((time, k) => ({ currentTime: 10 + k * 0.02, lastUpdateTime: 10 + (k - 1) * 0.02, frameCount: 32 + k,
      lineChecks, timeSeconds: time, A: Array.from({ length: 256 }, () => f(Math.floor(random() * 1000) / 999)) }));
    const scene = {
      levelInfo: { ambient: ambientOf(levelValues), brightness: u32(f(levelValues.Brightness ?? 1)), timeSeconds: 0 },
      zones: zoneValues ? { zone: { ambient: ambientOf(zoneValues) } } : {},
      lights: lights.map(light => light.oracle), model: { leaves: [0], lights: [...run, 0] }, leafLights: [],
      coords: { origin: origin.map(u32), x: axes.x.map(u32), y: axes.y.map(u32), z: axes.z.map(u32) },
      actor: { index: 30000 + source.index, location: location.map(u32), zone: zoneValues ? 'zone' : null, iLeaf: 0,
        zoneNumber: region.zoneNumber || 1, scaleGlow: u32(f(v.ScaleGlow ?? 1)), ambientGlow: v.AmbientGlow ?? 0,
        bUnlit: Boolean(v.bUnlit), bSpecialLit: Boolean(v.bSpecialLit) },
      frames: frames.map((frame, k) => ({ currentTime: frame.currentTime, lastUpdateTime: frame.lastUpdateTime, frameCount: frame.frameCount,
        lineChecks: frame.lineChecks, timeSeconds: u32(frame.timeSeconds), noiseA: frame.A.map(u32), vertices: [],
        ...(k === 0 ? { strobe: [0, 0] } : {}) })),
      sines,
    };
    cases.setups.push(scene);
    scenes.push({ map: mapName, name: source.name, scene, lights, frames, run, zoneValues, levelValues, v, location, origin, axes,
      types: [...new Set(near.map(ref => values.get(ref).LightType & 255))] });
  }
}
const reference = JSON.parse(execFileSync(python, ['scripts/native-mesh-light-oracle.py', root, ...cwArgs],
  { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 30 })).setups;

// The oracle's order: scene by scene, frame by frame; each scene a fresh
// manager and Strobe state, as each oracle scene is a fresh emulator.
const strobe = { time: 0, flag: 0 };
const stats = { scenes: scenes.length, frames: 0, infos: 0, byType: {}, strobeFlips: 0 };
scenes.forEach((entry, s) => {
  strobe.time = 0; strobe.flag = 0;
  const manager = createMeshLightManager({ strobe });
  const objects = new Map(entry.lights.map(light => [light.id, { actor: light.id, index: light.index, location: light.location,
    values: light.values, flickerKey: light.flickerKey }]));
  const camera = point => {
    const d = point.map((c, i) => f(f(c) - f(entry.origin[i])));
    return [entry.axes.x, entry.axes.y, entry.axes.z].map(axis => f(f(f(d[0] * axis[0]) + f(d[1] * axis[1])) + f(d[2] * axis[2])));
  };
  const ambientOf = v => [v.AmbientBrightness ?? 0, v.AmbientHue ?? 0, v.AmbientSaturation ?? 0];
  entry.frames.forEach((frame, k) => {
    const expected = reference[s][k], label = `${entry.map} ${entry.name} frame ${k}`, before = strobe.flag;
    const setup = setupForActor(manager, {
      self: 'sink', index: entry.scene.actor.index, location: entry.location, iLeaf: 0,
      zone: entry.zoneValues ? { ambient: ambientOf(entry.zoneValues) } : null,
      AmbientGlow: entry.v.AmbientGlow ?? 0, ScaleGlow: f(entry.v.ScaleGlow ?? 1), bUnlit: Boolean(entry.v.bUnlit), bSpecialLit: Boolean(entry.v.bSpecialLit),
    }, {
      levelInfo: { ambient: ambientOf(entry.levelValues), brightness: f(entry.levelValues.Brightness ?? 1), timeSeconds: frame.timeSeconds },
      noise: { A: Float32Array.from(frame.A) },
      model: modelFromObjects({ leaves: [{ permeating: 0 }], lights: [...entry.run, 0] }),
      lightOf: ref => objects.get(ref), leafLights: [],
      lineCheck: light => frame.lineChecks[light.actor], viewport: frame, rendMap: 5, noLighting: false, alive: () => true,
      worldToCamera: camera,
    });
    stats.frames++;
    assert.deepEqual(setup.lights.map(info => info.light.actor), expected.infos.map(info => info.light), `${label}: added lights`);
    setup.lights.forEach((info, i) => {
      const type = info.light.values.LightType & 255;
      (stats.byType[type] ??= 0); stats.byType[type]++; stats.infos++;
      assert.deepEqual(info.color.map(u32), expected.infos[i].color, `${label}: colour of light ${info.light.actor} (type ${type})`);
    });
    assert.deepEqual([u32(strobe.time), strobe.flag], expected.strobe, `${label}: Strobe state`);
    if (strobe.flag !== before) stats.strobeFlips++;
  });
});
assert.ok([2, 4, 5, 6, 7].every(type => stats.byType[type] > 0), `every reached type is covered: ${JSON.stringify(stats.byType)}`);
assert.ok(stats.strobeFlips > 2, 'the shared Strobe flag flips');
console.log(JSON.stringify(stats));
if (assert.enabled) assert.report('validate-mesh-light-types');
else console.log(`validate-mesh-light-types: PASS (${stats.scenes} actors, ${stats.frames} frames, ${stats.infos} light infos)`);
