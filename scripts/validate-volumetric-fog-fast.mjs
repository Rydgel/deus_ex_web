// The fog loop's certain-rounding fast path (fog.rs texel_fast,
// docs/volumetric-fog.md "Fast path") against the Ext-only loop over real
// map inputs: what Play's fog pass sends to the Rust loop on 02_NYC_Bar,
// 06_HongKong_WanChai_Market, 09_NYC_Ship and 02_NYC_BatteryPark from many
// eye positions and rotations (volumetric-fog-capture.mjs, cached under
// .cache/volumetric-fog-inputs/). Each frame replays its surfaces in Play's
// order with the early-out flag carried from surface to surface:
// - `fog.check` runs every texel on Ext and the fast path on the same
//   incoming flag; any texel where the fast path answers with a different
//   index or flag fails. Equal (index, flag) per texel makes the flag
//   sequence equal by induction.
// - `fog.map` with the fast path, then on Ext only: texels and final flag
//   equal; the replayed flag chain equals the one Play produced.
// Reports the fallback rate (texels the fast path left to Ext) per map.
//
//   node scripts/validate-volumetric-fog-fast.mjs [--maps A,B] [--capture] [--bench [--reps N]]
//
// --bench: ms per frame-equivalent (the "view" frames: surfaces in the main
// view's frustum, as Play sends them) of the kernel loop with uploads, fast
// path against Ext only, interleaved, medians of N passes.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, mkdirSync} from 'node:fs';
import {loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {squareRootTable} from '../src/runtime/dynamic-lighting.mjs';
import {gameDirectory} from './game-directory.mjs';

const flag = name => process.argv.includes(`--${name}`);
const listed = process.argv.indexOf('--maps');
const MAPS = listed < 0 ? ['02_NYC_Bar', '06_HongKong_WanChai_Market', '09_NYC_Ship', '02_NYC_BatteryPark'] : process.argv[listed + 1].split(',');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : Number(process.argv[i + 1]); };
const DIRECTORY = '.cache/volumetric-fog-inputs';

function capture(map) {
  const file = `${DIRECTORY}/${map}.json`;
  if (flag('capture') || !existsSync(file)) {
    try { gameDirectory(); } catch { console.log('SKIP validate-volumetric-fog-fast: no installed game data'); process.exit(0); }
    mkdirSync(DIRECTORY, {recursive: true});
    execFileSync(process.execPath, ['scripts/volumetric-fog-capture.mjs', map, file], {stdio: ['ignore', 'inherit', 'inherit']});
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const words = text => { const b = Buffer.from(text, 'base64'); return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
  const tables = data.tables.map(text => new Uint8Array(Buffer.from(text, 'base64')));
  const lightSets = data.lightSets.map(set => ({lights: words(set.lights), tables: tables[set.table]}));
  const frames = data.frames.map(frame => {
    const w = words(frame.surfaces), surfaces = [];
    for (let i = 0; i < w.length; i += 14)
      surfaces.push({width: w[i], height: w[i + 1], count: w[i + 2], missIn: w[i + 3], set: lightSets[w[i + 4]], grid: w.slice(i + 5, i + 14)});
    return {kind: frame.kind, surfaces, texels: surfaces.reduce((n, s) => n + s.width * s.height * s.count, 0)};
  });
  return {...data, frames};
}

const kernel = await loadScriptVmKernel(), fog = kernel.fog;
fog.sqrt(squareRootTable());
const upload = surface => { fog.lights(surface.set.lights); fog.tables(surface.set.tables); fog.grid(surface.grid); };

if (!flag('bench')) {
  const totals = {texels: 0, fallbacks: 0, surfaces: 0, frames: 0};
  for (const map of MAPS) {
    const {frames, lights, fogSurfaces} = capture(map);
    let texels = 0, fallbacks = 0, surfaces = 0, fastFallbacks = 0, fogged = 0;
    frames.forEach((frame, f) => {
      let miss = 0; // fog.update starts each frame with the flag clear
      frame.surfaces.forEach((surface, k) => {
        const where = `${map} frame ${f} surface ${k}`, {width, height, count} = surface;
        assert.equal(surface.missIn, miss, `${where}: Play's incoming flag equals the Ext replay's`);
        upload(surface);
        fog.setExact(false); fog.setMiss(miss); fog.resetFallbacks();
        assert.equal(fog.check(width, height, count), 0, `${where}: fast-path texels agree with Ext on index and flag`);
        const exact = fog.texels(width, height), exactMiss = fog.miss();
        fallbacks += fog.fallbacks();
        fog.setMiss(miss); fog.resetFallbacks();
        const fast = fog.map(width, height, count);
        fastFallbacks += fog.fallbacks();
        assert.ok(fast && Buffer.from(fast).equals(Buffer.from(exact)), `${where}: fast-path fog map equals Ext's`);
        assert.equal(fog.miss(), exactMiss, `${where}: fast-path final flag`);
        fog.setExact(true); fog.setMiss(miss);
        const ext = fog.map(width, height, count);
        assert.ok(Buffer.from(ext).equals(Buffer.from(exact)), `${where}: Ext-only fog map equals the checked loop's`);
        assert.equal(fog.miss(), exactMiss, `${where}: Ext-only final flag`);
        miss = exactMiss;
        texels += width * height * count; surfaces++;
        for (let t = 3; t < exact.length; t += 4) if (exact[t]) fogged++;
      });
    });
    fog.setExact(false);
    assert.equal(fastFallbacks, fallbacks, `${map}: fog_map and fog_check fall back on the same texels`);
    console.log(`${map}: ${lights} volumetric light(s), ${fogSurfaces} fog surfaces; ${frames.length} frames, ${surfaces} surface maps, ${texels} texel-lights (${fogged} fogged texels): fast path equals Ext on every texel and flag; ${fallbacks} fallbacks (${(100 * fallbacks / texels).toFixed(4)}%)`);
    totals.texels += texels; totals.fallbacks += fallbacks; totals.surfaces += surfaces; totals.frames += frames.length;
  }
  console.log(`validate-volumetric-fog-fast: PASS (${totals.frames} frames, ${totals.surfaces} surface maps, ${totals.texels} texel-lights; ${totals.fallbacks} fallbacks, ${(100 * totals.fallbacks / totals.texels).toFixed(4)}%)`);
} else {
  const reps = option('reps', 7), median = values => values.slice().sort((a, b) => a - b)[values.length >> 1];
  for (const map of MAPS) {
    const frames = capture(map).frames.filter(frame => frame.kind === 'view');
    const pass = exact => {
      fog.setExact(exact);
      const start = performance.now();
      for (const frame of frames) {
        fog.setMiss(0);
        for (const surface of frame.surfaces) { upload(surface); fog.map(surface.width, surface.height, surface.count); }
      }
      return (performance.now() - start) / frames.length;
    };
    pass(false); pass(true); // warm-up
    const ext = [], fast = [];
    for (let r = 0; r < reps; r++) { ext.push(pass(true)); fast.push(pass(false)); }
    fog.setExact(false);
    const texels = frames.reduce((n, frame) => n + frame.texels, 0) / frames.length;
    const [e, q] = [median(ext), median(fast)];
    console.log(`${map}: ${frames.length} view frames, ${Math.round(texels)} texel-lights/frame: Ext only ${e.toFixed(3)} ms/frame, fast path ${q.toFixed(3)} ms/frame (${(e / q).toFixed(1)}x; medians of ${reps})`);
  }
}
