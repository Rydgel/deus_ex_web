/** Pawn.FindStairRotation (native 524) in Play (docs/pawn-stair-rotation.md): in 00_Training the player's bLookUpStairs is set, which
 * makes the base PlayerPawn.PlayerWalking.PlayerMove call the native every tick it walks (installed User.ini has it False; the StairLook
 * exec sets it). Every live call is recorded with the pawn state and the level's answers, and replayed through the original exec under
 * Unicorn (scripts/native-find-stair-rotation-oracle.py, NATIVE_PROBE_PYTHON): the result and the number of line checks the script asked for must be the original's. Needs the installed game data. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import {gameDirectory} from './game-directory.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-find-stair-rotation-play: no installed game data'); process.exit(0); }
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
const input = createPlayerInputFixture(game, {paint: () => game.hud.commands(1024, 640, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75})});
input.tick(30);
const live = [];
runtime.observeStairRotation = record => live.push(record);
assert.equal(runtime.readNamed(player, 'bLookUpStairs'), false, 'the installed User.ini value'); 
assert.equal(live.length, 0);
input.tick(10);
assert.equal(live.length, 0, 'with bLookUpStairs false PlayerMove never asks');
runtime.writeNamed(player, 'bLookUpStairs', true);
// Walk forward, look down and up, so the pitch eases and the traces see the floor and walls.
for (let phase = 0; phase < 6; phase++) {
  if (phase === 1) input.key('KeyW', true);
  if (phase === 3) input.key('KeyW', false);
  if (phase === 4) runtime.writeNamed(player, 'ViewRotation', [-4000, runtime.readNamed(player, 'ViewRotation')[1], 0]);
  if (phase === 5) runtime.writeNamed(player, 'ViewRotation', [0x9000, runtime.readNamed(player, 'ViewRotation')[1], 0]);
  input.tick(40);
}
assert.equal(game.runtimeError ?? null, null, 'no runtime error');
assert.ok(live.length >= 100, `PlayerMove asked FindStairRotation ${live.length} times`);
const bits = value => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
const encode = ({state, deltaTime, times}) => ({dt: bits(deltaTime), location: state.location.map(bits), rotation: state.viewRotation, eye: bits(state.eyeHeight),
  radius: bits(state.radius), height: bits(state.height), times: [...times, 1, 1, 1, 1, 1].slice(0, 5).map(bits)});
const original = JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-find-stair-rotation-oracle.py', root], {input: JSON.stringify({cases: live.map(encode)}), encoding: 'utf8', maxBuffer: 1 << 28})).results;
let differing = 0, traced = 0;
live.forEach((record, index) => {
  if (record.result !== original[index].result || record.times.length !== original[index].calls.length) differing++;
  traced += original[index].calls.length;
});
assert.equal(differing, 0, `${differing} of ${live.length} live results differ from the original exec`);
console.log(JSON.stringify({calls: live.length, lineChecks: traced, results: [...new Set(live.map(r => r.result))].slice(0, 8)}));
process.exit(0);
