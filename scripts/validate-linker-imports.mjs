#!/usr/bin/env node
// Establish original instruction reference cases before loading the translation.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? path.join(root, '.cache/native-probe-env/bin/python');
const N = {None: 0, Core: 0x14, UnrealI: 0x17, UnrealShare: 0x18, Package: 0x298,
  Class: 0x29b, Caller: 0x500, Target: 0x501, Type: 0x502, Item: 0x503,
  Group: 0x504, Mesh: 0x505, LodMesh: 0x506, Other: 0x603};
const imp = (objectName, className = N.Class, packageIndex = -1, classPackage = N.Core) =>
  ({classPackage, className, packageIndex, objectName, object: null, sourceLinker: null, sourceIndex: -1});
const exp = (objectName, classIndex = 0, packageIndex = 0) =>
  ({classIndex, superIndex: 0, packageIndex, objectName, objectFlags: 4, object: null});
const packageImport = name => imp(name, N.Package, 0);
function base(name, actions = [{op: 'verifyImport', linker: 'caller', index: 1}]) {
  return {name, names: Object.fromEntries(Object.entries(N).map(([name, id]) => [id, name])),
    counter: 7, actions,
    objects: {
      Caller: {name: N.Caller, class: '@Package', packageFlags: 15},
      Target: {name: N.Target, class: '@Package'},
      Core: {name: N.Core, class: '@Package'},
      Type: {name: N.Type, class: '@Class', outer: 'Core'},
      Item: {name: N.Item, class: 'Type', outer: 'Target', flags: 0x04004004},
    },
    linkers: {
      caller: {root: 'Caller', imports: [packageImport(N.Target), imp(N.Item)], exports: []},
      target: {root: 'Target', imports: [], exports: [exp(N.Item)]},
      core: {root: 'Core', imports: [], exports: []},
    }};
}
const scenes = [];
function scene(name, change = () => {}, actions) { const s = base(name, actions); change(s); scenes.push(s); }
scene('public-class');
scene('root-package-keeps-null', () => {}, [{op: 'verifyImport', linker: 'caller', index: 0}, {op: 'index', linker: 'caller', index: -1}]);
scene('public-imported-class', s => {
  s.linkers.target.imports = [packageImport(N.Core), imp(N.Type)];
  s.linkers.target.exports[0].classIndex = -2;
  s.linkers.caller.imports[1].className = N.Type;
});
scene('public-local-class', s => {
  s.linkers.target.exports.push(exp(N.Type));
  s.linkers.target.exports[0].classIndex = 2;
  Object.assign(s.linkers.caller.imports[1], {className: N.Type, classPackage: N.Target});
});
scene('hash-collision-name', s => { s.linkers.target.exports.push(exp(N.Other)); });
scene('hash-collision-class', s => {
  s.linkers.target.imports = [packageImport(N.Core), imp(N.Class + 256)];
  s.names[N.Class + 256] = 'OtherClass';
  s.linkers.target.exports.push(exp(N.Item, -2));
});
function nested(s) {
  s.linkers.target.imports = [packageImport(N.Core), imp(N.Package)];
  s.linkers.target.exports.push(exp(N.Group, -2));
  s.linkers.caller.imports.push(imp(N.Group, N.Package));
  s.linkers.caller.imports[1].packageIndex = -3;
  s.linkers.target.exports[0].packageIndex = 2;
}
scene('nested-outer', nested);
scene('nested-zero-outer-fallback', s => { nested(s); s.linkers.target.exports[0].packageIndex = 0; });
scene('nested-wrong-outer-skip', s => { nested(s); s.linkers.target.exports.push(exp(N.Item, 0, 3)); });
scene('root-rejects-nested-export', s => { s.linkers.target.exports.push(exp(N.Item, 0, 2)); });
scene('registered-static', s => {
  s.linkers.target.exports = [];
  s.linkers.caller.imports[1].className = N.Type;
});
scene('transient-class-missing-allowed', s => {
  s.linkers.target.exports = [];
  s.linkers.caller.imports[1].className = N.Type;
  s.objects.Type.classFlags = 0x40;
  delete s.objects.Item;
});
for (const flag of [4, 0x4000, 0x04000000]) scene(`registered-missing-flag-${flag.toString(16)}`, s => {
  s.linkers.target.exports = [];
  s.linkers.caller.imports[1].className = N.Type;
  s.objects.Item.flags &= ~flag;
});
scene('private-export-is-error', s => { s.linkers.target.exports[0].objectFlags = 0; });
scene('mesh-remap-after-match', s => {
  s.linkers.target.imports = [packageImport(N.Core), imp(N.Mesh), imp(N.LodMesh)];
  s.linkers.target.exports = [exp(N.Item, -2), exp(N.Item, -3)];
  s.linkers.caller.imports[1].className = N.Mesh;
});
scene('unreal-class-package-alias', s => {
  s.linkers.target.imports = [packageImport(N.UnrealShare), imp(N.Type)];
  s.linkers.target.exports[0].classIndex = -2;
  Object.assign(s.linkers.caller.imports[1], {className: N.Type, classPackage: N.UnrealI});
});
scene('verify-ordered-summary-count', s => {
  s.linkers.caller.summaryImportCount = 2;
  // A post-summary entry must not be visited by Verify.
  s.linkers.caller.imports.push(imp(N.Other));
}, [{op: 'verify', linker: 'caller'}]);
scene('verify-already-verified-normalizes-flag', s => { s.linkers.caller.verified = 9; }, [{op: 'verify', linker: 'caller'}]);
scene('verified-import-early-return', s => { s.linkers.caller.imports[1].sourceIndex = 8; });
for (const name of ['classPackage', 'className', 'objectName']) scene(`none-${name}`, s => { s.linkers.caller.imports[1][name] = 0; });
scene('index-zero', () => {}, [{op: 'index', linker: 'caller', index: 0}]);
scene('index-export-enters-create', s => { s.linkers.target.exports[0].object = 'Item'; }, [{op: 'index', linker: 'target', index: 1}]);
scene('import-unverified-keeps-null', () => {}, [{op: 'index', linker: 'caller', index: -2}]);
scene('import-cached-does-not-create', s => { s.linkers.caller.imports[1].object = 'Item'; }, [{op: 'index', linker: 'caller', index: -2}]);
scene('verified-lazy-import-and-cache', s => { s.createResults = ['Item']; }, [
  {op: 'verifyImport', linker: 'caller', index: 1},
  {op: 'index', linker: 'caller', index: -2}, {op: 'create', linker: 'caller', index: 1},
]);
scene('null-create-retries-and-counts', s => { s.createResults = [null, 'Item']; }, [
  {op: 'verifyImport', linker: 'caller', index: 1},
  {op: 'create', linker: 'caller', index: 1}, {op: 'create', linker: 'caller', index: 1},
]);

const original = JSON.parse(execFileSync(python, [path.join(root, 'scripts/native-linker-import-oracle.py'),
  process.env.DEUS_EX_GAME_DIR ?? path.join(root, 'Deus Ex GOTY Edition')],
{input: JSON.stringify(scenes), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
const cache = path.join(root, '.cache/research');
mkdirSync(cache, {recursive: true});
writeFileSync(path.join(cache, 'linker-import-reference.json'), JSON.stringify({scenes, original}, null, 2));
assert.equal(original.length, scenes.length);
assert.equal(original[0].linkers.caller.imports[1].sourceIndex, 0);
assert.equal(original[1].results[0], null);
assert.equal(original.at(-1).counter, 9);
if (process.argv.includes('--original-only')) {
  console.log(`Captured ${scenes.length} original Core.dll linker import cases`);
  process.exit(0);
}

const runtime = await import('../src/runtime/script-linker-imports.mjs');

function translated(scene, implementation = runtime) {
  const {buildLinkerExportHash, verifyLinkerImports, verifyLinkerImport, createLinkerImport, linkerIndexToObject} = implementation;
  const events = [];
  const objects = Object.fromEntries(Object.entries(scene.objects).map(([label, value]) => [label, {...value, label}]));
  objects['@Package'] = {label: '@Package'};
  objects['@Class'] = {label: '@Class'};
  const linkers = Object.fromEntries(Object.entries(scene.linkers).map(([label, value]) => [label, {
    ...structuredClone(value), label, verified: value.verified ?? 0, root: objects[value.root],
  }]));
  for (const obj of Object.values(objects)) {
    obj.class = objects[obj.class] ?? null;
    obj.outer = objects[obj.outer] ?? null;
  }
  for (const linker of Object.values(linkers)) {
    for (const imp of linker.imports) {
      imp.object = objects[imp.object] ?? null;
      imp.sourceLinker = linkers[imp.sourceLinker] ?? null;
    }
    for (const exp of linker.exports) exp.object = objects[exp.object] ?? null;
    buildLinkerExportHash(linker);
  }
  const state = {importCount: scene.counter};
  const createResults = [...(scene.createResults ?? [])];
  const label = object => object?.label ?? null;
  const services = {
    state, packageClass: objects['@Package'], classClass: objects['@Class'],
    nameText: index => scene.names[index],
    nameIndex(text, mode) {
      const index = Number(Object.entries(scene.names).find(([, value]) => value === text)[0]);
      events.push({op: 'FName', text, mode, index}); return index;
    },
    createPackage(outer, name) {
      const result = Object.values(objects).find(o => o.class === objects['@Package'] && scene.names[o.name] === name && o.outer === outer);
      assert.ok(result); events.push({op: 'CreatePackage', outer: label(outer), name, result: label(result)}); return result;
    },
    getPackageLinker(root, filename, flags, sandbox, guid) {
      assert.equal(filename, null); assert.equal(sandbox, null); assert.equal(guid, null);
      const result = Object.values(linkers).find(l => l.root === root);
      assert.ok(result); events.push({op: 'GetPackageLinker', root: label(root), flags, result: label(result)}); return result;
    },
    staticFindObject(cls, outer, name, exact) {
      const result = Object.values(objects).find(o => o.class === cls && o.outer === outer && scene.names[o.name] === name) ?? null;
      events.push({op: 'StaticFindObject', class: label(cls), outer: label(outer), name, exact, result: label(result)}); return result;
    },
    createExport(linker, index) {
      const exp = linker.exports[index];
      const result = createResults.length ? objects[createResults.shift()] ?? null : exp.object;
      exp.object = result;
      events.push({op: 'CreateExport', linker: label(linker), index, result: label(result)}); return result;
    },
  };
  const results = [];
  let boundary = null;
  for (const action of scene.actions) {
    const linker = linkers[action.linker];
    try {
      if (action.op === 'verify') verifyLinkerImports(linker, services);
      else if (action.op === 'verifyImport') verifyLinkerImport(linker, action.index, services);
      else results.push(label(action.op === 'create' ? createLinkerImport(linker, action.index, services)
        : linkerIndexToObject(linker, action.index, services)));
    } catch (error) {
      if (!['LINKER_IMPORT_PRIVATE', 'LINKER_IMPORT_MISSING'].includes(error.code)) throw error;
      boundary = error.code.slice('LINKER_IMPORT_'.length); break;
    }
  }
  return {results, events, boundary, counter: state.importCount,
    linkers: Object.fromEntries(Object.entries(linkers).map(([label, l]) => [label, {
      verified: l.verified, imports: l.imports.map(i => ({object: i.object?.label ?? null, sourceLinker: i.sourceLinker?.label ?? null, sourceIndex: i.sourceIndex, className: i.className})),
      hash: [...l.exportHash], hashNext: l.exports.map(e => e.hashNext),
    }])),
    packageFlags: Object.fromEntries(Object.entries(objects).filter(([, o]) => o.class === objects['@Package']).map(([label, o]) => [label, o.packageFlags ?? 0])),
  };
}
for (let index = 0; index < scenes.length; index += 1) {
  assert.deepEqual(translated(scenes[index]), original[index], scenes[index].name);
}
// Check that the new boundary comparisons detect consequential translation
// errors. Mutants are isolated modules in memory; the worktree is never edited.
const source = readFileSync(path.join(root, 'src/runtime/script-linker-imports.mjs'), 'utf8');
const mutations = [
  ['counter', 'incrementImports(services);', '/* lost counter increment */'],
  ['zero-source-index', 'record.sourceIndex >= 0', 'record.sourceIndex > 0'],
  ['outer-match', 'candidate.packageIndex === outer.sourceIndex + 1 || candidate.packageIndex === 0', 'candidate.packageIndex === outer.sourceIndex + 1'],
  ['native-flags', '=== 0x04004004', '!== 0'],
  ['class-match', 'cls.name === record.className &&', 'true &&'],
  ['package-alias', 'pkg === 0x18 ? 0x17 : pkg', 'pkg'],
];
for (const [name, before, after] of mutations) {
  assert.ok(source.includes(before), `mutation ${name} anchor exists`);
  const mutated = await import(`data:text/javascript;base64,${Buffer.from(source.replaceAll(before, after)).toString('base64')}`);
  assert.throws(() => {
    for (let i = 0; i < scenes.length; i += 1) assert.deepEqual(translated(scenes[i], mutated), original[i], scenes[i].name);
  }, `mutation ${name} must be detected`);
}
console.log(`PASS ${scenes.length} original Core.dll linker import cases and ${mutations.length} mutation checks (hash, calls, references, counters and flags)`);
