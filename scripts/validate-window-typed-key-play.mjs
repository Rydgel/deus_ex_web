/** Play integration of the typed-character route (an integration check; the
 * route's bodies are compared by validate-window-typed-key-diff.mjs, the
 * Edit and List KeyPressed bodies by validate-text-layout-diff.mjs and
 * validate-window-list-family.mjs).
 *
 * One 00_Training game. Every key goes through game.inputKey (UEngine::
 * InputEvent, the installed User.ini bindings, XInputExt::Process) and every
 * character it would type through game.inputChar (WM_CHAR/WM_SYSCHAR ->
 * XGameEngineExt::Key), in the order WinDrv receives them: key press, its
 * characters, key release.
 *
 *  1. No window grabs the keyboard: a typed character reaches nothing.
 *  2. Console Talk through T, which DeusExRootWindow binds to Talk when the
 *     multiplayer keys are free ("SET InputExt T Talk"): Console.Typing's
 *     KeyType swallows the 't' that started it (bNoStuff), appends "hi",
 *     refuses '`' and 0xe9 (only 0x20..0x7f); the Escape press clears the
 *     line and its release leaves Typing (KeyEvent does not test Action).
 *  3. Goals screen (F2): Alt+N reaches the "Add |&Note" button through the
 *     modal's accelerator table; the new PersonaNotesEditWindow takes "Hi\ é€"
 *     (its FilterChar refuses the backslash), Backspace deletes the last
 *     character, and Tab's focus change saves "Hi é" into the DeusExNote.
 *  4. Logs screen: with the list focused by a click, the unbound 'h' cycles
 *     through the rows starting with h/H, a mismatching prefix keeps the
 *     focus row, and after the 1 s hot-key timeout 'j' finds "Juliet". (A
 *     bound letter runs its binding first: G switches to the Goals screen.)
 *  5. Main menu -> New Game -> difficulty -> MenuScreenNewGame: typing over
 *     the selected "JC Denton" in the name field gives "Paul", Backspace
 *     "Pau", and the field is editing.
 *  6. 01_NYC_UNATCOIsland, ComputerPersonal0 (frobbed through the public use
 *     path): the login screen's user name and password fields take typed
 *     text, Tab moves between them and Enter runs ComputerScreenLogin's
 *     EditActivated. A wrong password clears both fields; GUEST/guest logs in
 *     (Caps compare) and the terminal shows its e-mail screen.
 *
 * Parts 1-5 run on 00_Training and part 6 on the Island, each map in its
 * own child process (`--map`), so the two games never share a heap.
 * docs/script-window-typed-keys.md. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const mapOption = process.argv.indexOf('--map');
if (mapOption < 0) {
  for (const map of ['00_Training', '01_NYC_UNATCOIsland']) {
    const child = spawnSync(process.execPath, [import.meta.filename, '--map', map], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']});
    process.stdout.write(child.stdout ?? '');
    if (child.status !== 0) { console.error(`window-typed-key-play ${map} failed (${child.signal ?? child.status})`); process.exit(1); }
  }
  process.exit(0);
}
const map = process.argv[mapOption + 1];
const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, host = game.hud.host, W = host.W, player = game.player.collisionActor;
const paint = () => game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
const input = createPlayerInputFixture(game, {paint});
input.tick(30);

const rootWindow = runtime.namedReference(player, 'rootWindow').get();
const cls = win => win ? runtime.instance(win).cls.record.key : null;
const topWindow = () => { let w = W.ptr(rootWindow, 0x140); while (w && W.u8(w, 0x28) < 2) w = W.ptr(w, 0x144); return w || null; };
const focus = () => W.ptr(rootWindow, 0x5c8);
const textOf = win => W.heap.read(win, 0x168, 'string');
const press = code => { game.inputKey(code, true); game.inputKey(code, false); input.tick(1); };
/** A keydown, the characters TranslateMessage posts for it, the keyup. */
const type = (code, text, {shift = false, alt = false} = {}) => {
  if (alt) game.inputKey('AltLeft', true);
  if (shift) game.inputKey('ShiftLeft', true);
  game.inputKey(code, true);
  const results = [...text].map(ch => game.inputChar(ch.charCodeAt(0)));
  game.inputKey(code, false);
  if (shift) game.inputKey('ShiftLeft', false);
  if (alt) game.inputKey('AltLeft', false);
  input.tick(1);
  return results;
};
const checks = [];

if (map === '00_Training') {
  // 1. Nothing grabs the keyboard.
  assert.equal(W.i32(rootWindow, 0x5d0), 0, 'no window grabs the keyboard in the world');
  assert.deepEqual(type('KeyJ', 'j'), [{handled: false, console: false}], 'a typed character reaches nothing');
  checks.push('no grab: unhandled');

  // 2. Console Talk.
  const viewport = runtime.readNamed(player, 'Player'), console_ = runtime.readNamed(viewport, 'Console');
  const consoleState = () => runtime.instance(console_).state?.stateNode?.record.name ?? null;
  const typed = () => runtime.readNamed(console_, 'TypedStr');
  const keyT = host.inputKeyNames.findIndex(name => name?.toLowerCase() === 'ik_t');
  assert.equal(host.input.bindings[keyT], 'Talk', "DeusExRootWindow bound T to Talk ('SET InputExt T Talk')");
  assert.deepEqual(type('KeyT', 't'), [{handled: true, console: true}], "Console.KeyType takes the 't' that started Talk");
  assert.equal(consoleState(), 'Typing');
  assert.equal(typed(), 'Say ', 'bNoStuff swallowed it');
  type('KeyH', 'h'); type('KeyI', 'i');
  assert.equal(typed(), 'Say hi');
  assert.deepEqual(type('Backquote', '`'), [{handled: false, console: false}], 'Typing refuses `');
  assert.deepEqual(type('KeyE', 'é'), [{handled: false, console: false}], 'Typing refuses 0xe9 (Key < 0x80)');
  assert.equal(typed(), 'Say hi');
  game.inputKey('Escape', true);
  assert.deepEqual([typed(), consoleState()], ['', 'Typing'], 'the Escape press clears the line');
  game.inputKey('Escape', false); input.tick(1);
  assert.equal(consoleState(), null, "its release, also IK_Escape to Typing's KeyEvent, leaves Typing");
  checks.push('Console Talk: "Say hi"');

  // 3. Goals screen: accelerator, note editing, FilterChar, save.
  press('F2'); input.tick(5);
  assert.equal(cls(topWindow()), 'deusex.personascreengoals', 'F2 opens the Goals screen');
  type('KeyN', 'n', {alt: true});
  const note = focus();
  assert.equal(cls(note), 'deusex.personanoteseditwindow', 'Alt+N pressed "Add |&Note" through the accelerator table');
  assert.equal(textOf(note), 'New Note');
  type('KeyH', 'H', {shift: true});
  assert.equal(textOf(note), 'H', 'the typed character replaces the selected default text');
  type('KeyI', 'i'); type('Backslash', '\\'); type('Space', ' '); type('KeyE', 'é'); type('Digit4', '€');
  assert.equal(textOf(note), 'Hi é€', "PersonaNotesEditWindow.FilterChar refuses the backslash; 0xe9 and 0x20ac are kept");
  type('Backspace', '\b');
  assert.equal(textOf(note), 'Hi é', 'Backspace (VirtualKeyPressed) deletes; its 0x08 character inserts nothing');
  type('Tab', '\t');
  assert.notEqual(focus(), note, 'Tab moves the focus out of the note');
  const notes = [];
  for (let n = runtime.readNamed(player, 'FirstNote'); n; n = runtime.readNamed(n, 'next')) notes.push(runtime.readNamed(n, 'text'));
  assert.deepEqual(notes, ['Hi é'], 'FocusLeftDescendant saved the note text');
  press('Escape'); input.tick(5);
  assert.equal(topWindow(), null, 'Escape closes the Goals screen');
  checks.push('Goals note: Alt+N, "Hi é" saved');

  // 4. Logs list hot keys.
  for (const line of ['Juliet one', 'Hotel first', 'Lima', 'hotel second', 'Oscar', 'Hotel third', 'Papa'])
    game.hud.scoped(() => runtime.dispatchSpawnedEvent(player, 'AddLog', [line]));
  assert.equal(game.hud.scoped(() => runtime.scriptConsoleExec(player, 'ShowLogsWindow')), true);
  input.tick(5);
  const lists = [];
  const walk = win => { for (let c = W.ptr(win, 0x13c); c; c = W.ptr(c, 0x148)) { if (host.families(c) === 'extension.listwindow') lists.push(c); walk(c); } };
  walk(rootWindow);
  assert.equal(lists.length, 1, 'the Logs screen has one list');
  const list = lists[0], rows = () => W.i32(list, 0x174);
  const node = i => W.heap.mem.read(W.u32(list, 0x170) + 4 * i, 'u32');
  const rowText = i => { const fields = W.heap.mem.read(node(i) + 8, 'u32'), data = W.heap.mem.read(fields, 'u32'), num = W.heap.mem.read(fields + 4, 'i32');
    let s = ''; for (let j = 0; j < num - 1; j++) s += String.fromCharCode(W.heap.mem.read(data + 2 * j, 'u16')); return s; };
  const focusRow = () => { const f = W.u32(list, 0x1ac); for (let i = 0; i < rows(); i++) if (node(i) === f) return rowText(i); return null; };
  const line = W.f32(list, 0x19c), x = W.f32(list, 0xd4) + 20, y = W.f32(list, 0xd8) + 0.5 * line;
  game.windowPointer({x, y, key: 1, action: 1}); game.windowPointer({x, y, key: 1, action: 3}); input.tick(1);
  assert.equal(focus(), list, 'the click focuses the list');
  assert.equal(focusRow(), 'Papa', 'newest first');
  const hot = [];
  for (const ch of 'hhhh') { type(`Key${ch.toUpperCase()}`, ch); hot.push(focusRow()); }
  assert.deepEqual(hot, ['Hotel third', 'hotel second', 'Hotel first', 'Hotel third'], "a repeated 'h' cycles the h/H rows");
  type('KeyO', 'o');
  assert.equal(focusRow(), 'Hotel third', 'the prefix "hhhho" matches no row');
  input.tick(90);
  type('KeyJ', 'j');
  assert.equal(focusRow(), 'Juliet one', "after the 1 s hot-key timeout 'j' starts a new search");
  press('Escape'); input.tick(5);
  assert.equal(topWindow(), null, 'Escape closes the Logs screen');
  checks.push('Logs hot keys');

  // 5. The New Game name field.
  press('Escape'); input.tick(5);
  const menu = topWindow();
  assert.equal(cls(menu), 'deusex.menumain', 'Escape opens the main menu');
  game.hud.scoped(() => W.native.activateButton(runtime.readNamed(menu, 'winButtons')[0], 1));
  input.tick(5);
  assert.equal(cls(topWindow()), 'deusex.menuuimessageboxwindow', 'New Game asks about training first');
  press('KeyN'); input.tick(5);
  assert.equal(cls(topWindow()), 'deusex.menuselectdifficulty');
  press('Enter'); input.tick(5);
  const screen = topWindow(), name = runtime.readNamed(screen, 'editName');
  assert.equal(cls(screen), 'deusex.menuscreennewgame');
  assert.equal(focus(), name, 'the name field has the focus');
  assert.equal(textOf(name), 'JC Denton');
  type('KeyP', 'P', {shift: true}); type('KeyA', 'a'); type('KeyU', 'u'); type('KeyL', 'l');
  assert.equal(textOf(name), 'Paul', 'typing replaces the selected name');
  type('Backspace', '\b');
  assert.equal(textOf(name), 'Pau');
  assert.equal(W.u8(name, 0x1d0) & 1, 1, 'the field is editing');
  checks.push('New Game name: "Pau"');
} else {
  // 6. A computer login on the Island.
  const level = runtime.levelFor(player);
  const computer = level.actors.find(actor => actor?.name === 'ComputerPersonal0');
  input.aim(computer); input.tick(10);
  input.aim(computer, {position: [...game.player.position]});
  assert.deepEqual(game.use(), {ok: true, message: ''}, 'Frob opens the terminal');
  input.tick(10);
  const terminal = topWindow();
  assert.equal(cls(terminal), 'deusex.networkterminalpersonal');
  const login = runtime.readNamed(terminal, 'winComputer');
  assert.equal(cls(login), 'deusex.computerscreenlogin');
  const userName = runtime.readNamed(login, 'editUserName'), password = runtime.readNamed(login, 'editPassword');
  assert.equal(focus(), userName, 'the user name field has the focus');
  const typeText = text => { for (const ch of text) type(/[0-9]/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`, ch, {shift: ch !== ch.toLowerCase()}); };
  typeText('guest');
  assert.equal(textOf(userName), 'guest');
  type('Tab', '\t');
  assert.equal(focus(), password, 'Tab moves to the password field');
  typeText('wrong1');
  assert.equal(textOf(password), 'wrong1');
  type('Enter', '\r');
  assert.deepEqual([textOf(userName), textOf(password), focus() === userName], ['', '', true],
    'a wrong password clears both fields and refocuses the user name');
  typeText('GUEST'); type('Tab', '\t'); typeText('guest'); type('Enter', '\r');
  input.tick(5);
  assert.equal(runtime.readNamed(terminal, 'userName'), 'GUEST', 'ProcessLogin compares in Caps and logs in');
  assert.equal(cls(runtime.readNamed(terminal, 'winComputer')), 'deusex.computerscreenemail', 'the terminal shows its e-mail screen');
  checks.push('Island ComputerPersonal0 login as GUEST');
}

console.log(`window-typed-key-play ${map}: ${checks.join('; ')}`);
process.exit(0);
