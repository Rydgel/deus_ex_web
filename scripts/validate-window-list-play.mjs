/** Play integration of the ListWindow family (not an original comparison; the
 * bodies are compared by validate-window-list-family.mjs).
 *
 * On 00_Training, 40 log lines are added through the original
 * DeusExPlayer.AddLog, the Logs screen opens through its exec function, and
 * the HUD paints at 1432x1268: the PersonaListWindow holds 40 rows sorted
 * newest first, VisibilityChanged selected row 0, and the overflowing list's
 * scroll area draws its scrollbar (XScaleWindow::Draw). Mouse samples through
 * the root's button route then press, drag, release and double-click rows,
 * virtual keys move the focus through ListWindow.uc's VirtualKeyPressed, and
 * Escape closes the screen. docs/script-window-list-family.md. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, host = game.hud.host, W = host.W, player = game.player.collisionActor;
let commands = [];
const paint = () => (commands = game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75}));
const input = createPlayerInputFixture(game, {paint});
input.tick(30);
const LINES = 40;
for (let i = 0; i < LINES; i++) game.hud.scoped(() => runtime.dispatchSpawnedEvent(player, 'AddLog', [`Line ${String(i).padStart(2, '0')}`]));
assert.equal(game.hud.scoped(() => runtime.scriptConsoleExec(player, 'ShowLogsWindow')), true, 'ShowLogsWindow runs');
input.tick(5);

const rootWindow = runtime.namedReference(player, 'rootWindow').get();
const lists = [], scales = [];
const walk = win => { for (let c = W.ptr(win, 0x13c); c; c = W.ptr(c, 0x148)) {
  if (host.families(c) === 'extension.listwindow') lists.push(c);
  if (host.families(c) === 'extension.scalewindow' && (W.u8(c, 0x30) & 1)) scales.push(c);
  walk(c);
} };
walk(rootWindow);
assert.equal(lists.length, 1, 'the Logs screen has one list');
const list = lists[0];
assert.equal(runtime.instance(list).cls.record.key, 'deusex.personalistwindow');
const rows = () => W.i32(list, 0x174);
const node = i => W.heap.mem.read(W.u32(list, 0x170) + 4 * i, 'u32');
const text = i => { const fields = W.heap.mem.read(node(i) + 8, 'u32'), data = W.heap.mem.read(fields, 'u32'), num = W.heap.mem.read(fields + 4, 'i32');
  let s = ''; for (let j = 0; j < num - 1; j++) s += String.fromCharCode(W.heap.mem.read(data + 2 * j, 'u16')); return s; };
const focus = () => { const f = W.u32(list, 0x1ac); return f ? W.heap.mem.read(f, 'i32') : null; };
const selected = () => { const out = []; for (let i = 0; i < rows(); i++) if (W.heap.mem.read(node(i) + 4, 'u32') & 1) out.push(i); return out; };
assert.equal(rows(), LINES, 'every log line is a row');
assert.equal(text(0), 'Line 39', 'SetSortColumn(1, reverse) on the float index column puts the newest line first');
assert.equal(text(LINES - 1), 'Line 00');
assert.deepEqual([focus(), selected()], [0, [0]], 'VisibilityChanged selected and focused row 0');
assert.ok(scales.length >= 1, 'the overflowing list shows a scrollbar');
assert.ok(commands.length > 0, 'the HUD painted');

const line = W.f32(list, 0x19c), x = W.f32(list, 0xd4) + 20, y0 = W.f32(list, 0xd8);
const at = i => ({x, y: y0 + (i + 0.5) * line});
const button = (i, action) => assert.equal(game.windowPointer({...at(i), key: 1, action}), true, 'the root takes the button sample');
button(3, 1); input.tick(1);
assert.deepEqual([focus(), selected(), W.u32(list, 0x1b4) & 1], [3, [3], 1], 'a press focuses and selects the row and starts dragging');
game.windowPointer(at(5)); input.tick(1);
assert.deepEqual([focus(), selected()], [5, [5]], 'dragging moves the single selection');
button(5, 3); input.tick(1);
assert.equal(W.u32(list, 0x1b4) & 1, 0, 'the release stops dragging');
button(2, 1); button(2, 3); button(2, 1); button(2, 3); input.tick(1);
assert.deepEqual([focus(), selected()], [2, [2]], 'a double click focuses the row');
const key = code => { game.windowKey(code, true); game.windowKey(code, false); input.tick(1); };
key('ArrowDown'); assert.equal(focus(), 3, 'Down moves the focus row');
key('ArrowUp'); assert.equal(focus(), 2, 'Up moves the focus row');
key('End'); assert.deepEqual([focus(), selected()], [LINES - 1, [LINES - 1]], 'End selects the last row');
key('Home'); assert.deepEqual([focus(), selected()], [0, [0]], 'Home selects the first row');
key('Escape'); input.tick(5);
let top = W.ptr(rootWindow, 0x140);
while (top && W.u8(top, 0x28) < 2) top = W.ptr(top, 0x144);
assert.equal(top, null, 'Escape closes the screen');
console.log(`window-list-play: Logs list of ${LINES} rows drew with its scrollbar, took clicks, drag, double click and keys, and closed`);
process.exit(0);
