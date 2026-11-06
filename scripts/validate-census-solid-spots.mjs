/** The slow-spot census lost three sessions to a player that died in god mode (2026-11-06: 03_NYC_Airfield (698, -4255, 24),
 * 03_NYC_UNATCOHQ (-36, 1, 264), 12_Vandenberg_Computer (782, 2657, -2249)). Each spot is a placed navigation point inside the level's
 * solid, UModel::PointRegion ZoneNumber 0, which the census' farthest-point sampling prefers because such points lie far from the rest.
 * A pawn in zone 0 takes physWalking's FellOutOfWorld branch on its first walking tick (Engine.dll 0x103ca584..0x103ca5e7, oracle:
 * validate-native-walking's zone-0 cases, docs/walking.md); Pawn.FellOutOfWorld (bytecode Engine.Pawn, @0..@40) sets Health -1,
 * SetPhysics(PHYS_None), Weapon = None and calls Died(None, 'Fell', Location) directly. DeusExPlayer.Died has no god-mode test: the
 * god mode (`ReducedDamageType 'All'`) is read by TakeDamage only (DeusExPlayer.uc "//God mode"), so the original kills a god player there
 * too. The session that follows (Dying, then DXOnly whose player is `Paralyzed`: DeusExPlayer's MissionNumber -1 branch) is the original's
 * death flow, not a second fault.
 *
 * This validator checks, on the three maps: the spots are in zone 0 and scripts/map-nav-points.mjs no longer offers them; a god player
 * placed there is Dying with Health -1 and PHYS_None within a few ticks while ReducedDamageType stays 'All'; a nav point in a real zone of
 * the same map (the census' later spots, left in `Paralyzed` only because the session had gone to DXOnly) leaves the god player walking
 * and unhurt. Simulation only, headless; the original contract is the walking oracle named above. */
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {pointRegion} from '../src/runtime/zone.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {placeProbe} from '../src/viewer/decal-probe.mjs';
import {viewProbe} from '../src/viewer/view-probe.mjs';
import {navPoints} from './map-nav-points.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`))
    files.push({path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`)});
const assets = new AssetStore(files);

const CASES = [
  {map: '03_NYC_Airfield', solid: [698, -4255, 24], real: [-1578, 34, 23]},
  {map: '03_NYC_UNATCOHQ', solid: [-36, 1, 264], real: [1730, -847, -40]},
  {map: '12_Vandenberg_Computer', solid: [782, 2657, -2249], real: [1884, 2974, -1993]},
];

for (const {map, solid, real} of CASES) {
  const asset = await assets.get(map), decoded = decodeMap(asset.bytes);
  const zoneOf = location => pointRegion(decoded.model, location, {}, [], decoded.model.zones?.length || 1).zoneNumber;
  assert.equal(zoneOf(solid), 0, `${map} ${solid}: inside the level's solid (PointRegion ZoneNumber 0)`);
  assert.ok(zoneOf(real) > 0, `${map} ${real}: a real zone`);
  // The census places the player 8 units above the point (spot-census --z), and tests the placed location.
  const placed = p => [p.location[0], p.location[1], p.location[2] + 8].map(Math.round).join();
  const offered = (await navPoints(map, {lift: 8})).map(placed), kept = (await navPoints(map, {solid: true, lift: 8})).map(placed);
  assert.ok(kept.includes(solid.join()), `${map}: the solid spot is a placed navigation point`);
  assert.ok(!offered.includes(solid.join()), `${map}: the census no longer offers it`);
  assert.ok(offered.includes(real.join()), `${map}: the census still offers the real-zone spot`);

  const game = await createGame(decoded, asset, assets, {randomSeed: 1, presentation: true});
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const read = name => runtime.readNamed(player, name), stateName = () => runtime.instance(player).state?.stateNode?.record.name ?? 'None';
  for (let i = 0; i < 30; i++) game.tick(1 / 60);
  viewProbe(game, {exec: ['set DeusEx.JCDentonMale bCheatsEnabled True', 'god']});
  assert.equal(read('ReducedDamageType'), 'All', `${map}: god mode`);

  // A spot in a real zone: the god player walks on, unhurt.
  placeProbe(game, {location: real, rotation: [0, 0, 0], endConversation: true});
  for (let i = 0; i < 20; i++) game.tick(1 / 60);
  assert.equal(stateName(), 'PlayerWalking', `${map} ${real}: still walking`);
  assert.equal(read('Health'), 100, `${map} ${real}: unhurt`);

  // A spot in the solid: FellOutOfWorld on the first walking tick, whatever the damage reduction.
  placeProbe(game, {location: solid, rotation: [0, 0, 0], endConversation: true});
  assert.equal(read('Region').ZoneNumber ?? read('Region')['engine.actor.pointregion.zonenumber'], 0, `${map} ${solid}: Region.ZoneNumber 0 after the placement`);
  for (let i = 0; i < 3; i++) game.tick(1 / 60);
  assert.equal(stateName(), 'Dying', `${map} ${solid}: the god player dies`);
  assert.equal(read('Health'), -1, `${map} ${solid}: Pawn.FellOutOfWorld sets Health -1`);
  assert.equal(read('Physics'), 0, `${map} ${solid}: PHYS_None`);
  assert.equal(read('ReducedDamageType'), 'All', `${map}: god mode was on all along`);
  console.log(`${map}: solid ${solid} -> ZoneNumber 0, Dying, Health -1; real-zone ${real} walks on`);
}
console.log('census solid spots: PASS');
