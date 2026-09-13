/** Focused metadata, byte-hash, oracle, and semantic validation for ComputerWindow. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {
  COMPUTER_WINDOW_NATIVE, COMPUTER_WINDOW_NATIVE_ADDRESSES, COMPUTER_WINDOW_OFFSETS,
  constructComputerWindowNative, constructComputerWindowInternalNative,
  initComputerWindowNative, setComputerTextSizeNative, setComputerTextFontNative,
  setComputerTextTimingNative, setComputerFadeSpeedNative, setComputerCursorColorNative,
  showComputerTextCursorNative, clearComputerScreenNative, printComputerTextNative,
  enableComputerWordWrapNative,
} from '../src/runtime/script-window-computer.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory();
const system = path.join(root, 'System');
const assets = new AssetStore((await readdir(system)).map(name => ({
  path: `System/${name}`, read: () => readFile(path.join(system, name)),
})));
const extension = await assets.get('Extension');
const computerClassIndex = extension.exportsByPath.get('computerwindow');
assert.equal(computerClassIndex, COMPUTER_WINDOW_NATIVE.classPackageExport);
const computerClass = readClass(extension, computerClassIndex);
assert.equal(computerClass.classFlags, 0x112);
assert.equal(computerClass.entry.superIndex, extension.exportsByPath.get('window'));

const functions = [
  ['settextsize', COMPUTER_WINDOW_NATIVE.setTextSize, ['int', 'int']],
  ['settextfont', COMPUTER_WINDOW_NATIVE.setTextFont, ['object', 'int', 'int', 'struct']],
  ['settexttiming', COMPUTER_WINDOW_NATIVE.setTextTiming, ['float']],
  ['setfadespeed', COMPUTER_WINDOW_NATIVE.setFadeSpeed, ['float']],
  ['setcursorcolor', COMPUTER_WINDOW_NATIVE.setCursorColor, ['struct']],
  ['showtextcursor', COMPUTER_WINDOW_NATIVE.showTextCursor, ['bool']],
  ['clearscreen', COMPUTER_WINDOW_NATIVE.clearScreen, []],
  ['print', COMPUTER_WINDOW_NATIVE.print, ['string', 'bool']],
  ['enablewordwrap', COMPUTER_WINDOW_NATIVE.enableWordWrap, ['bool']],
];
for (const [name, evidence, types] of functions) {
  const index = extension.exportsByPath.get(`computerwindow.${name}`);
  const metadata = readFunctionMetadata(extension, index);
  assert.equal(index, evidence.packageExport, `${name} package export`);
  assert.equal(metadata.nativeIndex, evidence.nativeIndex, `${name} native index`);
  assert.equal(metadata.functionFlags, evidence.functionFlags, `${name} flags`);
  assert.equal(metadata.entry.serialSize, evidence.serialSize, `${name} serial size`);
  assert.deepEqual(metadata.parameters.map(parameter => parameter.type), types, `${name} parameters`);
}

const dll = new Uint8Array(await readFile(path.join(system, 'Extension.dll')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(dll), COMPUTER_WINDOW_NATIVE.dllSha256, 'Extension.dll hash');
const evidenceKeys = ['internalConstructor', 'constructor', 'init', 'setTextSize', 'setTextFont',
  'setTextTiming', 'setFadeSpeed', 'setCursorColor', 'showTextCursor', 'clearScreen', 'print',
  'enableWordWrap'];
for (const key of evidenceKeys) {
  const evidence = COMPUTER_WINDOW_NATIVE[key];
  if (!evidence?.body || !evidence.end || !evidence.bodySha256) continue;
  assert.equal(sha256(dll.subarray(evidence.body - 0x10000000, evidence.end - 0x10000000)),
    evidence.bodySha256, `${key} body bytes`);
}

const python = process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-computer-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}));
assert.equal(native.hashes['Extension.dll'], COMPUTER_WINDOW_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
for (const key of evidenceKeys) {
  const evidence = COMPUTER_WINDOW_NATIVE[key];
  assert.equal(native.addresses[key] - (0x12000000 - 0x10000000), evidence.body, `${key} oracle address`);
}

function fixture() {
  const values = new WeakMap();
  const fields = object => {
    if (!values.has(object)) values.set(object, new Map());
    return values.get(object);
  };
  const read = (object, offset, kind) => {
    const value = fields(object).get(offset);
    if (value !== undefined) return value;
    return kind === 'ptr' ? null : 0;
  };
  const write = (object, offset, kind, value) => {
    fields(object).set(offset, value);
  };
  return {values, fields, read, write};
}

function constructorFixture(seed) {
  const m = fixture();
  const object = {};
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.flags, 0xa1b2c3d4);
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.cursorFlags, 0x55667788);
  const core = ({object: target}) => { m.fields(target).set(0, COMPUTER_WINDOW_NATIVE_ADDRESSES.temporaryVtable); };
  const base = ({object: target}) => {
    core({object: target});
    for (const offset of [0xd4, 0xd8, 0xdc, 0xe0, 0xe4, 0xe8]) m.write(target, offset, 'u32', 0);
    m.write(target, 0, 'u32', COMPUTER_WINDOW_NATIVE_ADDRESSES.xWindowVtable);
  };
  return {m, object, core, base};
}

for (const [name, translate, internal] of [
  ['direct', constructComputerWindowNative, false], ['internal', constructComputerWindowInternalNative, true],
]) {
  const reference = native.constructors[name];
  const {m, object, core, base} = constructorFixture(0xa5);
  const services = {read: m.read, write: m.write, coreObjectConstructor: core, constructWindow: base};
  (internal ? constructComputerWindowInternalNative : constructComputerWindowNative)(object, services);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.flags) >>> 0,
    internal ? 0xa1b2c3d4 : 0xa1b2c3d5,
    `${name} flags`);
  if (internal) {
    assert.equal(m.fields(object).get(0), COMPUTER_WINDOW_NATIVE_ADDRESSES.xComputerWindowVtable);
  } else {
    assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.cursorFlags) >>> 0, 0x5566778b);
    assert.equal(m.fields(object).get(0), COMPUTER_WINDOW_NATIVE_ADDRESSES.xComputerWindowVtable);
  }
}

const initReference = native.init;
{
  const m = fixture();
  const object = {}, parent = {}, rootWindow = {}, player = {}, textWindow = {}, inputWindow = {};
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.textFont, 0x21212121);
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.fontWidth, 8);
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.fontHeight, 12);
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.textCols, 40);
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.textRows, 25);
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.cursorBlinkSpeed, 0.25);
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.inputFlags, 0x80000001);
  const calls = [];
  initComputerWindowNative(object, parent, {
    read: m.read, write: m.write,
    initWindow: request => calls.push({op: 'XWindow::Init', parent: request.parent}),
    getRootWindow: () => { calls.push({op: 'GetRootWindow'}); return rootWindow; },
    getPlayerPawn: () => { calls.push({op: 'GetPlayerPawn'}); return player; },
    readPlayerViewportName: () => '',
    createNewWindow: request => {
      const child = request.bShow ? textWindow : inputWindow;
      calls.push({op: 'CreateNewWindow', child, bShow: request.bShow});
      return child;
    },
    resize: request => calls.push({op: 'Resize', object: request.object, width: request.width, height: request.height}),
    setWindowAlignments: request => calls.push({op: 'SetWindowAlignments', object: request.object, args: request.alignments}),
    setTextMargins: request => calls.push({op: 'SetTextMargins', object: request.object, args: [request.horizontal, request.vertical]}),
    setInsertionPointBlinkRate: request => calls.push({op: 'SetInsertionPointBlinkRate', object: request.object, args: [request.flags, request.rate]}),
    setSelectability: request => calls.push({op: 'SetSelectability', object: request.object, value: request.value}),
  });
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.player), player);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.textWindow), textWindow);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.inputWindow), inputWindow);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.inputFlags), 0x80000001);
  assert.deepEqual(calls.filter(call => call.op !== 'CreateNewWindow').map(call => call.op),
    initReference.events.map(event => event.op));
  assert.deepEqual(calls.find(call => call.op === 'Resize'), {op: 'Resize', object, width: 320, height: 300});
  assert.deepEqual(calls.find(call => call.op === 'SetWindowAlignments').args, [3, 3, 0, 0, 0, 0]);
  assert.deepEqual(calls.find(call => call.op === 'SetInsertionPointBlinkRate').args, [0, 0.5]);
}

function methodFixture() {
  const m = fixture();
  const object = {}, events = [], calls = [];
  const O = COMPUTER_WINDOW_OFFSETS;
  for (const [offset, value] of [
    [O.flags, 0xa5a5a5a5], [O.cursorFlags, 0x11223344], [O.inputFlags, 0x80000021],
    [O.textFont, {}], [O.textWindow, {}], [O.fontWidth, 8], [O.fontHeight, 12],
    [O.textCols, 40], [O.textRows, 25],
  ]) m.fields(object).set(offset, value);
  m.fields(object).set(O.eventTimeInterval, 0.25);
  m.fields(object).set(O.timeNextEvent, 1.5);
  m.fields(object).set(O.timeCurrent, 10);
  m.fields(object).set(O.cursorBlinkSpeed, 0.5);
  m.fields(object).set(O.displayBuffer + 4, 3);
  m.fields(object).set(O.displayBuffer + 8, 3);
  let nextIndex = 0;
  const services = {
    read: m.read, write: m.write,
    resize: request => calls.push({op: 'Resize', width: request.width, height: request.height}),
    appendQueuedEvent: request => { events.push(request.event); return nextIndex++; },
    arrayRealloc: request => {
      calls.push({op: 'Realloc', elementSize: request.elementSize});
      m.fields(object).set(O.displayBuffer + 4, 0);
      m.fields(object).set(O.displayBuffer + 8, 0);
    },
  };
  return {m, object, events, calls, services};
}

{
  const {m, object, events, calls, services} = methodFixture();
  setComputerTextSizeNative(object, 80, 30, services);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.textCols), 80);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.textRows), 30);
  assert.deepEqual(calls.pop(), {op: 'Resize', width: 640, height: 360});
  setComputerTextFontNative(object, {}, 9, 14, 0x7f2040ff, services);
  assert.deepEqual(events.pop(), {type: 1, time: 1.5, color: 0x7f2040ff, colorWord: 0x7f2040ff,
    fields: {type: 1, time: 1.5, color: 0x7f2040ff, colorWord: 0x7f2040ff}});
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.timeLastEvent), 10);
  assert.deepEqual(calls.pop(), {op: 'Resize', width: 720, height: 420});
}

{
  const {m, object, events, calls, services} = methodFixture();
  setComputerTextTimingNative(object, 0.75, services);
  setComputerFadeSpeedNative(object, 1.25, services);
  setComputerCursorColorNative(object, 0xff00a040, services);
  showComputerTextCursorNative(object, false, services);
  enableComputerWordWrapNative(object, false, services);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.eventTimeInterval), 0.75);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.fadeSpeed), 1.25);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.cursorColor), 0xff00a040);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.cursorFlags), 0x11223344 & ~2);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.flags), 0xa5a5a5a4);
  clearComputerScreenNative(object, services);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.inputFlags), 0x80000020);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.textX), 0);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.textY), 0);
  assert.deepEqual(calls.pop(), {op: 'Realloc', elementSize: 0x20});
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.eventTimeInterval, 0.25);
  m.fields(object).set(COMPUTER_WINDOW_OFFSETS.timeNextEvent, 1.5);
  printComputerTextNative(object, 'A^B', true, services);
  assert.deepEqual(events.map(event => [event.type, event.time, event.charCode]),
    [[0, 1.5, 65], [4, 1.75, 94], [0, 2, 66]]);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.timeNextEvent), 2.25);
  assert.equal(m.fields(object).get(COMPUTER_WINDOW_OFFSETS.timeLastEvent), 10);
}

console.log('ComputerWindow passed: installed class/function metadata, Extension.dll body hashes, original constructor/Init leaves, CreateControls setters, and bounded queue/clear/print behavior.');
