/**
 * Core appSprintf (_vsnwprintf, 10123490) and appAtof (atof, 101235c0) against
 * the game's own MSVCRT.dll executed under Wine (tools/msvcrt-text-probe.c).
 * The JavaScript model in src/runtime/script-text-format.mjs must reproduce
 * every measured row: the %f spellings the shipped slider formats use
 * (%1.0f, %1.1f, %1.2f from ScaleWindow.SetValueFormat and its constructor
 * default), FloatToString's %f, widths/flags, and atof over decimal text.
 *
 * Skips loudly (exit 0) when the toolchain or Wine is absent: this is a
 * hardware measurement, not a pure-software check. On Linux:
 *   X87_PROBE_WINE=/usr/bin/wine WINEPREFIX=$HOME/.wine-deusex node scripts/validate-msvcrt-text-hardware.mjs
 */
import assert from 'node:assert/strict';
import {gameDirectory} from './game-directory.mjs';
import {msvcrtSprintf, msvcrtAtof, stringToFloat} from '../src/runtime/script-text-format.mjs';
import {probeAvailable, runProbe, doubleBits as bits64, wideHex as wide, ansiHex as ansi, decodeWide} from './msvcrt-text-probe-lib.mjs';

const unavailable = probeAvailable();
if (unavailable) { console.log(`SKIP validate-msvcrt-text-hardware: ${unavailable}`); process.exit(0); }

const view = new DataView(new ArrayBuffer(8));
// ---- cases ----------------------------------------------------------------

let seed = 0x13579bdf;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const f32 = v => Math.fround(v);
const values = new Set();
const add = v => values.add(Object.is(v, -0) ? '-0' : String(v));
const raw = [0, -0, 0.5, 1.5, 2.5, 3.5, 0.25, 0.75, 0.125, 0.375, 0.0625, 0.05, 0.15, 0.95, 0.995, 9.5, 99.5, 0.045, 1e-7, 123456.789, 1e15, 1.5e16, 123456789012345678, 4294967296.5];
for (const v of raw) { add(v); add(-v); add(f32(v)); }
for (let k = -50; k <= 2200; k++) { add(f32(k / 10)); add(f32(k / 100)); add(f32(k / 1000)); add(k); add(k + 0.5); }
for (let k = 0; k <= 1000; k++) add(f32(k / 255 * 10));
for (let k = 0; k <= 255; k++) { add(k); add(f32(k * 100 / 255)); add(f32(k / 255)); add(f32(k * 0.1)); }
for (let i = 0; i < 6000; i++) {                       // random float32 across exponents
  const b = random();
  const exponent = 100 + (b >>> 24) % 60;              // 2^-27 .. 2^32
  view.setUint32(0, ((b & 0x807fffff) | (exponent << 23)) >>> 0, true);
  const v = view.getFloat32(0, true);
  if (Number.isFinite(v)) add(v);
}
for (let i = 0; i < 1500; i++) add(f32(random() / 2 ** 32 * 20 - 5));   // small, signed
for (let i = 0; i < 1500; i++) add(random() / 2 ** 32 * 20 - 5);         // full doubles
const list = [...values].map(v => v === '-0' ? -0 : Number(v));
const formats = ['%1.0f', '%1.1f', '%1.2f', '%f', '%8.3f', '%-8.2f', '%+.1f', '%05.1f', '% .0f', '%.0f%%', 'x%1.1fy', '%12f', '%.10f', '%.3f'];
const atofTexts = ['', ' ', '0', '1', '-1', '+2', '0.6', '0.600000', '0.400000', '1.000000', '5.000000', '2.5', '.5', '5.', '-.5', '1e3', '1E-2', '1e', '1e+', '12abc',
  ' \t 7.25', 'abc', '--1', '0x10', '1,5', '0.1', '0.2', '0.3', '0.7', '16777217', '3.4028235e38', '3.5e38', '1e-46', '1e-45', '0.000001', '100000.000000',
  '255', '204.000000', '153', '1.7976931348623157e308', '1e309', '123456789012345678901234567890', '0.30000000000000004', '9007199254740993', '4.35', '2.675'];
for (let k = 0; k <= 400; k++) { atofTexts.push((k / 100).toFixed(2), (k / 10).toFixed(1), (k / 1000).toFixed(6), (k * 0.1).toString(), String(k)); }
for (let i = 0; i < 4000; i++) atofTexts.push(msvcrtSprintf('%f', f32(random() / 2 ** 32 * 300)), msvcrtSprintf('%1.3f', random() / 2 ** 32 * 2));
for (let i = 0; i < 1500; i++) atofTexts.push((random() / 2 ** 32 * 10 ** (random() % 12 - 4)).toPrecision(1 + random() % 17));

const lines = [];
for (const format of formats) for (const v of list) lines.push({kind: 'P', format, value: v, text: `P ${wide(format)} ${bits64(v)}`});
for (const text of atofTexts) lines.push({kind: 'A', text: text, line: `A ${ansi(text)}`});
const caseLines = lines.map(l => l.line ?? l.text);
const rows = runProbe(caseLines);
const defaultWord = runProbe.controlWord;
// atof/_vsnwprintf run on the x87 (double formatting, decimal conversion), so
// the rows are re-measured under each precision control the game can have:
// 0x027f (53-bit, Wine's process default here), 0x037f (64-bit, the game
// thread's assumed word) and 0x007f (24-bit, URender::PreRender's render pass).
const controlWords = [0x027f, 0x037f, 0x007f], varied = [];
for (const word of controlWords) {
  const other = runProbe(caseLines, 'msvcrt-text-cases.txt', word);
  const differing = other.filter((row, i) => row !== rows[i]).length;
  varied.push(`${word.toString(16).padStart(4, '0')}:${differing}`);
  assert.equal(runProbe.controlWord, word.toString(16).padStart(4, '0'), 'the probe ran under the requested word');
  assert.equal(differing, 0, `MSVCRT results differ under x87 control word ${word.toString(16)}`);
}
assert.equal(rows.length, lines.length, 'one result per case');

let printed = 0, parsed = 0, unsupported = 0;
const misses = [];
const bits32 = v => { view.setFloat32(0, v, true); return view.getUint32(0, true).toString(16).padStart(8, '0'); };
lines.forEach((entry, i) => {
  const parts = rows[i].split(' ');
  if (entry.kind === 'P') {
    const original = decodeWide(parts[2]);
    let model;
    try { model = msvcrtSprintf(entry.format, entry.value); } catch (error) { unsupported++; return; }
    if (model !== original) misses.push(`${entry.format} of ${entry.value} (${bits64(entry.value)}): MSVCRT ${JSON.stringify(original)} model ${JSON.stringify(model)}`);
    else printed++;
  } else {
    const [fb, db] = [parts[1], parts[2]];
    const model = msvcrtAtof(entry.text);
    if (bits64(model) !== db) misses.push(`atof(${JSON.stringify(entry.text)}): MSVCRT double ${db} model ${bits64(model)}`);
    else if (bits32(stringToFloat(entry.text)) !== fb) misses.push(`StringToFloat(${JSON.stringify(entry.text)}): MSVCRT float ${fb} model ${bits32(stringToFloat(entry.text))}`);
    else parsed++;
  }
});
if (misses.length) {
  console.error(`MISMATCH ${misses.length} of ${lines.length}:\n  ${misses.slice(0, 25).join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log(`validate-msvcrt-text-hardware: ${printed} _vsnwprintf rows and ${parsed} atof rows match the game's MSVCRT.dll under Wine (${unsupported} printf cases outside the supported subset, skipped); rows identical under x87 control words ${varied.join(' ')} (process default ${defaultWord})`);
}
