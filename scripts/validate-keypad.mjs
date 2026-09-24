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
// Face +X, toward the keypad from the placement below, so HighlightCenterObject
// targets it and FrobDisplayWindow draws its hack strength (FloatToString).
const idle = {forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false};
// Every frame also paints the HUD at the browser's canvas size, like the viewer.
const paint = () => game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
const tick = frames => { for (let i = 0; i < frames; i++) { game.tick(1 / 60, idle); paint(); } };
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
const at = get(keypad, 'Location');
game.collision.queries.changeActor(player, () => { game.player.position = [at[0] - 48, at[1], at[2]]; game.player.velocity = [0, 0, 0]; });
// Standing here also starts Training's DataLink, whose InfoLink display is a
// delegated legacy subtree that ShowHud(False) must not walk into.
tick(30);
assert.equal(get(player, 'FrobTarget'), keypad, 'HighlightCenterObject targets the keypad');
// Those painted frames ran FrobDisplayWindow.DrawWindow -> FormatString on the
// keypad's hack strength, which needs FloatToString (VM opcode 0x55).
assert.ok(game.doors.scriptRuntime.dataLinkPresentation(), 'the Training DataLink is being presented');
game.interaction.frobTarget = keypad;
assert.deepEqual(game.use(), {ok: true, message: ''}, 'Keypad.Frob opens the original keypad screen');
tick(10);

const rootWindow = get(player, 'rootWindow');
const topModal = () => { let w = W.ptr(rootWindow, 0x140); while (w && W.u8(w, 0x28) < 2) w = W.ptr(w, 0x144); return w; };
const window = topModal();
assert.equal(className(window), 'HUDKeypadWindow');
assert.equal(get(keypad, 'keypadwindow'), window);
assert.equal(W.i32(rootWindow, 0x5d0), 1, 'the modal grabs keyboard events');
assert.equal(W.i32(rootWindow, 0x5cc), 1, 'the modal grabs mouse events');
// HUDKeypadWindow.Tick's SetCursorPos(width, height) puts the cursor on the
// keypad's bottom-right corner (outside every button, as FindWindowByPoint
// needs x < width). The keypad is not selectable, so EnterLeave focus stays empty
// and keys go to the keypad as the top modal.
const clip = [W.f32(window, 0xd4), W.f32(window, 0xd8)];
assert.deepEqual([W.f32(rootWindow, 0x590), W.f32(rootWindow, 0x594)],
  [Math.fround(clip[0] + W.f32(window, 0x80)), Math.fround(clip[1] + W.f32(window, 0x84))], 'SetCursorPos places the cursor at the keypad corner');
assert.equal(W.ptr(rootWindow, 0x5a0), window, 'ProcessMouseMove records the keypad as the mouse window');
assert.equal(W.ptr(rootWindow, 0x5c8), null, 'the unselectable keypad takes no EnterLeave focus');
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

// KeypadDelay fires one second later and PopWindow destroys the keypad. The
// following DeusExRootWindow.UnPauseGame reads parentPawn.Player.Console: Play's
// viewport is a host listener without the original UPlayer/Console objects.
assert.throws(() => tick(90), /not attached to script runtime/);
assert.equal(failedStack?.at(-1), 'deusex.deusexrootwindow.unpausegame', 'the stop is UnPauseGame after PopWindow');
assert.equal(failedStack[0], 'deusex.deusexrootwindow.popwindow', 'the stop is inside root.PopWindow');
assert.ok(events.includes('KeypadDelay'), 'InvokeTimers ran the KeypadDelay timer function');
assert.equal(host.isDestroyed(window), true, 'PopWindow destroyed the keypad window');
assert.equal(get(keypad, 'keypadwindow'), null, 'HUDKeypadWindow.DestroyWindow cleared the owner');
assert.equal(W.i32(rootWindow, 0x5d0), 0, 'hiding the modal released the keyboard grab');
assert.equal(W.i32(rootWindow, 0x5cc), 0, 'hiding the modal released the mouse grab');
console.log('Keypad0 opens with the DataLink active, grabs input, places the cursor, accepts 0012 through original key routing, opens both paddoor movers, ' +
  'and its KeypadDelay timer destroys the window; UnPauseGame\'s Player.Console remains the explicit boundary');
