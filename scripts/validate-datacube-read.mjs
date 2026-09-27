/** Reading Training's information devices in Play through the original path.
 *
 * game.use() runs DeusExPlayer.ParseRightClick -> DoFrob -> InformationDevices.Frob.
 * CreateInfoWindow constructs `new(None) DeusExTextParser` in the transient
 * package, opens the DeusExText XExtString with the recovered DeusExText.dll
 * natives (verified separately by validate-text-parser-diff.mjs), fills the
 * HUD's HUDInformationDisplay with one TextWindow per paragraph, adds the
 * DataVault note, and CriticalDeletes the parser. Walking away lets
 * InformationDevices.Tick close the window again. docs/script-text-parser.md. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, host = game.doors.scriptRuntime.windowHost;
const player = game.player.collisionActor, level = runtime.levelFor(player), W = host.W;
const input = createPlayerInputFixture(game);
const get = (object, name) => runtime.namedReference(object, name).get();
const live = name => level.actors.find(actor => actor?.name === name);
const visible = window => (W.u32(window, 0x30) & 1) === 1;
const children = window => {
  const list = [];
  for (let child = W.ptr(window, 0x13c); child; child = W.ptr(child, 0x148)) list.push(child);
  return list;
};
const text = window => W.heap.read(window, 0x168, 'string');
const notes = () => {
  const list = [];
  for (let note = get(player, 'FirstNote'); note; note = get(note, 'next')) list.push(note);
  return list;
};

// Record the parser objects CreateInfoWindow constructs so their release is visible.
const parsers = [];
const newObject = runtime.newObject.bind(runtime);
runtime.newObject = request => {
  const object = newObject(request);
  if (request.classRef?.linkedClass?.record.key === 'deusextext.deusextextparser')
    parsers.push({object, native: runtime.instance(object).nativeObject});
  return object;
};

input.tick(30);
const hud = get(get(player, 'rootWindow'), 'hud');
const cross = get(hud, 'cross'), frobDisplay = get(hud, 'frobDisplay'), info = get(hud, 'info');
assert.ok(info !== null && runtime.instance(info).cls.record.name === 'HUDInformationDisplay', 'the HUD owns its information display');
assert.equal(visible(info), false, 'the information display starts hidden');
assert.equal(visible(cross), true, 'the crosshair starts visible');

async function read(actor, options) {
  const result = await input.frob(actor, options);
  assert.deepEqual(result, {ok: true, message: ''}, `${actor.name} frob runs the original right-click path`);
}

// DataCube0 (00_Datacube01) holds the paddoor code.
const cube = live('DataCube0');
assert.equal(get(cube, 'textTag'), '00_Datacube01');
assert.equal(get(cube, 'bAddToVault'), true, 'DataCube text is added to the DataVault');
const soundsBefore = host.soundRequests.length;
const cubeSide = 48 * Math.SQRT1_2;
const cubeTracePose = {position: [get(cube, 'Location')[0] - cubeSide,
  get(cube, 'Location')[1] - cubeSide, get(cube, 'Location')[2]]};
await read(cube, cubeTracePose);
assert.ok(get(cube, 'infoWindow')===info, 'CreateInfoWindow uses the HUD information display');
assert.ok(get(cube, 'aReader')===player);
assert.equal(visible(info), true, 'ShowInfoWindow shows the display');
assert.equal(visible(cross), false, 'SetCrosshair(False) hides the crosshair while reading');
assert.equal(visible(frobDisplay), false, 'the frob display is hidden while reading');
const tile = get(info, 'winTile');
const paragraphs = children(tile).map(text);
assert.deepEqual(paragraphs, [
  "We'll make this one easy for you.  To open the door, use the code:  ",
  '  ', '0012  ', '  ', 'Got it?  ', '  ', 'Jaime',
], 'one TextWindow per paragraph with the parser text');
const packed = W.u32(children(tile)[0], 0x3d);
assert.equal(packed & 0xffffff, 0xffffff, '<DC=255,255,255> sets the first TextWindow colour (RGB)');
assert.equal(packed >>> 24, 0, 'the heap-address alpha byte is the documented model value');
assert.equal(W.u32(children(tile)[0], 0x150) & 1, 1, 'AddTextWindow enables word wrap');

// DeusExHUD.ConfigurationChanged sizes the display from its preferred size, and
// the paragraph TextWindows draw their glyphs inside it.
const rootWindow = get(player, 'rootWindow');
const commands = game.hud.commands(800, 600, game.view());
const absolute = window => {
  let x = 0, y = 0;
  for (let at = window; at; at = W.ptr(at, 0x138)) { x += W.f32(at, 0x78); y += W.f32(at, 0x7c); }
  return {x, y, width: W.f32(window, 0x80), height: W.f32(window, 0x84)};
};
const box = absolute(info);
assert.ok(box.width > 300 && box.height > 80, `the information display has its preferred size: ${JSON.stringify(box)}`);
assert.ok(children(tile).every(window => W.f32(window, 0x80) > 0), 'every paragraph TextWindow was given a width');
const glyphs = commands.filter(command => /font/i.test(String(command.texture?.key ?? command.texture?.name ?? '')) &&
  command.x >= box.x && command.x < box.x + box.width && command.y >= box.y && command.y < box.y + box.height);
assert.ok(glyphs.length >= 60, `paragraph text is drawn inside the display (${glyphs.length} glyphs)`);

// The DataVault note, its log message and sound request.
assert.equal(notes().length, 1, 'one DataVault note');
const note = notes()[0];
assert.equal(get(note, 'text'), "We'll make this one easy for you.  To open the door, use the code:    \n0012  \n  \nGot it?  \n  \nJaime");
assert.equal(get(note, 'textTag'), '00_Datacube01');
assert.equal(get(note, 'bUserNote'), false);
assert.equal(get(get(player, 'FirstLog'), 'text'), 'Note Received - Check DataVault For Details');
const soundName = sound => String(sound?.key ?? sound?.name ?? sound?.objectName ?? sound ?? '');
assert.ok(host.soundRequests.slice(soundsBefore).some(request => /lognoteadded/i.test(soundName(request.sound))),
  `the log note sound is a recorded window sound request: ${host.soundRequests.slice(soundsBefore).map(r => soundName(r.sound)).join(', ')}`);

// The parser was constructed in the transient package and CriticalDeleted.
assert.equal(parsers.length, 1, 'one DeusExTextParser was constructed');
const registry = runtime.actorLifecycle.construction.registry;
const [{native: parser}] = parsers;
assert.ok(parser.outer===runtime.actorLifecycle.construction.transientPackage, 'new(None) uses the transient package');
assert.equal(parser.released, true, 'CriticalDelete ran the deleting destructor');
assert.ok(registry.objects[parser.index]===null, 'the parser registry slot was cleared');
assert.ok(registry.freeIndices.includes(parser.index), 'the parser index is reusable');

// DoFrob selects PushButton within 16 units of vertical separation; this scoped
// trace pose puts JC at the cube's Z. See the bytecode contract in scene-events.
assert.equal(get(player, 'AnimSequence'), 'PushButton', 'DoFrob -> PlayPickupAnim height branch');

// Walking out of frob range: InformationDevices.Tick sees FrobTarget != Self.
input.loseTarget(cube, {distance: 400});
input.tick(1); // Let InformationDevices.Tick observe the changed FrobTarget on its next actor update.
assert.ok(get(cube, 'infoWindow')===null, 'Tick closed the window once FrobTarget changed');
assert.equal(visible(info), false, 'DestroyWindow hides the display');
assert.equal(children(tile).length, 0, 'ClearTextWindows destroyed the paragraph windows');
assert.equal(visible(cross), true, 'the crosshair is restored to bCrosshairVisible');
assert.equal(visible(frobDisplay), true, 'the frob display is shown again');

// Reading again reuses the vault note; frobbing while open closes the window.
await read(cube, cubeTracePose);
assert.equal(notes().length, 1, 'GetNote(textTag) prevents a duplicate note');
assert.equal(children(tile).length, 7);
await read(cube, cubeTracePose);
assert.ok(get(cube, 'infoWindow')===null, 'a second frob while reading closes the window');
assert.equal(visible(info), false);
assert.equal(parsers.length, 2, 'the reopened read built one more parser; the close built none');
assert.ok(parsers.every(({native}) => native.released), 'every parser was released');

// The other two Training information devices.
for (const [name, tag] of [['BookOpen0', '00_Book01'], ['DataCube2', '00_Datacube03']]) {
  const device = live(name);
  assert.equal(get(device, 'textTag'), tag);
  await read(device);
  assert.ok(get(device, 'infoWindow')===info, `${name} opened the information display`);
  assert.ok(children(tile).length > 0 && children(tile).some(window => text(window).trim()), `${name} shows its text`);
  input.loseTarget(device, {distance: 400});
  input.tick(1); // Observe the changed FrobTarget on the device's next Tick.
  assert.ok(get(device, 'infoWindow')===null, `${name} closes when JC walks away`);
}
assert.equal(runtime.lastRuntimeError ?? null, null);
console.log(`Information devices read in Play: DataCube0 shows ${paragraphs.length} paragraph windows with the paddoor code 0012, ` +
  `adds one DataVault note (reused on re-read), closes when JC walks away or frobs again; ${parsers.length} ` +
  'DeusExTextParser objects were constructed in the transient package and CriticalDeleted; BookOpen0 and DataCube2 also read.');
