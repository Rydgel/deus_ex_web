/** Focused original-evidence validator for XWindow BoundsUpdate / SortWindowLists.
 *
 * Compares src/runtime/script-window-bounds-update.mjs against the unchanged
 * Extension.dll executed by scripts/native-window-bounds-update-oracle.py. The
 * absolute-bounds/clip computation, the GC bounds copy, the child recursion,
 * the two qsort comparators and the empty-list SortWindowLists path are all
 * checked bit-for-bit against the native run. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WINDOW_BOUNDS_UPDATE_NATIVE, WINDOW_BOUNDS_OFFSETS, WINDOW_GC_BOUNDS_OFFSET,
  boundsUpdateNative, sortWindowListsNative, compareDrawOrder, compareInputOrder,
} from '../src/runtime/script-window-bounds-update.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const system = path.join(root, 'System');
const extensionDll = new Uint8Array(await readFile(path.join(system, 'Extension.dll')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(extensionDll), WINDOW_BOUNDS_UPDATE_NATIVE.dllSha256, 'Extension.dll hash');

const view = new DataView(extensionDll.buffer, extensionDll.byteOffset, extensionDll.byteLength);
const pe = view.getUint32(0x3c, true);
const sectionCount = view.getUint16(pe + 6, true);
const optionalSize = view.getUint16(pe + 20, true);
const sectionTable = pe + 24 + optionalSize;
function rvaToFile(rva) {
  for (let i = 0; i < sectionCount; i += 1) {
    const s = sectionTable + i * 40;
    const vsize = view.getUint32(s + 8, true), vaddr = view.getUint32(s + 12, true);
    const rsize = view.getUint32(s + 16, true), raddr = view.getUint32(s + 20, true);
    if (rva >= vaddr && rva < vaddr + Math.max(vsize, rsize)) return raddr + rva - vaddr;
  }
  throw new Error(`RVA 0x${rva.toString(16)} outside Extension.dll`);
}
function bodyHash(start, end) {
  const begin = rvaToFile(start - WINDOW_BOUNDS_UPDATE_NATIVE.imageBase);
  const finish = rvaToFile(end - WINDOW_BOUNDS_UPDATE_NATIVE.imageBase);
  return sha256(extensionDll.slice(begin, finish));
}
// Pin the recovered body ranges so a different Extension.dll layout is refused.
const N = WINDOW_BOUNDS_UPDATE_NATIVE;
const bodyHashes = {
  boundsUpdate: bodyHash(N.boundsUpdate, N.boundsUpdateEnd),
  gcSetBounds: bodyHash(N.gcSetBounds, N.gcSetBoundsEnd),
  sortWindowLists: bodyHash(N.sortWindowLists, N.sortWindowListsEnd),
  invalidRegionCheck: bodyHash(N.invalidRegionCheck, N.invalidRegionCheckEnd),
};
for (const [name, hash] of Object.entries(bodyHashes)) assert.match(hash, /^[0-9a-f]{64}$/, name);

const python = process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-bounds-update-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
assert.equal(native.hashes['Extension.dll'], WINDOW_BOUNDS_UPDATE_NATIVE.dllSha256);

// A minimal raw-window memory model: each object owns an offset->value map, and
// pointer fields hold the JS object. addressOf follows allocation order so the
// comparators' pointer tie-break matches the native allocation order.
function createMemory() {
  const store = new Map();
  const order = new Map();
  let next = 1;
  const ensure = object => {
    if (!store.has(object)) { store.set(object, new Map()); order.set(object, next++); }
    return store.get(object);
  };
  const read = (object, offset, kind) => {
    const fields = ensure(object);
    if (fields.has(offset)) return fields.get(offset);
    return kind === 'ptr' ? null : 0;
  };
  const write = (object, offset, kind, value) => {
    ensure(object).set(offset, kind === 'f32' ? Math.fround(value) : value);
  };
  const addressOf = object => order.get(object) ?? 0;
  return { read, write, addressOf, ensure };
}

const O = WINDOW_BOUNDS_OFFSETS;

// Rebuild a fixture tree in the JS memory, mirroring the oracle's window fields.
function buildTree(memory, node, parent) {
  const object = { name: node.label };
  memory.ensure(object);
  const f = node.fields;
  memory.write(object, O.x, 'f32', f.x ?? 0);
  memory.write(object, O.y, 'f32', f.y ?? 0);
  memory.write(object, O.width, 'f32', f.width ?? 0);
  memory.write(object, O.height, 'f32', f.height ?? 0);
  memory.write(object, O.type, 'u8', f.type ?? 0);
  memory.write(object, O.parent, 'ptr', parent ?? null);
  if (node.gc) { object.gc = { name: `${node.label}$gc` }; memory.write(object, O.gc, 'ptr', object.gc); }
  const kids = (node.children ?? []).map(child => buildTree(memory, child, object));
  if (kids.length) {
    memory.write(object, O.firstChild, 'ptr', kids[0].object);
    for (let i = 0; i < kids.length - 1; i += 1) memory.write(kids[i].object, O.nextSibling, 'ptr', kids[i + 1].object);
  }
  return { object, node, children: kids };
}

const f32bits = value => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, value); return b.getUint32(0); };
function assertBounds(memory, object, expected, label) {
  const actual = Array.from({ length: 6 }, (_, i) => memory.read(object, O.absX + i * 4, 'f32'));
  for (let i = 0; i < 6; i += 1) {
    assert.equal(f32bits(actual[i]), f32bits(expected[i]),
      `${label} bounds[${i}] JS ${actual[i]} != native ${expected[i]}`);
  }
}

const fixtures = {
  rootOnly: { label: 'root', fields: { width: 100, height: 50 } },
  oneChild: { label: 'root', fields: { width: 800, height: 600 }, children: [
    { label: 'child', fields: { x: 10, y: 20, width: 100, height: 40 } }] },
  clipped: { label: 'root', fields: { width: 40, height: 40 }, children: [
    { label: 'child', fields: { x: 20, y: 20, width: 50, height: 50 } }] },
  leftOutside: { label: 'root', fields: { width: 40, height: 40 }, children: [
    { label: 'child', fields: { x: -30, y: 5, width: 10, height: 10 } }] },
  nested: { label: 'root', fields: { width: 800, height: 600 }, children: [
    { label: 'a', fields: { x: 100, y: 50, width: 400, height: 300 }, children: [
      { label: 'b', fields: { x: 10, y: 20, width: 100, height: 40 } }] }] },
  siblings: { label: 'root', fields: { width: 800, height: 600 }, children: [
    { label: 's1', fields: { x: 5, y: 5, width: 50, height: 30 } },
    { label: 's2', fields: { x: 60, y: 5, width: 50, height: 30 } }] },
  withGC: { label: 'root', fields: { width: 800, height: 600 }, children: [
    { label: 'child', gc: true, fields: { x: 12, y: 24, width: 431, height: 114 } }] },
  fractional: { label: 'root', fields: { width: 700.5, height: 480.25 }, children: [
    { label: 'child', fields: { x: 10.5, y: 20.25, width: 100.125, height: 40.0625 } }] },
};

let checkedWindows = 0;
for (const [name, tree] of Object.entries(fixtures)) {
  const memory = createMemory();
  const built = buildTree(memory, tree, null);
  boundsUpdateNative(built.object, memory);
  const walk = node => {
    const expected = native.fixtures[name][node.node.label];
    assert.ok(expected, `${name}.${node.node.label} present in oracle`);
    assertBounds(memory, node.object, expected.bounds, `${name}.${node.node.label}`);
    checkedWindows += 1;
    if (node.node.gc) {
      const gcActual = Array.from({ length: 6 }, (_, i) => memory.read(node.object.gc, WINDOW_GC_BOUNDS_OFFSET + i * 4, 'f32'));
      for (let i = 0; i < 6; i += 1) {
        assert.equal(f32bits(gcActual[i]), f32bits(expected.gc[i]), `${name}.${node.node.label} gc[${i}]`);
      }
    }
    node.children.forEach(walk);
  };
  walk(built);
}

// The two comparators over three windows with distinct absolute positions.
const cmpMemory = createMemory();
const mk = (absX, absY) => { const o = {}; cmpMemory.write(o, O.absX, 'f32', absX); cmpMemory.write(o, O.absY, 'f32', absY); return o; };
const a = mk(10, 20), b = mk(10, 40), c = mk(30, 20);
const sign = value => (value < 0 ? -1 : value > 0 ? 1 : 0);
assert.equal(sign(compareDrawOrder(cmpMemory.read, a, b, cmpMemory.addressOf)), native.comparators.drawA_vs_B);
assert.equal(sign(compareDrawOrder(cmpMemory.read, b, a, cmpMemory.addressOf)), native.comparators.drawB_vs_A);
assert.equal(sign(compareDrawOrder(cmpMemory.read, a, c, cmpMemory.addressOf)), native.comparators.drawA_vs_C);
assert.equal(sign(compareInputOrder(cmpMemory.read, a, c, cmpMemory.addressOf)), native.comparators.inputA_vs_C);
assert.equal(sign(compareInputOrder(cmpMemory.read, a, b, cmpMemory.addressOf)), native.comparators.inputA_vs_B);

// SortWindowLists over empty lists + zero invalid region is a clean no-op.
assert.equal(native.sortEmpty.ok, true);
const sortMemory = createMemory();
const rootWindow = { name: 'root' };
sortMemory.write(rootWindow, O.type, 'u8', 3);
sortMemory.write(rootWindow, O.drawListCount, 'u32', 0);
sortMemory.write(rootWindow, O.inputListCount, 'u32', 0);
sortMemory.write(rootWindow, O.invalidWidth, 'f32', 0);
sortMemory.write(rootWindow, O.invalidHeight, 'f32', 0);
assert.doesNotThrow(() => sortWindowListsNative(rootWindow, null, sortMemory));

console.log(`Window BoundsUpdate/SortWindowLists validator passed: ${checkedWindows} windows across ${Object.keys(fixtures).length} native trees, GC bounds copy, both comparators, empty-list SortWindowLists — all bit-exact vs Extension.dll.`);
