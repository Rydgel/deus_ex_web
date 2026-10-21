/** RootWindow.GenerateSnapshot (native 1524) in the simulation (docs/root-snapshot.md), headless, 00_Training: with the player's UIBackground
 * set to 1 (Snapshot) the main menu's UIPauseGame calls ShowSnapshot, which calls the native. Checked: the native makes one Texture of the
 * root's snapshot size rounded up to powers of two (USize/VSize), the request for the page carries the viewport's size and the snapshot
 * size, the HUD commands of that frame draw a texture the request names (at the powers of two), 3D rendering is off and the raw background
 * is that texture; with UIBackground 0 nothing is requested; the pause leaves no runtime error, and UIBackground 2 (Black) CriticalDeletes the
 * held texture, which tells the page to release it. The pixels are the page's (validate-root-snapshot-browser). */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import {createMenuDriver} from '../src/viewer/menu-driver.mjs';
import {gameDirectory} from './game-directory.mjs';
import {potCeiling} from '../src/runtime/script-root-snapshot.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-root-snapshot-play: no installed game data'); process.exit(0); }
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, host = game.doors.scriptRuntime.windowHost, player = game.player.collisionActor;
const view = () => ({location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
let commands = [];
const paint = () => { commands = game.hud.commands(1024, 640, view()); return commands; };
const input = createPlayerInputFixture(game, {paint});
input.tick(30);
const driver = createMenuDriver(game);
const closeMenus = () => { for (let guard = 0; driver.top() && guard < 8; guard++) { game.windowKey('Escape', true); game.windowKey('Escape', false); input.tick(5); } };
let checks = 0;
const is = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };

// UIBackground 0 (the installed value): the pause makes no snapshot.
is(runtime.readNamed(player, 'UIBackground'), 0, 'the installed UIBackground');
driver.showMainMenu(); input.tick(10);
is([host.display.snapshotRequests.length, driver.top()], [0, 'deusex.menumain'], 'Render 3D asks for no snapshot');
closeMenus();

// UIBackground 1: the pause asks for one.
runtime.writeNamed(player, 'UIBackground', 1);
driver.showMainMenu(); input.tick(10);
is(driver.top(), 'deusex.menumain', 'the menu opened');
assert.equal(game.runtimeError ?? null, null, 'the pause stopped the game'); checks++;
const [request] = host.display.snapshotRequests;
is(host.display.snapshotRequests.length, 1, 'one request');
const rootWindow = host.root, snapW = runtime.readNamed(rootWindow, 'snapshotWidth'), snapH = runtime.readNamed(rootWindow, 'snapshotHeight');
is([request.snapW, request.snapH], [snapW | 0, snapH | 0], 'the request carries the root\'s snapshot size (the floats SetSnapshotSize truncated)');
is([request.sizeX, request.sizeY], [1024, 640], 'and the viewport size of the last HUD frame');
const snapshot = runtime.readNamed(rootWindow, 'snapshot');
assert.ok(snapshot, 'the script holds the texture'); checks++;
is([runtime.readNamed(snapshot, 'USize'), runtime.readNamed(snapshot, 'VSize')], [potCeiling(request.snapW), potCeiling(request.snapH)], 'USize and VSize are the powers of two');
is(runtime.instance(snapshot).cls.record.key, 'engine.texture', 'an Engine.Texture');
is(runtime.instance(snapshot).nativeObject.nativeVtable, 0x100613e8, 'the Extension texture vtable');
paint();
const drawn = commands.filter(command => command.texture?.key === request.key);
assert.ok(drawn.length > 0, `the HUD draws the snapshot (${commands.length} commands, ${commands.filter(c => c.texture).map(c => c.texture.key).slice(0, 5)})`); checks++;
is([drawn[0].texture.dynamic, drawn[0].texture.width, drawn[0].texture.height], [true, potCeiling(request.snapW), potCeiling(request.snapH)], 'at the powers of two');
is(runtime.readNamed(rootWindow, 'colSnapshot') !== undefined, true, 'the tint the root gives it exists');
// The root renders no 3D behind it (EnableRendering(False)).
is(game.hud.renderViewport?.(1024, 640)?.width ?? 0, 0, 'rendering is off');

// The next pause makes a new snapshot (the old one is only replaced in the variable).
closeMenus();
driver.showMainMenu(); input.tick(10);
is(host.display.snapshotRequests.length, 2, 'a second request');
is(host.display.snapshotRequests.map(r => r.serial), [1, 2], 'with the next serial');
assert.equal(game.runtimeError ?? null, null); checks++;
// UIBackground 2 (Black): ShowSnapshot CriticalDeletes the snapshot it holds (native 751, the texture's destructor) and the page is told.
runtime.writeNamed(player, 'UIBackground', 2);
closeMenus();
driver.showMainMenu(); input.tick(10);
is(runtime.readNamed(rootWindow, 'snapshot'), null, 'Black drops the snapshot');
is(host.display.snapshotReleased, ['snapshot:2'], 'and the page is told to release it');
is(host.display.snapshotRequests.length, 2, 'Black asks for none');
assert.equal(game.runtimeError ?? null, null); checks++;
runtime.writeNamed(player, 'UIBackground', 0);
closeMenus();
console.log(`root snapshot (simulation): ${checks} checks pass; request ${JSON.stringify(request)}`);
process.exit(0);
