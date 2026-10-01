/** XRootWindow raw background clip list against the original Extension.dll
 * (docs/conversation-camera.md, "Raw background").
 *
 * scripts/native-root-raw-background-oracle.py runs the clip-rect subtraction
 * 0x1003c1d0 and GetRawBackgroundClipList 0x1003c5f0 unchanged in Unicorn;
 * script-root-raw-background.mjs must give the same rects, bit for bit, in the
 * same order. Cases: random and edge rects (fractions, huge and tiny values,
 * zero and negative extents, infinities, NaN, signed zeros), the letterbox
 * ConWindowActive sets with SetRenderViewport, and window trees mixing
 * bDrawRawBackground, visibility and nesting. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {subtractClipRect, rawBackgroundClipList} from '../src/runtime/script-root-raw-background.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = process.env.NATIVE_PROBE_PYTHON;
if (!python) throw new Error('Install unicorn==2.1.4 in a virtualenv and set NATIVE_PROBE_PYTHON to its Python executable.');

const io = new DataView(new ArrayBuffer(4));
const b = v => { io.setFloat32(0, v, true); return io.getUint32(0, true); };
let seed = 0x5eed1234;
const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
const pick = list => list[Math.floor(rand() * list.length)];
const SPECIAL = [0, -0, 1, -1, 0.5, 1e-30, 1.4e-45, 3e38, 16777217, Infinity, -Infinity, NaN, 0.1, 1 / 3];
const value = (scale = 1000) => {
  const r = rand();
  if (r < 0.15) return pick(SPECIAL);
  if (r < 0.55) return Math.round((rand() * 2 - 0.3) * scale);
  return (rand() * 2 - 0.3) * scale;
};
const rect = () => [value(200), value(200), value(), value(), value(), value()].map(b);
const box = (ox, oy, x, y, w, h) => [ox, oy, x, y, w, h].map(b);

const cases = [];
// Subtraction: random cuts over random lists, and cuts made from list rects.
for (let i = 0; i < 1500; i++) {
  const list = Array.from({length: 1 + Math.floor(rand() * 4)}, rect);
  const cut = rand() < 0.3 ? pick(list).slice() : rect();
  cases.push({kind: 'subtract', cut, list});
}
for (const [w, h] of [[1440, 960], [640, 480], [1024, 768], [1432, 1268], [800.5, 600.25]]) {
  const screen = box(0, 0, 0, 0, w, h);
  for (const [y, ch] of [[h * 0.15, h * 0.7], [0, h], [h / 2, 0], [-10, h + 20], [h * 0.1, h * 0.1]])
    cases.push({kind: 'subtract', cut: box(0, 0, 0, y, w, ch), list: [screen.slice()]});
  cases.push({kind: 'subtract', cut: box(10, 20, 30, 40, 50, 60), list: [screen.slice(), box(5, 5, 0, 0, 100, 100)]});
}
// Clip lists over window trees.
const windowTree = () => {
  const w = pick([1440, 640, 1024.5, 800]), h = pick([960, 480, 768.25, 600]);
  const windows = [{flags: 1, surface: pick([1, 1, 0, 3]), clip: box(0, 0, 0, 0, w, h), children: []}];
  const count = Math.floor(rand() * 6);
  for (let i = 0; i < count; i++) {
    const parent = Math.floor(rand() * windows.length);
    const x = Math.round(rand() * w), y = Math.round(rand() * h);
    windows.push({flags: pick([1, 1, 1, 0, 3]), surface: pick([0, 0, 1, 2]),
      clip: rand() < 0.2 ? rect() : box(x, y, 0, 0, Math.round(rand() * w / 2), Math.round(rand() * h / 2)), children: []});
    windows[parent].children.push(windows.length - 1);
  }
  const ry = Math.round(rand() * h / 4);
  return {kind: 'clipList', windows,
    root: {renderFlags: pick([0, 1, 3, 2, 5, 7, 1]), render: pick([[0, ry, w, h - 2 * ry], [value(), value(), value(), value()]]).map(b)}};
};
for (let i = 0; i < 600; i++) cases.push(windowTree());
// The conversation letterbox: root bDrawRawBackground, the two letterbox
// windows and the speech window over the clipped render area.
{
  const w = 1440, h = 960, bar = 144;
  cases.push({kind: 'clipList', root: {renderFlags: 3, render: [0, bar, w, h - 2 * bar].map(b)}, windows: [
    {flags: 1, surface: 1, clip: box(0, 0, 0, 0, w, h), children: [1]},
    {flags: 1, surface: 1, clip: box(0, 0, 0, 0, w, h), children: [2, 3]},
    {flags: 1, surface: 0, clip: box(0, 0, 0, 0, w, bar), children: []},
    {flags: 1, surface: 0, clip: box(0, h - bar, 0, 0, w, bar), children: []},
  ]});
}

const run = spawnSync(python, [path.join(root, 'scripts/native-root-raw-background-oracle.py'), gameDirectory()],
  {input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
if (run.status !== 0) throw new Error(`Oracle failed:\n${run.stderr.slice(-4000)}`);
const {results} = JSON.parse(run.stdout);
assert.equal(results.length, cases.length, 'one oracle result per case');

// A window image over the fields the clip list reads.
function mockWindows(spec) {
  const views = spec.windows.map(() => new DataView(new ArrayBuffer(0x800)));
  const objects = views.map((view, i) => ({view, i}));
  const links = new Map();
  spec.windows.forEach((win, i) => {
    views[i].setUint8(0x30, win.flags); views[i].setUint8(0x38, win.surface);
    win.clip.forEach((bits, k) => views[i].setUint32(0xd4 + 4 * k, bits, true));
    const children = win.children.map(c => objects[c]);
    links.set(`${i}:${0x13c}`, children[0] ?? null);
    children.forEach((child, k) => links.set(`${child.i}:${0x148}`, children[k + 1] ?? null));
  });
  views[0].setUint32(0x5d8, spec.root.renderFlags, true);
  spec.root.render.forEach((bits, k) => views[0].setUint32(0x5dc + 4 * k, bits, true));
  const W = {
    u32: (o, off) => o.view.getUint32(off, true), u8: (o, off) => o.view.getUint8(off),
    ptr: (o, off) => links.get(`${o.i}:${off}`) ?? null,
  };
  return {W, root: objects[0]};
}

let rects = 0, nonEmpty = 0;
const hex = list => list.map(r => r.map(x => (x >>> 0).toString(16)).join(',')).join(' | ');
cases.forEach((c, i) => {
  let got;
  if (c.kind === 'subtract') got = subtractClipRect(c.cut, c.list.map(r => r.slice()));
  else { const {W, root: rootWin} = mockWindows(c); got = rawBackgroundClipList(W, rootWin); }
  const want = results[i];
  rects += want.length; if (want.length) nonEmpty++;
  if (hex(got) !== hex(want))
    assert.fail(`case ${i} (${c.kind}) differs\n  js:     ${hex(got)}\n  native: ${hex(want)}\n  case: ${JSON.stringify(c)}`);
});
console.log(JSON.stringify({ok: true, cases: cases.length, nonEmpty, rects}));
