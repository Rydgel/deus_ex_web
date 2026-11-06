/** The moving brush tracker's GMem scratch arena (native/script-vm/src/tracker.rs `SCRATCH_TOP`, docs/brush-tracker.md "The scratch arena").
 *
 * The arena's top was never pointed at the host's scratch block, so the FPoly copies and fragments of a rebuild went to the bottom of the
 * module's memory, past the shadow stack and over its statics when a mover fragmented enough: 06_HongKong_Storage's BreakableGlass0
 * overwrote 2,138 entries of the rotation sine table (the next rotated mover's vertices came out at x = -10,667, yaw 3072) and left three
 * fragment nodes (10829, 10830, 10836) with NaN planes. A Play session placed in the Storage then stopped at the first sound or
 * perception line through them, `Nonfinite FastLineCheck plane distance is unsupported` (the 2026-11-06 slow-spot census).
 *
 * For every map with movers this builds the tracker as sim-host does (every mover at its placement, Update(NULL) at the game thread's
 * precision) and checks that construction succeeds, leaves the kernel's sine table as the host uploaded it, and leaves no tracker node with
 * a non-finite plane. The original's equality is validate-brush-tracker's case `storage-nonfinite-fragments` (the Unicorn oracle, field for
 * field including every polygon FPoly::Transform returned). Before the fix: 06_HongKong_Storage failed (2,138 table entries, 3 nodes);
 * the other 83 maps with movers passed.
 *
 *   node scripts/validate-brush-tracker-scratch.mjs [--maps a,b] */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion, texturePolyFlags } from '../src/runtime/bsp-occlusion.mjs';
import { surfaceTextureFlags as textureFlagsOf } from './occlusion-request.mjs';
import { collectTrackerMovers, trackerMoverSpec, trackerTextureFlags } from '../src/runtime/brush-tracker.mjs';
import { readTexture } from '../src/unreal/textures.mjs';
import { rotationSineTable } from '../src/runtime/coords.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const game = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(game, directory))) files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(game, directory, name)) });
const assets = new AssetStore(files), kernel = (await loadScriptVmKernel()).occlusion;
const sine = rotationSineTable(), f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bits = v => (f32[0] = v, u32[0]);
// The table's address in the kernel's memory: the kernel does not export it, the host's upload is found by its first entries.
let sineAt = -1;
{
  const mem = new Uint32Array(kernel.memory.buffer), a = bits(sine[1]), b = bits(sine[2]), c = bits(sine[3]);
  for (let i = 0; i < mem.length - 3; i++) if (mem[i] === a && mem[i + 1] === b && mem[i + 2] === c) { sineAt = i - 1; break; }
}
assert.ok(sineAt >= 0, 'the sine table is in the kernel memory');
const maps = option('maps', null)?.split(',') ?? (await readdir(path.join(game, 'Maps'))).filter(n => /\.dx$/i.test(n)).map(n => n.replace(/\.dx$/i, '')).sort();
let checked = 0, nodes = 0;
for (const mapName of maps) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const movers = await collectTrackerMovers(assets, asset, map);
  if (!movers.length) continue;
  const surfaceTextureFlags = await textureFlagsOf(assets, asset, model);
  await trackerTextureFlags(assets, asset, movers, object => texturePolyFlags(readTexture(object.asset, object.index).values));
  const specs = movers.map((m, i) => trackerMoverSpec(m, i, { hidden: m.values.bHidden, location: m.values.Location ?? [0, 0, 0],
    rotation: m.values.Rotation ?? [0, 0, 0], prePivot: m.values.PrePivot ?? [0, 0, 0] }));
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags, zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)), tracker: { movers: specs } });
  try {
    assert.equal(occlusion.tracker.construct({ pc64: true }), 0, `${mapName}: tracker construction`);
    const mem = new Uint32Array(kernel.memory.buffer);
    let changed = 0;
    for (let i = 0; i < sine.length; i++) if (mem[sineAt + i] !== bits(sine[i])) changed++;
    assert.equal(changed, 0, `${mapName}: the sine table is intact after construction (${changed} entries changed)`);
    const live = occlusion.lineNodes(), floats = new Float32Array(live.memory.buffer), bad = [];
    for (let i = 0; i < live.count; i++) {
      const o = (live.at >>> 2) + 16 * i;
      if (!(Number.isFinite(floats[o]) && Number.isFinite(floats[o + 1]) && Number.isFinite(floats[o + 2]) && Number.isFinite(floats[o + 3]))) bad.push(i);
    }
    assert.deepEqual(bad, [], `${mapName}: tracker nodes with a non-finite plane`);
    nodes += live.count;
  } finally { occlusion.dispose(); }
  checked++;
}
console.log(`brush tracker scratch: ${checked} maps with movers, ${nodes} nodes, sine table intact, every plane finite: PASS`);
