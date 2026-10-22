/** What Play writes to DeusEx.ini and User.ini when the original menus change a setting, against what the original wrote
 * (docs/config-persistence.md), headless.
 *
 * Play runs 00_Training with the config store the page uses (config-store.mjs), and the original menus make the changes the Wine
 * session made (scripts/config-persistence-measurements.json): Settings > Sound, Display (SetRes, Decals), Keyboard/Mouse, Controls, Game
 * Options (Gore Level, Subtitles, UI/Menu Background), Colors, and Main menu > New Game with bAskedToTrain=False. After each OK the
 * file the game wrote differs from the file before it in exactly the keys the original changed, at the values it wrote; nothing is written
 * before OK. An installed ini holds fewer keys than a played one, so a first save of a class appends the keys the file lacks: those
 * are compared with the keys the original's earlier saves had added to the Wine prefix's User.ini and with the Engine.GameInfo list of
 * the session (measurements `firstSaveAppended`, `appended`), in the original's order.
 * Then a reload: a new asset store over the kept records is a new page, and the next game session starts with the changed bindings,
 * options, volumes and theme.
 *
 *   node scripts/validate-config-persistence.mjs [--verbose] [--wine <dir>]
 * `--wine <dir>` (the captures of the Wine session, .work/config-persistence/wine) also requires the byte-exact result: the installed
 * ini files are the measured baselines and the files Play wrote equal the original's. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {ConfigFile} from '../src/runtime/config-cache.mjs';
import {createConfigStore} from '../src/runtime/config-store.mjs';
import {decodeIniBytes, encodeIniText} from '../src/runtime/ini-bytes.mjs';
import {createMenuDriver} from '../src/viewer/menu-driver.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const option = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const verbose = process.argv.includes('--verbose');
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-config-persistence: no installed game data'); process.exit(0); }
const measurements = JSON.parse(await readFile(new URL('./config-persistence-measurements.json', import.meta.url), 'utf8'));
const wineDir = option('wine');
let checks = 0;
const is = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const by = name => measurements.scenarios.find(scenario => scenario.name === name);

// ---- the installed files, and the baseline each session starts from ------------------------------------------------------------------
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const parse = text => { const file = new ConfigFile(); file.read(text); return file; };
const textOf = async leaf => decodeIniBytes(await files.find(file => file.path.toLowerCase() === `system/${leaf}`).read());
const setKey = (file, section, key, value) => {
  const target = file.find(section) ?? file.set(section), pair = target.find(key);
  if (pair) pair.value = value; else target.add(key, value);
};
const asText = file => { file.dirty = true; return file.write(); };
/** The installed files with each scenario's `from` values set, and without the keys the original appended in the session. */
async function baseline(names) {
  const system = parse(await textOf('deusex.ini')), user = parse(await textOf('user.ini'));
  for (const [section, key, value] of measurements.baseline.launcherChanges.keys) setKey(system, section, key, value);
  // a key several scenarios change (the resolution) starts at the first one's `from`
  const set = new Set();
  for (const name of names) for (const change of by(name).changes) {
    const leaf = (change.file ?? by(name).file) === 'User.ini' ? 'user' : 'system', id = `${leaf}\0${change.section}\0${change.key}`;
    if (!set.has(id)) { set.add(id); setKey(leaf === 'user' ? user : system, change.section, change.key, change.from); }
  }
  if (names.includes('options')) {
    const appended = by('options').appended, section = system.find(appended.section), drop = new Set(appended.keys.map(([key]) => key));
    if (section) section.pairs = section.pairs.filter(pair => !drop.has(pair.key) && !/^IPPolicies\[/.test(pair.key));
  }
  return {'deusex.ini': asText(system), 'user.ini': asText(user)};
}
const wine = file => readFileSync(`${wineDir}/${file}`, 'latin1');

// ---- Play with the kept-config store the page uses -------------------------------------------------------------------------------------
const sectionsOf = text => new Map(parse(text ?? '').sections.map(({name, section}) => [name.toLowerCase(), {name, pairs: section.pairs.map(({key, value}) => [key, value])}]));
// A value the save wrote again in its own spelling (an installed `1.0` is `1.000000` once exported) is not a change of the setting.
const sameValue = (a, b) => a === b || a.toLowerCase() === b.toLowerCase() || (a !== '' && b !== '' && !Number.isNaN(Number(a)) && Number(a) === Number(b));

async function session(startTexts, {saved = null} = {}) {
  const patched = {'deusex.ini': encodeIniText(startTexts['deusex.ini']), 'user.ini': encodeIniText(startTexts['user.ini'])};
  const sources = files.map(file => file.path.startsWith('System/') && patched[file.path.slice(7).toLowerCase()]
    ? {path: file.path, read: async () => patched[file.path.slice(7).toLowerCase()]} : file);
  const store = createConfigStore({saved: saved ?? new Map()});
  const assets = new AssetStore(sources, {configStore: store});
  const asset = await assets.get('00_Training');
  const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
  const paint = () => game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
  const input = createPlayerInputFixture(game, {paint});
  input.tick(30);
  const driver = createMenuDriver(game), host = game.doors.scriptRuntime.windowHost, runtime = driver.runtime, player = driver.player;
  const closeMenus = () => { for (let guard = 0; driver.top() && guard < 8; guard++) { game.windowKey('Escape', true); game.windowKey('Escape', false); input.tick(5); } };
  const open = (...screens) => { closeMenus(); driver.showMainMenu(); input.tick(5); for (const screen of screens) { driver.invoke(screen); input.tick(5); } };
  const press = code => { game.windowKey(code, true); game.windowKey(code, false); input.tick(3); };
  const ok = () => { driver.pressAction(1); input.tick(5); };
  const snapshot = leaf => { const record = store.snapshot().get(leaf); return record ? decodeIniBytes(record.bytes) : null; };
  const last = {'deusex.ini': decodeIniBytes(patched['deusex.ini']), 'user.ini': decodeIniBytes(patched['user.ini'])};
  /** The change of a file since the last look, pair by pair in file order: values that changed in place, pairs appended to a section, and
   * `moved` where a pair is not at its place (a write keeps the order it read). */
  const delta = leaf => {
    const now = snapshot(leaf), before = last[leaf];
    if (now === null || now === before) return {written: false, changed: [], appended: [], moved: []};
    last[leaf] = now;
    const old = sectionsOf(before), changed = [], appended = [], moved = [];
    for (const [id, {name, pairs}] of sectionsOf(now)) {
      const was = old.get(id)?.pairs;
      pairs.forEach(([key, value], i) => {
        if (!was || i >= was.length) appended.push([name, key, value]);
        else if (was[i][0] !== key) moved.push([name, i, was[i][0], key]);
        else if (!sameValue(was[i][1], value)) changed.push({section: name, key, from: was[i][1], to: value});
      });
    }
    return {written: true, changed, appended, moved};
  };
  const both = () => ({'deusex.ini': delta('deusex.ini'), 'user.ini': delta('user.ini')});
  return {store, game, assets, driver, host, runtime, player, input, open, press, ok, closeMenus, snapshot, delta, both, last};
}

const changesFor = (scenario, leaf) => scenario.changes.filter(change => (change.file ?? scenario.file) === (leaf === 'user.ini' ? 'User.ini' : 'DeusEx.ini')).map(({section, key, from, to}) => ({section, key, from, to}));
const NOTHING = {written: false, changed: [], appended: [], moved: []};
const merge = (a, b) => Object.fromEntries(['deusex.ini', 'user.ini'].map(leaf => [leaf, {written: a[leaf].written || b[leaf].written,
  changed: [...a[leaf].changed, ...b[leaf].changed], appended: [...a[leaf].appended, ...b[leaf].appended], moved: [...a[leaf].moved, ...b[leaf].moved]}]));
function check(name, results, {exact = false, appendedBy} = {}) {
  const scenario = by(name);
  for (const leaf of ['deusex.ini', 'user.ini']) {
    const got = results[leaf], want = changesFor(scenario, leaf);
    (appendedBy[leaf] ??= []).push(...got.appended);
    if (verbose) console.log(name, leaf, JSON.stringify({written: got.written, changed: got.changed, appended: got.appended.length, moved: got.moved}).slice(0, 1200));
    is(got.moved, [], `${name}: ${leaf} keeps the order it read`);
    is(got.changed.map(({section, key, from, to}) => ({section, key, from, to})), want, `${name}: ${leaf} changed in exactly the keys the original changed`);
    // the original wrote a file only when a value changed (its baseline held every key); against an installed file that lacks keys a save may write more
    if (exact) is(got.written, want.length > 0, `${name}: ${leaf} written or not as the original did`);
  }
}

// ---- Part 1: the scenarios of the Wine session, in Play ------------------------------------------------------------------------------------
async function scenarios(names, start, {exact = false} = {}) {
  const s = await session(start);
  s.appendedBy = {};                                            // leaf -> every pair a save appended in the session, in order
  const {driver, runtime, host, game, player, open, press, ok} = s;
  const untouched = label => is(s.both(), {'deusex.ini': NOTHING, 'user.ini': NOTHING}, `${label}: nothing is written before OK`);
  for (const name of names) {
    s.both();                                                   // the look before the scenario
    let results;
    switch (name) {
      case 'sound':
        open('MenuSettings', 'MenuScreenSound');
        driver.drag('MenuChoice_SoundVolume', 5); s.input.tick(3);
        driver.press('MenuChoice_ReverseStereo'); s.input.tick(3);
        untouched('sound'); ok();
        break;
      case 'display': {
        // The measured viewport was windowed. The resolution is chosen with SetRes and Decals with the `set` its choice sends: the Display
        // screen's own OK would also send SetRes for its Resolution choice, whose list is the host's modes (docs/config-persistence.md "Open").
        game.viewportFullscreen = false;
        host.consoleCommands.consoleCommand(player, 'SetRes 1280x768');
        const resized = s.both();
        is(resized['deusex.ini'].changed.map(({key, to}) => [key, to]), [['WindowedViewportY', '768']], 'display: SetRes alone writes the file at once');
        host.consoleCommands.consoleCommand(player, 'set ini:Engine.Engine.ViewportManager Decals False');
        results = merge(resized, s.both());
        break;
      }
      case 'resolution':
        host.consoleCommands.consoleCommand(player, 'SetRes 1280x960');
        break;
      case 'askedToTrain':
        open(); driver.pressButton(0); s.input.tick(5);          // New Game
        break;
      case 'keys':
        open('MenuSettings', 'MenuScreenCustomizeKeys');
        press('ArrowDown'); press('Enter');
        is(runtime.readNamed(driver.topWindow(), 'bWaitingForInput'), true, 'keys: the row waits for a key');
        press('KeyG');
        untouched('keys'); ok();
        break;
      case 'controls':
        open('MenuSettings', 'MenuScreenControls');
        driver.press('MenuChoice_InvertMouse'); driver.drag('MenuChoice_MouseSensitivity', 6); s.input.tick(3);
        untouched('controls'); ok();
        break;
      case 'options':
        open('MenuSettings', 'MenuScreenOptions');
        for (const choice of ['MenuChoice_GoreLevel', 'MenuChoice_Subtitles', 'MenuChoice_UIBackground']) { driver.press(choice); s.input.tick(3); }
        untouched('options'); ok();
        break;
      case 'colors':
        open('MenuSettings', 'MenuScreenAdjustColors');
        for (const choice of ['MenuChoice_MenuColor', 'MenuChoice_HUDColor']) { driver.press(choice); s.input.tick(3); }
        untouched('colors'); ok();
        break;
      default: throw new Error(`no scenario ${name}`);
    }
    check(name, results ?? s.both(), {exact, appendedBy: s.appendedBy});
  }
  return s;
}

const SESSION_1 = ['sound', 'display', 'resolution'], SESSION_2 = ['askedToTrain', 'keys', 'controls', 'options', 'colors'];
const exact = Boolean(wineDir);
const first = await scenarios(SESSION_1, exact ? {'deusex.ini': wine('cfg1.start.DeusEx.ini'), 'user.ini': wine('cfg1.start.User.ini')} : await baseline(SESSION_1), {exact});
const second = await scenarios(SESSION_2, exact ? {'deusex.ini': wine('cfg2.start.DeusEx.ini'), 'user.ini': wine('cfg2.start.User.ini')} : await baseline(SESSION_2), {exact});

// The keys a first save appended to a file that lacked them, in the original's order (keys only: the original's played file held its own values).
{
  const firstSave = measurements.firstSaveAppended.keys, sections = new Set(firstSave.map(([section]) => section));
  if (!exact) is(first.appendedBy['user.ini'].filter(([section]) => sections.has(section)).map(([section, key]) => [section, key]), firstSave,
    'the keys player.SaveConfig added to the installed User.ini are the ones, in the order, the original had added to a played one');
  const gameInfo = by('options').appended, listed = second.appendedBy['deusex.ini'].filter(([section]) => section === gameInfo.section).map(([, key, value]) => [key, value]);
  const expanded = gameInfo.keys.flatMap(([key, value]) => key === 'IPPolicies[1..49]' ? Array.from({length: 49}, (_, i) => [`IPPolicies[${i + 1}]`, value]) : [[key, value]]);
  is(listed, expanded, `Level.Game.SaveConfig appended ${gameInfo.section}'s keys as the original did`);
}

// A second New Game goes straight to the difficulty screen: the prompt is asked once.
{
  second.closeMenus(); second.open();
  const before = second.snapshot('user.ini');
  second.driver.pressButton(0); second.input.tick(5);
  is(second.driver.top(), 'deusex.menuselectdifficulty', 'New Game goes straight to the difficulty screen once asked');
  is(second.snapshot('user.ini'), before, 'and writes nothing');
}

// ---- Part 2: a new page over the kept files ---------------------------------------------------------------------------------------------
{
  const kept = new Map([...second.store.snapshot()]);
  const kept1 = first.store.snapshot();
  const reload = await session(await baseline(SESSION_2), {saved: new Map([['user.ini', kept.get('user.ini')], ['deusex.ini', kept1.get('deusex.ini')]])});
  const {runtime, player, host} = reload;
  const key = name => host.consoleCommands.consoleCommand(player, `KEYBINDING ${name}`);
  is(key('G'), 'ParseRightClick', 'reload: the rebound key is bound');
  is([runtime.readNamed(player, 'MouseSensitivity'), runtime.readNamed(player, 'bInvertMouse'), runtime.readNamed(player, 'bSubtitles'), runtime.readNamed(player, 'UIBackground'),
    runtime.readNamed(player, 'bAskedToTrain')], [7, true, false, 1, true], 'reload: the player\'s options');
  is([runtime.readNamed(player, 'MenuThemeName'), runtime.readNamed(player, 'HUDThemeName')], ['Blue & Gold', 'Amber'], 'reload: the colour schemes');
  is(host.consoleCommands.consoleCommand(player, 'get ini:Engine.Engine.AudioDevice SoundVolume'), '127', 'reload: the sound volume');
  is(host.consoleCommands.consoleCommand(player, 'get ini:Engine.Engine.ViewportManager Decals'), 'False', 'reload: Decals');
  is(host.display.fullscreen, false, 'reload: the viewport starts as StartupFullscreen says (the measured baseline is windowed)');
}

if (exact) {
  // byte for byte: on a mismatch, the first line that differs
  const sameText = (actual, expected, label) => {
    if (actual !== expected) {
      if (option('dump')) { mkdirSync(option('dump'), {recursive: true}); writeFileSync(`${option('dump')}/${label.replace(/\W+/g, '-')}.ini`, actual, 'latin1'); }
      const a = actual.split('\r\n'), b = expected.split('\r\n');
      let at = 0; while (at < a.length && a[at] === b[at]) at++;
      assert.fail(`${label}: line ${at + 1} differs\n  Play:     ${JSON.stringify(a.slice(at, at + 3))}\n  original: ${JSON.stringify(b.slice(at, at + 3))}`);
    }
    checks++;
  };
  sameText(second.snapshot('user.ini'), wine('cfg2.final.User.ini'), 'the User.ini Play wrote is the original\'s, byte for byte');
  sameText(second.snapshot('deusex.ini'), wine('cfg2.final.DeusEx.ini'), 'the DeusEx.ini Play wrote is the original\'s, byte for byte');
  sameText(first.snapshot('deusex.ini'), wine('cfg1.res-post-ok.DeusEx.ini'), 'and after the Display scenarios');
}

console.log(`config-persistence: ${checks} checks pass`);
process.exit(0);
