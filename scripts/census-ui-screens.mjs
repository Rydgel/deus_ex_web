/** Which of the original's UI screens open, draw and close in Play
 * (Stage 4's remaining native UI presentation). For each screen the player's
 * own exec function (DeusExPlayer.ShowInventoryWindow, ...) runs through
 * ScriptConsoleExec on a fresh game, the HUD paints for a few frames at the
 * browser's canvas size, and Escape closes it. Each result is the topmost
 * window class, or the first error with the script stack that reached it.
 * A census of reach, not a fidelity check.
 *
 * A `Menu...` entry (MenuScreenLoadGame, `MenuSettings>MenuScreenOptions`) opens the
 * main menu and activates, in each window along the `>` path, the button whose
 * buttonDefaults invoke that class, through XButtonWindow::ActivateButton like a click. They are
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
import {createMenuDriver} from '../src/viewer/menu-driver.mjs';

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
  // The shared menu driver (src/viewer/menu-driver.mjs): the same button and slider actions the
  // browser check uses.
  const driver = createMenuDriver(game), {topWindow, top} = driver;
  // 'MenuSettings>MenuScreenOptions' opens the main menu, then each class in turn from the previous
  // window; 'MenuSettings>MenuScreenDisplay#MenuChoice_Brightness' then presses an action choice
  // (a MenuUIChoiceAction: its ButtonActivated invokes the screen it names).
  const openFromMainMenu = path => {
    driver.showMainMenu();
    input.tick(5);
    for (const step of path.split('>')) {
      const [screenClass, choice] = step.split('#');
      driver.invoke(screenClass); input.tick(10);
      if (choice) { driver.press(choice); input.tick(10); }
    }
    return true;
  };
  // Trailing '!cycle', '!reset', '!ok' on a path exercise the screen once it is open: cycle every
  // value choice (a ButtonActivated on its action button), press ResetToDefaults, press OK
  // (SaveSettings, then PopWindow). The action choices (MenuUIChoiceAction) are skipped.
  const exercise = word => {
    // A restart-required choice opens a message box; dismiss it with Escape first.
    for (let guard = 0; top()?.includes('messagebox') && guard < 5; guard++) {
      game.windowKey('Escape', true); game.windowKey('Escape', false); input.tick(5);
    }
    if (word === 'ok') { driver.pressAction(1); input.tick(10); return null; }
    if (word === 'reset') { driver.pressAction(3); input.tick(10); return null; }
    if (word !== 'cycle') throw new Error(`unknown census step !${word}`);
    return driver.cycleAll();
  };
  const result = {screen};
  try {
    input.tick(30);
    const [path, ...exercises] = screen.split('!');
    result.opened = /^Menu/.test(screen) ? openFromMainMenu(path) : game.hud.scoped(() => runtime.scriptConsoleExec(player, screen));
    input.tick(10);
    for (const word of exercises) { const done = exercise(word); input.tick(5); if (Array.isArray(done)) result.cycled = done; else result.pressed = word; }
    result.window = top();
    if (process.env.CENSUS_ACTIONS) {
      // What the topmost menu offers: the classes its buttonDefaults invoke.
      const defaults = top()?.includes('menuscreen') ? [] : runtime.readNamed(topWindow(), 'buttonDefaults') ?? [];
      result.invokes = defaults.map(entry => Object.entries(entry).filter(([key]) => /\.(invoke|text)$/.test(key)).map(([, v]) => v?.key ?? v).join(' '));
      const choices = (() => { try { return runtime.readNamed(topWindow(), 'Choices'); } catch { return null; } })();
      if (choices) result.choices = choices.map(c => c?.key ?? c);
    }
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
