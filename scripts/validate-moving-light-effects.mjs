/** The time-varying moving lights (docs/dynamic-lighting.md "Time-varying
 * moving lights") against the original Render.dll, on Play's own inputs.
 *
 * UNATCO Island's world and game run headless; its three BarrelFires
 * (Steady FireWaver) come from game.movingLights() and lights built from the
 * other reached sources' class defaults and map properties stand beside
 * them: a lit Flare (TorchWaver), a BarrelAmbrosia (WateryShimmer), a
 * turning AlarmLight (Spotlight) and 99_Endgame4's Strobe AlarmLight, and
 * 14_Vandenberg_Sub's Flicker LaserTrigger. Over frames with advancing,
 * repeated and jumping Level.TimeSeconds, a noise advanced from one seeded
 * appFrand stream (sim-session.mjs hands Play the game's) and the
 * AlarmLights' yaw turning, the world composes its moving light maps
 * (moving-lights.mjs, full mode). native-dynamic-light-oracle.py
 * `movingFrames` runs, for every light of every frame, GlobalLighting with
 * the shared strobe state, ComputeFromActor's colour table and, per reached
 * surface, its constants, incidence and rectangle, the 0x7f illumination,
 * the effect row's spatial body and the merge from index 0. Each reached
 * light map must equal its static copy plus the original's colour entries,
 * added as Play adds them; rectangles, constants and spatial bytes must match
 * too. The bodies run at the render pass's 0x007f (`ORACLE_CW=0x037f`
 * measures the other word).
 *
 *   node scripts/validate-moving-light-effects.mjs [--frames N]
 */
import { auditAssert } from './precision-audit.mjs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { createWorld } from '../src/viewer/world.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createLightNoise, lightNoiseSnapshot } from '../src/runtime/static-lighting.mjs';
import { createNativeRng } from '../src/runtime/rng.mjs';
import { frameData, runChain, checkFrame } from './moving-light-chain.mjs';
import { gameDirectory } from './game-directory.mjs';
import { createPlayerInputFixture } from './player-input-fixture.mjs';

const assert = auditAssert();
const argv = process.argv.slice(2), flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), defaults = new ClassDefaults(assets);
const f = Math.fround;

// The reached sources' light fields: class defaults, or a map actor's.
const LIGHT_FIELDS = ['LightType', 'LightEffect', 'LightBrightness', 'LightRadius', 'LightHue', 'LightSaturation', 'LightPeriod',
  'LightPhase', 'LightCone', 'bStatic', 'bNoDelete', 'bDynamicLight', 'bSpecialLit'];
const fieldsOf = values => Object.fromEntries(LIGHT_FIELDS.map(k => [k, values[k] ?? (k.startsWith('b') ? false : 0)]));
async function classLight(pkg, name, extra = {}) {
  const asset = await assets.get(pkg), index = asset.pkg.exports.findIndex(e => e.className === 'Class' && e.name === name);
  return { ...fieldsOf(await defaults.get(asset, index + 1)), ...extra };
}
async function mapLight(mapName, actorName) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), actor = map.actors.find(a => a.name === actorName);
  return fieldsOf(await defaults.forActor(asset, actor));
}

const asset = await assets.get('01_NYC_UNATCOIsland'), map = decodeMap(asset.bytes);
const world = await createWorld(map, asset, assets, undefined, { movingLightsMode: 'full' });
const game = await createGame(map, asset, assets, { randomSeed: 1, onLightingChanged: changes => world.updateLighting(changes) });
const input = createPlayerInputFixture(game, { tickSeconds: 1 / 60 });
input.tick(30);
const authored = game.movingLights();
const fires = authored.filter(light => /^BarrelFire\d+$/.test(light.name));
assert.equal(fires.length, 3, 'Island places three BarrelFires');
assert.ok(fires.every(light => light.values.LightType === 1 && light.values.LightEffect === 2), 'the BarrelFires are Steady FireWaver');
const levelBrightness = authored[0].levelBrightness;
const near = (k, offset) => fires[k].location.map((v, i) => f(v + offset[i]));
const synthetic = [
  { name: 'Flare0', values: await classLight('DeusEx', 'Flare', { LightType: 1 }), location: near(0, [60, -40, 20]) },
  { name: 'BarrelAmbrosia0', values: await classLight('DeusEx', 'BarrelAmbrosia'), location: near(1, [-70, 30, 0]) },
  { name: 'AlarmLight0', values: await classLight('DeusEx', 'AlarmLight', { LightRadius: 12 }), location: near(2, [0, 80, 90]), turn: true },
  { name: 'AlarmLight1', values: { ...await mapLight('99_Endgame4', 'AlarmLight0'), LightRadius: 10 }, location: near(0, [-90, 0, 100]), turn: true },
  { name: 'LaserTrigger0', values: await mapLight('14_Vandenberg_Sub', 'LaserTrigger0'), location: near(1, [40, 60, 30]) },
];
assert.equal(synthetic[3].values.LightType, 5, 'Endgame4 AlarmLight0 is Strobe');
assert.equal(synthetic[4].values.LightType, 4, 'Vandenberg Sub LaserTrigger0 is Flicker');
synthetic.forEach((light, k) => Object.assign(light, { levelBrightness, flickerKey: 0x40 + 37 * k }));

// Frames: advancing, a repeated time (no strobe flip, noise step kept), a
// jump (the noise's reset branch), then advancing again.
const frameCount = Number(flag('frames', 8));
const times = [2.5, 2.5 + 1 / 60, 2.5 + 2 / 60, 2.5 + 2 / 60, 9.25, 9.25 + 1 / 35, 9.25 + 2 / 35, 30.125].slice(0, frameCount).map(f);
const noise = createLightNoise(createNativeRng(0x5ca1ab1e).frand);
const movers = game.collision.movers.map(mover => ({ name: mover.name, offset: mover.collider.offset }));
const frames = [];
for (const [frameIndex, timeSeconds] of times.entries()) {
  noise.update(timeSeconds);
  const snapshot = lightNoiseSnapshot(noise);
  const lights = [...authored, ...synthetic.map(light => ({ ...light,
    values: light.turn ? { ...light.values, Rotation: [-6000, (frameIndex * 1638) & 0xffff, 0] } : light.values }))];
  world.beginLightFrame({ timeSeconds, noise: snapshot });
  world.syncMovingLights(lights, movers);
  frames.push(frameData({ time: timeSeconds, A: snapshot.A, W: snapshot.W, lights, records: world.movingLightRecords() }));
}
const native = runChain(root, { levelBrightness, frames });
const stats = { frames: frames.length, lights: 0, contributions: 0, texels: 0, lit: 0, maps: 0, byPair: {} };
frames.forEach((frame, i) => checkFrame(frame, native.frames[i], assert, stats, `frame ${i} `));
// The time-varying inputs changed something from frame to frame.
const changes = frames.slice(1).filter((frame, i) => frame.records.some(record => {
  const previous = frames[i].records.find(p => p.surfaceIndex === record.surfaceIndex && p.width === record.width);
  return previous && !Buffer.from(previous.pixels.buffer).equals(Buffer.from(record.pixels.buffer));
})).length;
assert.ok(changes >= times.length - 2, 'the light maps change from frame to frame');
assert.ok(Object.keys(stats.byPair).includes('5/12') && Object.keys(stats.byPair).includes('4/0'), 'Strobe spot and Flicker lights are covered');
console.log(JSON.stringify({ ...stats, changedFrames: changes, notes: world.notes.filter(n => /moving|Moving/.test(n)) }));
if (assert.enabled) assert.report('validate-moving-light-effects');
