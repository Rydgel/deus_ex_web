import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createMovingComposeKernel } from '../src/runtime/moving-compose-kernel.mjs';
import { colorTableEntry, fistp } from '../src/runtime/dynamic-lighting.mjs';
import { LightAtlas } from '../src/viewer/light-atlas.mjs';

// The Rust composition (moving.rs) against the JavaScript bodies it replaces: moving-lights.mjs addDirect (copied here, with the modulator's
// rule) and light-atlas.mjs update. The integrated comparisons are validate-moving-lights-incremental and ?movingCompose=verify.
const MAX = 127 / 255, f = Math.fround, TWO_52 = 4503599627370496;
const kernel = await loadScriptVmKernel();
let seed = 0x2545f491;
const rand = () => { seed = Math.imul(seed ^ seed >>> 15, 0x2c1b3c6d) + 0x297a2d39 | 0; return ((seed ^ seed >>> 13) >>> 0) / 4294967296; };
const int = n => Math.floor(rand() * n);

/** addDirect for one contribution, as moving-lights.mjs has it. */
function addDirect(pixels, width, entry, colour, factor) {
  const { rect, spatial } = entry, amounts = colour.steps.map(step => Float64Array.from({ length: 256 }, (_, byte) => colorTableEntry(step, byte) / 255));
  let index = 0, k = 0, written = 0;
  for (let v = rect.minV; v < rect.maxV; v++) {
    let i = (v * width + rect.minU) * 3;
    for (let u = rect.minU; u < rect.maxU; u++, index++, k++, i += 3) {
      let byte = spatial[k];
      if (factor && byte) {
        const value = f(factor[index & 0xff] * byte) - 0.5;
        byte = (value >= 0 && value < TWO_52 ? (value + TWO_52) - TWO_52 : value < 0 && value > -TWO_52 ? (value - TWO_52) + TWO_52 : fistp(value)) & 255;
      }
      if (!byte) continue;
      pixels[i] = Math.min(MAX, pixels[i] + amounts[0][byte]);
      pixels[i + 1] = Math.min(MAX, pixels[i + 1] + amounts[1][byte]);
      pixels[i + 2] = Math.min(MAX, pixels[i + 2] + amounts[2][byte]);
      written++;
    }
  }
  return written;
}

test('moving.rs composes light maps and converts atlas rectangles as addDirect and LightAtlas.update do', () => {
  const composer = createMovingComposeKernel(kernel.moving);
  const atlas = new LightAtlas(256);
  const frame = { factors: { 1: Float64Array.from({ length: 256 }, () => 0.95 + 0.05 * rand()), 2: Float64Array.from({ length: 256 }, () => 0.8 + 0.2 * rand()),
    3: Float64Array.from({ length: 256 }, () => 0.6 + 0.4 * rand()) }, frameIndex: 1 };
  let jobs = 0, texels = 0;
  for (let round = 0; round < 6; round++) {
    frame.frameIndex++;
    composer.begin();
    const cases = [];
    for (let n = 0; n < 12; n++) {
      const width = 1 + int(23), height = 1 + int(19);
      const staticPixels = Float32Array.from({ length: width * height * 3 }, () => f(int(round === 5 ? 256 : 128) / 255));
      const lightmap = { width, height, pixels: new Float32Array(staticPixels.length), staticPixels, uv: () => [0, 0] };
      atlas.add(lightmap);
      const entries = [];
      for (let c = 0; c < 1 + int(3); c++) {
        const minU = int(width), minV = int(height), maxU = minU + 1 + int(width - minU), maxV = minV + 1 + int(height - minV);
        const effect = int(4), spatial = Uint8Array.from({ length: (maxU - minU) * (maxV - minV) }, () => rand() < 0.4 ? 0 : 1 + int(255));
        if (rand() < 0.15) spatial.fill(0);
        const steps = [int(1 << 20), int(1 << 20), int(1 << 20)];
        const colour = { steps, modulate: effect ? () => 0 : null, token: `${n}.${c}` };
        entries.push({ rect: { minU, maxU, minV, maxV }, spatial, item: { colour, effect } });
      }
      cases.push({ lightmap, entries });
    }
    for (const effect of [1, 2, 3]) composer.modulation(effect, frame, frame.frameIndex);
    for (const { lightmap, entries } of cases) {
      const kept = composer.prepare(lightmap, entries, entry => entry.spatial);
      assert.ok(composer.eligible(kept));
      const { region } = kept, rect = atlas.rectOf(lightmap, region);
      composer.add(lightmap, kept, region, rect, null);
    }
    composer.run();
    cases.forEach(({ lightmap, entries, ...rest }, i) => {
      // The reference: restore the region, add every contribution in order, convert the region and its padding.
      const reference = Float32Array.from(lightmap.staticPixels);
      let written = 0;
      for (const entry of entries) written += addDirect(reference, lightmap.width, entry, entry.item.colour, entry.item.effect ? frame.factors[entry.item.effect] : null);
      assert.equal(composer.written(i), written, `round ${round} light map ${i}: texels written`);
      composer.copyBand(i);
      const { region } = composer.job(i).kept;
      const got = new Uint32Array(lightmap.pixels.buffer), want = new Uint32Array(reference.buffer);
      for (let v = region.minV; v < region.maxV; v++) for (let k = (v * lightmap.width + region.minU) * 3; k < (v * lightmap.width + region.maxU) * 3; k++)
        assert.equal(got[k], want[k], `round ${round} light map ${i}: float bits ${k}`);
      // The atlas bytes: the packed texels of the core, and update() on the reference floats.
      const tile = atlas.tiles.get(lightmap), page = tile.page;
      atlas.writePacked(lightmap, composer.job(i).rect, composer.words(), composer.packedAt(i));
      const mine = Uint8Array.from(page.pixels);
      lightmap.pixels.set(reference);
      atlas.update(lightmap, { partial: true, region });
      const index = (x, y) => ((tile.y + y) * atlas.size + tile.x + x) * 4;
      for (let y = -1; y <= lightmap.height; y++) for (let x = -1; x <= lightmap.width; x++) {
        const inside = x >= (region.minU ? region.minU : -1) && x <= (region.maxU < lightmap.width ? region.maxU - 1 : lightmap.width)
          && y >= (region.minV ? region.minV : -1) && y <= (region.maxV < lightmap.height ? region.maxV - 1 : lightmap.height);
        if (!inside) continue;
        for (let c = 0; c < 4; c++) assert.equal(mine[index(x, y) + c], page.pixels[index(x, y) + c], `round ${round} light map ${i}: atlas byte at ${x},${y},${c}`);
      }
      jobs++; texels += written;
    });
  }
  assert.ok(jobs >= 72 && texels > 500, `${jobs} jobs, ${texels} texels`);
  composer.dispose();
});

test('moving.rs colour amounts follow colorTableEntry for negative and large steps', () => {
  const composer = createMovingComposeKernel(kernel.moving);
  const atlas = new LightAtlas(64), staticPixels = new Float32Array(3).fill(f(10 / 255));
  for (const step of [0, 1, 255, 257, 65535, 65536, 1 << 20, (1 << 23) + 5, -1, -65536, 2 ** 31 - 1, -(2 ** 31)]) {
    composer.begin();
    const lightmap = { width: 1, height: 1, pixels: new Float32Array(3), staticPixels, uv: () => [0, 0] };
    atlas.add(lightmap);
    for (let byte = 1; byte < 256; byte += 17) {
      const entry = { rect: { minU: 0, maxU: 1, minV: 0, maxV: 1 }, spatial: Uint8Array.of(byte), item: { colour: { steps: [step, step, step], modulate: null }, effect: 0 } };
      composer.begin();
      const kept = composer.prepare(lightmap, [entry], e => e.spatial);
      composer.add(lightmap, kept, kept.region, atlas.rectOf(lightmap, kept.region), null);
      composer.run();
      composer.copyBand(0);
      const reference = Float32Array.from(staticPixels);
      addDirect(reference, 1, entry, entry.item.colour, null);
      assert.deepEqual(new Uint32Array(lightmap.pixels.buffer), new Uint32Array(reference.buffer), `step ${step} byte ${byte}`);
    }
  }
  composer.dispose();
});
