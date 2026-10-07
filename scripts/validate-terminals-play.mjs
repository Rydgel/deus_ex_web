/** Reach of the computer terminals in Play through the original frob path
 * (an integration check of original scripts already translated elsewhere;
 * docs/script-window-computer-terminals.md).
 *
 * Each terminal is approached from its front (Location + 56 units along its
 * Rotation yaw): ATM0 is mounted in a wall, and an approach from behind puts
 * the eye inside the BSP, where HighlightCenterObject's TraceActors starts
 * in solid and selects nothing. Computers are bStasis actors: they tick only
 * once seen, and an authored-on computer then plays its Deactivate animation
 * (state Off), during which Computers.Frob ignores the player (bAnimating).
 * So the check aims, waits for the animation, aims again and uses. Keys go
 * through game.inputKey and characters through game.inputChar.
 *
 * 01_NYC_UNATCOIsland:
 *  - ATM0 (ATMWindow): a wrong PIN is refused; account 230023 / PIN 4558
 *    opens the withdraw screen with balance 200; withdrawing 50 adds 50 to
 *    the player's Credits and leaves 150; Escape logs out to the login
 *    screen and a second Escape closes the ATM.
 *  - ComputerPersonal0 (NetworkTerminalPersonal): KLloyd/squishy opens the
 *    e-mail screen with its list (01_EmailMenu_klloyd) and the first
 *    message's text; Escape logs out, and Escape on the login screen closes
 *    the terminal.
 *  - ComputerSecurity1 (NetworkTerminalSecurity): the login succeeds and
 *    the security screen's camera ViewportWindows are admitted
 *    (docs/script-window-viewport.md); the screen then stops at its pan
 *    slider's ScaleManagerWindow native 1667 (SetMarginSpacing), which is
 *    not translated yet (an explicit, labelled boundary).
 * 01_NYC_UNATCOHQ:
 *  - ComputerPublic0 (NetworkTerminalPublic): six bulletins, the first shown,
 *    Down shows the second, Escape closes, and the computer turns off.
 *
 * Each terminal runs in its own child process (`--map M --terminal T`) on a
 * fresh game. Headless runs draw no world, so nothing stamps the zones' or
 * the actors' LastRenderTime; after 5 s of level time a bStasis computer
 * (Physics None) is in stasis and its Activate animation would stop. Play
 * stamps them from its drawn set (sim-session.mjs stamps). */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const option = name => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const RUNS = [['01_NYC_UNATCOIsland', 'ATM0'], ['01_NYC_UNATCOIsland', 'ComputerPersonal0'],
  ['01_NYC_UNATCOIsland', 'ComputerSecurity1'], ['01_NYC_UNATCOHQ', 'ComputerPublic0']];
if (!option('map')) {
  for (const [map, terminal] of RUNS) {
    const child = spawnSync(process.execPath, [import.meta.filename, '--map', map, '--terminal', terminal],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']});
    process.stdout.write(child.stdout ?? '');
    if (child.status !== 0) { console.error(`terminals-play ${map} ${terminal} failed (${child.signal ?? child.status})`); process.exit(1); }
  }
  process.exit(0);
}
const map = option('map'), only = option('terminal');
const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, host = game.hud.host, W = host.W, player = game.player.collisionActor;
const paint = () => game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
const input = createPlayerInputFixture(game, {paint});
input.tick(30);

const rd = (object, name) => runtime.readNamed(object, name);
const cls = win => win ? runtime.instance(win).cls.record.key : null;
const rootWindow = rd(player, 'rootWindow');
const topWindow = () => { let w = W.ptr(rootWindow, 0x140); while (w && W.u8(w, 0x28) < 2) w = W.ptr(w, 0x144); return w || null; };
const focus = () => W.ptr(rootWindow, 0x5c8);
const textOf = win => W.heap.read(win, 0x168, 'string');
const level = runtime.levelFor(player);
const actor = name => level.actors.find(a => a?.name === name);
const key = code => { game.inputKey(code, true); game.inputKey(code, false); input.tick(1); };
const type = (code, ch, shift = false) => {
  if (shift) game.inputKey('ShiftLeft', true);
  game.inputKey(code, true); game.inputChar(ch.charCodeAt(0)); game.inputKey(code, false);
  if (shift) game.inputKey('ShiftLeft', false);
  input.tick(1);
};
const typeText = text => { for (const ch of text) type(/[0-9]/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`, ch, ch !== ch.toLowerCase()); };
const enter = () => { game.inputKey('Enter', true); game.inputChar(0x0d); game.inputKey('Enter', false); input.tick(5); };
const listRows = list => {
  const rows = [];
  for (let i = 0; i < W.i32(list, 0x174); i++) {
    const node = W.heap.mem.read(W.u32(list, 0x170) + 4 * i, 'u32'), fields = W.heap.mem.read(node + 8, 'u32');
    const data = W.heap.mem.read(fields, 'u32'), num = W.heap.mem.read(fields + 4, 'i32');
    let s = ''; for (let j = 0; j < num - 1; j++) s += String.fromCharCode(W.heap.mem.read(data + 2 * j, 'u16'));
    rows.push(s);
  }
  return rows;
};
/** Frob a terminal from its front, through the real view trace and use. */
function open(name) {
  const target = actor(name), at = rd(target, 'Location'), yaw = rd(target, 'Rotation')[1] * Math.PI / 32768;
  input.aim(target, {position: [at[0] + Math.cos(yaw) * 56, at[1] + Math.sin(yaw) * 56, at[2]]});
  // Computers.bAnimating (an ATM has no activation animation).
  const animating = () => { try { return rd(target, 'bAnimating'); } catch { return false; } };
  for (let i = 0; i < 600 && (i < 10 || animating()); i++) input.tick(1);
  input.aim(target, {position: [...game.player.position]});
  assert.deepEqual(game.use(), {ok: true, message: ''}, `${name}: use`);
  for (let i = 0; i < 300 && !topWindow(); i++) input.tick(1);
  input.tick(5);
  return {target, terminal: topWindow()};
}
const checks = [];

{ // 01_NYC_UNATCOIsland
  if (only === 'ATM0') {
    const {target, terminal} = open('ATM0');
    assert.equal(cls(terminal), 'deusex.atmwindow');
    const login = rd(terminal, 'winComputer');
    assert.equal(cls(login), 'deusex.computerscreenatm');
    assert.equal(focus(), rd(login, 'editAccount'), 'the account field has the focus');
    typeText('230023'); key('Tab'); typeText('1111'); enter();
    assert.equal(cls(rd(terminal, 'winComputer')), 'deusex.computerscreenatm', 'a wrong PIN is refused');
    assert.equal(focus(), rd(login, 'editAccount'));
    typeText('230023'); key('Tab'); typeText('4558'); enter();
    const withdraw = rd(terminal, 'winComputer');
    assert.equal(cls(withdraw), 'deusex.computerscreenatmwithdraw', 'account 230023 / PIN 4558 logs in');
    assert.equal(textOf(rd(withdraw, 'editBalance')), '200');
    const credits = rd(player, 'Credits');
    typeText('50'); enter();
    assert.equal(rd(player, 'Credits'), credits + 50, 'the withdrawn credits reach the player');
    assert.equal(rd(target, 'userList')[0]['deusex.atm.suserinfo.balance'], 150, "the account's balance drops by 50");
    assert.equal(textOf(rd(withdraw, 'editBalance')), '150');
    assert.equal(textOf(rd(withdraw, 'winInfo')), '50 CREDITS WITHDRAWN');
    key('Escape'); input.tick(2);
    assert.equal(cls(rd(terminal, 'winComputer')), 'deusex.computerscreenatm', 'Escape logs out');
    key('Escape'); input.tick(5);
    assert.equal(topWindow(), null, 'Escape on the login screen closes the ATM');
    checks.push(`ATM0: login, withdraw 50 (Credits ${credits} -> ${credits + 50}, balance 200 -> 150), logout, close`);
  }
  if (only === 'ComputerPersonal0') {
    const {terminal} = open('ComputerPersonal0');
    assert.equal(cls(terminal), 'deusex.networkterminalpersonal');
    // GUEST has no 01_EmailMenu_GUEST text ("No Email Today!"); KLloyd does.
    typeText('KLloyd'); key('Tab'); typeText('squishy'); enter();
    const email = rd(terminal, 'winComputer');
    assert.equal(cls(email), 'deusex.computerscreenemail', 'KLloyd/squishy opens the e-mail screen');
    const rows = listRows(rd(email, 'lstEmail'));
    assert.ok(rows.length > 0, 'the e-mail list has messages');
    const body = textOf(rd(email, 'winEmail'));
    assert.ok(body.length > 0 && body !== 'No Email Today!', 'the first message is shown');
    key('Escape'); input.tick(2);
    assert.equal(cls(rd(terminal, 'winComputer')), 'deusex.computerscreenlogin', 'Escape logs out');
    key('Escape'); input.tick(5);
    assert.equal(topWindow(), null, 'Escape on the login screen closes the terminal');
    checks.push(`ComputerPersonal0: KLloyd, ${rows.length} e-mail(s) ("${rows[0]}"), logout, close`);
  }
  // The login works; the pan slider's ScaleManager native is the boundary.
  if (only === 'ComputerSecurity1') {
    const {terminal} = open('ComputerSecurity1');
    assert.equal(cls(terminal), 'deusex.networkterminalsecurity');
    assert.equal(cls(rd(terminal, 'winComputer')), 'deusex.computerscreenlogin');
    typeText('NSF001'); key('Tab');
    for (const ch of 'smashthestate') type(`Key${ch.toUpperCase()}`, ch);
    let boundary = null;
    try { enter(); } catch (error) { boundary = String(error.message).split('\n')[0]; }
    assert.equal(rd(terminal, 'userName'), 'NSF001', 'the security login succeeds');
    assert.match(boundary ?? '', /Unsupported original door native 1667 in menuuisliderbuttonwindow\.initwindow/,
      'the security screen stops at the pan slider native 1667 (explicitly unsupported)');
    checks.push('ComputerSecurity1: NSF001 logs in; the pan slider ScaleManager native 1667 is unsupported');
  }
}
if (only === 'ComputerPublic0') {
  const {target, terminal} = open('ComputerPublic0');
  assert.equal(cls(terminal), 'deusex.networkterminalpublic');
  const bulletins = rd(terminal, 'winComputer');
  assert.equal(cls(bulletins), 'deusex.computerscreenbulletins');
  const rows = listRows(rd(bulletins, 'lstBulletins'));
  assert.equal(rows.length, 6, 'six bulletins');
  const text = rd(bulletins, 'winBulletin');
  assert.ok(textOf(text).startsWith(rows[0]), 'the first bulletin is shown');
  key('ArrowDown'); input.tick(1);
  assert.ok(textOf(text).startsWith(rows[1]), 'Down shows the second bulletin');
  key('Escape'); input.tick(5);
  assert.notEqual(cls(topWindow()), 'deusex.networkterminalpublic', 'Escape closes the terminal');
  for (let i = 0; i < 120 && rd(target, 'bOn'); i++) input.tick(1);
  assert.equal(rd(target, 'bOn'), false, 'the computer turns off');
  checks.push(`ComputerPublic0: ${rows.length} bulletins, pages, close`);
}
if (!checks.length) throw new Error(`No terminal check for ${map} ${only}`);
console.log(`terminals-play ${map}: ${checks.join('; ')}`);
process.exit(0);
