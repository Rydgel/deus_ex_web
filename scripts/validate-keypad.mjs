/** The Training keypad in Play through the original window input path.
 *
 * game.use() runs Keypad.Frob -> ActivateKeypadWindow -> InvokeUIScreen, and the
 * pushed HUDKeypadWindow grabs the root keyboard/mouse (XModalWindow::
 * VisibilityChanged), places the cursor (SetCursorPos -> ProcessMouseMove) and
 * takes EnterLeave focus. Browser digits go through game.windowKey ->
 * XRootWindow::Process -> HandleVirtualKeyboard -> HUDKeypadWindow.
 * VirtualKeyPressed -> PressButton/ActivateButton; the fourth digit runs
 * ValidateCode, whose KeypadDelay timer (AddTimer/InvokeTimers) pops and
 * destroys the window. docs/script-window-input.md. */
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
const runtime = game.doors.scriptRuntime.runtime, host = game.hud.host, W = host.W;
const player = game.player.collisionActor, level = runtime.levelFor(player);
const get = (object, name) => runtime.namedReference(object, name).get();
const className = object => object ? runtime.instance(object).cls.record.name : null;
// A failed assert.equal on live runtime objects asks Node to format both
// object graphs. These identity checks are deliberately strict but report only
// a scalar message, keeping a regression bounded under the validator RSS cap.
const sameReference = (actual, expected, message) => assert.ok(actual === expected, message);
const input = createPlayerInputFixture(game, {paint: () => game.hud.commands(1432, 1268,
  {location: game.player.eye, rotation: game.player.viewRotation, fov: 75})});
// Every frame also paints the HUD at the browser's canvas size, like the viewer.
const paint = () => game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
const tick = frames => input.tick(frames);
const scriptStack = [];
let failedStack = null;
const callFunction = runtime.callFunction.bind(runtime);
runtime.callFunction = (record, receiver, ...rest) => {
  scriptStack.push(record?.key ?? '?');
  try { return callFunction(record, receiver, ...rest); }
  catch (error) { failedStack ??= [...scriptStack]; throw error; }
  finally { scriptStack.pop(); }
};
const events = [];
const processEvent = runtime.processEvent.bind(runtime);
runtime.processEvent = (receiver, event, ...rest) => { events.push(event); return processEvent(receiver, event, ...rest); };

tick(60);
const keypad = level.actors.find(actor => actor?.name === 'Keypad0');
assert.equal(get(keypad, 'validCode'), '0012');
// Placing beside Keypad0 enters Training's DataLink trigger. Its InfoLink
// display is a delegated legacy subtree that ShowHud(False) must not walk into.
input.aim(keypad);
tick(30);
assert.ok(game.doors.scriptRuntime.dataLinkPresentation(), 'the Training DataLink is being presented');
// Player physics runs during the 30 settling frames; re-aim from the current
// position so the real FrobTarget is still Keypad0 when game.use dispatches.
input.aim(keypad, {position: [...game.player.position]});
const selectedAfterSettle = get(player, 'FrobTarget');
sameReference(selectedAfterSettle, keypad,
  `HighlightCenterObject targets the keypad immediately before Frob (selected=${selectedAfterSettle?.name ?? 'None'}/${className(selectedAfterSettle) ?? 'null'}, ` +
  `player=${JSON.stringify(game.player.position)}, view=${JSON.stringify(game.player.viewRotation)}, ` +
  `keypad=${JSON.stringify(get(keypad, 'Location'))})`);
// The last painted aim frame runs FrobDisplayWindow.DrawWindow -> FormatString
// on the keypad's hack strength, which needs FloatToString (VM opcode 0x55).
assert.deepEqual(game.use(), {ok: true, message: ''}, 'Keypad.Frob opens the original keypad screen');
tick(10);

const rootWindow = get(player, 'rootWindow');
const topModal = () => { let w = W.ptr(rootWindow, 0x140); while (w && W.u8(w, 0x28) < 2) w = W.ptr(w, 0x144); return w; };
const window = topModal();
assert.equal(className(window), 'HUDKeypadWindow');
sameReference(get(keypad, 'keypadwindow'), window, 'Keypad.keypadwindow owns the modal');
assert.equal(W.i32(rootWindow, 0x5d0), 1, 'the modal grabs keyboard events');
assert.equal(W.i32(rootWindow, 0x5cc), 1, 'the modal grabs mouse events');
// HUDKeypadWindow.Tick's SetCursorPos(width, height) puts the cursor on the
// keypad's bottom-right corner (outside every button, as FindWindowByPoint
// needs x < width). The keypad is not selectable, so EnterLeave focus stays empty
// and keys go to the keypad as the top modal.
const clip = [W.f32(window, 0xd4), W.f32(window, 0xd8)];
assert.deepEqual([W.f32(rootWindow, 0x590), W.f32(rootWindow, 0x594)],
  [Math.fround(clip[0] + W.f32(window, 0x80)), Math.fround(clip[1] + W.f32(window, 0x84))], 'SetCursorPos places the cursor at the keypad corner');
sameReference(W.ptr(rootWindow, 0x5a0), window, 'ProcessMouseMove records the keypad as the mouse window');
sameReference(W.ptr(rootWindow, 0x5c8), null, 'the unselectable keypad takes no EnterLeave focus');
const drawn = new Set(paint().map(command => command.texture?.name));
for (const texture of ['MaskTexture', 'HUDKeypadBackground', 'HUDKeypadBorder', 'HUDKeypadButton_Normal', 'DeusExCursor1', 'DeusExCursor1_Shadow'])
  assert.ok(drawn.has(texture), `PaintWindows draws ${texture} (the keypad, MaskBackground and the grabbed-mouse cursor)`);

assert.equal(game.windowKey('KeyW', true), true, 'a grabbed root consumes movement keys');
assert.equal(game.windowKey('KeyW', false), true);
const recipients = game.collision.movers.filter(mover => String(get(mover, 'Tag')).toLowerCase() === 'paddoor');
assert.deepEqual(recipients.map(mover => mover.name).sort(), ['DeusExMover18', 'DeusExMover26']);
assert.ok(recipients.every(mover => !mover.interpolation.interpolating), 'the paddoor movers start closed');
for (const [index, digit] of [...'0012'].entries()) {
  assert.equal(game.windowKey(`Digit${digit}`, true), true);
  tick(2);
  assert.equal(game.windowKey(`Digit${digit}`, false), true);
  tick(12);
  assert.equal(get(window, 'inputCode'), '0012'.slice(0, index + 1), `digit ${digit} reaches HUDKeypadWindow.PressButton`);
}
assert.equal(get(get(window, 'winText'), 'Text') ?? null, '~~GRANTED~~', 'ValidateCode accepts the code');
assert.ok(recipients.every(mover => mover.interpolation.interpolating && mover.interpolation.key === 1),
  'KeypadRunEvents triggers both paddoor movers');

// KeypadDelay now completes PopWindow -> UnPauseGame -> GameInfo.SetPause.
const viewport = get(player, 'Player'), consoleObject = get(viewport, 'Console');
runtime.gotoState(consoleObject, 'Menuing');
assert.equal(runtime.instance(consoleObject).state.stateNode.record.key, 'engine.console.menuing');
runtime.namedReference(level.actors[0], 'Pauser').set('Close reference');
tick(90);
assert.equal(failedStack, null, 'the original close chain completes');
assert.equal(get(rootWindow, 'bUIPaused'), false);
assert.equal(W.u8(rootWindow, 0x3c), 0, 'DSTY_None clears the background style');
assert.ok(W.u32(get(rootWindow, 'hud'), 0x30) & 1, 'ShowHud restores HUD visibility');
assert.equal(get(player, 'bShowMenu'), false);
assert.equal(get(level.actors[0], 'Pauser'), '', 'GameInfo.SetPause(False) clears Pauser');
sameReference(viewport, level.engine.client.viewports[0], 'attached viewport is first in Client.Viewports');
assert.equal(className(viewport), 'Viewport');
sameReference(get(viewport, 'Actor'), player, 'Viewport.Actor is the player');
sameReference(get(consoleObject, 'Viewport'), viewport, 'Console.Viewport is attached');
assert.equal(className(consoleObject), 'Console');
assert.equal(get(consoleObject, 'TopLine'), 63);
assert.equal(get(consoleObject, 'BorderSize'), 1);
sameReference(runtime.instance(consoleObject).state.stateNode, null, 'Console leaves Menuing');
assert.ok(events.includes('KeypadDelay'), 'InvokeTimers ran the KeypadDelay timer function');
assert.equal(host.isDestroyed(window), true, 'PopWindow destroyed the keypad window');
sameReference(get(keypad, 'keypadwindow'), null, 'HUDKeypadWindow.DestroyWindow cleared the owner');
assert.equal(W.i32(rootWindow, 0x5d0), 0, 'hiding the modal released the keyboard grab');
assert.equal(W.i32(rootWindow, 0x5cc), 0, 'hiding the modal released the mouse grab');
sameReference(runtime.callFunction(runtime.lookup(player, 'GetPlayerPawn'), player), player,
  'native 720 still follows Client.Viewports[0].Actor');
assert.equal(typeof runtime.callFunction(runtime.lookup(player, 'ConsoleCommand'), player, 1, ()=>'KEYBINDING W'), 'string');
assert.notEqual(runtime.callFunction(runtime.lookup(player, 'GetDisplayName'), player, 1, ()=>keypad), '',
  'GetDisplayName still sees Player');
console.log('Keypad0 opens with the DataLink active, grabs input, places the cursor, accepts 0012 through original key routing, opens both paddoor movers, ' +
  'and its KeypadDelay timer destroys the window and completes UnPauseGame through the attached Viewport/Console and GameInfo.SetPause');
