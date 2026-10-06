/** Which of the original's UI screens open, draw and close in Play
 * (Stage 4's remaining native UI presentation). For each screen the player's
 * own exec function (DeusExPlayer.ShowInventoryWindow, ...) runs through
 * ScriptConsoleExec on a fresh game, the HUD paints for a few frames at the
 * browser's canvas size, and Escape closes it. Each result is the topmost
 * window class, or the first error with the script stack that reached it.
 * A census of reach, not a fidelity check.
 *
 *   node scripts/census-ui-screens.mjs [--map 00_Training] [--screens ShowInventoryWindow,...]
 */
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
  const top = () => {
    const rootWindow = runtime.namedReference(player, 'rootWindow').get();
    let window = rootWindow ? W.ptr(rootWindow, 0x140) : 0;
    while (window && W.u8(window, 0x28) < 2) window = W.ptr(window, 0x144);
    return window ? runtime.instance(window).cls.record.key : null;
  };
  const result = {screen};
  try {
    input.tick(30);
    result.opened = game.hud.scoped(() => runtime.scriptConsoleExec(player, screen));
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
const failed = results.filter(r => r.error);
console.log(`census-ui-screens ${map}: ${results.length - failed.length} of ${results.length} screens opened, drew and closed`);
process.exit(0);
