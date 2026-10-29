// UModel::FastLineCheck over Level->Model as the moving brush tracker holds it, Play against Engine.dll
// (docs/fast-line-check.md "Over the tracked model", docs/brush-tracker.md "Line checks").
//
// Each map's tracker is built as sim-host.mjs builds it (every mover at its placement, the constructor's Update(NULL) at PC64),
// and Play's fastLineCheck runs the production path: the level model carries `trackedLineNodes()` and the check reads the
// node block in the kernel's memory. The original FastLineCheck (Engine.dll 0x103f3280, native-fast-line-check-oracle.py)
// runs under Unicorn on every node of the same tracked model. Cases: the line of the Underworld capture `sndm` at tick 210
// (the player to GlassFragment9, which the original attenuated as blocked: BreakableGlass0's fragments stand between),
// lines through every mover in random directions, and random lines between actor placements; the same lines over the static
// model run through the static path, and the oracle over the static nodes.
//
//   node scripts/validate-fast-line-check-tracked.mjs [--maps a,b] [--lines N]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion, texturePolyFlags } from '../src/runtime/bsp-occlusion.mjs';
import { surfaceTextureFlags as textureFlagsOf } from './occlusion-request.mjs';
import { collectTrackerMovers, trackerMoverSpec, trackerTextureFlags, trackedModel } from '../src/runtime/brush-tracker.mjs';
import { readTexture } from '../src/unreal/textures.mjs';
import { fastLineCheck } from '../src/runtime/fast-line-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const maps = option('maps', '06_HongKong_WanChai_Underworld,00_Training,01_NYC_UNATCOIsland').split(',');
const randomLines = Number(option('lines', 400));
const python = process.env.NATIVE_PROBE_PYTHON ?? path.join(root, '.cache/native-probe-env/bin/python');
const work = path.join(root, '.cache/fast-line-check-tracked');
mkdirSync(work, { recursive: true });
const game = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(game, directory))) files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(game, directory, name)) });
const assets = new AssetStore(files), kernel = (await loadScriptVmKernel()).occlusion;
const f32 = Math.fround, view = new DataView(new ArrayBuffer(4));
const bitsOf = x => { view.setFloat32(0, x); return view.getUint32(0); };
// The capture's line (.work/live-acceptance/06_HongKong_WanChai_Underworld/original-trace-sndm.jsonl{,.calls.jsonl}, tick 210): the player's
// Location after the tick and GlassFragment9's Location in its Galaxy PlaySound; the original's ClientHearSound got 70 of 200 (x 0.35).
const CAPTURE = { '06_HongKong_WanChai_Underworld': [{ label: 'sndm u210 player -> GlassFragment9', first: [-1170.97461, -1123.96045, -336.200012],
  second: [-1203.3828125, -2056.0400390625, -310.1609802246094], original: 0 }] };

function oracle(name, model, cases) {
  const modelPath = path.join(work, `${name}-model.json`), casesPath = path.join(work, `${name}-cases.json`);
  writeFileSync(modelPath, JSON.stringify({ rootOutside: model.rootOutside, leafHulls: Array.from(model.leafHulls),
    nodes: model.nodes.map(n => ({ ...n, planeBits: n.plane.map(bitsOf) })) }));
  writeFileSync(casesPath, JSON.stringify(cases.map(c => ({ firstBits: c.first.map(bitsOf), secondBits: c.second.map(bitsOf) }))));
  const out = execFileSync(python, ['-I', path.join(root, 'scripts/native-fast-line-check-oracle.py'), game, modelPath, casesPath],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  return JSON.parse(out).results;
}

let seed = 0x5eed1234;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const direction = () => { const z = 2 * random() - 1, t = 2 * Math.PI * random(), r = Math.sqrt(1 - z * z); return [r * Math.cos(t), r * Math.sin(t), z]; };
let total = 0, blockedByMovers = 0;
for (const mapName of maps) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const surfaceTextureFlags = await textureFlagsOf(assets, asset, model);
  const movers = await collectTrackerMovers(assets, asset, map);
  await trackerTextureFlags(assets, asset, movers, object => texturePolyFlags(readTexture(object.asset, object.index).values));
  const specs = movers.map((m, i) => trackerMoverSpec(m, i, { hidden: m.values.bHidden, location: m.values.Location ?? [0, 0, 0],
    rotation: m.values.Rotation ?? [0, 0, 0], prePivot: m.values.PrePivot ?? [0, 0, 0] }));
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags, zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)), tracker: { movers: specs } });
  assert.equal(occlusion.tracker.construct({ pc64: true }), 0, `${mapName}: tracker construction`);
  // The production path: a level model whose trackedLineNodes() gives the live block (sim-host.mjs).
  const live = { ...model };
  Object.defineProperty(live, 'trackedLineNodes', { value: () => occlusion.lineNodes() });
  const tracked = trackedModel(occlusion, model, kernel.memory);
  const cases = [...(CAPTURE[mapName] ?? [])];
  for (const m of movers) {
    const at = m.values.Location ?? [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const d = direction(), r = 64 + 448 * random();
      cases.push({ label: `through ${m.name}`, first: at.map((x, i) => f32(x + d[i] * r)), second: at.map((x, i) => f32(x - d[i] * r)) });
    }
  }
  const spots = map.actors.map(a => a.values?.Location).filter(Boolean);
  for (let k = 0; k < randomLines; k++) {
    const a = spots[Math.floor(random() * spots.length)], b = spots[Math.floor(random() * spots.length)];
    cases.push({ label: 'between placements', first: a.map(f32), second: b.map(f32) });
  }
  const want = oracle(`${mapName}-tracked`, tracked, cases), wantStatic = oracle(`${mapName}-static`, model, cases);
  let differ = 0, moverBlocked = 0;
  cases.forEach((c, i) => {
    const play = Number(fastLineCheck(live, c.first, c.second)), playStatic = Number(fastLineCheck(model, c.first, c.second));
    if (c.original !== undefined) assert.equal(want[i], c.original, `${mapName} ${c.label}: the oracle over the tracked model gives the capture's answer`);
    if (play !== want[i] || playStatic !== wantStatic[i]) {
      differ++;
      if (differ <= 5) console.log(`  differs: ${c.label} ${JSON.stringify(c.first)} -> ${JSON.stringify(c.second)}: tracked play ${play} original ${want[i]}, static play ${playStatic} original ${wantStatic[i]}`);
    }
    if (want[i] === 0 && wantStatic[i] === 1) moverBlocked++;
  });
  console.log(`${mapName}: ${movers.length} movers, nodes ${model.nodes.length} -> ${tracked.nodes.length}; ${cases.length} lines, `
    + `${cases.length - differ} equal over the tracked and the static model; ${moverBlocked} blocked only by a mover's fragments`);
  assert.equal(differ, 0, `${mapName}: Play's FastLineCheck equals Engine.dll's`);
  assert.ok(moverBlocked > 0, `${mapName}: the cases reach a line that only a mover blocks`);
  total += cases.length; blockedByMovers += moverBlocked;
  occlusion.dispose();
}
console.log(`ok: ${total} lines on ${maps.length} maps equal to Engine.dll's FastLineCheck over the tracked and the static model (${blockedByMovers} blocked only by movers)`);
