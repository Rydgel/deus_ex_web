/** Two in-game screens that reached natives Play did not route, driven through the window host's pointer route in 00_Training
 * (docs/native-census.md, step 2):
 *
 *  - Inventory drag and drop: PersonaInventoryItemButton.MouseMoved, HUDObjectSlot.MouseMoved and PersonaScreenInventory.UpdateDragMouse call
 *    Window.ConvertCoordinates (native 1449). An item button is pressed, dragged over a belt slot and released; the item takes the slot.
 *  - The images screen: PersonaImageWindow.MouseButtonReleased in note-add mode calls DeusExPlayer.CreateDataVaultImageNoteObject (native
 *    3014); the image's note list gets the new note (original AddNote bytecode).
 *
 * No runtime error may occur. Needs the installed game data. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import {createMenuDriver} from '../src/viewer/menu-driver.mjs';
import {gameDirectory} from './game-directory.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-ui-natives-play: no installed game data'); process.exit(0); }
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
const paint = () => game.hud.commands(1024, 640, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
const input = createPlayerInputFixture(game, {paint});
input.tick(30);
const driver = createMenuDriver(game), level = runtime.levelFor(player), dx = await assets.get('DeusEx');
const spawn = async name => {
  const cls = await runtime.loadClass(dx, dx.exportsByPath.get(name));
  return runtime.spawnActor({cls: cls.record ?? cls, level, name: 'None', owner: null, instigator: null, location: [...game.player.position], rotation: [0, 0, 0]});
};
const center = w => [w.x + w.w / 2, w.y + w.h / 2];
const sample = (x, y, extra = {}) => game.windowPointer({relative: false, x, y, ...extra});
const clickAt = (x, y) => { sample(x, y); input.tick(3); sample(x, y, {key: 1, action: 1}); input.tick(3); sample(x, y, {key: 1, action: 3}); input.tick(5); };
const noError = label => assert.equal(game.runtimeError ?? null, null, `${label}: runtime error`);
let checks = 0;

// ---- Inventory drag and drop ------------------------------------------------------------------------------------------
for (const name of ['medkit', 'multitool', 'lockpick']) {
  const item = await spawn(name);
  assert.ok(item, `${name} spawned`);
  runtime.callFunction(runtime.lookup(item, 'GiveTo'), item, 1, () => player);
}
input.tick(5);
game.hud.scoped(() => runtime.scriptConsoleExec(player, 'ShowInventoryWindow'));
input.tick(20);
assert.equal(driver.top(), 'deusex.personascreeninventory'); checks++;
let controls = driver.controls();
const buttons = controls.windows.filter(w => w.class === 'deusex.personainventoryitembutton');
const slots = controls.windows.filter(w => w.class === 'deusex.hudobjectslot');
assert.equal(buttons.length, 3, 'one button per item'); assert.equal(slots.length, 10, 'ten belt slots'); checks += 2;
const itemsOf = () => { const out = []; for (let item = runtime.readNamed(player, 'Inventory'); item; item = runtime.readNamed(item, 'Inventory')) out.push([runtime.instance(item).cls.record.key, runtime.readNamed(item, 'beltPos')]); return out; };
const before = itemsOf();
// The second item button holds the multitool; the sixth slot window is belt position 5.
const from = center(buttons[1]), to = center(slots[5]);
const beltOf = key => itemsOf().find(([name]) => name === key)[1];
const was = beltOf('deusex.multitool');
sample(...from); input.tick(3);
sample(...from, {key: 1, action: 1}); input.tick(3);
for (let step = 1; step <= 6; step++) { sample(from[0] + (to[0] - from[0]) * step / 6, from[1] + (to[1] - from[1]) * step / 6); input.tick(3); }
noError('mid-drag');
sample(...to, {key: 1, action: 3}); input.tick(5);
noError('drop');
const now = beltOf('deusex.multitool');
assert.notEqual(now, was, `the dragged item changed its belt position (${was} -> ${now})`); checks++;
assert.equal(now, 5, 'and landed on the slot it was released over'); checks++;
assert.deepEqual(itemsOf().filter(([name]) => name !== 'deusex.multitool'), before.filter(([name]) => name !== 'deusex.multitool'), 'the other items kept their slots'); checks++;
assert.equal(driver.top(), 'deusex.personascreeninventory'); checks++;
game.windowKey('Escape', true); game.windowKey('Escape', false); input.tick(10);

// ---- The images screen: add a note ------------------------------------------------------------------------------------
const image = await spawn('image02_nyc_warehouse');
assert.ok(image, 'image spawned');
assert.equal(runtime.callFunction(runtime.lookup(player, 'AddImage'), player, 1, () => image), true, 'AddImage'); checks++;
game.hud.scoped(() => runtime.scriptConsoleExec(player, 'ShowImagesWindow'));
input.tick(20);
assert.equal(driver.top(), 'deusex.personascreenimages'); checks++;
const notes = () => { const out = []; for (let n = runtime.readNamed(image, 'firstNote'); n; n = runtime.readNamed(n, 'nextNote')) out.push([runtime.readNamed(n, 'posX'), runtime.readNamed(n, 'posY'), runtime.readNamed(n, 'noteText')]); return out; };
assert.deepEqual(notes(), []); checks++;
controls = driver.controls();
const list = controls.windows.find(w => w.class === 'deusex.personalistwindow');
clickAt(list.x + list.w / 2, list.y + 10); input.tick(10);          // select the image
controls = driver.controls();
const addNote = controls.windows.filter(w => w.class === 'deusex.personaactionbuttonwindow' && w.sensitive).at(-1);
assert.ok(addNote, 'the Add Note button is sensitive once an image is selected'); checks++;
clickAt(...center(addNote)); input.tick(10);
const picture = controls.windows.find(w => w.class === 'deusex.personaimagewindow');
clickAt(picture.x + 82, picture.y + 26); input.tick(10);          // a point inside the picture
noError('add a note');
const added = notes();
assert.equal(added.length, 1, 'the click created one note'); checks++;
assert.deepEqual(added[0].slice(2), ['New Note'], 'with the label the window gives it'); checks++;
assert.ok(added[0][0] > 0 && added[0][1] > 0, 'at the clicked point'); checks++;
const note = runtime.readNamed(image, 'firstNote');
assert.equal(runtime.instance(note).cls.record.key, 'deusex.datavaultimagenote'); checks++;
assert.equal(runtime.instance(note).nativeObject.nativeVtable, 0x10027b24, 'a DDataVaultImageNote'); checks++;
console.log(`ui natives: ${checks} checks pass; drag ${was} -> ${now}, note ${JSON.stringify(added[0])}`);
process.exit(0);
