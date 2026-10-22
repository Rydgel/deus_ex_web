#!/usr/bin/env node
/** The Load Game screen's snapshot picture against the original (docs/save-storage.md "The snapshot").
 *
 * The original under Wine drew each save's snapshot in the 160 x 120 window of MenuScreenLoadGame (`winSnapshot.SetBackground(saveInfo.Snapshot)`,
 * CreateSnapshotWindow at 387, 24): the captures `sd1/load1.png` (Save0001 selected) and `sd1/load2.png` (Quick Save), 1280 x 720, of
 * docs/save-directory.md. This reads the two real `SaveInfo.dxs` files with Play's reader (src/runtime/save-info.mjs: the P8 texture and its palette)
 * and shows, from the captures:
 *
 *  1. the picture in the capture is the texture's top-left 160 x 120 pixels, unscaled: there is one window position at which every pixel of the
 *     capture is a single-valued, monotonic function of the texture's palette index (the display ramp of the original's render device), the same
 *     for both saves and both captures;
 *  2. that position is the snapshot window's own (the Load Game window's client origin plus 387, 24), so the picture sits at the window's origin
 *     with no scaling, offset or border;
 *  3. Play's HUD tile for the window (`validate-save-directory.mjs` scenario `real`, and `browser-tests/save-folder.spec.mjs`) is the same
 *     source rectangle: u = v = 0, ul = 160, vl = 120 of the 256 x 128 texture.
 *
 * Needs the Wine captures (`DX_WINE_SD1`, default `.work/travel/sd1`) and the two saves (`DX_SAVE_DIR`, default the Wine prefix's Save folder); skips
 * without them. The ramp it measures is printed: it is the original's gamma as the Wine render device applied it, not a Play value. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';
import { decodePng } from './png-decode.mjs';

const captures = process.env.DX_WINE_SD1 ?? '.work/travel/sd1';
const saves = process.env.DX_SAVE_DIR ?? path.join(process.env.HOME ?? '', '.wine-deusex/drive_c/Deus Ex GOTY Edition/Save');
const read = file => readFile(file).then(bytes => bytes, () => null);
const [first, second, quick, save1] = await Promise.all([read(path.join(captures, 'load1.png')), read(path.join(captures, 'load2.png')),
  read(path.join(saves, 'QuickSave/SaveInfo.dxs')), read(path.join(saves, 'Save0001/SaveInfo.dxs'))]);
if (!first || !second || !quick || !save1) { console.log('SKIP validate-save-snapshot: the Wine captures or the real saves are not here'); process.exit(0); }

const shots = { Save0001: decodePng(first), QuickSave: decodePng(second) };
const infos = { Save0001: parseSaveInfo(save1), QuickSave: parseSaveInfo(quick) };
const WIDTH = 160, HEIGHT = 120;
const texel = (image, x, y) => image.data[y * image.width + x];

/** The capture's grey level at (x0 + x, y0 + y) as a function of the texture index at (x, y): how many indices map to more than one level, and whether the
 * mapping is non-decreasing in the index. Fewer conflicts is a better alignment; none is the picture. */
function fit(shot, image, x0, y0) {
  const levels = new Map();
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const o = ((y0 + y) * shot.width + x0 + x) * 4, index = texel(image, x, y), level = shot.data[o];
    if (!levels.has(index)) levels.set(index, new Map());
    levels.get(index).set(level, (levels.get(index).get(level) ?? 0) + 1);
  }
  let conflicts = 0, pixels = 0;
  const ramp = new Map();
  for (const [index, seen] of levels) {
    const [[level, count]] = [...seen].sort((a, b) => b[1] - a[1]);
    ramp.set(index, level);
    for (const n of seen.values()) pixels += n;
    conflicts += [...seen.values()].reduce((a, b) => a + b, 0) - count;
  }
  return { conflicts, pixels, ramp };
}

const results = {};
for (const [slot, shot] of Object.entries(shots)) {
  const image = infos[slot].snapshot.image;
  assert.ok(image && image.width === 256 && image.height === 128, `${slot}: the P8 256 x 128 texture`);
  // the picture is grey (the palette is the grey ramp), so any channel serves; find the origin: a quick screen of a coarse sample at every position,
  // then the full fit on the best few
  const samples = [];
  for (let y = 0; y < HEIGHT; y += 3) for (let x = 0; x < WIDTH; x += 3) samples.push([x, y, texel(image, x, y)]);
  const screened = [];
  for (let y0 = 150; y0 <= 320; y0++) for (let x0 = 680; x0 <= 860; x0++) {
    const seen = new Int16Array(256).fill(-1);
    let conflicts = 0;
    for (const [x, y, index] of samples) {
      const level = shot.data[((y0 + y) * shot.width + x0 + x) * 4];
      if (seen[index] < 0) seen[index] = level; else if (seen[index] !== level) conflicts++;
    }
    screened.push([conflicts, x0, y0]);
  }
  screened.sort((a, b) => a[0] - b[0]);
  let best = null;
  for (const [, x0, y0] of screened.slice(0, 6)) {
    const result = fit(shot, image, x0, y0);
    if (!best || result.conflicts < best.conflicts) best = { x0, y0, ...result };
  }
  results[slot] = best;
  console.log(`  ${slot}: window origin (${best.x0}, ${best.y0}), ${best.conflicts} of ${best.pixels} pixels off the single-valued ramp`);
}
const near = (a, b) => Math.abs(a - b) <= 1;
for (const [slot, best] of Object.entries(results)) assert.equal(best.conflicts, 0, `${slot}: every pixel of the capture is one function of the texture index`);
assert.ok(near(results.Save0001.x0, results.QuickSave.x0) && near(results.Save0001.y0, results.QuickSave.y0), 'both captures place the picture at the same window position');
// the ramp is non-decreasing in the index, and the two captures agree where both have an index
const monotonic = ramp => { let last = -1; for (const index of [...ramp.keys()].sort((a, b) => a - b)) { const level = ramp.get(index); if (level < last) return false; last = level; } return true; };
for (const [slot, best] of Object.entries(results)) assert.ok(monotonic(best.ramp), `${slot}: the display ramp is non-decreasing`);
let shared = 0;
for (const [index, level] of results.QuickSave.ramp) if (results.Save0001.ramp.has(index)) { shared++; assert.equal(results.Save0001.ramp.get(index), level, `index ${index}: the same level in both captures`); }
assert.ok(shared > 20, `the two pictures share ${shared} palette indices to compare`);
console.log(`  the two captures give the same level for each of the ${shared} palette indices both pictures use`);
// the window sits where CreateSnapshotWindow puts it: (387, 24) in the client of the Load Game window; the capture's window origin minus that is the client origin
const [clientX, clientY] = [results.Save0001.x0 - 387, results.Save0001.y0 - 24];
console.log(`  the Load Game client origin would be (${clientX}, ${clientY}) of the 1280 x 720 capture; the picture is the texture's top-left ${WIDTH} x ${HEIGHT}, unscaled`);
const sample = [...results.Save0001.ramp].sort((a, b) => a[0] - b[0]).filter((_, i, all) => i % Math.ceil(all.length / 8) === 0).map(([index, level]) => `${index}->${level}`).join(' ');
console.log(`  the original's display ramp at sample indices: ${sample}`);
console.log('validate-save-snapshot: the Wine captures show the snapshot as the texture\'s top-left 160 x 120 pixels, unscaled, through one monotonic display ramp');
