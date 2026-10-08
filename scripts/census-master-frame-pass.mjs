/** How much the render pass's ComputeRenderSize changes the 3D frame
 * OccludeBsp sees (docs/render-pass-precision.md "The 3D frame's
 * projection"): for seeded camera views on the Island and the Paris club,
 * the master frame built the way Play did before (ComputeRenderSize once, at
 * the game thread's 64 bits, on the render rectangle) against the way the
 * original builds it (CreateMasterFrame at 64 bits on the viewport, then
 * XRootWindow::PreRender's ComputeRenderSize at 24 bits on the rectangle,
 * the screen span still the viewport's). Counts the views whose frame
 * fields (FX..PrjYP, ViewSides, ViewPlanes) differ and those whose
 * OccludeBsp result differs (the draw lists' surfaces and fragments, child
 * frame requests with spans, NodesDraw/PolysDraw, NodeFlags and zone times
 * after; and, apart, the saved polygons' projected point bits), each view
 * on a fresh occlusion state so the two variants start equal. Two
 * rectangles: the viewport itself (normal play) and a letterboxed one
 * (a conversation's bars).
 *
 *   node scripts/census-master-frame-pass.mjs [views per map and FOV] */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion, OCCLUSION_POINTS, OCCLUSION_SHOW_PLAYER_CTRL, OCCLUSION_SHINY_SURFACES } from '../src/runtime/bsp-occlusion.mjs';
import { surfaceTextureFlags } from './occlusion-request.mjs';

const perMap = Number(process.argv[2] ?? 60);
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const kernel = (await loadScriptVmKernel()).occlusion;
const units = r => Math.round(r * 32768 / Math.PI);
const VIEWPORT = [1440, 960];
const rectangles = { 'viewport (normal play)': { width: 1440, height: 960 }, 'letterbox (conversation bars)': { width: 1440, height: 720 } };

async function census(mapName, seed) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const textureFlags = await surfaceTextureFlags(assets, asset, model);
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const spots = map.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint|Inventory|Decoration|ScriptedPawn|Light|Trigger/.test(a.className)).map(a => a.values.Location);
  const views = [];
  for (let i = 0; i < perMap; i++) {
    const anywhere = random() < 0.25 || !spots.length;
    const p = anywhere ? [0, 1, 2].map(k => model.bounds.min[k] + random() * (model.bounds.max[k] - model.bounds.min[k]))
      : spots[Math.floor(random() * spots.length)].map((v, k) => v + (k === 2 ? 30 : (random() - 0.5) * 40));
    views.push({ location: p.map(Math.fround), rotation: [units((random() - 0.5) * 0.5), Math.floor(random() * 65536), 0], frameCounter: Math.floor(random() * 1000) });
  }
  const options = { surfaceTextureFlags: textureFlags, zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)) };
  const run = (view, fov, master) => {
    const occlusion = createBspOcclusion(kernel, model, options);
    try {
      const frame = occlusion.master({ location: view.location, rotation: view.rotation, fov, ...master });
      const words = [...frame.frame];
      words[44] = view.frameCounter; words[45] = 0x3f800000 + view.frameCounter;
      words[46] = OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES | OCCLUSION_POINTS; words[47] = 0;
      const r = occlusion.run(words, []);
      const flags = [], times = [];
      for (let k = 0; k < model.nodes.length; k++) flags.push(occlusion.nodeFlags(k));
      for (let k = 0; k < model.zones.length; k++) times.push(occlusion.zoneTime(k) >>> 0);
      const lists = r.draw.map(list => list.map(d => ({ iNode: d.iNode, iSurf: d.iSurf, iZone: d.iZone, polyFlags: d.polyFlags,
        polys: d.polys.map(p => ({ iNode: p.iNode, points: p.points.map(t => [...t]) })) })));
      // What the draw consumes (which fragments of which surfaces, the child frame requests, the counters and the state
      // the next frame inherits) apart from the saved points' projected bits.
      const structure = JSON.stringify({ draw: lists.map(list => list.map(d => ({ ...d, polys: d.polys.map(p => p.iNode) }))),
        children: r.children.map(c => ({ iSurf: c.iSurf, zone: c.zone, span: c.span })), counters: [r.nodesDraw, r.polysDraw], flags, times });
      return { fields: [...frame.fields].slice(12, 57), structure, points: JSON.stringify(lists.map(list => list.map(d => d.polys.map(p => p.points)))) };
    } finally { occlusion.dispose(); }
  };
  for (const [label, rect] of Object.entries(rectangles)) {
    for (const fov of [75, 90]) {
      let fieldsChanged = 0, structureChanged = 0, pointsChanged = 0, words = 0;
      for (const view of views) {
        const before = run(view, fov, { width: rect.width, height: rect.height });
        const after = run(view, fov, { width: VIEWPORT[0], height: VIEWPORT[1], render: rect });
        const differing = before.fields.filter((v, k) => v !== after.fields[k]).length;
        if (differing) { fieldsChanged++; words += differing; }
        if (before.structure !== after.structure) structureChanged++;
        if (before.points !== after.points) pointsChanged++;
      }
      console.log(`${mapName} ${label}, FOV ${fov}: ${views.length} views: ${fieldsChanged} change the frame (${(words / Math.max(1, fieldsChanged)).toFixed(1)} of 45 size words on average), ${structureChanged} change which surfaces, child requests or node state OccludeBsp produces, ${pointsChanged} change the saved polygons' projected points`);
    }
  }
}
await census('01_NYC_UNATCOIsland', 101);
await census('10_Paris_Club', 103);
