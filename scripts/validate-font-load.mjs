#!/usr/bin/env node
/** Engine Font registration, constructor, Serialize and PostLoad against the
 * unchanged retail bodies (scripts/native-font-load-oracle.py). Real DXFonts
 * and Engine fonts plus synthetic reload, assertion and lazy-loop cases.
 * Evidence: docs/script-font-load.md. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {parsePackage, Reader} from '../src/unreal/package.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {FONT_NATIVE, FONT_PER_PAGE_ASSERT, FontLoadBoundaryError, constructFont, serializeFont}
  from '../src/runtime/script-font-load.mjs';
import {removeResourceArray} from '../src/runtime/script-texture-load.mjs';
import {postLoadObject} from '../src/runtime/script-post-load.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? process.env.DEUS_EX_NATIVE_PYTHON ??
  '.cache/native-probe-env/bin/python';
const oracle = specs => JSON.parse(execFileSync(python, ['scripts/native-font-load-oracle.py',
  gameDirectory(), '--stdin'], {encoding: 'utf8', input: JSON.stringify(specs), maxBuffer: 64 * 1024 * 1024}));

function compact(value) {
  const out = [(value < 0 ? 0x80 : 0) | (Math.abs(value) & 63)];
  let rest = Math.abs(value) >>> 6;
  if (rest) out[0] |= 64;
  while (rest) { out.push((rest & 127) | (rest >= 128 ? 128 : 0)); rest >>>= 7; }
  return out;
}
const word = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
function synthetic(pages, perPage) {
  const out = [...compact(pages.length)];
  for (const {texture, chars} of pages) {
    out.push(...compact(texture), ...compact(chars.length));
    for (const record of chars) for (const value of record) out.push(...word(value));
  }
  out.push(...word(perPage));
  return Buffer.from(out).toString('base64');
}

async function realCase(file, name, extra = {}) {
  const bytes = new Uint8Array(await readFile(path.join(gameDirectory(), file)));
  const pkg = parsePackage(bytes), index = pkg.exports.findIndex(e => e.name === name) + 1;
  assert.ok(index > 0, `${file} ${name}`);
  const entry = pkg.exports[index - 1], decoded = readObject(pkg, bytes, index);
  assert.equal(entry.className, 'Font');
  return {name, start: entry.serialOffset, prefixSize: decoded.reader.offset, version: pkg.version,
    payload: Buffer.from(bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize)).toString('base64'),
    end: entry.serialOffset + entry.serialSize, ...extra};
}

const glyph = n => [n, n + 1, n + 2, n + 3];
const cases = [
  await realCase('Textures/DXFonts.utx', 'MainMenuTrueType'),
  await realCase('Textures/DXFonts.utx', 'HUDMessageTrueType', {reload: true, lazy: 1}),
  await realCase('System/Engine.u', 'SmallFont'),
  await realCase('System/DeusExUI.u', 'FontMenuSmall', {lazy: 7}),
  {name: 'empty', start: 4096, prefixSize: 0, version: 68, payload: synthetic([], 1)},
  {name: 'non-power-of-two', start: 4096, prefixSize: 0, version: 68,
    payload: synthetic([{texture: 1, chars: [glyph(1)]}], 3), stopsAtAssert: true},
  // A callback that clears the forced GLazyLoad reaches the mip Load loop:
  // 256/64 iterations over three pages (the second has no texture).
  {name: 'lazy-loop', start: 4096, prefixSize: 0, version: 68, clearLazyOnRef: true,
    mips: {1: 2, 3: 1}, payload: synthetic([{texture: 1, chars: [glyph(1), glyph(5)]},
      {texture: 0, chars: []}, {texture: 3, chars: [glyph(9)]}], 64)},
];

const result = oracle(cases);
assert.deepEqual(result.hashes, {
  'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
});

// Vtable: Serialize +0x28 -> 0x10302342 -> 0x10385400; PostLoad +0x20 is the
// shared jump to Core UObject::PostLoad.
assert.equal(result.vtable[10], 0x10302342);
assert.equal(result.vtable[8], FONT_NATIVE.postLoadThunk);
// Registration: 15 UClass-constructor arguments and the registered default.
const defaults = result.classDefaults;
assert.deepEqual(defaults.registration, [0, FONT_NATIVE.instanceSize, 0, 0x1029e0d0, 0x1029e0d0,
  0, 0, 0, 0, 0x1047e0fe, 0x1047a148, 0x10479e58, 0x4084004, FONT_NATIVE.internalConstructor,
  FONT_NATIVE.staticConstructor]);
assert.deepEqual(defaults.strings, {name: 'Font', package: 'Engine', config: 'System'});
assert.equal(defaults.atexit, 0x10385630);
assert.equal(defaults.size, FONT_NATIVE.instanceSize);
assert.equal(defaults.classFlags, FONT_NATIVE.registeredClassFlags);
assert.equal(defaults.num, 0x38);
assert.equal(defaults.max, 0x38);
assert.deepEqual(defaults.defaultTail, Array(0x10).fill(0));

function translated(spec) {
  const data = Buffer.from(spec.payload, 'base64');
  const bytes = new Uint8Array(spec.start + data.length); bytes.set(data, spec.start);
  const reader = new Reader(bytes); reader.seek(spec.start);
  let events = [], lazy = spec.lazy ?? 0;
  const textures = new Map();
  const texture = index => {
    if (index === 0) return null;
    if (!textures.has(index)) {
      const count = spec.mips?.[index] ?? 0;
      const mips = {data: Array.from({length: count}, (_, mip) => ({lazy: {vtable: FONT_NATIVE.lazyArrayVtable,
        owner: {texture: index, mip}}})), num: count, max: count};
      textures.set(index, {index, slots: new Map([[0xa4, mips]])});
    }
    return textures.get(index);
  };
  const font = {slots: new Map([[0x28, 0x5a5a5a5a], [0x1c, 0x01000000]])};
  const services = {
    read: (object, offset) => object.slots.get(offset),
    write: (object, offset, value) => object.slots.set(offset, value),
    objectConstructor: () => events.push({op: 'ObjectCtor', object: 'texture'}),
    objectSerialize() { events.push({op: 'ObjectSerialize'}); reader.offset += spec.prefixSize; },
    getLazyLoad: () => lazy,
    setLazyLoad: value => { lazy = value; },
    serializeObject() {
      const before = reader.offset;
      const index = rawCompact();
      events.push({op: 'ObjectRef', index, bytes: reader.offset - before});
      if (spec.clearLazyOnRef) lazy = 0;
      return texture(index);
    },
    arrayRealloc(a, elementSize) {
      events.push({op: 'Realloc', elementSize, num: a.num, max: a.max});
      if (!a.max) { a.data = null; return; }
      a.data ??= [];
      a.data.length = a.max;
    },
    arrayRemove: (a, index, amount, size) => removeResourceArray(a, index, amount, size, services),
    freeArray(a) { events.push({op: 'Free'}); a.data = null; },
    loadLazyArray(lazyArray) {
      assert.equal(lazyArray.vtable, FONT_NATIVE.lazyArrayVtable);
      events.push({op: 'MipLoad', ...lazyArray.owner});
    },
    failAssert: ({expr, file, line}) => events.push({op: 'FailAssert', line, expr, file}),
  };
  const raw = reader.u8.bind(reader);
  const rawCompact = () => { const saved = reader.u8; reader.u8 = raw; try { return reader.compact(); } finally { reader.u8 = saved; } };
  const archive = {
    ar04: spec.version, ar0c: 1, ar10: 0,
    readRaw(size) { events.push({op: 'Read', at: reader.offset, size}); return reader.take(size); },
    readCompact: () => reader.compact(),
    countBytes: (amount, maximum) => events.push({op: 'CountBytes', amount, maximum}),
  };
  reader.u8 = () => archive.readRaw(1)[0];
  constructFont(font, services);
  const constructor = {events, vtable: font.slots.get(0), words: {
    '0x28': font.slots.get(0x28), '0x2c': font.slots.get(0x2c).data ?? 0,
    '0x30': font.slots.get(0x2c).num, '0x34': font.slots.get(0x2c).max}};
  const passes = [];
  let stopped = null;
  for (let pass = 0; pass < (spec.reload ? 2 : 1); pass += 1) {
    reader.seek(spec.start);
    lazy = spec.lazy ?? 0;
    events = [];
    try { serializeFont(font, archive, services); } catch (error) {
      if (!(error instanceof FontLoadBoundaryError) || !spec.stopsAtAssert) throw error;
      stopped = error;
    }
    const pages = font.slots.get(0x2c);
    passes.push({events, state: {vtable: font.slots.get(0), charactersPerPage: font.slots.get(0x28) | 0,
      num: pages.num, max: pages.max, position: reader.offset, lazyGlobal: lazy,
      pages: (pages.data ?? []).slice(0, pages.num).map(page => ({texture: page.texture?.index ?? null,
        num: page.characters.num, max: page.characters.max,
        chars: (page.characters.data ?? []).slice(0, page.characters.num)
          .map(r => [r.startU, r.startV, r.uSize, r.vSize])}))}});
  }
  const flagsBefore = font.slots.get(0x1c);
  postLoadObject(font, {read: (o, field) => field === 'objectFlags' ? o.slots.get(0x1c) : undefined,
    write: (o, field, value) => { assert.equal(field, 'objectFlags'); o.slots.set(0x1c, value); }});
  return {constructor, passes, stopped, post: {events: [], flagsBefore, flagsAfter: font.slots.get(0x1c)}};
}

for (const [index, spec] of cases.entries()) {
  const expected = result.cases[index], actual = translated(spec);
  assert.equal(expected.name, spec.name);
  assert.deepEqual(actual.constructor, expected.constructor, `${spec.name} constructor`);
  assert.equal(expected.constructor.vtable, FONT_NATIVE.vtable);
  assert.equal(actual.passes.length, expected.passes.length);
  for (const [pass, original] of expected.passes.entries()) {
    const mine = actual.passes[pass];
    if (spec.stopsAtAssert) {
      // Release appFailAssert throws through GError; compare to that edge.
      const at = original.events.findIndex(event => event.op === 'FailAssert');
      assert.ok(at >= 0, `${spec.name} reaches the original assertion`);
      assert.deepEqual(original.events[at], {op: 'FailAssert', ...FONT_PER_PAGE_ASSERT});
      assert.deepEqual(mine.events, original.events.slice(0, at + 1), `${spec.name} events`);
      assert.equal(actual.stopped?.assertion, FONT_PER_PAGE_ASSERT);
      continue;
    }
    // Page texture identities are the stub's per-index objects on both sides.
    assert.deepEqual(mine.events, original.events, `${spec.name} pass ${pass} events`);
    assert.deepEqual(mine.state, {...original.state, vtable: original.state.vtable}, `${spec.name} pass ${pass} state`);
    if (spec.end !== undefined) assert.equal(original.state.position, spec.end, `${spec.name} consumes its export`);
    assert.equal(original.state.lazyGlobal, spec.lazy ?? 0, `${spec.name} restores GLazyLoad`);
  }
  if (!spec.stopsAtAssert) assert.deepEqual(actual.post, expected.post, `${spec.name} PostLoad`);
}

const main = result.cases[0].passes[0].state;
assert.equal(main.charactersPerPage, 128);
assert.deepEqual(main.pages.map(page => [page.texture, page.num]), [[5, 128], [3, 128]]);
const loop = result.cases.find(c => c.name === 'lazy-loop').passes[0].events.filter(e => e.op === 'MipLoad');
assert.deepEqual(loop, [{op: 'MipLoad', texture: 1, mip: 0}, {op: 'MipLoad', texture: 1, mip: 1},
  {op: 'MipLoad', texture: 3, mip: 0}]);

const names = cases.map(spec => spec.name).join(', ');
console.log(`validate-font-load: ${cases.length} cases match the retail Engine.dll bodies (${names}); ` +
  'registration, constructor, Serialize, page/glyph arrays, reload destruction and PostLoad');
