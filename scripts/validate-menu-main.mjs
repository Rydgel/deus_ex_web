/** Stage 6 row 6.1.6: every MenuMain entry reaches its screen or action (Multiplayer excluded), in Play against the original's own window stack.
 *
 * The original under Wine (`--capture`: scripts/travel-probe.sh mm1 with the steps below, written to .work/travel/mm1-steps.txt; the capture stays in
 * .work/travel/mm1, outside Git) and Play headless take the same inputs: on the logo map DX.dx a click opens MenuMain, then each entry's button is clicked
 * and Escape goes back; in a running game (a cold open of 15_Area51_Final, the original's `open`) Escape opens MenuMain, then Save Game, Training and
 * Play Intro (each asks first in a running game: MenuUIWindow.ConfirmTraining/ConfirmIntro), Back to Game, Escape again and Exit with Enter for Yes.
 * After every step the root's window stack (DeusExRootWindow.winStack[0..winCount-1]; tools/dump-actor-win.c at the linked offsets winStack +0x754,
 * winCount +0x76c) is read in both programs and compared by class. A button is clicked where it is: the capture's viewport is 1280x720 (x 641,
 * y = 183 + buttonDefaults.y, measured: New Game at 196 and Training at 340, scripts/chain-original.mjs), Play's at the button's centre through the
 * root's pointer (XRootWindow input: an insensitive button takes no click in either program).
 *
 * Exit's Yes ends the original's process: its engine log ends `Log: appRequestExit(0)` (USystem::Exec EXIT, Core 0x1016bb43, then appRequestExit
 * 0x1016b2f0), then `Exit: Preparing to exit.` and the shutdown. Play's engine log takes the same line and the window host one exit request for the
 * page (docs/host-services.md "Exit"). Not entered here: New Game's Start Game, Training and Play Intro from the logo map, Credits to their end
 * (rows 6.1.2 to 6.1.4), Multiplayer (excluded, AGENTS.md), the Settings screens' controls (docs/settings-menus.md).
 *
 * runner-timeout: 900
 *
 *   node scripts/validate-menu-main.mjs [--capture] */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';
import { loadAssets } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createMenuDriver } from '../src/viewer/menu-driver.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const captureDir = `${ROOT}.work/travel/mm1/`;
const FIELDS = ['winCount:0x76c:u32', ...[0, 1, 2, 3, 4, 5].map(i => `s${i}:0x${(0x754 + 4 * i).toString(16)}:obj`)].join(',');
// MenuMain's buttons (MenuMain.buttonDefaults: New Game 0, Save Game 1, Load Game 2, Settings 3, Training 4, Play Intro 5, Credits 6, Back to Game 7,
// Multiplayer 8, Exit 9) at the capture's 1280x720: x 641, y = 183 + buttonDefaults.y
const BUTTON_Y = [13, 49, 85, 121, 157, 193, 229, 265, 301, 359];

/** The steps: [label, input] with input {open: 'menu'} (a click on the logo map), {button: n}, {key: 'ESC'|'ENTER'}, {map} (a cold open), or null. */
const STEPS = [
  ['l0-before', { wait: 8 }], ['l1-menu', { click: 'menu' }],
  ['l2-newgame', { button: 0 }], ['l3-newgame-esc', { key: 'ESC' }],
  ['l4-save', { button: 1 }],
  ['l5-load', { button: 2 }], ['l6-load-esc', { key: 'ESC' }],
  ['l7-settings', { button: 3 }], ['l8-settings-esc', { key: 'ESC' }],
  ['l9-back', { button: 7 }],
  ['l10-exit', { button: 9 }], ['l11-exit-no', { key: 'ESC' }],
  ['l12-credits', { button: 6, wait: 4 }], ['l13-credits-click', { click: 'menu', wait: 4 }],
  // MenuMain closed before the console line: a key typed over the menu is the menu's (its Enter activates the focused button)
  ['l14-menu-esc', { key: 'ESC' }],
  ['g0-before', { map: '15_Area51_Final', wait: 5 }], ['g1-menu', { key: 'ESC' }],
  ['g2-save', { button: 1 }], ['g3-save-esc', { key: 'ESC' }],
  ['g4-training', { button: 4 }], ['g5-training-no', { key: 'ESC' }],
  ['g6-intro', { button: 5 }], ['g7-intro-no', { key: 'ESC' }],
  ['g8-back', { button: 7 }], ['g9-menu-again', { key: 'ESC' }],
  ['g10-exit', { button: 9 }],
];

/** The probe's step lines (scripts/travel-probe.sh verbs) for the same inputs. */
function probeSteps() {
  const lines = ['# the logo map: MenuMain by a click, each entry, back by Escape (docs/stage-6-exit-criteria.md row 6.1.6)'];
  for (const [label, input] of STEPS) {
    if (input.map) lines.push(`cmd:open ${input.map}`, `arrive:${input.map.toLowerCase()}$`);
    if (input.click) lines.push('click:640 360');
    if (input.button !== undefined) lines.push(`click:641 ${183 + BUTTON_Y[input.button]}`);
    if (input.key) lines.push(`key:${input.key}`);
    lines.push(`wait:${input.wait ?? 2}`, `props:DeusExRootWindow:${label}:${FIELDS}`);
    if (label === 'l13-credits-click') lines.push('snap:logo-end');
    if (label === 'g9-menu-again') lines.push('ini:before-exit', 'snap:before-exit');
  }
  lines.push('key:ENTER', 'wait:10');
  return lines.join('\n') + '\n';
}

if (process.argv.includes('--capture')) {
  await mkdir(`${ROOT}.work/travel`, { recursive: true });
  await writeFile(`${ROOT}.work/travel/mm1-steps.txt`, probeSteps());
  const run = spawnSync(`${ROOT}scripts/travel-probe.sh`, ['mm1', `@${ROOT}.work/travel/mm1-steps.txt`], { stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
try { gameDirectory(); } catch { console.log('SKIP validate-menu-main: no installed game data'); process.exit(0); }
if (!existsSync(`${captureDir}final.log`)) { console.log('SKIP validate-menu-main: the capture is not in .work/travel/mm1 (outside Git; --capture takes it)'); process.exit(0); }

/** The original's stack after a step: the class of each winStack entry (an object's name is its class and a number: MenuMain0). */
async function measuredStack(label) {
  const text = await readFile(`${captureDir}${label}.props.txt`, 'utf8');
  const line = text.split('\n').find(row => row.startsWith('DeusExRootWindow '));
  if (!line) throw new Error(`${label}: no DeusExRootWindow in the dump`);
  const field = name => new RegExp(`\\b${name}=(\\S+)`).exec(line)?.[1];
  const count = Number(field('winCount'));
  return Array.from({ length: count }, (_, i) => String(field(`s${i}`)).replace(/\d+$/, '').toLowerCase());
}

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
const assets = await loadAssets();
let c = null, driver = null;
const stackOf = () => {
  const runtime = c.runtime, root = runtime.readNamed(c.player(), 'rootWindow');
  const count = runtime.readNamed(root, 'winCount'), stack = runtime.readNamed(root, 'winStack');
  return stack.slice(0, count).map(win => runtime.instance(win).cls.record.key.replace(/^.*\./, ''));
};
const click = (x, y) => { for (const action of [1, 3]) { c.game.windowPointer({ relative: false, x, y, key: 1, action }); c.frames(2); } };
const KEYS = { ESC: 'Escape', ENTER: 'Enter' };
const consoleLine = line => c.game.hud.scoped(() => c.game.hud.host.consoleCommands.consoleCommand(c.player(), line));
// The capture's User.ini (the prefix's): bAskedToTrain True there, so New Game opens the difficulty screen with no "train first?" box. Play's player takes the
// same setting (the shipped default is False): the menus read it, the comparison is of the same configuration.
const askedToTrain = /^bAskedToTrain=True\s*$/im.test(await readFile(`${captureDir}before-exit.User.ini`, 'latin1'));
async function openCold(map) {
  ({ c } = await openSession(map, assets, { travel: {} }));
  // the original's `open` leaves the player's FlagBase empty (tools/dump-flags-win.c: 0 flags): Play's fresh-mission marker goes
  const base = c.read(c.player(), 'FlagBase'), call = ['PlayerTraveling', 0];
  c.runtime.callFunction(c.runtime.lookup(base, 'DeleteFlag'), base, call.length, i => call[i]);
  if (askedToTrain) consoleLine('set DeusEx.DeusExPlayer bAskedToTrain True');
  if (Boolean(c.read(c.player(), 'bAskedToTrain')) !== askedToTrain) throw new Error(`the player's bAskedToTrain is not the capture's ${askedToTrain}`);
  driver = createMenuDriver(c.game);
}

await openCold('DX');
for (const [label, input] of STEPS) {
  if (input.map) await openCold(input.map);
  if (input.click) {
    // the logo map: the left button is the player's Fire (Paralyzed.Fire -> ShowMainMenu); over a window, the root's pointer
    if (stackOf().length) { const root = c.runtime.readNamed(c.player(), 'rootWindow'); click(driver.W.f32(root, 0xe4) / 2, driver.W.f32(root, 0xe8) / 2); }
    else { c.game.inputButton('LeftMouse', true); c.frames(2); c.game.inputButton('LeftMouse', false); c.frames(2); }
  }
  if (input.button !== undefined) {
    const { x, y } = driver.center({ field: 'winButtons', index: input.button });
    click(x, y);
  }
  if (input.key) c.key(KEYS[input.key]);
  c.frames(Math.round(60 * (input.wait ?? 2)));
  const got = stackOf(), want = await measuredStack(label);
  check(JSON.stringify(got) === JSON.stringify(want), `${label}: Play's window stack [${got}] (the original's [${want}])`);
  console.log(`${label}: [${got.join(', ')}]${JSON.stringify(got) === JSON.stringify(want) ? '' : `  DIFFERS from the original's [${want.join(', ')}]`}`);
}

// Exit's Yes: the original's log ends its last level's lines with appRequestExit(0), then the shutdown
const logBefore = c.game.doors.scriptRuntime.engineLog.length;
c.key('Enter'); c.frames(10);
const playLines = c.game.doors.scriptRuntime.engineLog.slice(logBefore);
const display = c.game.hud.host.display;
const original = (await readFile(`${captureDir}final.log`, 'utf8')).split(/\r?\n/);
const exitAt = original.indexOf('Log: appRequestExit(0)');
check(exitAt > 0 && original[exitAt + 1] === 'Exit: Preparing to exit.', `the original's log has no appRequestExit(0) followed by the exit (line ${exitAt})`);
check(JSON.stringify(playLines) === JSON.stringify(['Log: appRequestExit(0)']), `Exit's Yes: Play's engine log took ${JSON.stringify(playLines)} (the original: appRequestExit(0))`);
check(display.exitRequests === 1, `Exit's Yes: ${display.exitRequests} exit requests for the page (expected 1)`);
check(stackOf().length === 0, `Exit's Yes: the window stack is [${stackOf()}] (DeusExRootWindow.ExitGame clears it first)`);
console.log(`g11-exit-yes: engine log ${JSON.stringify(playLines)}, exit requests ${display.exitRequests}, window stack [${stackOf().join(', ')}]`);

if (failures.length) { console.log(`FAIL validate-menu-main:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS validate-menu-main: ${STEPS.length} window stacks equal the original's, and Exit's Yes requests the exit`);
process.exit(0);
