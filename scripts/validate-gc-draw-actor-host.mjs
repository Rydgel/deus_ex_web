/** GC.DrawActor and GC.ClearZ through the live HUD paint (docs/gc-draw-actor.md "Play"), headless on 00_Training.
 *
 * The vision augmentation is granted through the original console chain (AugAdd, then the augmentation's level and ActivateAllAugs:
 * the retail DrawVisionAugmentation draws heat sources only from CurrentLevel 1 on) and the player stands in front of an NPC. The
 * window host's actor planner (the one sim-session.mjs installs) is a recorder here: each GC.DrawActor reaches it with the actor in the
 * state XGC::DrawActor set (bHidden 0, bUnlit, the GC's Style, DrawScale * 1, ScaleGlow 2.0, the script's grid skins), and the
 * paint leaves every field of every actor as it was. `ShowClass`/`ShowMesh` (ActorDisplayWindow) on a class with no actors puts the
 * GC.ClearZ command in the stream. Requires the local install.
 *
 *   node scripts/validate-gc-draw-actor-host.mjs [--near mib1] */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {viewProbe} from '../src/viewer/view-probe.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-gc-draw-actor-host: no installed game data'); process.exit(0); }
const files = [];
for (const d of ['System', 'Textures', 'Maps', 'Sounds', 'Music']) for (const n of await readdir(path.join(root, d)))
  files.push({path: `${d}/${n}`, read: () => readFile(path.join(root, d, n))});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const input = createPlayerInputFixture(game, {tickSeconds: 1 / 120});
const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor, level = runtime.levelFor(player);
const read = (actor, name) => runtime.readNamed(actor, name);
const FIELDS = ['bHidden', 'bUnlit', 'Style', 'ScaleGlow', 'DrawScale', 'Skin', 'MultiSkins', 'LastRenderTime'];
const snapshot = actor => JSON.stringify(FIELDS.map(name => { const v = read(actor, name); return Array.isArray(v) ? v.map(x => x?.name ?? x) : v?.name ?? v; }));

input.tick(30);
viewProbe(game, {exec: ['AugAdd AugVision']});
runtime.writeNamed(level.actors.find(actor => actor?.name?.startsWith('AugVision')), 'CurrentLevel', 3);
viewProbe(game, {exec: ['ActivateAllAugs']});
const near = level.actors.find(actor => actor?.name === option('near', 'mib1')), at = read(near, 'Location');
runtime.farMoveActor(player, [at[0] - 160, at[1], at[2] + 20], 0, 1);
runtime.writeNamed(player, 'ViewRotation', [0, 0, 0]);
input.tick(60);

const before = new Map(level.actors.filter(Boolean).map(actor => [actor, snapshot(actor)]));
const seen = [];
game.hud.host.setActorDrawPlanner((actor, rect) => {
  const skins = read(actor, 'MultiSkins');
  seen.push({name: actor.name, hidden: read(actor, 'bHidden'), unlit: read(actor, 'bUnlit'), style: read(actor, 'Style'), glow: read(actor, 'ScaleGlow'),
    scale: read(actor, 'DrawScale'), skin: read(actor, 'Skin')?.name ?? null, skins: skins.map(skin => skin?.name ?? null), rect});
  return null;
});
const view = {location: game.player.eye, rotation: game.player.viewRotation, fov: 75};
const commands = game.hud.commands(960, 600, view);
const actorCommands = commands.filter(command => command.kind === 'actor');
assert.ok(actorCommands.length >= 3, `the vision augmentation draws the heat sources in range (${actorCommands.length})`);
assert.deepEqual(actorCommands.map(command => command.actor), seen.map(entry => entry.name), 'one planner call per actor command, in order');
assert.ok(actorCommands.some(command => command.actor === option('near', 'mib1')));
for (const entry of seen) {
  const original = JSON.parse(before.get(level.actors.find(actor => actor?.name === entry.name)));
  assert.equal(entry.hidden, false, `${entry.name}: bHidden cleared for the draw`);
  assert.equal(entry.unlit, true, `${entry.name}: bUnlit`);
  assert.equal(entry.style, 3, `${entry.name}: Style from the GC (DSTY_Translucent)`);
  assert.equal(entry.glow, 2, `${entry.name}: ScaleGlow 2.0`);
  assert.equal(entry.scale, Math.fround(original[4] * 1), `${entry.name}: DrawScale times the argument`);
  assert.ok(entry.skins.every(Boolean) && entry.skin, `${entry.name}: the script's grid skins`);
  assert.deepEqual(entry.rect.x + entry.rect.y, 0, 'the HUD frame the draw is made in');
}
// Every actor's fields are as before the paint (LastRenderTime included: no planner stamped it).
for (const [actor, text] of before) assert.equal(snapshot(actor), text, `${actor.name}: restored`);
// The stream keeps window order: the tint tiles first, the actors after them, the LightAmp box's tiles after the actors.
const first = commands.findIndex(command => command.kind === 'actor'), last = commands.findLastIndex(command => command.kind === 'actor');
assert.ok(first > 0 && last < commands.length - 1, 'tiles before and after the actor draws');
assert.ok(commands.slice(first, last + 1).every(command => command.kind === 'actor'), 'the actor draws are consecutive (no tile between SetSkins and ResetSkins)');

// ActorDisplayWindow.DrawWindow's GC.ClearZ (ShowMesh) with a class that has no actors in the level.
game.hud.host.setActorDrawPlanner(null);
viewProbe(game, {exec: ['ShowClass Greasel', 'ShowMesh True']});
input.tick(10);
const showMesh = game.hud.commands(960, 600, view);
assert.ok(showMesh.some(command => command.kind === 'clearZ'), 'GC.ClearZ reaches the command stream');
console.log(`GC.DrawActor/ClearZ host path passed: ${actorCommands.length} actors drawn in the vision pass (${seen.map(entry => entry.name).join(', ')}), state restored for ${before.size} actors, ClearZ command queued`);
