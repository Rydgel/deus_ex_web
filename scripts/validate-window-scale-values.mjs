/** ScaleWindow value-string natives against their original exec bodies:
 * SetValueFormat 1646, GetValueString 1647, SetEnumeration 1648,
 * ClearAllEnumerations 1649 and PlayScaleSound 1653.
 *
 * The bodies call Core (FArray/FString/appStrlen/...), so they run through
 * scripts/native-window-scale-values-oracle.py, which executes the unchanged
 * Extension.dll and Core.dll code in Unicorn and records the reconfigure,
 * ChangeScalePosition and sound calls. appSprintf's MSVCRT _vsnwprintf is
 * answered from rows measured with the game's own MSVCRT.dll under Wine
 * (scripts/msvcrt-text-probe-lib.mjs); GetValueString cases are skipped when
 * Wine is absent. Each case compares the receiver image, the format string
 * and label array contents (with their Num/Max), the result, the recorded
 * events and the consumed code bytes with dispatchWindowHostNative.
 * See docs/script-window-scale-settings.md. Needs NATIVE_PROBE_PYTHON. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import {createWindowFArray} from '../src/runtime/script-window-farray.mjs';
import {dispatchWindowHostNative} from '../src/runtime/script-window-host-natives.mjs';
import {msvcrtSprintf} from '../src/runtime/script-text-format.mjs';
import {tickToValue} from '../src/runtime/script-window-scroll-movement.mjs';
import {x87storeDouble} from '../src/runtime/script-vm.mjs';
import {gameDirectory} from './game-directory.mjs';
import {loadExtensionNatives, patternBytes, encodeParam} from './native-exec-diff-lib.mjs';
import {probeAvailable, measurePrintf, doubleBits} from './msvcrt-text-probe-lib.mjs';

const python = process.env.NATIVE_PROBE_PYTHON;
if (!python) { console.log('SKIP validate-window-scale-values: set NATIVE_PROBE_PYTHON'); process.exit(0); }
const wineMissing = probeAvailable();

const RECEIVER_SIZE = 0x800;
const FORMAT = 0x1dc, ARRAY = 0x268;
const natives = await loadExtensionNatives();
const view = new DataView(new ArrayBuffer(8));
const f32bits = v => { view.setFloat32(0, v, true); return view.getUint32(0, true); };

// ---- the JavaScript side --------------------------------------------------
function runScript(entry) {
  const heap = createNativeHeap({capacity: 1 << 21}), win = {name: 'Receiver'};
  heap.allocate(win, RECEIVER_SIZE);
  entry.bytes.forEach((byte, offset) => heap.write(win, offset, 'u8', byte));
  for (const {offset, text} of entry.strings) {
    for (let i = 0; i < 12; i++) heap.write(win, offset + i, 'u8', 0);
    heap.write(win, offset, 'string', text);
  }
  for (const {offset, elements, max} of entry.arrays) {
    const size = Math.max(max, elements.length);
    const data = size ? heap.allocRaw(size * 12) : 0;
    elements.forEach((text, i) => heap.write(data, i * 12, 'string', text));
    heap.write(win, offset, 'u32', data); heap.write(win, offset + 4, 'i32', elements.length); heap.write(win, offset + 8, 'i32', max);
  }
  const events = [], f = Math.fround;
  const W = {heap,
    u8: (o, off) => heap.read(o, off, 'u8'), u32: (o, off) => heap.read(o, off, 'u32'), i32: (o, off) => heap.read(o, off, 'i32'),
    f32: (o, off) => heap.read(o, off, 'f32'), ptr: (o, off) => heap.read(o, off, 'u32'),
    setU8: (o, off, v) => heap.write(o, off, 'u8', v & 0xff), setU32: (o, off, v) => heap.write(o, off, 'u32', v >>> 0),
    setI32: (o, off, v) => heap.write(o, off, 'i32', v | 0), setF32: (o, off, v) => heap.write(o, off, 'f32', f(v)),
    setPtr: (o, off, v) => heap.write(o, off, 'u32', heap.addressOf(v)),
    native: {
      askParentForReconfigure: () => events.push({op: 'AskParentForReconfigure', object: 'this'}),
      changeScalePosition: (object, notify) => events.push({op: 'ChangeScalePosition', object: object === win ? 'this' : 'other', args: [notify]}),
      playSound: (object, sound, volume, pitch, x, y) => events.push({op: 'PlaySound', object: object === win ? 'this' : 'other',
        args: [sound >>> 0, f32bits(volume), f32bits(pitch), f32bits(x), f32bits(y)]}),
    },
  };
  W.farray = createWindowFArray(W, heap);
  const values = entry.values, native = entry.native;
  const call = {index: native.index, receiver: win, argumentCount: values.length,
    evaluateArgument: i => values[i] === undefined ? undefined : values[i]};
  const out = dispatchWindowHostNative(W, call);
  assert.equal(out.handled, true, `${native.function} is not routed by dispatchWindowHostNative`);
  const after = new Uint8Array(RECEIVER_SIZE);
  for (let offset = 0; offset < RECEIVER_SIZE; offset++) after[offset] = heap.read(win, offset, 'u8');
  const stringState = offset => ({offset, text: heap.read(win, offset, 'string'), num: heap.read(win, offset + 4, 'i32'), max: heap.read(win, offset + 8, 'i32')});
  const arrays = entry.arrays.map(({offset}) => {
    const data = heap.read(win, offset, 'u32'), num = heap.read(win, offset + 4, 'i32');
    return {offset, num, max: heap.read(win, offset + 8, 'i32'), data: Boolean(data),
      elements: data ? Array.from({length: num}, (_, i) => heap.read(data, i * 12, 'string')) : []};
  });
  return {bytes: after, value: out.value, events, strings: entry.strings.map(({offset}) => stringState(offset)), arrays};
}

// ---- cases ----------------------------------------------------------------
const plan = [];
let counter = 0;
function addCase(index, {values = [], strings = [], arrays = [], floats = {}, words = {}, printf = []}) {
  const native = natives.get(index);
  assert.ok(native, `native ${index} has no registered exec body`);
  const bytes = patternBytes(RECEIVER_SIZE, index * 131 + counter);
  const dv = new DataView(bytes.buffer);
  for (const [offset, v] of Object.entries(floats)) dv.setFloat32(Number(offset), v, true);
  for (const [offset, v] of Object.entries(words)) dv.setUint32(Number(offset), v >>> 0, true);
  const params = native.params.map((shape, i) => shape.kind === 'StrProperty'
    ? (values[i] === undefined ? {skip: true} : {string: values[i]}) : encodeParam(shape, values[i]));
  plan.push({native, values, bytes, strings, arrays, printf,
    oracle: {id: `${index}:${counter++}`, exec: native.exec, this: Buffer.from(bytes).toString('hex'), params, strings, arrays,
      resultString: native.result?.kind === 'StrProperty'}});
}

const formats = ['', '%1.0f', '%1.1f', '%1.2f', '%f', 'plain', '%8.3f|', 'long ' + 'x'.repeat(40) + '%1.1f'];
// 1646 SetValueFormat: the old format text and the new one (a skipped optional is not possible: the parameter is required).
for (const old of formats) for (const next of formats) addCase(1646, {values: [next], strings: [{offset: FORMAT, text: old}]});

// 1648 SetEnumeration: ticks across the 0x200 limit, growth beyond Max, the current position, empty and set texts.
const arrays = [
  {elements: [], max: 0}, {elements: [], max: 40}, {elements: ['Off', '1', '2'], max: 3}, {elements: ['Off', '', '2', 'x'], max: 35},
  {elements: ['a'], max: 1}, {elements: Array.from({length: 11}, (_, i) => String(i)), max: 11},
];
for (const array of arrays) for (const tick of [-1, 0, 1, 2, 3, 10, 11, 12, 100, 0x1ff, 0x200, 0x201, -0x80000000, 0x7fffffff])
  for (const [text, position] of [['', 1], ['New', 2], ['Max', 0], ['Longer label text', 3]])
    addCase(1648, {values: [tick, text], arrays: [{offset: ARRAY, ...array}], words: {0x1c8: position === 3 ? tick >>> 0 : position}});
// 1649 ClearAllEnumerations.
for (const array of arrays) addCase(1649, {arrays: [{offset: ARRAY, ...array}]});

// 1653 PlayScaleSound: object / float parameters with skipped optionals, geometry around the sound position.
const geometry = [[10, 20, 100, 200], [-3.5, 0.25, 0, 0], [1e30, -1e30, 1e30, 3], [0.1, 0.2, 0.3, 0.4]];
for (const [x, y, w, h] of geometry) {
  const floats = {0x210: x, 0x214: y, 0x218: w, 0x21c: h};
  for (const sound of [0, 0x0bad0c0d]) for (const volume of [0, -0, 1.5, -3.25, 3.4028234663852886e38, 1e-45])
    for (const pitch of [0, 1, -1.5, 2.25e-5]) addCase(1653, {values: [sound, volume, pitch], floats});
  for (const sound of [0, 0x0bad0c0d]) {
    addCase(1653, {values: [sound], floats});                      // volume -1.0 and pitch 1.0 default
    addCase(1653, {values: [sound, 0.75], floats});                // pitch 1.0 default
  }
  addCase(1653, {values: [], floats});
}

// 1647 GetValueString: labels, formats, ranges and positions. The printf rows come from the model first
// (the doubles it predicts), are measured under Wine, and the oracle fails a case if its own x87 run asks for another double.
const ranges = [[0, 1], [0, 10], [-2.5, 8.25], [0.5, 3], [3, 3], [100, 0], [0, 255], [0.0625, 0.1875]];
const printfPairs = new Map();
for (const format of ['%1.0f', '%1.1f', '%1.2f', '%f', 'plain', '', '%8.3f|', 'a%%b%1.0f'])
  for (const [from, to] of ranges) for (const [count, flags] of [[11, 0], [1, 0], [2, 0], [0x80000000 | 0, 0], [21, 16], [10, 0], [101, 0]])
    for (const position of [0, 1, 2, 3, 5, 9, 10, 11, 20, 100, -1]) {
      const labels = position % 3 === 0 ? [] : ['Off', 'Low', '', 'High'];
      const fields = {floats: {0x1d4: from, 0x1d8: to}, words: {0x164: flags, 0x1c4: count, 0x1c8: position >>> 0, 0x1cc: 2},
        strings: [{offset: FORMAT, text: format}], arrays: [{offset: ARRAY, elements: labels, max: labels.length + 5}]};
      const labelled = position >= 0 && position < labels.length && labels[position] !== '';
      // Without Wine only the label cases (no MSVCRT formatting) are comparable.
      if (wineMissing) { if (labelled) addCase(1647, fields); continue; }
      // The model's double for the position, with the same receiver fields the original run reads.
      const model = {i32: (o, off) => ({0x1c4: count, 0x1c8: position}[off] ?? 0), u8: (o, off) => off === 0x164 ? flags : 0,
        f32: (o, off) => ({0x1d4: Math.fround(from), 0x1d8: Math.fround(to)}[off] ?? 0)};
      if (!labelled) {
        const stored = x87storeDouble(tickToValue(model, null, position));
        const value = stored.nan !== undefined ? NaN : stored.inf ? (stored.neg ? -Infinity : Infinity) : (stored.neg ? -1 : 1) * Number(stored.sig) * 2 ** stored.exp;
        if (!Number.isFinite(value)) continue;          // MSVCRT's spelling of NaN/Inf is not measured
        printfPairs.set(`${format}|${doubleBits(value)}`, [format, value]);
      }
      addCase(1647, fields);
    }
let measured = new Map();
if (!wineMissing && printfPairs.size) {
  const pairs = [...printfPairs.values()];
  const texts = measurePrintf(pairs);
  pairs.forEach(([format, value], i) => measured.set(`${format}|${doubleBits(value)}`, {format, bits: doubleBits(value), text: texts[i]}));
}
// The oracle looks rows of the measured table up by format and bits.
const table = [...measured.values()];

// ---- run -------------------------------------------------------------------
const input = JSON.stringify({cases: plan.map(entry => entry.oracle), printf: table});
const output = execFileSync(python, [path.join(path.dirname(new URL(import.meta.url).pathname), 'native-window-scale-values-oracle.py'), gameDirectory()],
  {input, encoding: 'utf8', maxBuffer: 1 << 29});
const results = output.trim().split('\n').map(line => JSON.parse(line));
assert.equal(results.length, plan.length);

const summary = new Map(), failures = [];
for (const [position, entry] of plan.entries()) {
  const original = results[position], {native} = entry;
  const row = summary.get(native.index) ?? {name: native.function, cases: 0, compared: 0};
  summary.set(native.index, row); row.cases++;
  if (original.status !== 'leaf') { failures.push(`${native.function} case ${original.id}: original ${original.status} ${original.reason ?? ''}`); continue; }
  let script;
  try { script = runScript(entry); } catch (error) { failures.push(`${native.function} values ${JSON.stringify(entry.values)}: script threw ${error.message}`); continue; }
  const expected = Buffer.from(original.this, 'hex'), diffs = [];
  const ignored = offset => [...entry.strings.map(f => f.offset), ...entry.arrays.map(a => a.offset)].some(start => offset >= start && offset < start + 12);
  for (let offset = 0; offset < RECEIVER_SIZE; offset++)
    if (!ignored(offset) && expected[offset] !== script.bytes[offset]) diffs.push(`+0x${offset.toString(16)} original ${expected[offset].toString(16)} script ${script.bytes[offset].toString(16)}`);
  if (JSON.stringify(original.strings) !== JSON.stringify(script.strings.map(({offset, text, num, max}) => ({text, num, max, offset}))))
    diffs.push(`strings original ${JSON.stringify(original.strings)} script ${JSON.stringify(script.strings)}`);
  if (JSON.stringify(original.arrays) !== JSON.stringify(script.arrays.map(({offset, num, max, data, elements}) => ({offset, num, max, data, elements}))))
    diffs.push(`arrays original ${JSON.stringify(original.arrays)} script ${JSON.stringify(script.arrays)}`);
  if (native.result?.kind === 'StrProperty') {
    if (original.resultString !== script.value) diffs.push(`result original ${JSON.stringify(original.resultString)} script ${JSON.stringify(script.value)}`);
  }
  if (JSON.stringify(original.events) !== JSON.stringify(script.events))
    diffs.push(`events original ${JSON.stringify(original.events)} script ${JSON.stringify(script.events)}`);
  if (original.codeAdvance !== native.params.length + 1) diffs.push(`original consumed ${original.codeAdvance} code bytes`);
  if (diffs.length) failures.push(`${native.function} values ${JSON.stringify(entry.values)} strings ${JSON.stringify(entry.strings.map(f => f.text))} arrays ${JSON.stringify(entry.arrays.map(a => a.elements))}: ${diffs.slice(0, 3).join('; ')}`);
  else row.compared++;
}
for (const [index, row] of summary) console.log(`${String(index).padEnd(5)} ${row.name.padEnd(40)} ${row.compared}/${row.cases} identical`);
if (failures.length) { console.error(`MISMATCH (${failures.length}):\n  ${failures.slice(0, 20).join('\n  ')}`); process.exitCode = 1; }
else console.log(`window-scale-values: ${[...summary.values()].reduce((sum, row) => sum + row.compared, 0)} cases identical across ${summary.size} natives${wineMissing ? ` (GetValueString skipped formats need Wine: ${wineMissing})` : ''}`);
