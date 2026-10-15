/** The Rust core's detail-texture pass (native/script-vm/src/detail.rs, `detail_run`) against D3DDrv's own pass run under Unicorn
 * (scripts/native-frame-projection-oracle.py, the same cameras as scripts/validate-detail-pass.mjs): the OccludeBsp run in the
 * Rust core with saved points (option 0x100) gives the stream, `detail_run` turns it, the frame's fields and the per-surface
 * table (src/runtime/detail-pass.mjs `detailTable`) into fans; every fan the original handed DrawPrimitiveVB (draw list, layer,
 * polygon, X, Y, depth, RHW, colour, U, V) must equal Rust's bit for bit, with no fan more or less.
 *
 *   node scripts/validate-detail-pass-rust.mjs [map ...] */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { depthConstants, floatWord } from '../src/runtime/frame-projection.mjs';
import { detailTable } from '../src/runtime/detail-pass.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion, OCCLUSION_POINTS, OCCLUSION_DETAIL, OCCLUSION_SHOW_PLAYER_CTRL, OCCLUSION_SHINY_SURFACES } from '../src/runtime/bsp-occlusion.mjs';
import { available, bspOracle, rectOf } from './frame-projection-cases.mjs';
import { surfaceTextureFlags } from './occlusion-request.mjs';
import { detailJobs } from './detail-pass-cases.mjs';

if (!available) {
  console.log('SKIP validate-detail-pass-rust: no native probe environment');
  process.exit(0);
}
const only = new Set(process.argv.slice(2).filter(a => !a.startsWith('--')));
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const vm = await loadScriptVmKernel(), kernel = vm.occlusion;
if (!kernel?.detailRun) throw new Error('The script VM core predates the detail pass; run npm run build:wasm');
const stats = { cases: 0, records: 0, fans: 0, vertices: 0, filteredRecords: 0, wordsAll: 0, wordsFiltered: 0 };
const word = v => v >>> 0;

for (const [map, views] of detailJobs) {
  if (only.size && !only.has(map)) continue;
  const { model, details, cases, results } = await bspOracle(map, { seed: 1, count: 0, aimed: false, views, detail: true });
  const asset = await assets.get(map);
  const table = detailTable(model, details);
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags: await surfaceTextureFlags(assets, asset, model),
    zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)), detailTable: table });
  const tableAt = kernel.alloc(4 * table.length), outCap = 1 << 20, outAt = kernel.alloc(4 * outCap);
  const fieldsAt = kernel.alloc(4 * 80);
  new Uint32Array(kernel.memory.buffer).set(table, tableAt >>> 2);
  const depth = depthConstants(32);
  try {
    for (const [i, c] of cases.entries()) {
      const o = results[i], rect = rectOf(c), where = `${map} case ${i} (${c.location} ${c.rotation})`;
      const master = occlusion.master({ location: c.location.map(Math.fround), rotation: c.rotation, width: c.width, height: c.height,
        fov: c.fov, render: c.render ? { width: c.render.width, height: c.render.height } : null });
      const frame = [...master.frame];
      frame[44] = c.frameCounter; frame[45] = c.timeBits;
      frame[46] = OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES | OCCLUSION_POINTS; frame[47] = 0;
      const r = occlusion.run(frame, []);
      new Uint32Array(kernel.memory.buffer).set(master.fields, fieldsAt >>> 2);
      const written = kernel.detailRun(fieldsAt, rect.x, rect.y, floatWord(depth.zBias), floatWord(depth.zScale), tableAt, model.surfaces.length,
        r.stream.at, r.stream.words, outAt, outCap);
      assert.notEqual(written, 0xffffffff, `${where}: the output buffer overflowed`);
      // Rust's records, keyed by draw list and node.
      const out = new Uint32Array(kernel.memory.buffer, outAt, written), got = new Map();
      for (let at = 0; at < written;) {
        const [list, node, , fans] = out.subarray(at, at + 4);
        at += 4;
        const fanList = [];
        for (let k = 0; k < fans; k++) {
          const [layer, first, count] = out.subarray(at, at + 3);
          at += 3;
          const vertices = [];
          for (let v = 0; v < count; v++, at += 7) vertices.push([...out.subarray(at, at + 7)]);
          fanList.push({ layer, first, count, vertices });
        }
        got.set(`${list}:${node | 0}`, fanList);
      }
      // The original's: the detail fans of each entry (the draws after SetBlending's state calls).
      const want = new Map();
      for (const [list, entries] of o.draw.entries()) for (const entry of entries) {
        if (!entry.detail) continue;
        const start = entry.detail.calls.findIndex(call => call.op === 'rs' && call.args[0] === 27);
        const fans = start < 0 ? [] : entry.detail.calls.slice(start).filter(call => call.op === 'draw')
          .map(call => ({ layer: call.layer, first: call.first, count: call.count, vertices: call.vertices.map(v => v.slice(0, 7)) }));
        if (fans.length) want.set(`${list}:${entry.iNode | 0}`, fans);
      }
      assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort(), `${where}: draw list records with detail fans`);
      for (const [key, fans] of want) {
        const have = got.get(key);
        assert.equal(have.length, fans.length, `${where} ${key}: number of fans`);
        for (const [k, fan] of fans.entries()) {
          assert.deepEqual([have[k].layer, have[k].first, have[k].count], [fan.layer, fan.first, fan.count], `${where} ${key} fan ${k}: layer, first vertex, count`);
          assert.deepEqual(have[k].vertices.map(v => v.map(word)), fan.vertices.map(v => v.map(word)), `${where} ${key} fan ${k}: vertices`);
          stats.fans++;
          stats.vertices += fan.count;
        }
        stats.records++;
      }
      // The same frame with option OCCLUSION_DETAIL (Play's: the saved points only of the polygons the pass can use): the fans
      // are the same vertex for vertex; `first` counts the kept polygons only.
      frame[46] = OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES | OCCLUSION_DETAIL;
      const f = occlusion.run(frame, []);
      new Uint32Array(kernel.memory.buffer).set(master.fields, fieldsAt >>> 2);
      const writtenF = kernel.detailRun(fieldsAt, rect.x, rect.y, floatWord(depth.zBias), floatWord(depth.zScale), tableAt, model.surfaces.length,
        f.stream.at, f.stream.words, outAt, outCap);
      assert.notEqual(writtenF, 0xffffffff, `${where}: the output buffer overflowed (filtered)`);
      const filtered = new Uint32Array(kernel.memory.buffer, outAt, writtenF), gotF = new Map();
      for (let at = 0; at < writtenF;) {
        const [list, node, , fans] = filtered.subarray(at, at + 4);
        at += 4;
        const fanList = [];
        for (let k = 0; k < fans; k++) {
          const [layer, , count] = filtered.subarray(at, at + 3);
          at += 3;
          const vertices = [];
          for (let v = 0; v < count; v++, at += 7) vertices.push([...filtered.subarray(at, at + 7)]);
          fanList.push({ layer, count, vertices });
        }
        gotF.set(`${list}:${node | 0}`, fanList);
      }
      assert.deepEqual([...gotF.keys()].sort(), [...got.keys()].sort(), `${where}: filtered draw list records with detail fans`);
      for (const [key, fans] of got) {
        const have = gotF.get(key);
        assert.equal(have.length, fans.length, `${where} ${key}: filtered number of fans`);
        for (const [k, fan] of fans.entries()) {
          assert.deepEqual([have[k].layer, have[k].count], [fan.layer, fan.count], `${where} ${key} filtered fan ${k}: layer, count`);
          assert.deepEqual(have[k].vertices.map(v => v.map(word)), fan.vertices.map(v => v.map(word)), `${where} ${key} filtered fan ${k}: vertices`);
        }
        stats.filteredRecords++;
      }
      stats.wordsAll += r.stream.words; stats.wordsFiltered += f.stream.words;
      stats.cases++;
    }
  } finally {
    occlusion.dispose();
  }
  console.log(`${map}: ${cases.length} cameras`);
}
console.log(JSON.stringify(stats));
console.log('validate-detail-pass-rust: ok');
