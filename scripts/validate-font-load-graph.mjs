#!/usr/bin/env node
/** DXFonts.MainMenuTrueType through the shared graph's original BeginLoad,
 * CreateExport, EndLoad Preload/PostLoad queue, compared with the retail
 * Font and Texture/Palette bodies. No predecoded glyphs; the page textures
 * and palette are the package's own exports. Evidence: docs/script-font-load.md. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {createScriptLoadGraph} from '../src/runtime/script-load-graph.mjs';
import {FONT_NATIVE} from '../src/runtime/script-font-load.mjs';
import {clientTextureLodSet, CLIENT_LAZY_LOAD} from '../src/runtime/script-client-resource-settings.mjs';
import {ConfigCache} from '../src/runtime/config-cache.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? process.env.DEUS_EX_NATIVE_PYTHON ??
  '.cache/native-probe-env/bin/python';
const run = (script, specs) => JSON.parse(execFileSync(python, [script, gameDirectory(), '--stdin'],
  {encoding: 'utf8', input: JSON.stringify(specs), maxBuffer: 64 * 1024 * 1024}));

const files = {core: 'System/Core.u', engine: 'System/Engine.u', dxfonts: 'Textures/DXFonts.utx'};
const assets = new AssetStore(Object.values(files).map(file => ({path: file,
  read: () => readFile(path.join(gameDirectory(), file))})));
const packageAssets = new Map();
for (const name of ['Core', 'Engine', 'DXFonts']) packageAssets.set(name.toLowerCase(), await assets.get(name));
const dxfonts = packageAssets.get('dxfonts');
assert.deepEqual(dxfonts.pkg.dependencies, ['Engine']);
assert.equal(packageAssets.get('engine').exportsByPath.has('font'), false,
  'Font really is native-only in the original Engine.u');

const ini = await readFile(path.join(gameDirectory(), 'System/DeusEx.ini'), 'utf8');
const lodSet = clientTextureLodSet(new ConfigCache({files: new Map([['deusex.ini', ini]])}));
let lazy = CLIENT_LAZY_LOAD, clock = 0;
const lifecycle = [], biasReads = [];
// Original Core native registration inputs, as validate-function-bind uses
// them to finalize the Core.Object queue.
const natives = JSON.parse(execFileSync(python, ['scripts/native-function-bind-oracle.py', gameDirectory(),
  '--registry-only'], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
const graph = createScriptLoadGraph({packageAssets, captureEvents: true, nativeFunctions: {
  readNative: index => natives.numbered[index] ?? natives.defaultHandler,
  getDllExport: (pkg, name) => natives.named[name],
  readPointer: cell => cell.pointer,
}, resourceServices: {
  seconds: () => (clock += 1),
  getLazyLoad: () => lazy, setLazyLoad: value => { lazy = value; },
  mipBias: (texture, set) => { biasReads.push(set); return lodSet[set] ?? 0; },
}, lifecycle: {
  logReceiver: {name: 'GWarn'}, logEndLoad: () => lifecycle.push('Logf'),
  reallocLoaded: ({array, num, max}) => {
    assert.equal(array, graph.loadedObjects); assert.equal(num, 0); assert.equal(max, 0);
    lifecycle.push('Realloc');
  },
}});

const fontClass = graph.staticRecords.get('Engine.Font');
assert.equal(graph.slotOf(fontClass, 0x3c), 0x38);
assert.equal(graph.slotOf(fontClass, 0x484), 0x12);
assert.equal(graph.superOf(fontClass), graph.staticRecords.get('Core.Object'));

// A running client loaded Core.Object and the Engine resource classes at
// startup; flush that queue first so the measured load starts, as the
// original BeginLoad asserts, from an empty GObjLoaded.
const engine = packageAssets.get('engine');
graph.beginLoad();
for (const name of ['texture', 'palette']) graph.loadExport('Engine', engine.exportsByPath.get(name));
graph.endLoad();
assert.equal(graph.loadedObjects.length, 0);
lifecycle.length = 0;
const startupEvents = graph.events.length;

// StaticLoadObject order: BeginLoad precedes GetPackageLinker and Create.
graph.beginLoad();
const linker = graph.buildLinker('DXFonts');
const fontIndex = dxfonts.exportsByPath.get('mainmenutruetype');
const font = graph.indexToObject(linker, fontIndex);
assert.equal(graph.classRecordOf(font), fontClass, 'import resolves to the native-only static Font class');
assert.equal(graph.slotOf(font, 0x18), linker.root);
assert.equal(graph.slotOf(font, 0), FONT_NATIVE.vtable);
graph.endLoad();
assert.deepEqual(lifecycle, ['Logf', 'Realloc']);
assert.equal(graph.loadedObjects.length, 0);
assert.equal(lazy, CLIENT_LAZY_LOAD, 'Font Serialize restores GLazyLoad');

// Queue order: the Font's own Preload creates its page textures; the first
// texture's tagged Palette creates the shared palette.
const measured = graph.events.slice(startupEvents);
const created = measured.filter(e => e.op === 'ConstructObject').map(e => `${e.cls}:${e.name}`)
  .filter(name => /^Engine\.(Font|Texture|Palette):/.test(name) || /^(Font|Texture|Palette):/.test(name));
const resourceOrder = measured.filter(e => e.op === 'ConstructObject' && ['Font', 'Texture', 'Palette'].includes(e.cls))
  .map(e => e.name);
assert.deepEqual(resourceOrder, ['MainMenuTrueType', 'Texture0', 'Texture1', 'Palette1'], created.join(','));
const postLoads = measured.filter(e => e.op === 'PostLoad' && ['Engine.Font', 'Engine.Texture', 'Engine.Palette'].includes(e.kind))
  .map(e => graph.nameText(graph.slotOf(e.object, 0x20)));
assert.deepEqual(postLoads, ['MainMenuTrueType', 'Texture0', 'Texture1', 'Palette1']);

// Compare the loaded Font with the retail serializer over the same bytes.
const decoded = readObject(dxfonts.pkg, dxfonts.bytes, fontIndex), entry = decoded.entry;
const [fontOracle] = run('scripts/native-font-load-oracle.py', [{name: entry.name, start: entry.serialOffset,
  prefixSize: decoded.reader.offset, version: dxfonts.pkg.version, lazy: CLIENT_LAZY_LOAD,
  payload: Buffer.from(dxfonts.bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize)).toString('base64')}]).cases;
const expected = fontOracle.passes[0].state;
const pages = font.instanceValues.get(0x2c);
assert.equal(font.instanceValues.get(0x28), expected.charactersPerPage);
assert.equal(pages.num, expected.num);
assert.equal(pages.max, expected.max);
for (const [i, page] of expected.pages.entries()) {
  const mine = pages.data[i];
  assert.equal(mine.texture, graph.indexToObject(linker, page.texture), `page ${i} canonical texture export`);
  assert.equal(mine.characters.num, page.num);
  assert.equal(mine.characters.max, page.max);
  assert.deepEqual(mine.characters.data.slice(0, page.num).map(r => [r.startU, r.startV, r.uSize, r.vSize]), page.chars);
}
assert.equal(graph.slotOf(font, 0x1c) & 0x01000200, 0, 'Font load/postload flags complete');
assert.ok(graph.slotOf(font, 0x1c) & 0x20000000);

// Page textures and their palette against the retail Texture/Palette bodies.
const specs = [], textures = [];
for (const page of pages.data.slice(0, pages.num)) {
  const texture = page.texture, index = graph.slotOf(texture, 0x14) + 1;
  const t = readObject(dxfonts.pkg, dxfonts.bytes, index);
  const spec = kind => (d => ({name: d.entry.path, kind, start: d.entry.serialOffset, version: dxfonts.pkg.version,
    prefixSize: d.reader.offset, payload: Buffer.from(dxfonts.bytes.subarray(d.entry.serialOffset,
      d.entry.serialOffset + d.entry.serialSize)).toString('base64')}));
  specs.push({...spec('texture')(t), lazy: CLIENT_LAZY_LOAD, seed: {132: texture.instanceValues.get(0x84) ?? 0},
    postSize: [t.values.USize, t.values.VSize], uClamp: t.values.UClamp ?? 0, vClamp: t.values.VClamp ?? 0});
  textures.push(texture);
}
const palette = textures[0].instanceValues.get(0x2c);
assert.equal(textures[1].instanceValues.get(0x2c), palette, 'both pages share Palette1');
specs.push((d => ({name: d.entry.path, kind: 'palette', start: d.entry.serialOffset, version: dxfonts.pkg.version,
  prefixSize: d.reader.offset, payload: Buffer.from(dxfonts.bytes.subarray(d.entry.serialOffset,
    d.entry.serialOffset + d.entry.serialSize)).toString('base64')}))(
  readObject(dxfonts.pkg, dxfonts.bytes, graph.slotOf(palette, 0x14) + 1)));
const reference = run('scripts/native-texture-load-oracle.py', specs).cases;
for (const [i, texture] of textures.entries()) {
  const a = texture.instanceValues.get(0xa4), archive = linker.archive, original = reference[i].primary;
  assert.equal(a.num, original.num);
  assert.deepEqual(a.data.slice(0, a.num).map(m => ({width: m.width, height: m.height, uBits: m.uBits,
    vBits: m.vBits, savedPosition: m.lazy.savedPosition, attached: m.lazy.archive === archive,
    data: [...(m.lazy.bytes.data?.slice(0, m.lazy.bytes.num) ?? [])], num: m.lazy.bytes.num, max: m.lazy.bytes.max})),
  original.mips.map(m => ({...m, data: [...m.data]})), `${specs[i].name} mips`);
  assert.equal(texture.instanceValues.get(0x3c), reference[i].post.uClamp);
  assert.equal(texture.instanceValues.get(0x40), reference[i].post.vClamp);
}
const colors = palette.instanceValues.get(0x28);
assert.deepEqual(colors.data.slice(0, colors.num).flatMap(color => [...color]), reference.at(-1).colors);
assert.deepEqual(biasReads, textures.map(texture => texture.instanceValues.get(0x88) ?? 0));
assert.deepEqual(graph.assertions, []);
assert.deepEqual(graph.warnings.filter(warning => warning.kind !== 'exists'), []);

const mips = textures.map(t => t.instanceValues.get(0xa4));
console.log(`validate-font-load-graph: DXFonts.MainMenuTrueType through BeginLoad/CreateExport/EndLoad; ` +
  `${pages.num} pages x ${expected.charactersPerPage} glyphs, ${textures.length} page textures ` +
  `(${mips.map(m => `${m.num} mip`).join(', ')}) and one palette match the retail Font/Texture/Palette bodies; ` +
  `GLazyLoad ${CLIENT_LAZY_LOAD}, TextureLODSet [${lodSet.slice(0, 3).join(', ')}]`);
