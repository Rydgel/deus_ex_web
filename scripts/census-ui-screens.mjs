/** Which of the original's UI screens open, draw and close in Play
 * (Stage 4's remaining native UI presentation). For each screen the player's
 * own exec function (DeusExPlayer.ShowInventoryWindow, ...) runs through
 * ScriptConsoleExec on a fresh game, the HUD paints for a few frames at the
 * browser's canvas size, and Escape closes it. Each result is the topmost
 * window class, or the first error with the script stack that reached it.
 * A census of reach, not a fidelity check.
 *
 * A `MenuScreen...` entry (MenuScreenLoadGame, MenuScreenSaveGame) opens the
 * main menu and activates the MenuMain button whose buttonDefaults invoke
 * that class, through XButtonWindow::ActivateButton like a click. They are
 * not in the default list: both stop at the save-game directory (Stage 6).
 *
 * Each screen runs in its own child Node process (`--single`), so memory does
 * not pile up across games; the parent prints the child's JSON line, or an
 * error line when the child produced none.
 *
 *   node scripts/census-ui-screens.mjs [--map 00_Training] [--screens ShowInventoryWindow,...]
 */
import {spawnSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const map = option('map', '00_Training');
const SCREENS = ['ShowInventoryWindow', 'ShowHealthWindow', 'ShowAugmentationsWindow', 'ShowSkillsWindow',
  'ShowGoalsWindow', 'ShowConversationsWindow', 'ShowImagesWindow', 'ShowLogsWindow', 'ShowQuotesWindow',
  'ShowAugmentationAddWindow', 'ShowMainMenu'];
const screens = option('screens', null)?.split(',') ?? SCREENS;

if (!process.argv.includes('--single')) {
  const results = [];
  for (const screen of screens) {
    const child = spawnSync(process.execPath, [import.meta.filename, '--map', map, '--screens', screen, '--single'],
      {encoding: 'utf8', maxBuffer: 1 << 26});
    const line = (child.stdout ?? '').split('\n').reverse().find(text => text.startsWith('{"screen"'));
    let result;
    try { result = line ? JSON.parse(line) : null; } catch { result = null; }
    if (!result) {
      const reason = child.error?.message ?? (child.signal ? `signal ${child.signal}` : `exit ${child.status}`);
      const tail = (child.stderr ?? '').trim().split('\n').filter(text => text && !text.startsWith('    at ')).slice(-2).join(' | ');
      result = {screen, error: `census child produced no result (${reason}): ${tail}`.slice(0, 300)};
    }
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const failed = results.filter(r => r.error);
  console.log(`census-ui-screens ${map}: ${results.length - failed.length} of ${results.length} screens opened, drew and closed`);
  process.exit(0);
}

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);

const results = [];
for (const screen of screens) {
  const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
  const runtime = game.doors.scriptRuntime.runtime, W = game.hud.host.W, player = game.player.collisionActor;
  const paint = () => game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
  const input = createPlayerInputFixture(game, {paint});
  const stack = [];
  let failedStack = null;
  const callFunction = runtime.callFunction.bind(runtime);
  runtime.callFunction = (record, receiver, ...rest) => {
    stack.push(record?.key ?? '?');
    try { return callFunction(record, receiver, ...rest); }
    catch (error) { failedStack ??= [...stack]; throw error; }
    finally { stack.pop(); }
  };
  const topWindow = () => {
    const rootWindow = runtime.namedReference(player, 'rootWindow').get();
    let window = rootWindow ? W.ptr(rootWindow, 0x140) : 0;
    while (window && W.u8(window, 0x28) < 2) window = W.ptr(window, 0x144);
    return window || null;
  };
  const top = () => { const window = topWindow(); return window ? runtime.instance(window).cls.record.key : null; };
  // MenuMain's button for a menu screen class (MenuUIMenuWindow buttonDefaults[i].invoke).
  const openFromMainMenu = screenClass => {
    game.hud.scoped(() => runtime.scriptConsoleExec(player, 'ShowMainMenu'));
    input.tick(5);
    const menu = topWindow(), defaults = runtime.readNamed(menu, 'buttonDefaults'), buttons = runtime.readNamed(menu, 'winButtons');
    const index = defaults.findIndex(entry => Object.entries(entry).find(([key]) => key.endsWith('.invoke'))?.[1]?.key === `deusex.${screenClass.toLowerCase()}`);
    if (index < 0) throw new Error(`MenuMain has no button invoking ${screenClass}`);
    game.hud.scoped(() => W.native.activateButton(buttons[index], 1));
    return true;
  };
  const result = {screen};
  try {
    input.tick(30);
    result.opened = screen.startsWith('MenuScreen') ? openFromMainMenu(screen) : game.hud.scoped(() => runtime.scriptConsoleExec(player, screen));
    input.tick(10);
    result.window = top();
    game.windowKey('Escape', true); game.windowKey('Escape', false);
    input.tick(10);
    result.after = top();
  } catch (error) {
    result.error = String(error?.message ?? error).split('\n')[0].slice(0, 220);
    result.stack = (failedStack ?? []).slice(-4);
  }
  results.push(result);
  console.log(JSON.stringify(result));
}
process.exit(0);
