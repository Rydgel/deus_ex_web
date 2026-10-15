/** The original's light-corona tile (docs/coronas.md "On the tile chain", docs/frame-projection.md "Sprites"),
 * measured under Unicorn: DrawFrame's corona draw loop (Render.dll 0x10b1b745..0x10b1bafc) -> UCanvas::DrawIcon
 * (Engine 0x10376640) -> UCanvas::DrawTile (0x10376160) -> UD3DRenderDevice::DrawTile (D3DDrv 0x10005ba0),
 * scripts/native-sprite-draw-oracle.py with `coronas`.
 *
 * Lights placed around seeded cameras on 00_Training, 01_NYC_UNATCOIsland and 10_Paris_Club (in the view,
 * across its edges, at and behind the near plane; the maps' own corona skins, Effects 127 and 129, and
 * other texture sizes; DrawScale from a few pixels to far larger than the frame; any hue, saturation and
 * fade brightness) fill the corona cache; the unchanged loop reads the frame OccludeBsp read (the
 * unchanged CreateMasterFrame and ComputeRenderSize on cameras with and without a render rectangle),
 * transforms and projects each light and calls the canvas.
 *
 * Checks (the oracle's numbers are the authority):
 *   - the loop reaches DrawIcon for exactly the lights the port (coronaIcon) draws, in cache order, with the
 *     port's X, Y, size, size, colour and PolyFlags 0x104, and Z 1.0 (the Z that makes the vertex depth
 *     `1 * _43 + _33` exactly 0);
 *   - UCanvas::DrawTile receives that rectangle and the texture's size as its source rectangle, reaches
 *     D3DDrv's DrawTile exactly when the clip keeps a rectangle, and the port (src/runtime/sprite-tile.mjs
 *     iconVertices) reproduces its clipped and scaled rectangle, SetTexture's multipliers and slots and
 *     the four vertices (X, Y, depth, RHW, texture coordinates), bit for bit;
 *   - the GLSL (src/viewer/sprite-tile-glsl.mjs fpCanvasTile and fpSpriteVertex) on the GPU gives the same
 *     vertices, clipped rectangle and source rectangle.
 *
 *   node scripts/validate-corona-tiles.mjs [--mutate (one bit of the port's first vertex flipped: the comparison
 *     must fail)] [--no-barrier (the GLSL without B(): reports how many differ)] [--angle gl|metal] */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { python } from './frame-projection-cases.mjs';
import { runGpuSprites } from './frame-projection-gpu-run.mjs';
import { spriteTileOracle } from './sprite-tile-cases.mjs';
import { iconVertices, stageScale } from '../src/runtime/sprite-tile.mjs';
import { coronaFrame, coronaIcon } from '../src/runtime/coronas.mjs';
import { coordsTransform } from '../src/runtime/volumetric-fog.mjs';

if (!existsSync(python)) { console.log('SKIP validate-corona-tiles: no native probe environment'); process.exit(0); }
const f = Math.fround;
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const num = word => (u32[0] = word >>> 0, f32[0]);
const bits = value => (f32[0] = value, u32[0]);

const RUNS = [
  ['00_Training', { seed: 21, count: 9, perCamera: 2, coronas: 28 }],
  ['01_NYC_UNATCOIsland', { seed: 22, count: 8, aimed: false, perCamera: 2, coronas: 28 }],
  ['10_Paris_Club', { seed: 23, count: 8, perCamera: 2, coronas: 28 }],
];
const units = [];
const totals = { maps: [], cases: 0, lights: 0, behind: 0, drawn: 0, rejected: 0, checked: 0, interior: 0, left: 0, top: 0, right: 0, bottom: 0, whole: 0,
  renderRect: 0, vertices: 0, skins: 0, tall: 0 };

for (const [mapName, options] of RUNS) {
  const started = performance.now();
  const { cases, results, lights, textures, uvScale } = await spriteTileOracle(mapName, options);
  let mapDrawn = 0;
  for (const [ci, result] of results.entries()) {
    const c = cases[ci], where0 = `${mapName} case ${ci}`;
    totals.cases++; totals.renderRect += c.render ? 1 : 0;
    // The frame the loop read: the master frame, as coronaFrame maps its words (coronas.mjs).
    const header = result.coronas?.[0]?.sizeAndProj;
    const bitsOf = result.frameBits, words = new Array(21).fill(0);
    for (let k = 0; k < 12; k++) words[k] = bitsOf[k];
    words[12] = (c.render?.width ?? c.width) | 0; words[16] = bitsOf[16]; words[17] = bitsOf[17]; words[20] = bitsOf[21];
    if (header) {
      assert.equal(header[0], words[12], `${where0}: X is the render rectangle's width`);
      assert.deepEqual([header[8], header[9], header[13]], [words[16], words[17], words[20]], `${where0}: FX2, FY2, Proj.Z`);
    }
    const { coords, frame } = coronaFrame(words);
    // The lights the port draws, in cache order (slot k holds light k).
    const expected = [];
    lights[ci].forEach((light, k) => {
      totals.lights++;
      const icon = coronaIcon({ brightness: light.brightness }, coordsTransform(light.location, coords), frame,
        { hue: light.hue, saturation: light.saturation, drawScale: light.drawScale });
      if (!icon) { totals.behind++; return; }
      expected.push({ light, k, icon });
    });
    const records = result.coronas ?? [];
    assert.equal(records.length, expected.length, `${where0}: the loop reaches DrawIcon for the lights the port draws (${records.length} vs ${expected.length})`);
    expected.forEach(({ light, k, icon }, n) => {
      const where = `${where0} light ${k}`, tile = records[n], texture = textures[light.texture];
      const events = tile.events, names = events.map(e => e[0]);
      const count = name => names.filter(e => e === name).length;
      assert.equal(count('DrawIcon'), 1, `${where}: one DrawIcon (${names})`);
      assert.equal(count('CanvasDrawTile'), 1, `${where}: one UCanvas::DrawTile`);
      const call = events.find(e => e[0] === 'DrawIcon')[1], canvas = events.find(e => e[0] === 'CanvasDrawTile')[1];
      // DrawFrame's call: Canvas.DrawIcon(Skin, X, Y, size, size, Span 0, Z 1.0, brightness * colour, fog 0, 0x104).
      assert.deepEqual(call.slice(1, 7), [icon.x, icon.y, icon.size, icon.size].map(bits).concat([0, bits(1)]), `${where}: DrawIcon's X, Y, XL, YL, Span and Z`);
      assert.deepEqual(call.slice(7, 10), icon.color.map(bits), `${where}: DrawIcon's colour`);
      assert.equal(call[15], icon.polyFlags, `${where}: PolyFlags`);
      assert.deepEqual(canvas.slice(1, 9), [...call.slice(1, 5), 0, 0, bits(texture.usize), bits(texture.vsize)], `${where}: DrawTile's rectangle and source rectangle`);
      // The clip against [0, FX] x [0, FY] keeps or rejects the rectangle.
      const [width, height, xb, yb, fx, fy] = tile.sizeAndProj;
      const vbs = events.filter(e => e[0] === 'DrawPrimitiveVB'), device = events.find(e => e[0] === 'DeviceDrawTile');
      const x = icon.x, y = icon.y, size = icon.size;
      const kept = size > 0 && f(x + size) > 0 && f(y + size) > 0 && x < num(fx) && y < num(fy);
      assert.equal(Boolean(device), kept, `${where}: D3DDrv's DrawTile exactly when the clip keeps a rectangle (${x}, ${y}, ${size} in ${num(fx)} x ${num(fy)})`);
      const info = { usize: texture.usize, vsize: texture.vsize, infoUSize: texture.usize, infoVSize: texture.vsize,
        uScale: num(texture.scaleBits), vScale: num(texture.scaleBits) };
      const frameRef = { fx: num(fx), fy: num(fy), xb, yb }, depth = { zBias: num(tile.depth.zBias), zScale: num(tile.depth.zScale) };
      const ref = iconVertices({ x, y, xl: size, yl: size }, 1, info, frameRef, depth);
      assert.equal(Boolean(ref), Boolean(device), `${where}: the port clips exactly when the original does`);
      if (ref && process.argv.includes('--mutate')) ref.vertices[0].x = f(ref.vertices[0].x * (1 + 2 ** -23));
      if (!device) { assert.equal(vbs.length, 0, `${where}: no vertices`); totals.rejected++; return; }
      assert.deepEqual(device[1].slice(2, 10), [ref.tile.x, ref.tile.y, ref.tile.xl, ref.tile.yl, ref.tile.u, ref.tile.v, ref.tile.ul, ref.tile.vl].map(bits),
        `${where}: UCanvas::DrawTile's clipped and scaled rectangle ${JSON.stringify(ref.tile)} vs ${JSON.stringify(device[1].slice(2, 10).map(num))}`);
      const stage = stageScale(info), measured = uvScale[light.texture];
      assert.deepEqual([stage.uMult, stage.vMult].map(bits), [measured.uMultBits, measured.vMultBits], `${where}: UMult, VMult`);
      assert.deepEqual([stage.uSlot, stage.vSlot], [measured.uSlot, measured.vSlot], `${where}: UIndex, VIndex`);
      assert.equal(vbs.length, 1, `${where}: one DrawPrimitiveVB`);
      assert.equal(vbs[0][3], 4, `${where}: four vertices`);
      assert.equal(vbs[0][1], 6, `${where}: D3DPT_TRIANGLEFAN`);
      const vertices = vbs[0][5];
      ref.vertices.forEach((want, v) => {
        const got = vertices[v], tc = [0, 0];
        tc[stage.uSlot] = want.u; tc[stage.vSlot] = want.v;
        assert.deepEqual([got[0], got[1], got[2], got[3], got[6], got[7]].map(w => w >>> 0), [want.x, want.y, want.z, want.rhw, tc[0], tc[1]].map(bits),
          `${where}: vertex ${v} ${JSON.stringify(want)} vs ${JSON.stringify([...got.slice(0, 4), ...got.slice(6, 8)].map(num))}`);
        // Z 1.0: the vertex depth is exactly 0 and RHW exactly 1 (the tile passes every depth test).
        assert.equal(got[2] >>> 0, 0, `${where}: vertex ${v} depth is 0`);
        assert.equal(got[3] >>> 0, bits(1), `${where}: vertex ${v} RHW is 1`);
      });
      totals.checked += 4;
      units.push({ label: where, a: [1, 0, 0, 0], b: [texture.usize, texture.vsize, 1, num(texture.scaleBits)], icon: [x, y, size, size].map(f),
        c: [info.infoUSize, info.infoVSize], fxy: [frameRef.fx, frameRef.fy], frameRect: [width, height, xb, yb], depth: [depth.zBias, depth.zScale],
        expected: vertices.map(got => [got[0], got[1], got[2], got[3]].map(w => w >>> 0)),
        expectedUv: vertices.map(got => { const tc = [got[6], got[7]]; return [tc[stage.uSlot], tc[stage.vSlot]].map(w => w >>> 0); }),
        expectedRect: [device[1][2], device[1][3], device[1][4], device[1][5]].map(w => w >>> 0),
        expectedSrc: [device[1][6], device[1][7], device[1][8], device[1][9]].map(w => w >>> 0) });
      totals.drawn++; mapDrawn++; totals.vertices += 4;
      if (x < 0) totals.left++;
      if (y < 0) totals.top++;
      if (f(x + size) > num(fx)) totals.right++;
      if (f(y + size) > num(fy)) totals.bottom++;
      if (x < 0 && y < 0 && f(x + size) > num(fx) && f(y + size) > num(fy)) totals.whole++;
      if (x >= 0 && y >= 0 && f(x + size) <= num(fx) && f(y + size) <= num(fy)) totals.interior++;
      if (texture.key.startsWith('Effects:')) totals.skins++;
      if (texture.vsize > texture.usize) totals.tall++;
    });
  }
  totals.maps.push(`${mapName} ${cases.length} cameras, ${mapDrawn} tiles (${((performance.now() - started) / 1000).toFixed(0)} s)`);
}
// The GLSL (src/viewer/sprite-tile-glsl.mjs fpCanvasTile) on the GPU, headless Chromium: the same coronas, bit for bit.
{
  const angle = process.argv.includes('--angle') ? process.argv[process.argv.indexOf('--angle') + 1] : process.platform === 'darwin' ? 'metal' : 'gl';
  const runtime = await runGpuSprites(units, { angle, noBarrier: process.argv.includes('--no-barrier') });
  let differ = 0;
  for (const [i, unit] of units.entries()) {
    const r = runtime.results[i];
    const got = { kept: r.kept, rect: r.rect, src: r.src, xyzw: r.vertices.map(v => v.xyzw), uv: r.vertices.map(v => v.uv) };
    const want = { kept: true, rect: unit.expectedRect, src: unit.expectedSrc, xyzw: unit.expected, uv: unit.expectedUv };
    if (process.argv.includes('--no-barrier')) { if (JSON.stringify(got) !== JSON.stringify(want)) differ++; continue; }
    assert.deepEqual(got, want, `${unit.label}: GPU corona tile`);
  }
  totals.gpu = process.argv.includes('--no-barrier') ? `without the barrier ${differ} of ${units.length} GPU coronas differ (${runtime.renderer})`
    : `${units.length} GPU coronas (${units.length * 4} vertices, the clipped rectangle and the scaled source too) equal the original's bit for bit (${runtime.renderer})`;
}
assert.ok(totals.drawn > 150 && totals.behind > 10, 'the cases draw many coronas and put some behind the eye');
assert.ok(totals.interior > 50 && totals.left && totals.top && totals.right && totals.bottom && totals.whole, 'the cases reach every clip branch');
assert.ok(totals.skins > 50 && totals.tall > 5, 'the cases use the maps\' corona skins and tall textures');
console.log(`validate-corona-tiles: ${totals.maps.join('; ')}; ${totals.cases} frames (${totals.renderRect} cameras on a render rectangle), ${totals.lights} lights in the cache, `
  + `${totals.behind} behind the eye (no DrawIcon), ${totals.drawn + totals.rejected} through DrawFrame's loop -> DrawIcon -> UCanvas::DrawTile: ${totals.drawn} reach D3DDrv's DrawTile (${totals.vertices} vertices), `
  + `${totals.checked} vertices (position, depth, RHW, texture coordinates) equal the port bit for bit, ${totals.rejected} clipped away, ${totals.interior} inside the frame; clipped at left ${totals.left}, top ${totals.top}, right ${totals.right}, bottom ${totals.bottom}, all four ${totals.whole}; `
  + `${totals.skins} with the maps' corona skins, ${totals.tall} taller than wide; ${totals.gpu}; PASS`);
