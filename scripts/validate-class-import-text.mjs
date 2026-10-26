#!/usr/bin/env node
/** UClassProperty::ImportText for the text of a `class<...>` console parameter
 * (docs/script-console-exec.md "Class parameters"): the translation
 * (src/runtime/script-class-import-text.mjs) against the unchanged Core.dll
 * body (scripts/native-class-import-oracle.py runs UClassProperty::ImportText
 * 0x10167110, UObjectProperty::ImportText 0x10166e20 and ReadToken 0x10164cb0
 * from the real vtable slot; StaticFindObject and appStricmp are the two
 * host-side leaves). Per text: the returned pointer (characters past the
 * start; NULL), the value stored, and every StaticFindObject call (class
 * argument, ANY_PACKAGE, name, exact flag).
 *
 * Part 2 runs it in Play (00_Training): `CheatView DeusEx.<class>` through
 * ScriptConsoleExec (PlayerPawn.CheatView's `class<actor> aClass`) sets the
 * player's ViewTarget to that class's actor and bBehindView; the same command
 * again cycles to None. StaticFindObject sees the classes the original holds
 * (ScriptRuntime.originalClass, docs/class-graph-design.md step 1c): a name no
 * class has, and a class Play linked only for its own readiness, are its miss,
 * a NULL import, so the required parameter logs BadProperty and CheatView is
 * not called.
 *
 * The `Class'Package.Object'` spelling is an explicit boundary of the
 * translation (it throws): the cases that reach it are checked to throw, not
 * compared. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {importClassText} from '../src/runtime/script-class-import-text.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const fixture = {
  objects: {
    'Core.Object': {class: true, super: null}, 'Engine.Actor': {class: true, super: 'Core.Object'},
    'Engine.Pawn': {class: true, super: 'Engine.Actor'}, 'DeusEx.ScriptedPawn': {class: true, super: 'Engine.Pawn'},
    'DeusEx.Female4': {class: true, super: 'DeusEx.ScriptedPawn'}, 'Engine.Inventory': {class: true, super: 'Engine.Actor'},
    'DeusEx.Thing': {class: false, super: null}, 'Engine.Interaction': {class: true, super: 'Core.Object'}, 'DeusEx.Class-1_a': {class: true, super: 'Engine.Actor'},
  },
  bare: {Female4: 'DeusEx.Female4', ScriptedPawn: 'DeusEx.ScriptedPawn'},
  meta: 'Engine.Actor',
};
const long = `A${'b'.repeat(1100)}`;
const texts = ['DeusEx.Female4', 'deusex.female4', 'None', 'none ', 'NONE x', '', ' ', 'DeusEx.Female4 foo', 'DeusEx.Female4   ',
  'DeusEx.Female4\tfoo', 'Core.Object', 'DeusEx.Thing', 'Missing.Thing', 'Female4', 'ScriptedPawn 1', '  x', '"DeusEx.Female4"',
  '"DeusEx.Female4" 1', '"unterminated', '"a\\41b"', 'DeusEx.Class-1_a', 'Engine.Inventory;', '1', '.', long, 'DeusEx.Female4.', 'DeusEx.Female4,x', 'Engine.Interaction'];
const quotedTexts = ["Class'DeusEx.Female4'", "DeusEx.Female4'", "DeusEx.Female4   'x'", "Class 'Engine.Pawn'"];

const out = JSON.parse(execFileSync(python, ['scripts/native-class-import-oracle.py', gameDirectory()],
  {encoding: 'utf8', input: JSON.stringify({...fixture, texts: [...texts, ...quotedTexts]}), maxBuffer: 64 * 1024 * 1024})).results;

const table = new Map();
for (const [name, entry] of Object.entries(fixture.objects)) table.set(name.toLowerCase(), {name, ...entry});
for (const [bare, full] of Object.entries(fixture.bare)) table.set(bare.toLowerCase(), table.get(full.toLowerCase()));
const classChildOf = (found, meta) => {
  if (!found.class) return false;
  for (let c = found; c; c = c.super ? table.get(c.super.toLowerCase()) : null) if (c.name.toLowerCase() === meta.toLowerCase()) return true;
  return false;
};

let compared = 0, found = 0, cleared = 0, nulls = 0;
for (const original of out.slice(0, texts.length)) {
  const finds = [];
  const result = importClassText(original.text, {
    find: token => { finds.push(token); return table.get(token.toLowerCase()) ?? null; },
    isClassChildOf: object => classChildOf(object, fixture.meta),
  });
  const ours = {consumed: result === null ? null : result.consumed, value: result?.value?.name ?? null,
    find: finds.map(name => ({class: 'PropertyClass', outer: 4294967295, name, exact: 0}))};
  // A NULL result leaves the parameter as the caller zeroed it, or stores None (a StaticFindObject miss does): both are None to the caller.
  const stored = original.consumed === null && original.value === '0xdeadbeef' ? null : original.value;
  assert.deepEqual(ours, {consumed: original.consumed, value: stored, find: original.find}, JSON.stringify(original.text.slice(0, 40)));
  assert.deepEqual(original.warnings.length > 0, original.text === long || original.text === '"unterminated', 'only a token ReadToken rejects warns');
  compared++;
  if (original.consumed === null) nulls++;
  else if (original.value) found++;
  else if (original.find.length) cleared++;
}
for (const original of out.slice(texts.length)) {
  assert.throws(() => importClassText(original.text, {find: () => null, isClassChildOf: () => true}), /not recovered/, original.text);
}
assert.ok(found >= 8 && cleared >= 3 && nulls >= 6, `the cases cover found/cleared/NULL (${found}/${cleared}/${nulls})`);
console.log(`UClassProperty::ImportText: ${compared} texts equal to Core.dll 0x10167110 (pointer, value, StaticFindObject arguments): ` +
  `${found} found, ${cleared} cleared by the metaclass check, ${nulls} NULL; ${quotedTexts.length} quoted spellings are the explicit boundary.`);

// 2. In Play: the exec function that takes a class (PlayerPawn.CheatView).
const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
const pawns = runtime.levelFor(player).actors.filter(actor => {
  if (!actor || actor === player) return false;
  for (let cls = runtime.instance(actor).cls; cls; cls = cls.base) if (cls.record.key === 'deusex.scriptedpawn') return true;
  return false;
});
assert.ok(pawns.length > 0, 'Training holds a ScriptedPawn');
const target = pawns[0], className = runtime.instance(target).cls.record.key;
const same = pawns.filter(actor => runtime.instance(actor).cls.record.key === className);
runtime.writeNamed(player, 'bCheatsEnabled', true);
assert.equal(runtime.readNamed(player, 'bBehindView'), false);
game.hud.scoped(() => assert.equal(runtime.scriptConsoleExec(player, `CheatView ${className}`), true));
assert.equal(runtime.readNamed(player, 'ViewTarget'), same[0], `CheatView ${className} makes the first actor of the class the ViewTarget`);
assert.equal(runtime.readNamed(player, 'bBehindView'), true, 'CheatView sets bBehindView');
for (let i = 1; i < same.length; i++) {
  game.hud.scoped(() => runtime.scriptConsoleExec(player, `cheatview ${className}`));
  assert.equal(runtime.readNamed(player, 'ViewTarget'), same[i], 'the next call cycles to the next actor of the class');
}
game.hud.scoped(() => runtime.scriptConsoleExec(player, `CheatView ${className}`));
assert.equal(runtime.readNamed(player, 'ViewTarget'), null, 'after the last one the call returns to the own camera');
assert.equal(runtime.readNamed(player, 'bBehindView'), false);
const warnings = [], warn = runtime.warning;
runtime.warning = event => { warnings.push(event); warn?.(event); };
const tracker = runtime.classLoader.originalLoads;
const isActor = cls => { for (; cls; cls = cls.base) if (cls.record.key === 'engine.actor') return true; return false; };
// neither reached by an original request nor registered by a DLL (Engine.WarpZoneInfo is registered, so the original finds it)
const registered = new Set(runtime.classLoader.graph.staticRecords.values());
const readinessOnly = [...runtime.linkedClasses].find(cls => isActor(cls) && !tracker.has(cls.loadRecord) && !registered.has(cls.loadRecord));
assert.ok(readinessOnly, 'Play linked an actor class the original does not hold');
for (const name of ['DeusEx.NoSuchClassAnywhere', readinessOnly.record.key]) {
  warnings.length = 0;
  game.hud.scoped(() => assert.equal(runtime.scriptConsoleExec(player, `CheatView ${name}`), true));
  assert.deepEqual(warnings.map(w => `${w.kind} ${w.parameter}`), ['BadProperty engine.playerpawn.cheatview.aclass'], `CheatView ${name}: a StaticFindObject miss is a NULL import`);
  assert.equal(runtime.readNamed(player, 'ViewTarget'), null, `CheatView ${name} is not called`);
  assert.equal(runtime.readNamed(player, 'bBehindView'), false);
}
runtime.warning = warn;
console.log(`In Play (00_Training): CheatView ${className} runs through ScriptConsoleExec's class import: ${same.length} actor(s) of the class cycle through ViewTarget and back to None, bBehindView follows; ` +
  `an unknown name and ${readinessOnly.record.key} (linked only for Play's readiness) are StaticFindObject misses: BadProperty, not called.`);
process.exit(0);
