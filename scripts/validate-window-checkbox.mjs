/** XCheckboxWindow and the text-family granularity against the original bodies.
 *
 * scripts/native-window-checkbox-oracle.py runs these bodies unchanged from
 * Extension.dll:
 *   - ParentRequestedPreferredSize 0x1000acb0, with the extent 0x1000a9c0 and
 *     XTextWindow 0x100465a0;
 *   - Init 0x1000a710 and Draw 0x1000aad0;
 *   - XTextWindow::ParentRequestedGranularity 0x10046880.
 * The GC, script-bridge and XToggleWindow::Init leaves are recorded services
 * with controlled responses. The JavaScript translations run over the same
 * receiver bytes, and must produce the same result bits, the same ordered
 * leaf calls with their argument bits, and the same receiver image. See
 * docs/script-window-checkbox.md. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import {checkboxPreferredSize, textGranularity} from '../src/runtime/script-window-family-layout.mjs';
import {initCheckboxWindow} from '../src/runtime/script-window-families.mjs';
import {checkboxDraw} from '../src/runtime/script-window-family-draw.mjs';
import {patternBytes} from './native-exec-diff-lib.mjs';
import {gameDirectory} from './game-directory.mjs';

const python = process.env.NATIVE_PROBE_PYTHON;
if (!python) throw new Error('Set NATIVE_PROBE_PYTHON (docs/native-exec-diff.md)');
const IMAGE = 0x300, bits = value => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, value, true); return b.getUint32(0, true); };

// Deterministic case mix. Fractional margins, font heights and extents make
// every fst/fstp and compare placement observable in the result bits.
let seed = 7;
const rand = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
const pick = list => list[rand(list.length)];
const cases = [];
const textures = [{}, {0x1f8: [[16, 16], 'on']}, {0x1f4: [[20, 12], 'off'], 0x1f8: [[16, 18], 'on']},
  {0x1f4: [[9, 30], 'off']}, {0x1f4: [[-4, 0], 'off'], 0x1f8: [[0, -2], 'on']}];
for (let i = 0; i < 80; i++) {
  const text = pick(['', 'Show completed goals', 'x']);
  cases.push({body: 'preferred', text, fontHeight: pick([11.25, 7.3, 13]), extent: pick([[30.25, 10.5], [100.125, 7.3], [0, 0]]),
    bW: rand(2), bH: rand(2), width: pick([100, 57.3, 0, 12.7]), height: pick([80, 12.1, 3.3]), noGC: rand(12) === 0,
    textures: pick(textures), f32: {0x154: pick([2.25, 0.1, 0]), 0x158: pick([3.5, 1.3, 0]), 0x164: pick([0, 44.4]),
      0x1fc: pick([0, 0, 12.5, -1]), 0x200: pick([0, 0, 9.75, -3]), 0x204: pick([3, 0.1, 0])},
    i32: {0x15c: pick([-1, -1, 2, 0, 3]), 0x160: pick([-1, -1, 1, 5])}, u32: {0x150: rand(2)},
    ...(rand(3) === 0 && !text ? {textures: {...pick(textures), 0xec: [[64, 32], 'background']}} : {})});
}
for (let i = 0; i < 40; i++)
  cases.push({body: 'draw', text: pick(['', 'Show completed goals']), textures: pick(textures),
    u8: {0x14c: rand(4), 0x14d: rand(4), 0x20c: pick([1, 2, 3, 4])},
    u32: {0x150: rand(4), 0x174: rand(8), 0x208: pick([0, 1, 0xfffffffe, 0xffffffff]), 0x18c: 0x12345678 + i},
    f32: {0x80: pick([200, 57.3, 12]), 0x84: pick([16, 13.7, 3, 0]), 0x154: pick([2.25, 0.1]), 0x158: pick([3.5, 1.3]),
      0x1fc: pick([0, 12.5]), 0x200: pick([0, 9.75, 20]), 0x204: pick([3, 0.1])},
    bytes: {0x20d: [rand(256), rand(256), rand(256), rand(256)]}});
for (let i = 0; i < 8; i++)
  cases.push({body: 'init', image: Buffer.from(patternBytes(IMAGE, 1840 + i)).toString('hex'),
    parent: [0x20123456, 0xa1b2c3d4, 0x00000000, 0xff00ff10][i % 4] + i});
for (let i = 0; i < 12; i++)
  cases.push({body: 'granularity', noGC: i % 4 === 0, fontHeight: pick([11.25, 7.3, 0]), h: pick([2.5, 0, 1]), v: pick([3.5, 7.7])});
cases.forEach((c, i) => {
  c.id = i;
  // Unaligned colour bytes go through u8 for both sides.
  for (const [at, list] of Object.entries(c.bytes ?? {})) list.forEach((b, k) => { (c.u8 ??= {})[Number(at) + k] = b; });
});

const original = JSON.parse(execFileSync(python, [path.join(path.dirname(new URL(import.meta.url).pathname), 'native-window-checkbox-oracle.py')],
  {input: JSON.stringify({gameRoot: gameDirectory(), cases}), encoding: 'utf8', maxBuffer: 1 << 28}));

function runScript(c) {
  const heap = createNativeHeap(), win = {name: 'Checkbox'}, gc = {name: 'GC'}, calls = [], labels = new Map();
  heap.allocate(win, IMAGE); heap.allocate(gc, 0x100);
  if (c.image) Buffer.from(c.image, 'hex').forEach((byte, offset) => heap.write(win, offset, 'u8', byte));
  const read = kind => (o, off) => heap.read(o, off, kind);
  const W = {heap, u8: read('u8'), u32: read('u32'), i32: read('i32'), f32: read('f32'), ptr: read('ptr'),
    setU8: (o, off, v) => heap.write(o, off, 'u8', v & 0xff), setU32: (o, off, v) => heap.write(o, off, 'u32', v >>> 0),
    setI32: (o, off, v) => heap.write(o, off, 'i32', v | 0), setF32: (o, off, v) => heap.write(o, off, 'f32', Math.fround(v)),
    setPtr: (o, off, v) => heap.write(o, off, 'ptr', v),
    addressOf: o => o?.parentAddress ?? heap.addressOf(o),
    gc: {services: {}, get() { calls.push(['getGC']); return c.noGC ? null : gc; }, release() { calls.push(['releaseGC']); },
      textExtent(_gc, clip) { calls.push(['extent', bits(clip)]); const [width, height] = c.extent ?? [30.25, 10.5]; return {width, height}; },
      fontHeight(_gc, flag) { calls.push(['fontHeight', Number(flag)]); return Math.fround(c.fontHeight ?? 11.25); }},
    processScript(_win, event, args) {
      if (event === 'DrawWindow') return void calls.push(['drawWindow']);
      if (event !== 'ParentRequestedPreferredSize') throw new Error(`unexpected script event ${event}`);
      calls.push(['script', args[0] ? 1 : 0, bits(args[1]), args[2] ? 1 : 0, bits(args[3])]);
      args[1] = 42.5; args[3] = 23.25;
    }};
  for (const [at, v] of Object.entries(c.u8 ?? {})) heap.write(win, Number(at), 'u8', v);
  for (const [at, v] of Object.entries(c.u32 ?? {})) heap.write(win, Number(at), 'u32', v >>> 0);
  for (const [at, v] of Object.entries(c.f32 ?? {})) heap.write(win, Number(at), 'f32', v);
  for (const [at, v] of Object.entries(c.i32 ?? {})) heap.write(win, Number(at), 'i32', v);
  for (const [at, [sizes, label]] of Object.entries(c.textures ?? {})) {
    const texture = {name: label}; heap.allocate(texture, 0x100);
    heap.write(texture, 0x34, 'i32', sizes[0]); heap.write(texture, 0x38, 'i32', sizes[1]);
    heap.write(win, Number(at), 'ptr', texture); labels.set(heap.addressOf(texture), label);
  }
  if (c.text) heap.write(win, 0x168, 'string', c.text);
  const out = {id: c.id};
  if (c.body === 'preferred') {
    const size = checkboxPreferredSize(W, win, c.bW ?? 0, c.width ?? 100, c.bH ?? 0, c.height ?? 80);
    out.width = bits(size.width); out.height = bits(size.height);
  } else if (c.body === 'granularity') {
    textGranularity(W, win, Math.fround(c.h ?? 2.5), Math.fround(c.v ?? 3.5), (_w, h, v) => { calls.push(['baseGranularity', bits(h), bits(v)]); return {h, v}; });
  } else if (c.body === 'init') {
    initCheckboxWindow(W, win, {parentAddress: c.parent}, (_W, _win, parent) => calls.push(['toggleInit', W.addressOf(parent)]));
  } else {
    checkboxDraw(W, win, gc, {
      setAlignments: (_gc, h, v) => calls.push(['setAlignments', h, v]), enableWordWrap: (_gc, flag) => calls.push(['enableWordWrap', flag]),
      setTextColor: (_gc, color) => calls.push(['setTextColor', color]), setStyle: (_gc, style) => calls.push(['setStyle', style]),
      setTileColor: (_gc, color) => calls.push(['setTileColor', color]),
      drawText: (_gc, x, y, w, h, text) => calls.push(['drawText', x, y, w, h, text]),
      tile: (_gc, t) => calls.push(['tile', ...[t.x, t.y, t.w, t.h, t.u, t.v, t.ul, t.vl].map(bits), labels.get(t.texture) ?? t.texture]),
    });
  }
  out.calls = calls;
  out.image = Buffer.from(Array.from({length: IMAGE}, (_, offset) => heap.read(win, offset, 'u8'))).toString('hex');
  return out;
}

// Pointer fields hold oracle-local or heap-local addresses; string storage
// (+0x168) and texture pointers are compared through their meaning instead.
const POINTERS = [0x168, 0x16c, 0x170, 0x1f4, 0x1f8, 0xec];
const normalize = (c, result) => {
  const image = Buffer.from(result.image, 'hex');
  for (const at of POINTERS) if (c.textures?.[at] || (at >= 0x168 && at < 0x174 && c.text)) image.fill(0, at, at + 4);
  // SetStyle reads only its BYTE argument; the pushed dword's high bytes are
  // the GC pointer left in ecx.
  const calls = result.calls.map(call => call[0] === 'setStyle' ? ['setStyle', call[1] & 0xff] : call);
  return {...result, calls, image: image.toString('hex')};
};
const counts = {}, failures = [];
for (const [i, c] of cases.entries()) {
  counts[c.body] = (counts[c.body] ?? 0) + 1;
  try { assert.deepEqual(normalize(c, runScript(c)), normalize(c, original[i])); }
  catch (error) { failures.push(`${c.body} case ${i}: ${error.message.split('\n').slice(0, 14).join('\n')}`); }
}
if (failures.length) { console.error(failures.slice(0, 4).join('\n\n')); console.error(`${failures.length}/${cases.length} checkbox cases differ`); process.exit(1); }
console.log(`window-checkbox: ${cases.length}/${cases.length} cases identical (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')})`);
