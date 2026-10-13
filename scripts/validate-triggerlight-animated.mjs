/** Animated (non-steady) TriggerLights reach the light maps with their live brightness.
 *
 * SetupForSurf classifies a surface-list light from the live actor (surfaceLightClass: no LightType or no LightBrightness is no
 * light), and a TriggerLight that BeginPlay or Tick leaves at brightness 0 adds nothing, whatever its LightType. The Play host
 * forwarded only the steady ones (script-lights.mjs lightingChange), so a Strobe, Pulse or Flicker TriggerLight that is off until
 * triggered stayed lit in the light maps at the map's brightness. Original evidence (docs/visual-acceptance.md "Strobe"): in
 * 06_HongKong_WanChai_Underworld TriggerLight1 (Strobe, brightness 200, bInitiallyOn false) reads 200 while the level is frozen and
 * 0 from its first unfrozen Tick (tools/dx-live-win.c trace of its live fields), the floor it lights is dark in the original's frames,
 * and Render.dll's Strobe flag stops flipping then. ~28 TriggerLights of 9 maps have a type other than Steady.
 *
 * Checks, headless, per map: after the initial sync every animated light-map entry of a TriggerLight holds the actor's live
 * brightness, and after the first Ticks too (no entry of a light at brightness 0 stays); and the lights that start on keep theirs.
 *
 *   node scripts/validate-triggerlight-animated.mjs
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createWorld } from '../src/viewer/world.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-triggerlight-animated: no installed game data'); process.exit(0); }
const files = [];
for (const dir of ['Maps', 'Textures', 'System', 'Sounds', 'Music'])
  for (const e of await readdir(path.join(root, dir), { withFileTypes: true }))
    if (e.isFile()) files.push({ path: `${dir}/${e.name}`, read: () => readFile(path.join(root, dir, e.name)) });
const assets = new AssetStore(files);

// [map, a TriggerLight name that is off until triggered or null, one that starts on or null]
const MAPS = [['06_HongKong_WanChai_Underworld', 'TriggerLight1', null], ['14_OceanLab_UC', 'TriggerLight0', null], ['03_NYC_Airfield', null, 'TriggerLight0']];
const summary = [];
for (const [name, offLight, onLight] of MAPS) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes), world = await createWorld(map, asset, assets);
  const lighting = world.lightMaps;
  const game = await createGame(map, asset, assets, { randomSeed: 1, onLightingChanged: changes => world.updateLighting(changes) });
  const runtime = game.doors.scriptRuntime.runtime, level = runtime.levelFor(game.player.collisionActor);
  const byRef = new Map(level.actors.filter(Boolean).map(actor => [actor.index, actor]));
  const entries = () => {
    const found = [];
    for (const record of lighting.animatedRecords()) for (const light of record.animated) {
      const actor = byRef.get(light.ref);
      if (actor && /triggerlight/.test(runtime.instance(actor).cls.record?.key ?? '')) found.push({ name: actor.name, held: light.values.LightBrightness, live: runtime.readNamed(actor, 'LightBrightness') });
    }
    return found;
  };
  const agree = () => entries().filter(entry => entry.held !== entry.live);
  assert.deepEqual(agree(), [], `${name}: after the initial sync`);
  for (let i = 0; i < 5; i++) game.tick(1 / 60);
  assert.deepEqual(agree(), [], `${name}: after 5 ticks every animated TriggerLight entry holds its live brightness`);
  const names = new Set(entries().map(entry => entry.name));
  const live = n => { const actor = [...byRef.values()].find(a => a.name === n); return actor ? runtime.readNamed(actor, 'LightBrightness') : null; };
  if (offLight) { assert.equal(live(offLight), 0, `${name}: ${offLight} is off after its first Tick`); assert.ok(!names.has(offLight), `${name}: ${offLight} is in no animated light map`); }
  if (onLight) { assert.ok(live(onLight) > 0, `${name}: ${onLight} stays on`); assert.ok(names.has(onLight), `${name}: ${onLight} stays in the animated light maps`); }
  summary.push(`${name}: ${entries().length} animated TriggerLight entries, all at their live brightness${offLight ? `, ${offLight} off` : ''}${onLight ? `, ${onLight} on` : ''}`);
}
console.log(`validate-triggerlight-animated: ${summary.join('; ')}`);
process.exit(0);
