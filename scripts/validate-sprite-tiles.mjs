/** The original's sprite tile (docs/frame-projection.md "Sprites"), measured
 * under Unicorn: URender::DrawActorSprite (Render.dll 0x10b25080) ->
 * UCanvas::DrawIcon (Engine 0x10376640) -> UCanvas::DrawTile (0x10376160) ->
 * UD3DRenderDevice::DrawTile (D3DDrv 0x10005ba0), scripts/native-sprite-draw-oracle.py.
 *
 * Sprite actors on 00_Training, 01_NYC_UNATCOIsland and 10_Paris_Club (the
 * map's runtime particle items and synthetic ones around seeded cameras: in
 * the view, across its edges, at and behind the near plane), through the
 * unchanged FDynamicSprite constructor and Setup, OccludeBsp and every
 * mirror and sky child frame, then DrawActorSprite on each Frame->Sprite.
 *
 * Checks (the oracle's numbers are the authority):
 *   - every call chain is complete: one DrawIcon and one UCanvas::DrawTile
 *     per sprite, a D3DDrv DrawTile with four vertices exactly when the
 *     canvas' clip kept a rectangle;
 *   - DrawActorSprite's arguments follow from the sprite's Setup floats
 *     (ScreenX, ScreenY, Persp, Z): XL = (USize * Persp) * DrawScale, X =
 *     ScreenX - XL * 0.5 (docs/frame-projection.md), each rounded to
 *     binary32;
 *   - DrawIcon hands DrawTile the texture's size as the source rectangle;
 *   - the port (src/runtime/sprite-tile.mjs) reproduces, stage by stage, UCanvas::DrawTile's
 *     clipped rectangle and scaled source rectangle, SetTexture's UMult, VMult and slots, and
 *     the four vertices' X, Y, depth, RHW and texture coordinates, bit for bit;
 *   - the GLSL (src/viewer/sprite-tile-glsl.mjs) on the GPU does too.
 *
 *   node scripts/validate-sprite-tiles.mjs [--mutate (one bit of the port's first vertex flipped:
 *     the comparison must fail)] [--no-barrier (the GLSL without B(): reports how many differ)]
 *     [--angle gl|metal] */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { python } from './frame-projection-cases.mjs';
import { runGpuSprites } from './frame-projection-gpu-run.mjs';
import { spriteTileOracle } from './sprite-tile-cases.mjs';
import { deviceVertices, stageScale, spriteVertices } from '../src/runtime/sprite-tile.mjs';

if (!existsSync(python)) { console.log('SKIP validate-sprite-tiles: no native probe environment'); process.exit(0); }
const f = Math.fround;
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const num = word => (u32[0] = word >>> 0, f32[0]);
const bits = value => (f32[0] = value, u32[0]);

const RUNS = [
  ['00_Training', { seed: 3, count: 9, perCamera: 90 }],
  ['01_NYC_UNATCOIsland', { seed: 5, count: 8, aimed: false, perCamera: 90 }],
  ['10_Paris_Club', { seed: 7, count: 8, perCamera: 90 }],
];
const units = [];
const totals = { maps: [], childSprites: 0, frames: 0, children: 0, sprites: 0, drawn: 0, rejected: 0, checked: 0, interior: 0, left: 0, top: 0, right: 0, bottom: 0, whole: 0,
  nearPlane: 0, renderRect: 0, translucent: 0, vertices: 0 };

for (const [mapName, options] of RUNS) {
  const started = performance.now();
  const { cases, results, textures, records, uvScale } = await spriteTileOracle(mapName, options);
  let mapDrawn = 0;
  for (const [ci, result] of results.entries()) {
    const c = cases[ci];
    totals.renderRect += c.render ? 1 : 0;
    const frames = [{ index: 0, sprites: result.sprites }, ...(result.frames ?? []).map(frame => ({ index: frame.index, sprites: frame.sprites }))];
    // The canvas stays on the master frame while a child frame's sprites draw (docs/frame-projection.md "The canvas' frame"):
    // DrawTile clips to and D3DDrv offsets by the master's X, Y, XB, YB, FX, FY. Every frame's own are those.
    const sizes = new Set();
    for (const frame of frames) {
      totals.frames++; if (frame.index) totals.children++;
      for (const entry of frame.sprites) {
        const where = `${mapName} case ${ci} frame ${frame.index} sprite ${entry.sprite}`;
        const actor = c.sprites[entry.sprite].actor, texture = textures[actor.texture], tile = entry.draw;
        assert.ok(tile, `${where}: drawn`);
        totals.sprites++;
        const events = tile.events, names = events.map(e => e[0]);
        const count = name => names.filter(n => n === name).length;
        assert.equal(count('DrawIcon'), 1, `${where}: one DrawIcon (${names})`);
        assert.equal(count('CanvasDrawTile'), 1, `${where}: one UCanvas::DrawTile`);
        const icon = events.find(e => e[0] === 'DrawIcon')[1], canvas = events.find(e => e[0] === 'CanvasDrawTile')[1];
        // DrawActorSprite: Setup's floats in, the icon rectangle out.
        const [z, sx, sy, persp] = [entry.zBits, ...entry.screenBits].map(num);
        const scale = num(actor.drawScaleBits);
        const xl = f(f(texture.usize * persp) * scale), yl = f(f(texture.vsize * persp) * scale);
        const want = [f(sx - f(xl * 0.5)), f(sy - f(yl * 0.5)), xl, yl].map(bits);
        assert.deepEqual(icon.slice(1, 5), want, `${where}: DrawIcon's X, Y, XL, YL from Setup's ScreenX ${sx}, ScreenY ${sy}, Persp ${persp} and DrawScale ${scale}`);
        assert.equal(icon[6], entry.zBits >>> 0, `${where}: DrawIcon's Z is the sprite's`);
        assert.notEqual(icon[5], 0, `${where}: the sprite's span buffer`);
        assert.equal(tile.lastRenderTimeBits >>> 0, c.timeBits >>> 0, `${where}: LastRenderTime stamped with Level.TimeSeconds`);
        // DrawIcon: the whole texture as the source rectangle (U = V = 0, UL = USize, VL = VSize).
        assert.deepEqual(canvas.slice(1, 9), [...icon.slice(1, 5), 0, 0, bits(texture.usize), bits(texture.vsize)],
          `${where}: DrawTile's rectangle and source rectangle`);
        // The clip against [0, FX] x [0, FY] keeps or rejects the rectangle.
        const [width, height, xb, yb, fx, fy] = tile.sizeAndProj;
        sizes.add(JSON.stringify(tile.sizeAndProj.slice(0, 6)));
        if (frame.index) totals.childSprites++;
        const vbs = events.filter(e => e[0] === 'DrawPrimitiveVB'), device = events.find(e => e[0] === 'DeviceDrawTile');
        const [x, y] = [num(icon[1]), num(icon[2])];
        const kept = xl > 0 && yl > 0 && f(x + xl) > 0 && f(y + yl) > 0 && x < num(fx) && y < num(fy);
        assert.equal(Boolean(device), kept, `${where}: D3DDrv's DrawTile exactly when the clip keeps a rectangle (${x}, ${y}, ${xl}, ${yl} in ${num(fx)} x ${num(fy)})`);
        // The port: the same inputs through src/runtime/sprite-tile.mjs, stage by stage.
        const info = { usize: texture.usize, vsize: texture.vsize, infoUSize: texture.usize, infoVSize: texture.vsize,
          uScale: num(texture.scaleBits), vScale: num(texture.scaleBits) };
        assert.equal(num(fx), width, `${where}: FX is the frame's width`);
        assert.equal(num(fy), height, `${where}: FY is the frame's height`);
        const frameRef = { fx: num(fx), fy: num(fy), xb, yb }, depth = { zBias: num(tile.depth.zBias), zScale: num(tile.depth.zScale) };
        const ref = spriteVertices({ z, screenX: sx, screenY: sy, persp, drawScale: scale }, info, frameRef, depth);
        assert.equal(Boolean(ref), Boolean(device), `${where}: the port clips exactly when the original does`);
        // --mutate: one bit of the port's first vertex differs; the comparison must find it.
        if (ref && process.argv.includes('--mutate')) ref.vertices[0].x = f(ref.vertices[0].x * (1 + 2 ** -23));
        if (!device) { assert.equal(vbs.length, 0, `${where}: no vertices`); totals.rejected++; continue; }
        assert.deepEqual(device[1].slice(2, 10), [ref.tile.x, ref.tile.y, ref.tile.xl, ref.tile.yl, ref.tile.u, ref.tile.v, ref.tile.ul, ref.tile.vl].map(bits),
          `${where}: UCanvas::DrawTile's clipped and scaled rectangle ${JSON.stringify(ref.tile)} vs ${JSON.stringify(device[1].slice(2, 10).map(num))}`);
        // SetTexture's multipliers and slots (the oracle ran its own instructions), then D3DDrv's four vertices.
        const stage = stageScale(info), measured = uvScale[actor.texture];
        assert.deepEqual([stage.uMult, stage.vMult].map(bits), [measured.uMultBits, measured.vMultBits], `${where}: UMult, VMult`);
        assert.deepEqual([stage.uSlot, stage.vSlot], [measured.uSlot, measured.vSlot], `${where}: UIndex, VIndex`);
        const vertices = vbs[0][5];
        ref.vertices.forEach((want, k) => {
          const got = vertices[k], tc = [0, 0];
          tc[stage.uSlot] = want.u; tc[stage.vSlot] = want.v;
          assert.deepEqual([got[0], got[1], got[2], got[3], got[6], got[7]].map(w => w >>> 0), [want.x, want.y, want.z, want.rhw, tc[0], tc[1]].map(bits),
            `${where}: vertex ${k} ${JSON.stringify(want)} vs ${JSON.stringify([...got.slice(0, 4), ...got.slice(6, 8)].map(num))}`);
        });
        totals.checked += 4;
        // The same sprite through the GLSL (below): the original's vertices are what it must produce.
        units.push({ label: where, a: [z, sx, sy, persp], b: [texture.usize, texture.vsize, scale, num(texture.scaleBits)],
          c: [info.infoUSize, info.infoVSize], fxy: [frameRef.fx, frameRef.fy], frameRect: [width, height, xb, yb], depth: [depth.zBias, depth.zScale],
          expected: vertices.map(got => [got[0], got[1], got[2], got[3]].map(w => w >>> 0)),
          expectedUv: vertices.map(got => { const tc = [got[6], got[7]]; return [tc[stage.uSlot], tc[stage.vSlot]].map(w => w >>> 0); }),
          expectedRect: [device[1][2], device[1][3], device[1][4], device[1][5]].map(w => w >>> 0),
          expectedSrc: [device[1][6], device[1][7], device[1][8], device[1][9]].map(w => w >>> 0) });
        assert.equal(vbs.length, 1, `${where}: one DrawPrimitiveVB`);
        assert.equal(vbs[0][2], 0, `${where}: starts at vertex 0`);
        assert.equal(vbs[0][3], 4, `${where}: four vertices`);
        assert.equal(vbs[0][1], 6, `${where}: D3DPT_TRIANGLEFAN`);
        totals.drawn++; mapDrawn++; totals.vertices += 4;
        if (x < 0) totals.left++;
        if (y < 0) totals.top++;
        if (f(x + xl) > num(fx)) totals.right++;
        if (f(y + yl) > num(fy)) totals.bottom++;
        if (x < 0 && y < 0 && f(x + xl) > num(fx) && f(y + yl) > num(fy)) totals.whole++;
        if (x >= 0 && y >= 0 && f(x + xl) <= num(fx) && f(y + yl) <= num(fy)) totals.interior++;
        if (z < 4) totals.nearPlane++;
        if (actor.style === 3) totals.translucent++;
        void z; void width; void height; void xb; void yb;
      }
    }
    assert.ok(sizes.size <= 1, `${mapName} case ${ci}: every frame has the master frame's X, Y, XB, YB, FX, FY (${[...sizes]})`);
  }
  totals.maps.push(`${mapName} ${cases.length} cameras, ${records.length} runtime particle items, ${mapDrawn} tiles (${((performance.now() - started) / 1000).toFixed(0)} s)`);
}
// The GLSL (src/viewer/sprite-tile-glsl.mjs) on the GPU, headless Chromium: the same sprites, bit for bit.
{
  const angle = process.argv.includes('--angle') ? process.argv[process.argv.indexOf('--angle') + 1] : process.platform === 'darwin' ? 'metal' : 'gl';
  const runtime = await runGpuSprites(units, { angle, noBarrier: process.argv.includes('--no-barrier') });
  let differ = 0;
  for (const [i, unit] of units.entries()) {
    const r = runtime.results[i];
    const got = { kept: r.kept, rect: r.rect, src: r.src, xyzw: r.vertices.map(v => v.xyzw), uv: r.vertices.map(v => v.uv) };
    const want = { kept: true, rect: unit.expectedRect, src: unit.expectedSrc, xyzw: unit.expected, uv: unit.expectedUv };
    if (process.argv.includes('--no-barrier')) { if (JSON.stringify(got) !== JSON.stringify(want)) differ++; continue; }
    assert.deepEqual(got, want, `${unit.label}: GPU sprite tile`);
  }
  totals.gpu = process.argv.includes('--no-barrier') ? `without the barrier ${differ} of ${units.length} GPU sprites differ (${runtime.renderer})`
    : `${units.length} GPU sprites (${units.length * 4} vertices, the clipped rectangle and the scaled source too) equal the original's bit for bit (${runtime.renderer})`;
}
assert.ok(totals.children > 0 && totals.drawn > 200, 'the cases reach child frames and many tiles');
assert.ok(totals.interior > 100 && totals.left && totals.top && totals.right && totals.bottom && totals.whole && totals.nearPlane, 'the cases reach every clip branch');
console.log(`validate-sprite-tiles: ${totals.maps.join('; ')}; ${totals.frames} frames (${totals.children} child frames, ${totals.renderRect} cameras on a render rectangle), `
  + `${totals.sprites} Frame->Sprite sprites (${totals.childSprites} in child frames, whose X, Y, XB, YB, FX, FY are the master frame's, the frame the canvas holds) through DrawActorSprite -> DrawIcon -> UCanvas::DrawTile: ${totals.drawn} reach D3DDrv's DrawTile (${totals.vertices} vertices), `
  + `${totals.checked} vertices (position, depth, RHW, texture coordinates) equal the port bit for bit, ${totals.rejected} clipped away, ${totals.interior} inside the frame; clipped at left ${totals.left}, top ${totals.top}, right ${totals.right}, bottom ${totals.bottom}, all four ${totals.whole}; `
  + `${totals.nearPlane} within 4 units of the camera, ${totals.translucent} translucent; ${totals.gpu}; PASS`);
