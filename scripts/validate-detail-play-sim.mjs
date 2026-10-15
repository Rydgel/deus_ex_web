/** The detail-texture pass on Play's simulation side (docs/frame-projection.md "Detail textures", "Play"), headless:
 * the fans one Play frame's snapshot carries (sim-session.mjs visibility -> detail-draw.mjs: OccludeBsp with option
 * OCCLUSION_DETAIL, `detail_run` over the main frame's stream and each mirror and sky child frame's) against the CPU reference
 * src/runtime/detail-pass.mjs (itself bit-equal to D3DDrv's pass under Unicorn, scripts/validate-detail-pass.mjs) over the same
 * frame's OccludeBsp run again with every saved polygon's points (option 0x100): each draw list record with a detail texture,
 * each fan's layer and every vertex word, for the main frame and every child frame. `?detailTextures=0` (DETAIL_TEXTURES=0)
 * must leave the snapshot without any.
 *
 * The cameras are the detail-pass validators' (a wall of Training and the Island's pier deck, near enough for all three layers),
 * Training's entrance floor mirror at a slant (a mirror frame with a sky frame inside it), and the same views again on the
 * Island from above the deck.
 *
 *   node scripts/validate-detail-play-sim.mjs [map ...] */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-detail-play-sim: no installed game data'); process.exit(0); }
const only = new Set(process.argv.slice(2).filter(a => !a.startsWith('--')));
const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createSimHost } = await import('../src/viewer/sim-host.mjs');
const { placeProbe } = await import('../src/viewer/decal-probe.mjs');
const { OCCLUSION_DETAIL, OCCLUSION_POINTS } = await import('../src/runtime/bsp-occlusion.mjs');
const { detailFans, detailStage, facetOf, modelSurfaceDetails, detailTexturesOn } = await import('../src/runtime/detail-pass.mjs');
const { unpackDetail, forEachFan } = await import('../src/runtime/detail-draw.mjs');
const { depthConstants, frameOfFields, wordFloat } = await import('../src/runtime/frame-projection.mjs');

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const PF_PORTAL = 0x04000000;
const size = [1280, 720];

const jobs = [
  ['00_Training', [
    { name: 'wall at 30', location: [-736, 1344 - 30, 560], rotation: [0, 16384, 0] },
    { name: 'wall at 120', location: [-1100, 1344 - 120, 560], rotation: [0, 16384 + 5000, 0] },
    { name: 'wall at 400, turned', location: [-736, 1344 - 400, 560], rotation: [0, 16384 - 5000, 0] },
    { name: 'entrance floor mirror, slant', location: [-1149, 1200, -85], rotation: [65536 - 9000, 57344, 0], children: true },
  ]],
  ['01_NYC_UNATCOIsland', [
    { name: 'deck from 20', location: [-4761, 10431, -304 + 20], rotation: [65536 - 6000, 0, 0] },
    { name: 'deck from 70, yaw', location: [-4761, 10431, -304 + 70], rotation: [65536 - 9000, 20000, 0] },
    { name: 'deck from 200', location: [-4761, 10431, -304 + 200], rotation: [65536 - 6000, 40000, 0] },
  ]],
];

const stats = { frames: 0, children: 0, records: 0, fans: 0, vertices: 0, off: 0 };
const word = v => v >>> 0;

/** The reference fans of an OccludeBsp output decoded with points (`draw`), for the frame `fields` and rectangle origin. */
function reference(draw, fields, origin, model, details) {
  const frame = frameOfFields(fields, { width: size[0], height: size[1], x: origin[0], y: origin[1] }), depth = depthConstants(32);
  const out = new Map();
  for (const [list, entries] of draw.entries()) for (const entry of entries) {
    const info = details[entry.iSurf];
    if (!info || entry.polyFlags & PF_PORTAL) continue;
    const polys = entry.polys.filter(p => p.points).map(p => p.points.map(t => ({ x: wordFloat(t[0]), y: wordFloat(t[1]), z: wordFloat(t[2]),
      screenX: wordFloat(t[3]), screenY: wordFloat(t[4]), rz: wordFloat(t[6]) })));
    if (!polys.length) continue;
    const surface = model.surfaces[entry.iSurf];
    const facet = facetOf(frame, model.points[surface.base], model.vectors[surface.textureU], model.vectors[surface.textureV]);
    const fans = detailFans(frame, depth, facet, detailStage(info.uSize, info.vSize, wordFloat(info.scaleBits[0])), [0, 0], polys);
    if (fans.length) out.set(`${list}:${entry.iNode}`, { iSurf: entry.iSurf, fans });
  }
  return out;
}

/** The sim's fans of one pack frame, keyed like `reference`. */
function packed(words) {
  const out = new Map();
  forEachFan(words, (list, node, surf, layer, count, w, at) => {
    const key = `${list}:${node}`;
    if (!out.has(key)) out.set(key, { iSurf: surf, fans: [] });
    const vertices = [];
    for (let v = 0; v < count; v++) vertices.push(Array.from(w.subarray(at + 7 * v, at + 7 * v + 7), word));
    out.get(key).fans.push({ layer, vertices });
  });
  return out;
}

for (const [mapName, views] of jobs) {
  if (only.size && !only.has(mapName)) continue;
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes);
  const details = await modelSurfaceDetails(assets, asset, map.model);
  const host = await createSimHost(map, asset, assets, { randomSeed: 1, subtitles: false, stampScene: null, panZones: [],
    childFrames: views.some(v => v.children), onProgress: () => {} });
  assert.ok(host.game, `${mapName}: the simulation side is built (${host.notes.join('; ')})`);
  const occlusion = host.occlusion();
  if (!detailTexturesOn()) assert.equal(occlusion.detail, null, `${mapName}: ?detailTextures=0 builds no detail table`);
  else assert.ok(occlusion?.detail, `${mapName}: the occlusion has a detail table`);
  let t = 0;
  const frame = () => host.session.frame({ play: true, dt: 1 / 60, run: false, halted: false, size, aspect: size[0] / size[1], resizes: 1,
    seconds: t += 1 / 60, mirrors: true, pixelRatio: 1, now: t, inspect: null });
  try {
    for (const view of views) {
      placeProbe(host.game, { location: view.location, rotation: view.rotation });
      let snapshot = frame();
      snapshot = frame();
      assert.deepEqual(snapshot.errors, [], `${mapName} ${view.name}: frame errors`);
      const vis = snapshot.begin.visibility, rect = snapshot.begin.renderRect;
      assert.ok(vis, `${mapName} ${view.name}: the frame has its OccludeBsp results`);
      const origin = [rect?.x ?? 0, rect?.y ?? 0];
      if (!detailTexturesOn()) {
        // A device without the cap: no detail option, no fans (SetRes zeroes URenderDevice.DetailTextures).
        assert.equal(vis.detail, null, `${mapName} ${view.name}: no detail fans without the cap`);
        assert.equal(vis.master.words[46] & OCCLUSION_DETAIL, 0, 'the frame ran without the detail option');
        stats.off++;
        continue;
      }
      // The same frame again with every saved polygon's points: the reference passes' input.
      const words = Uint32Array.from(vis.master.words);
      assert.ok(words[46] & OCCLUSION_DETAIL, 'the frame ran with the detail option');
      words[46] = (words[46] & ~OCCLUSION_DETAIL) | OCCLUSION_POINTS;
      const again = occlusion.run(words, [], { children: { fov: vis.master.fov, orthoZoom: 0 } });
      const built = occlusion.master({ location: vis.master.location, rotation: vis.master.rotation, width: vis.master.viewport[0],
        height: vis.master.viewport[1], fov: vis.master.fov, render: { width: vis.master.render[0], height: vis.master.render[1] } });
      const wants = new Map([[0, reference(again.draw, built.fields, origin, map.model, details)]]);
      for (const child of again.frames) wants.set(child.index, reference(child.draw, child.fields, origin, map.model, details));
      const got = new Map((vis.detail ? unpackDetail(vis.detail) : []).map(entry => [entry.index, packed(entry.words)]));
      const where = `${mapName} ${view.name}`;
      let fans = 0, records = 0;
      for (const index of new Set([...wants.keys(), ...got.keys()])) {
        const want = wants.get(index) ?? new Map(), have = got.get(index) ?? new Map();
        assert.deepEqual([...have.keys()].sort(), [...want.keys()].sort(), `${where} frame ${index}: draw list records with detail fans`);
        for (const [key, w] of want) {
          const h = have.get(key);
          assert.equal(h.iSurf, w.iSurf, `${where} frame ${index} ${key}: surface`);
          assert.equal(h.fans.length, w.fans.length, `${where} frame ${index} ${key}: number of fans`);
          for (const [k, fan] of w.fans.entries()) {
            assert.equal(h.fans[k].layer, fan.layer, `${where} frame ${index} ${key} fan ${k}: layer`);
            assert.deepEqual(h.fans[k].vertices, fan.vertices.map(v => v.map(word)), `${where} frame ${index} ${key} fan ${k}: vertices`);
            fans++; stats.vertices += fan.vertices.length;
          }
          records++;
        }
        if (index) stats.children++;
      }
      assert.ok(fans > 0, `${where}: the view has detail fans`);
      if (view.children) assert.ok([...got.keys()].some(i => i > 0), `${where}: a child frame carries detail fans (frames ${[...got.keys()]})`);
      stats.frames++; stats.records += records; stats.fans += fans;
      console.log(`${where}: frames with fans ${[...got.keys()]}, ${records} records, ${fans} fans, ${vis.detail.length} words`);
    }
  } finally { host.dispose(); }
}
console.log(JSON.stringify(stats));
console.log(`validate-detail-play-sim: ok${detailTexturesOn() ? '' : ' (?detailTextures=0)'}`);
