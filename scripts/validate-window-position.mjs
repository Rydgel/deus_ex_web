/** Focused original comparison for Window.SetPos -> XWindow::Move. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {
  WINDOW_POSITION_NATIVE,
  WINDOW_POSITION_NATIVE_ADDRESSES,
  WINDOW_POSITION_OFFSETS,
  moveWindowNative,
} from '../src/runtime/script-window-position.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory();
const system = path.join(root, 'System');
const assets = new AssetStore((await readdir(system)).map(name => ({
  path: `System/${name}`,
  read: () => readFile(path.join(system, name)),
})));
const extension = await assets.get('Extension');
const index = extension.exportsByPath.get('window.setpos');
assert.equal(index, WINDOW_POSITION_NATIVE.packageExport);
const metadata = readFunctionMetadata(extension, index);
assert.equal(metadata.nativeIndex, WINDOW_POSITION_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags, WINDOW_POSITION_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize, WINDOW_POSITION_NATIVE.serialSize);
assert.deepEqual(metadata.parameters.map(parameter => parameter.name), ['newX', 'newY']);

const dll = new Uint8Array(await readFile(path.join(system, 'Extension.dll')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(dll), WINDOW_POSITION_NATIVE.dllSha256);
for (const [start, end, hash] of [
  [WINDOW_POSITION_NATIVE.execBody, WINDOW_POSITION_NATIVE.execEnd, WINDOW_POSITION_NATIVE.execSha256],
  [WINDOW_POSITION_NATIVE.setPosBody, WINDOW_POSITION_NATIVE.setPosEnd, WINDOW_POSITION_NATIVE.setPosSha256],
  [WINDOW_POSITION_NATIVE.moveBody, WINDOW_POSITION_NATIVE.moveEnd, WINDOW_POSITION_NATIVE.moveSha256],
]) {
  assert.equal(sha(dll.subarray(start - 0x10000000, end - 0x10000000)), hash,
    `Extension.dll bytes ${start.toString(16)}..${end.toString(16)}`);
}

const python = process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python');
const original = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-position-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));
assert.equal(original.hashes['Extension.dll'], WINDOW_POSITION_NATIVE.dllSha256);
assert.equal(original.extensionBase, 0x12000000);
assert.equal(original.addresses.setPos, 0x120032f0);
assert.equal(original.addresses.move, 0x1204ce80);
assert.equal(original.addresses.askParentForReconfigure, 0x1204e060);

const fromBits = bits => {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, bits >>> 0, true);
  return view.getFloat32(0, true);
};
const toBits = value => {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};

function fixture(name, alignment, position) {
  const object = {name, bytes: new Uint8Array(0x200)};
  object.bytes.fill(0xaa);
  const view = new DataView(object.bytes.buffer);
  view.setUint8(WINDOW_POSITION_OFFSETS.alignmentX, alignment[0]);
  view.setUint8(WINDOW_POSITION_OFFSETS.alignmentY, alignment[1]);
  view.setUint32(WINDOW_POSITION_OFFSETS.x, position[0] >>> 0, true);
  view.setUint32(WINDOW_POSITION_OFFSETS.y, position[1] >>> 0, true);
  const accesses = [];
  const events = [];
  const read = (target, offset, kind, details) => {
    const value = kind === 'u8'
      ? new DataView(target.bytes.buffer).getUint8(offset)
      : new DataView(target.bytes.buffer).getFloat32(offset, true);
    accesses.push({op: 'read', offset, kind, bits: kind === 'u8' ? value : toBits(value)});
    return value;
  };
  const write = (target, offset, kind, value, details) => {
    const targetView = new DataView(target.bytes.buffer);
    if (kind === 'u8') targetView.setUint8(offset, value);
    else targetView.setFloat32(offset, value, true);
    accesses.push({op: 'write', offset, kind,
      bits: kind === 'u8' ? value : toBits(value)});
  };
  const services = {
    read,
    write,
    askParentForReconfigure: () => events.push({op: 'AskParentForReconfigure'}),
  };
  return {object, accesses, events, services};
}

const cases = {
  alignmentX: {alignment: [1, 0], position: [toBits(10), toBits(20)], request: [toBits(30), toBits(40)]},
  alignmentY: {alignment: [0, 1], position: [toBits(10), toBits(20)], request: [toBits(30), toBits(40)]},
  changedX: {alignment: [0, 0], position: [toBits(10), toBits(20)], request: [toBits(30), toBits(20)]},
  changedY: {alignment: [0, 0], position: [toBits(30), toBits(20)], request: [toBits(30), toBits(40)]},
  unchanged: {alignment: [0, 0], position: [toBits(30), toBits(40)], request: [toBits(30), toBits(40)]},
  negativeZero: {alignment: [0, 0], position: [0, 0], request: [0x80000000, 0x80000000]},
  storedNaN: {alignment: [0, 0], position: [0x7fc12345, toBits(40)], request: [toBits(5), toBits(40)]},
};

for (const [name, reference] of Object.entries(original.cases)) {
  const expected = cases[name];
  const translated = fixture(name, expected.alignment, expected.position);
  moveWindowNative(translated.object, fromBits(expected.request[0]),
    fromBits(expected.request[1]), translated.services);
  const view = new DataView(translated.object.bytes.buffer);
  const final = [
    view.getUint32(WINDOW_POSITION_OFFSETS.x, true),
    view.getUint32(WINDOW_POSITION_OFFSETS.y, true),
  ];
  const finalAlignment = [
    view.getUint8(WINDOW_POSITION_OFFSETS.alignmentX),
    view.getUint8(WINDOW_POSITION_OFFSETS.alignmentY),
  ];
  assert.deepEqual(translated.accesses, reference.accesses, `${name} access order/bits`);
  assert.deepEqual(translated.events, reference.events, `${name} callback order`);
  assert.deepEqual(finalAlignment, reference.finalAlignment, `${name} final alignment`);
  assert.deepEqual(final, reference.final, `${name} final position bits`);
}

assert.deepEqual(WINDOW_POSITION_NATIVE_ADDRESSES, {
  execSetPos: 0x10052160,
  setPos: 0x100032f0,
  move: 0x1004ce80,
  askParentForReconfigure: 0x1004e060,
});
console.log('Window.SetPos/Move matches the unchanged Extension.dll body: alignment-forced stores, ' +
  'float32 x87 C3 comparisons, exact raw access order, signed zero/NaN behavior, and reconfiguration order.');
