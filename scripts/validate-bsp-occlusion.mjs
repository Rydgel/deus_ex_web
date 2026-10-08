/** URender::OccludeBsp in the Rust core (src/runtime/bsp-occlusion.mjs,
 * native/script-vm/src/occlude.rs) against the unchanged original under
 * Unicorn (scripts/native-occlusion-oracle.py): docs/bsp-occlusion.md.
 *
 * Each map runs one seeded camera sequence through both in order, so the
 * NodeFlags the original keeps between frames (NF_BoxOccluded,
 * NF_PolyOccluded) and the frame counter's bound-test schedule carry over.
 * Cameras stand at actors and anywhere in the model's bounds (solid space,
 * outside the level, zone 0) at random rotations, frame sizes and FOVs 75
 * and 90. Every draw list entry, every saved polygon's clipped points
 * (X, Y, Z, ScreenX, ScreenY, IntY, RZ bits), the NodeFlags, the zones'
 * LastRenderTime, the counters and the child-frame requests with their
 * spans must match bit for bit, and so must the master frame the port
 * builds from the camera (CreateMasterFrame: ComputeRenderCoords,
 * ComputeRenderSize, PointRegion).
 *
 * Three cases in four also run the render pass's ComputeRenderSize
 * (docs/render-pass-precision.md "The 3D frame's projection"): the frame's
 * X and Y become a render rectangle (the viewport, or a clipped one at an
 * offset, as XRootWindow::PreRender leaves them) and ComputeRenderSize runs
 * again at control word 0x007f, so FX..PrjYP, ViewSides and ViewPlanes are
 * the 24-bit ones of that rectangle while the coordinates, the zone and the
 * screen span stay CreateMasterFrame's (the viewport's); every other pass
 * case builds the frame inside the render pass, as a ViewportWindow's does
 * (CreateMasterFrame at 0x007f). Core appTan's results for the 24-bit
 * arguments are measured on real x87 hardware (X87_PROBE_WINE) when the
 * runner exists; the FPTAN model stands in otherwise and is checked
 * against them.
 *
 * With the moving brush tracker (docs/brush-tracker.md), a map's movers are
 * filtered into the model first (construction at PC64, then moved movers'
 * Update at PC24, as Play runs them) and the oracle gets the resulting
 * model and a tracker whose SurfIsDynamic is Engine's own: the fragments'
 * draw lists, their coplanar chains and the skipped bound tests on
 * fragment nodes (whose iRenderBound links the mover's chain) must match
 * too. Cameras then include one at a spot near each mover, aimed at it. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion, OCCLUSION_POINTS, OCCLUSION_SHOW_PLAYER_CTRL,
  OCCLUSION_SHINY_SURFACES } from '../src/runtime/bsp-occlusion.mjs';
import { bits, occlusionModelRequest, occlusionTangents, renderPassTangent, renderPassTangentsMeasured, renderRectangle,
  surfaceTextureFlags as textureFlagsOf, trackedModelRequest } from './occlusion-request.mjs';
import { collectTrackerMovers, trackerMoverSpec, trackerTextureFlags } from '../src/runtime/brush-tracker.mjs';
import { texturePolyFlags } from '../src/runtime/bsp-occlusion.mjs';
import { readTexture } from '../src/unreal/textures.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) {
  console.log('SKIP validate-bsp-occlusion: no native probe environment');
  process.exit(0);
}
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const TANGENTS = occlusionTangents();
const vm = await loadScriptVmKernel(), kernel = vm.occlusion;

const units = r => Math.round(r * 32768 / Math.PI);

async function validate(mapName, count, seed, extra = [], { tracker = null } = {}) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const surfaceTextureFlags = await textureFlagsOf(assets, asset, model);
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const spots = map.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint|Inventory|Decoration|ScriptedPawn|Light|Trigger/.test(a.className)).map(a => a.values.Location);
  const sizes = [[640, 480], [1024, 768], [1440, 839], [1920, 1080], [801, 601], [1280, 720]];
  const cases = [...extra];
  // The tracker's movers at their map placement, then the moved ones
  // (`tracker.moves`: name, offset, addRotation) updated as a frame would.
  let movers = null, occlusion = null, fragmentNodes = 0;
  if (tracker) {
    movers = await collectTrackerMovers(assets, asset, map);
    await trackerTextureFlags(assets, asset, movers, object => texturePolyFlags(readTexture(object.asset, object.index).values));
    const specs = movers.map((m, i) => trackerMoverSpec(m, i, { hidden: m.values.bHidden, location: m.values.Location ?? [0, 0, 0],
      rotation: m.values.Rotation ?? [0, 0, 0], prePivot: m.values.PrePivot ?? [0, 0, 0] }));
    occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags,
      zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)), tracker: { movers: specs } });
    assert.equal(occlusion.tracker.construct({ pc64: true }), 0, `${mapName}: tracker construction`);
    for (const move of tracker.moves ?? []) {
      const i = movers.findIndex(m => m.name === move.name), v = movers[i].values;
      const location = (v.Location ?? [0, 0, 0]).map((x, k) => Math.fround(x + (move.offset?.[k] ?? 0)));
      occlusion.tracker.setMover(i, { locationBits: location.map(bits),
        rotation: (v.Rotation ?? [0, 0, 0]).map((r, k) => (r + (move.addRotation?.[k] ?? 0)) | 0) });
      occlusion.tracker.update(i);
    }
    fragmentNodes = movers.reduce((n, _, i) => n + occlusion.tracker.chain(i).length, 0);
    // A camera near each mover (a spot 150 to 700 units away), aimed at it.
    for (const m of movers) {
      const at = m.values.Location ?? [0, 0, 0];
      const spot = spots.map(p => ({ p, d: Math.hypot(...p.map((x, k) => x - at[k])) })).filter(e => e.d > 150 && e.d < 700)
        .sort((x, y) => x.d - y.d)[0];
      if (!spot) continue;
      const eye = spot.p.map((x, k) => x + (k === 2 ? 30 : 0)), d = at.map((x, k) => x - eye[k]);
      cases.push({ location: eye, rotation: [units(Math.atan2(d[2], Math.hypot(d[0], d[1]))), (units(Math.atan2(d[1], d[0])) + 65536) % 65536, 0],
        width: 1280, height: 720, fov: 90 });
    }
    count += cases.length;
  }
  while (cases.length < count) {
    const anywhere = random() < 0.4 || !spots.length;
    const p = anywhere ? [0, 1, 2].map(k => model.bounds.min[k] + random() * (model.bounds.max[k] - model.bounds.min[k]))
      : spots[Math.floor(random() * spots.length)].map((v, k) => v + (k < 2 ? (random() - 0.5) * 40 : random() * 40));
    const [width, height] = sizes[Math.floor(random() * sizes.length)];
    cases.push({ location: p, rotation: [Math.floor((random() - 0.5) * 28000), Math.floor(random() * 65536),
      random() < 0.2 ? Math.floor((random() - 0.5) * 8000) : 0], width, height, fov: random() < 0.5 ? 90 : 75 });
  }
  cases.forEach((c, i) => Object.assign(c, { locationBits: c.location.map(bits), frameCounter: i, timeBits: bits(1 + i / 30) }));
  // The render pass's ComputeRenderSize on three cases in four: the viewport
  // as the render rectangle (kind 1), a clipped rectangle at an offset
  // (kind 2), and one of those with the master frame built inside the pass
  // (kind 3, a ViewportWindow's).
  cases.forEach((c, i) => {
    if (i % 4 === 0) return;
    c.render = renderRectangle(c.width, c.height, random, i % 4 === 1 ? 1 : 0.5);
    if (i % 4 === 3) c.masterControlWord = 0x007f;
  });
  // Sprites as Setup leaves them: a screen rectangle with Y1 < Y2 inside the
  // frame, and a depth in front of the eye.
  for (const c of cases) {
    c.sprites = [];
    const frameWidth = c.render?.width ?? c.width, frameHeight = c.render?.height ?? c.height;
    const count = Math.floor(random() * 24);
    for (let k = 0; k < count; k++) {
      const a = Math.floor(random() * frameWidth), b = Math.floor(random() * frameWidth);
      const y = Math.floor(random() * (frameHeight - 1)), h = 1 + Math.floor(random() * Math.min(300, frameHeight - y - 1));
      c.sprites.push({ x1: Math.min(a, b), x2: Math.max(a, b) + 1, y1: y, y2: y + h, zBits: bits(8 + random() * 4000) });
    }
  }
  occlusion ??= createBspOcclusion(kernel, model, { surfaceTextureFlags,
    zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)) });
  const base = occlusionModelRequest(model, surfaceTextureFlags);
  const tangents = { ...TANGENTS };
  for (const c of cases) if (c.render) Object.assign(tangents, renderPassTangent(c.fov, c.render.width, 'validate-bsp-occlusion'));
  const request = { gameRoot: root, tangents, cases, model: tracker ? trackedModelRequest(occlusion, base, kernel.memory) : base };
  const oracle = JSON.parse(execFileSync(python, ['scripts/native-occlusion-oracle.py'],
    { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1 << 30 })).results;
  const flags = request.model.nodes.map(n => n.flags), times = new Array(model.zones.length).fill(0);
  const stats = { surfaces: 0, children: 0, zone0: 0 };
  try {
    for (const [i, c] of cases.entries()) {
      const o = oracle[i];
      const where = `${mapName} case ${i} ${JSON.stringify(c.location.map(v => +v.toFixed(1)))} ${c.rotation} ${c.width}x${c.height}` +
        (c.render ? ` render ${c.render.width}x${c.render.height}+${c.render.x}+${c.render.y}${c.masterControlWord ? ' in the pass' : ''}` : '');
      // The master frame from the camera: every field CreateMasterFrame made,
      // then the render pass's ComputeRenderSize.
      if (c.masterControlWord) vm.setPrecision(24);
      let master;
      try {
        master = occlusion.master({ location: c.location.map(Math.fround), rotation: c.rotation, width: c.width,
          height: c.height, fov: c.fov, render: c.render ? { width: c.render.width, height: c.render.height } : null });
      } finally { vm.setPrecision(64); }
      stats.pass = (stats.pass ?? 0) + Boolean(c.render);
      stats.clipped = (stats.clipped ?? 0) + Boolean(c.render && (c.render.width !== c.width || c.render.height !== c.height));
      assert.deepEqual([...master.fields].map(v => v >>> 0), [...o.frameBits, o.zoneNumber, ...o.uncoordsBits].map(v => v >>> 0), `${where}: master frame`);
      const words = [...master.frame];
      words[44] = c.frameCounter; words[45] = c.timeBits;
      words[46] = OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES | OCCLUSION_POINTS; words[47] = 0;
      const r = occlusion.run(words, c.sprites.map((sprite, key) => ({ key, ...sprite })));
      assert.deepEqual(r.sprites, o.sprites.map(entry => ({ key: entry.sprite, span: entry.span })), `${where}: Frame->Sprite`);
      for (let list = 0; list < 3; list++) {
        const want = o.draw[list].map(d => ({ iNode: d.iNode, iSurf: d.iSurf, iZone: d.iZone, polyFlags: d.polyFlags >>> 0,
          polys: d.polys.map(p => ({ iNode: p.iNode, points: p.points.map(t => [t[0], t[1], t[2], t[4], t[5], t[6], t[7]].map(v => v >>> 0)) })) }));
        const got = r.draw[list].map(d => ({ iNode: d.iNode, iSurf: d.iSurf, iZone: d.iZone, polyFlags: d.polyFlags,
          polys: d.polys.map(p => ({ iNode: p.iNode, points: p.points.map(t => [...t].map(v => v >>> 0)) })) }));
        assert.deepEqual(got, want, `${where}: draw list ${list}`);
      }
      assert.deepEqual(r.children.map(ch => ({ iSurf: ch.iSurf, zone: ch.zone, span: ch.span })),
        o.children.map(ch => ({ iSurf: ch.iSurf, zone: ch.iZone, span: ch.span })), `${where}: child frames`);
      assert.deepEqual([r.nodesDraw, r.polysDraw], o.counters, `${where}: NodesDraw/PolysDraw`);
      for (const [k, v] of Object.entries(o.nodeFlags)) flags[k] = v;
      for (const [k, v] of Object.entries(o.zoneTimes)) if (k < times.length) times[k] = v;
      let mismatch = -1;
      for (let k = 0; k < flags.length && mismatch < 0; k++) if (occlusion.nodeFlags(k) !== flags[k]) mismatch = k;
      assert.equal(mismatch, -1, `${where}: node ${mismatch} flags`);
      assert.deepEqual(times.map((_, k) => occlusion.zoneTime(k) >>> 0), times.map(t => t >>> 0), `${where}: zone times`);
      stats.surfaces += r.draw.reduce((n, l) => n + l.length, 0);
      stats.children += r.children.length;
      stats.zone0 += o.zoneNumber === 0;
      stats.sprites = (stats.sprites ?? 0) + c.sprites.length; stats.drawn = (stats.drawn ?? 0) + r.sprites.length;
      if (tracker) for (const list of r.draw) for (const entry of list) if (occlusion.tracker.surfOwner(entry.iSurf))
        stats.fragments = (stats.fragments ?? 0) + entry.polys.length;
    }
  } finally {
    occlusion.dispose();
  }
  const with_ = tracker ? ` with ${movers.length} tracked movers${tracker.moves ? ` (${tracker.moves.length} moved)` : ''}, ${fragmentNodes} fragment nodes,` : '';
  console.log(`${mapName}:${with_} ${cases.length} frames match (${stats.surfaces} draw lists${tracker ? `, ${stats.fragments ?? 0} mover polygons drawn` : ''}, ${stats.children} child requests, ${stats.zone0} zone-0 views, ${stats.drawn}/${stats.sprites} sprites drawn, ${stats.pass} through the render pass's ComputeRenderSize, ${stats.clipped} on a clipped rectangle)`);
}

// The Paris club entrance tunnel at spawn (the slow view that motivated the
// recovery: the frustum alone admits the club's mirrors and fog surfaces).
const tunnel = [32768, 40960, 0, 16384, 49152].map(yaw => ({ location: [2063, 273, 30], rotation: [0, yaw, 0], width: 1920, height: 1080, fov: 90 }));
await validate('10_Paris_Club', 40, 7, tunnel);
await validate('00_Training', 40, 11);
await validate('01_NYC_UNATCOIsland', 40, 13);
await validate('12_Vandenberg_Cmd', 24, 23);
// The moving brush tracker's fragments in the level (docs/brush-tracker.md):
// Training's doors closed and its first double door raised, the club's
// mirror movers turned, the Island's doors.
const raised = ['DeusExMover16', 'DeusExMover17'].map(name => ({ name, offset: [0, 0, 96] }));
await validate('00_Training', 16, 31, [], { tracker: {} });
await validate('00_Training', 8, 37, [], { tracker: { moves: raised } });
await validate('10_Paris_Club', 12, 41, [], { tracker: { moves: ['DeusExMover8', 'DeusExMover11'].map(name => ({ name, addRotation: [0, 6000, 0] })) } });
await validate('01_NYC_UNATCOIsland', 12, 43, [], { tracker: {} });
console.log(`validate-bsp-occlusion: ok (${renderPassTangentsMeasured()} render-pass appTan arguments measured on real x87)`);
