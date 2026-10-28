/** Every [Engine.Input] binding of the installed User.ini through the page's input entry points into a headless Play game
 * (docs/input-bindings.md): `game.inputKey` (UEngine::InputEvent, the installed bindings, XInputExt::Process), `inputButton`,
 * `inputWheel` (WinDrv's WM_MOUSEWHEEL) and the relative mouse motion. The cases are scripts/input-binding-cases.mjs, shared with
 * browser-tests/input-bindings-table.spec.mjs, which presses real events in Chromium against the page.
 *
 * Besides the cases (one 00_Training game, frames instead of wall time):
 *  - each [Engine.Input] key resolves to an EInputKey of the original table, and the installed binding is User.ini's (DeusExRootWindow
 *    binds T, Y, B, K and Equals itself, docs/script-window-typed-keys.md);
 *  - the wheel in a window (the root consumes it) and over a scroll area (the Customize Keys list scrolls);
 *  - a key rebound in MenuScreenCustomizeKeys runs its new binding.
 * `--table <path>` writes the rows as JSON. */
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { inputProbe } from '../src/viewer/input-probe.mjs';
import { viewProbe } from '../src/viewer/view-probe.mjs';
import { placeProbe } from '../src/viewer/decal-probe.mjs';
import { settingsProbe } from '../src/viewer/settings-probe.mjs';
import { gameDirectory } from './game-directory.mjs';
import { createPlayerInputFixture } from './player-input-fixture.mjs';
import { readBindingRows, runBoundaryCases, runInputBindings, runWindowCases } from './input-binding-cases.mjs';

const tableOption = process.argv.indexOf('--table');
const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const paint = () => game.hud.commands(1432, 1268, { location: game.player.eye, rotation: game.player.viewRotation, fov: 75 });
const input = createPlayerInputFixture(game, { paint });
input.tick(30);
const names = game.hud.host.inputKeyNames, bindings = game.hud.host.input.bindings;

const table = await readBindingRows();
for (const row of table.rows) {
  row.index = names.findIndex(name => name?.toLowerCase() === `ik_${row.key}`.toLowerCase());
  assert.ok(row.index > 0 || row.key === "None", `${row.key} is an EInputKey of the original table`);
  assert.equal(bindings[row.index] ?? '', row.binding, `${row.key}: the installed binding is ${row.scriptBound ? "DeusExRootWindow's" : "User.ini's"}`);
}

let clock = 0, lastError = null;
const frames = ms => Math.max(1, Math.round(ms / (1000 / 60)));
const tick = n => { input.tick(n); clock += n * 1000 / 60; };
const guarded = fn => { try { fn(); return { error: null }; } catch (error) { lastError = `${error.name}: ${error.message}`; return { error: lastError }; } };
const env = {
  key: async (code, { hold = 60 } = {}) => { const result = guarded(() => game.inputKey(code, true)); tick(frames(hold)); guarded(() => game.inputKey(code, false)); tick(2); return result; },
  down: async code => { guarded(() => game.inputKey(code, true)); },
  up: async code => { guarded(() => game.inputKey(code, false)); },
  button: async (name, { hold = 60 } = {}) => { game.inputButton(name, true); tick(frames(hold)); game.inputButton(name, false); tick(2); },
  buttonDown: async name => { game.inputButton(name, true); },
  buttonUp: async name => { game.inputButton(name, false); },
  wheel: async notches => { game.inputWheel(notches * 120); tick(2); },
  look: async (dx, dy) => { game.mouseMotion(dx, dy); tick(2); },
  pointerTo: async ({ x, y }) => { assert.equal(game.windowPointer({ x, y }), true, 'a modal window holds the mouse'); },
  wait: async ms => { tick(frames(ms)); },
  now: () => clock,
  probe: async args => inputProbe(game, args),
  state: async () => inputProbe(game, { op: 'state', clear: true }),
  exec: async lines => { viewProbe(game, { exec: lines }); },
  place: async args => placeProbe(game, args),
  settings: async step => settingsProbe(game, step),
  error: async () => lastError,
  // a game built without a travelling session: no game saver for SaveGame (native 3011)
  saves: false,
};

const results = await runInputBindings(env, table);
await runWindowCases(env, table, results);
await runBoundaryCases(env, table, results);

// ---- the table ------------------------------------------------------------------------------------------------------------------------------
const lines = [];
for (const row of table.rows) {
  const result = results.get(row.key) ?? {};
  row.result = result;
  if (row.joy || !row.binding) continue;
  assert.ok(result.status, `${row.key}=${row.binding}: a case ran`);
  if (result.reached === false) assert.fail(`${row.key}=${row.binding}: the binding line was not run (${JSON.stringify(result)})`);
  lines.push(`${row.key.padEnd(14)} ${row.binding.padEnd(24)} ${result.status.padEnd(8)} ${result.effect ?? ''}`);
}
console.log(lines.join('\n'));
const bound = table.rows.filter(row => row.binding && !row.joy);
console.log(`${table.rows.length} keys in [Engine.Input]: ${bound.length} bound (${table.rows.filter(row => row.joy).length} Joy* lines have no browser device), ` +
  `${bound.filter(row => row.result.status === 'ok').length} with an effect checked, ${bound.filter(row => row.result.status === 'boundary').length} stop at a later stage's system`);
if (tableOption > 0) await writeFile(process.argv[tableOption + 1], JSON.stringify(table.rows.map(row => ({ key: row.key, binding: row.binding, ini: row.ini, scriptBound: row.scriptBound, joy: row.joy, codes: row.codes, ...row.result })), null, 1));
console.log('Input bindings passed.');
