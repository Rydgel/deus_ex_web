#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {Reader} from '../src/unreal/package.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {createScriptLoadGraph} from '../src/runtime/script-load-graph.mjs';
import {createLinkerLoadArchive, attachLinkerLazyLoader, detachLinkerLazyLoader}
  from '../src/runtime/script-linker-lazy-loader.mjs';
import {constructTexture, constructPalette, serializeTexture, serializePalette,
  loadTextureLazyBytes, postLoadTexture, removeResourceArray}
  from '../src/runtime/script-texture-load.mjs';

const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
function oracle(specs) {
  return JSON.parse(execFileSync(python, ['scripts/native-texture-load-oracle.py', gameDirectory(),
    ...(specs ? ['--stdin'] : [])], {encoding: 'utf8', input: specs ? JSON.stringify(specs) : undefined,
    maxBuffer: 32 * 1024 * 1024}));
}
function compact(n) {
  const bytes = [(n & 63) | (n >= 64 ? 64 : 0)];
  n >>>= 6;
  while (n) { bytes.push((n & 127) | (n >= 128 ? 128 : 0)); n >>>= 7; }
  return bytes;
}
function payload(spec) {
  if (spec.payload) return Buffer.from(spec.payload, 'base64');
  if (spec.kind === 'palette') return Uint8Array.from([...compact(spec.colors.length), ...spec.colors.flat()]);
  const out = [], start = spec.start ?? 4096;
  const word = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
  for (const chain of spec.chains) {
    out.push(...compact(chain.length));
    for (const mip of chain) {
      const data = [...compact(mip.data.length), ...mip.data];
      if ((spec.version ?? 68) > 61) out.push(...word(start + out.length + 4 + data.length));
      out.push(...data, ...word(mip.width), ...word(mip.height), mip.uBits, mip.vBits);
    }
  }
  return Uint8Array.from(out);
}
function memory() { return {view: new DataView(new ArrayBuffer(0x600)), pointers: new Map()}; }
function translated(spec) {
  let events = [], lazy = spec.lazy ?? 0;
  const start = spec.start ?? 4096, data = payload(spec);
  const bytes = new Uint8Array(start + data.length); bytes.set(data, start);
  const reader = new Reader(bytes); reader.seek(start);
  const object = memory(), palette = memory();
  const methods = {u8: ['getUint8', 'setUint8'], u32: ['getUint32', 'setUint32'],
    f32: ['getFloat32', 'setFloat32'], f64: ['getFloat64', 'setFloat64']};
  const services = {
    read(obj, offset, type = 'u32') {
      return type === 'pointer' || type === 'array' ? obj.pointers.get(offset) ?? null
        : obj.view[methods[type][0]](offset, true);
    },
    write(obj, offset, value, type = 'u32') {
      if (type === 'pointer' || type === 'array') obj.pointers.set(offset, value);
      else obj.view[methods[type][1]](offset, value, true);
    },
    objectConstructor: obj => events.push({op: 'ObjectCtor', object: obj === palette ? 'palette' : 'texture'}),
    objectSerialize(obj) {
      events.push({op: 'ObjectSerialize'});
      reader.offset += spec.prefixSize ?? 0;
      for (const [offset, value] of Object.entries(spec.seed ?? {132: spec.flags ?? 0}))
        obj.view.setUint32(Number(offset), value, true);
    },
    objectPostLoad: obj => obj.view.setUint32(0x1c, obj.view.getUint32(0x1c, true) | 0x20000000, true),
    seconds: () => { events.push({op: 'Seconds'}); return 12.5; },
    arrayRealloc(a, elementSize) {
      events.push({op: 'Realloc', elementSize, num: a.num, max: a.max});
      if (!a.max) { a.data = null; return; }
      a.data ??= [];
      a.data.length = a.max;
    },
    arrayRemove: (a, index, amount, size) => removeResourceArray(a, index, amount, size, services),
    freeArray: a => { a.data = null; },
    attach(ar, loader) {
      events.push({op: 'Attach', position: reader.offset});
      attachLinkerLazyLoader(ar, loader, services);
    },
    detach(ar, loader) { events.push({op: 'Detach'}); detachLinkerLazyLoader(ar, loader, services); },
    readerTell: () => archive.tell(),
    getLazyLoad: () => lazy,
    setLazyLoad: value => { lazy = value; },
    mipBias: () => spec.bias ?? 0,
    allocatePalette({size, outer, name, flags}) {
      events.push({op: 'AllocatePalette', size, sameOuter: outer === 0x1234, name, flags});
      return palette;
    },
  };
  const archive = createLinkerLoadArchive({linker: {}, reader, services});
  Object.assign(archive, {
    ar04: spec.version ?? 68, ar0c: 1, ar10: 0,
    tell() { events.push({op: 'Tell', position: reader.offset}); return reader.offset; },
    seek(position) { events.push({op: 'Seek', position}); reader.seek(position); },
    readRaw(size) { events.push({op: 'Read', at: reader.offset, size}); return reader.take(size); },
    readU32() { const b = archive.readRaw(4); return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true); },
    readCompact: () => reader.compact(),
    countBytes: (amount, maximum) => events.push({op: 'CountBytes', amount, maximum}),
  });
  reader.u8 = () => archive.readRaw(1)[0];
  const mips = offset => {
    const a = services.read(object, offset, 'array');
    return {num: a.num, max: a.max, mips: a.data?.slice(0, a.num).map(m => ({width: m.width,
      height: m.height, uBits: m.uBits, vBits: m.vBits, savedPosition: m.lazy.savedPosition,
      attached: m.lazy.archive === archive, data: m.lazy.bytes.data?.slice(0, m.lazy.bytes.num) ?? [],
      num: m.lazy.bytes.num, max: m.lazy.bytes.max})) ?? []};
  };
  services.write(object, 0x18, 0x1234, 'pointer');
  services.write(object, 0x1c, 0x01000000);
  const isPalette = spec.kind === 'palette';
  (isPalette ? constructPalette : constructTexture)(object, services);
  const constructor = {vtable: services.read(object, 0)};
  if (!isPalette) Object.assign(constructor, {time: services.read(object, 0x4c, 'f64'),
    words: Object.fromEntries([0x28, 0x2c, 0x30, 0x34, 0x38, 0x44, 0x48, 0x60, 0x64, 0x68,
      0x6c, 0x70, 0x74].map(offset => [`0x${offset.toString(16)}`, services.read(object, offset)]))});
  events = [];
  (isPalette ? serializePalette : serializeTexture)(object, archive, services);
  const result = {spec, constructor, events, position: reader.offset};
  if (isPalette) {
    const a = services.read(object, 0x28, 'array');
    return {...result, colors: a.data?.slice(0, a.num).flatMap(color => [...color]) ?? [], num: a.num, max: a.max};
  }
  Object.assign(result, {primary: mips(0xa4), compressed: mips(0xb0), lazyAfter: lazy,
    attachedCount: archive.lazyLoaderArray.num});
  if (spec.reload) {
    events = []; reader.seek(start);
    serializeTexture(object, archive, services);
    result.reload = {events, primary: mips(0xa4), position: reader.offset, attachedCount: archive.lazyLoaderArray.num};
  }
  if (spec.loadDeferred) {
    events = [];
    const primary = services.read(object, 0xa4, 'array');
    for (const mip of primary.data?.slice(0, primary.num) ?? []) {
      loadTextureLazyBytes(mip.lazy, services); loadTextureLazyBytes(mip.lazy, services);
    }
    result.deferred = {events, primary: mips(0xa4), position: reader.offset};
  }
  events = [];
  services.write(object, 0x2c, spec.noPalette ? null : palette, 'pointer');
  for (const [offset, value] of [[0x34, spec.postSize?.[0] ?? 16], [0x38, spec.postSize?.[1] ?? 8], [0x3c, spec.uClamp ?? -2],
    [0x40, spec.vClamp ?? 20], [0xa0, 0xdeadbeef]]) services.write(object, offset, value);
  postLoadTexture(object, services);
  const colors = services.read(palette, 0x28, 'array');
  result.post = {events, flags: services.read(object, 0x1c), uClamp: services.read(object, 0x3c) | 0,
    vClamp: services.read(object, 0x40) | 0, clearA0: services.read(object, 0xa0),
    time: services.read(object, 0x4c, 'f64'), samePalette: services.read(object, 0x2c, 'pointer') === palette,
    palette: colors?.data?.slice(0, colors.num).flatMap(color => [...color]) ?? []};
  return result;
}

const native = oracle();
assert.equal(native.hashes['Engine.dll'], '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4');
for (const sample of native.cases) assert.deepEqual(translated(sample.spec), sample, sample.spec.name);

// Reuse the established original mutation case at the representation boundary:
// the shared body must negate the current SavedPos after a callback changes it.
const changed = JSON.parse(execFileSync(python, ['scripts/native-lazy-byte-array-oracle.py', gameDirectory()],
  {encoding: 'utf8'})).find(sample => sample.kind === 'generic' && sample.change);
let position = 200;
const byteArray = {data: null, num: 0, max: 0};
const changedLazy = {savedPosition: changed.initial, bytes: byteArray};
changedLazy.archive = {ar0c: 1, tell: () => position, seek: value => { position = value; },
  countBytes() {}, readCompact: () => 13, readRaw: count => {
    changedLazy.savedPosition = 160; return new Uint8Array(count);
  }};
loadTextureLazyBytes(changedLazy, {arrayRealloc: array => { array.data = new Uint8Array(array.max); }});
assert.equal(changedLazy.savedPosition, changed.position);
assert.equal(byteArray.num, changed.count);
assert.equal(position, changed.ops.at(-1)[1]);

// Real package-to-native boundary: retain original absolute offsets, run the
// original resource tails, then compare the shared graph (including its tagged
// base serializer and canonical lazy archive) to those original outputs.
const assets = new AssetStore(['Core', 'Engine'].map(name => ({path: `System/${name}.u`,
  read: () => readFile(path.join(gameDirectory(), 'System', `${name}.u`))})));
const packageAssets = new Map();
for (const name of ['Core', 'Engine']) packageAssets.set(name.toLowerCase(), await assets.get(name));
let lazy = 1;
const graph = createScriptLoadGraph({packageAssets, resourceServices: {
  seconds: () => 12.5, getLazyLoad: () => lazy, setLazyLoad: value => { lazy = value; }, mipBias: () => 0,
}});
const engine = packageAssets.get('engine'), records = [], specs = [];
for (const name of ['S_Camera', 'DefaultTexture']) {
  const ref = engine.exportsByPath.get(name.toLowerCase());
  const decoded = readObject(engine.pkg, engine.bytes, ref);
  const texture = graph.loadExport('Engine', ref);
  const palette = texture.instanceValues.get(0x2c);
  assert.equal(graph.indexToObject(graph.buildLinker('Engine'), ref), texture, 'canonical resource identity');
  graph.preload(palette);
  const palRef = graph.slotOf(palette, 0x14) + 1;
  const palDecoded = readObject(engine.pkg, engine.bytes, palRef);
  const specFor = (decoded, kind) => ({name: decoded.entry.path, kind, start: decoded.entry.serialOffset,
    version: engine.pkg.version, prefixSize: decoded.reader.offset,
    payload: Buffer.from(engine.bytes.subarray(decoded.entry.serialOffset,
      decoded.entry.serialOffset + decoded.entry.serialSize)).toString('base64')});
  const spec = {...specFor(decoded, 'texture'), lazy: 1, loadDeferred: true,
    seed: {132: texture.instanceValues.get(0x84) ?? 0},
    postSize: [decoded.values.USize, decoded.values.VSize],
    uClamp: decoded.values.UClamp ?? 0, vClamp: decoded.values.VClamp ?? 0};
  specs.push(spec, specFor(palDecoded, 'palette'));
  records.push({texture, palette, spec});
}
const real = oracle(specs);
function graphMips(texture, offset) {
  const a = texture.instanceValues.get(offset);
  const archive = graph.slotOf(texture, 0x10).archive;
  return {num: a.num, max: a.max, mips: a.data?.slice(0, a.num).map(m => ({width: m.width,
    height: m.height, uBits: m.uBits, vBits: m.vBits, savedPosition: m.lazy.savedPosition,
    attached: m.lazy.archive === archive, data: m.lazy.bytes.data?.slice(0, m.lazy.bytes.num) ?? [],
    num: m.lazy.bytes.num, max: m.lazy.bytes.max})) ?? []};
}
for (let i = 0; i < records.length; i += 1) {
  const {texture, palette, spec} = records[i], reference = real.cases[2 * i], palRef = real.cases[2 * i + 1];
  assert.deepEqual(translated(spec), reference, `${spec.name} original resource tail event order`);
  assert.deepEqual(graphMips(texture, 0xa4), reference.primary);
  assert.deepEqual(graphMips(texture, 0xb0), reference.compressed);
  const colors = palette.instanceValues.get(0x28);
  assert.deepEqual(colors.data.slice(0, colors.num).flatMap(color => [...color]), palRef.colors);
  const archive = graph.slotOf(texture, 0x10).archive;
  const position = archive.tell();
  for (const mip of texture.instanceValues.get(0xa4).data) {
    graph.loadResourceBytes(mip.lazy); graph.loadResourceBytes(mip.lazy);
  }
  assert.equal(archive.tell(), position, 'shared package cursor restored after lazy load');
  assert.deepEqual(graphMips(texture, 0xa4), reference.deferred.primary);
  graph.conditionalPostLoad(palette);
  graph.conditionalPostLoad(texture);
  assert.equal(texture.instanceValues.get(0x2c), palette, 'PostLoad retains canonical palette');
  assert.equal(texture.instanceValues.get(0x3c), reference.post.uClamp);
  assert.equal(texture.instanceValues.get(0x40), reference.post.vClamp);
  assert.equal(texture.instanceValues.get(0x4c), reference.post.time);
  assert.equal(texture.instanceValues.get(0xa0), 0);
  assert.equal(graph.slotOf(texture, 0x1c) & 0x01000200, 0, 'resource load/postload flags complete');
  assert.ok(graph.slotOf(texture, 0x1c) & 0x20000000);
}
assert.equal(graph.buildLinker('Engine').archive.lazyLoaderArray.num, 9);
assert.deepEqual(graph.assertions, []);
assert.deepEqual(graph.warnings.filter(warning => warning.kind !== 'exists'), []);
console.log(`PASS texture loading: ${native.cases.length} original Engine cases, constructor/serialize/postload, ` +
  'lazy cursor restoration, reload detach, compressed chain, legacy palette alpha; ' +
  `${records.length} real textures and their palettes through the shared graph (9 mips)`);
