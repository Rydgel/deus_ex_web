/** GConfig in Play (docs/script-config.md): class defaults take the installed
 * .ini values at class load (UClass::Serialize -> LoadConfig), and closing the
 * Goals screen runs DeusExPlayer.SaveConfig through the recovered SaveConfig,
 * GConfig SetString/Flush and the defaults reload. Requires the local install. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
const config = runtime.classLoader.graph.config;
assert.ok(config, 'GConfig is bound to the class load graph');
assert.equal(runtime.classLoader.graph.boundaries.has('config'), false, 'no class load reached LoadConfig unbound');

// Class load: the compiled default and the installed User.ini disagree on
// bHUDShowAllAugs; LoadConfig gives the class default the .ini value.
const dx = await assets.get('DeusEx');
const compiled = await new ClassDefaults(assets).get(dx, dx.exportsByPath.get('deusexplayer'));
const playerClass = runtime.instance(player).cls;
const classDefault = name => runtime.defaultValue(playerClass, runtime.lookupMember(playerClass, 'fields', name));
assert.notEqual(Boolean(compiled.bHUDShowAllAugs), true, 'the compiled default is not the installed preference');
assert.equal(config.getString('DeusEx.DeusExPlayer', 'bHUDShowAllAugs', 'User'), 'True');
assert.equal(classDefault('bHUDShowAllAugs'), true, 'globalconfig bHUDShowAllAugs comes from [DeusEx.DeusExPlayer]');
assert.equal(classDefault('logTimeout'), 3, 'logTimeout=3.000000 imports as a float');
assert.equal(classDefault('bDisplayCompletedGoals'), false);

// The Goals screen's DestroyWindow copies its toggles to the player and
// calls SaveConfig (PersonaScreenGoals.uc).
const idle = { forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false };
const tick = frames => { for (let i = 0; i < frames; i++) game.tick(1 / 60, idle); };
game.hud.scoped(() => assert.equal(runtime.scriptConsoleExec(player, 'ShowGoalsWindow'), true));
tick(10);
const W = game.hud.host.W, rootWindow = runtime.namedReference(player, 'rootWindow').get();
let screen = W.ptr(rootWindow, 0x140);
while (screen && W.u8(screen, 0x28) < 2) screen = W.ptr(screen, 0x144);
assert.equal(runtime.instance(screen).cls.record.key, 'deusex.personascreengoals');
runtime.namedReference(screen, 'bDisplayCompletedGoals').set(true);
// Startup's DeusExRootWindow.ConditionalBindMultiplayerKeys already flushed
// User.ini through SET InputExt's SaveConfig; the player's section then still
// holds the installed value.
const before = config.written.get('user.ini');
assert.match(before ?? '', /\[Extension\.InputExt\]\r\n/, 'startup SET InputExt wrote its section');
assert.match(before, /\r\nbDisplayCompletedGoals=False\r\n/, 'the player section is unchanged before SaveConfig');
game.windowKey('Escape', true); game.windowKey('Escape', false); tick(10);

const text = config.written.get('user.ini');
assert.ok(text, 'SaveConfig flushed User.ini');
const section = name => {
  const lines = text.split('\r\n'), start = lines.indexOf(`[${name}]`);
  assert.ok(start >= 0, `written User.ini has [${name}]`);
  const out = [];
  for (let i = start + 1; i < lines.length && lines[i] !== ''; i++) out.push(lines[i]);
  return out;
};
const player_ = section('DeusEx.DeusExPlayer');
assert.ok(player_.includes('bDisplayCompletedGoals=True'), 'the new value replaced bDisplayCompletedGoals=False');
// Every installed key keeps its original line text: the import/export round
// trip reproduces True/False, %i and %f spellings.
const installed = (await readFile(`${root}/System/User.ini`, 'latin1')).split(/\r?\n/);
const installedSection = [];
for (let i = installed.indexOf('[DeusEx.DeusExPlayer]') + 1; i < installed.length && installed[i] !== ''; i++)
  installedSection.push(installed[i]);
for (const line of installedSection) {
  if (line.startsWith('bDisplayCompletedGoals=')) continue;
  assert.ok(player_.includes(line), `round trip keeps "${line}"`);
}
assert.deepEqual(player_.slice(0, installedSection.length).map(line => line.split('=')[0]),
  installedSection.map(line => line.split('=')[0]), 'existing keys keep their order; new keys follow');
assert.ok(section('Engine.PlayerPawn').some(line => line.startsWith('MouseSensitivity=')), 'PlayerPawn globalconfig is saved to its owner section');
assert.equal(classDefault('bDisplayCompletedGoals'), true, 'the defaults reload applied the saved value');
assert.equal(runtime.namedReference(player, 'bDisplayCompletedGoals').get(), true);

// The bool ImportText (Core 0x10166380) through ScriptConsoleExec: the
// console's port flags change nothing, a spelling outside 1/True/0/False is
// NULL, and a required bool then logs BadProperty and skips the call.
const consoleWarnings = [], warning = runtime.warning;
runtime.warning = entry => consoleWarnings.push(entry);
for (const command of ['ShowHud False', 'ShowHud tRUE', 'ShowHud 0', 'ShowHud Maybe', 'ShowHud', 'ShowHud 1'])
  game.hud.scoped(() => assert.equal(runtime.scriptConsoleExec(player, command), true, command));
runtime.warning = warning;
assert.deepEqual(consoleWarnings.map(entry => entry.kind), ['BadProperty', 'BadProperty'],
  'only "Maybe" and the empty text fail the bool import');
tick(2);

console.log(`GConfig validated in Play: class defaults load the installed User.ini (bHUDShowAllAugs, logTimeout), ` +
  `and closing the Goals screen runs SaveConfig: ${player_.length} [DeusEx.DeusExPlayer] keys written, ` +
  `${installedSection.length - 1} installed lines unchanged, bDisplayCompletedGoals saved and reloaded into the class default.`);
process.exit(0);
