/** Shared by validate-moving-light-effects(-play): Play's composed moving
 * light maps as plain frame data, native-dynamic-light-oracle.py
 * `movingFrames` over the same inputs, and the comparison (docs/
 * dynamic-lighting.md "Time-varying moving lights").
 *
 * A frame is `{time, A, W, lights, records}` (float words as u32 bits):
 * - `lights`: every light of the frame in light order, with its fields and
 *   the contributions Play composed (`facet`, `grid` for the oracle; `js`:
 *   Play's rectangle, radius constants, incidence and spatial bytes);
 * - `records`: each composed light map's `pixels` and `staticPixels`
 *   (Float32Array) and its contributions in composition order, as
 *   [light index, contribution index] pairs. */
import { execFileSync } from 'node:child_process';
import { rotationSineTable } from '../src/runtime/coords.mjs';

const io = new DataView(new ArrayBuffer(4));
export const u32 = value => { io.setFloat32(0, value, true); return io.getUint32(0, true); };
const f = Math.fround;

/** A moving-lights.mjs contribution entry of `record` as frame data. */
export function contributionData(record, entry) {
  const offset = record.movingOffset ?? [0, 0, 0], facet = record.movingGeometry.facet;
  return {
    facet: { origin: facet.origin.map((v, i) => f(v + offset[i])).map(u32), axisU: facet.axisU.map(u32), axisV: facet.axisV.map(u32),
      normal: facet.normal.map(u32), pan: facet.pan.map(u32), scale: facet.scale.map(u32), clamp: facet.clamp },
    grid: { start: entry.grid.start.map(u32), stepU: entry.grid.stepU.map(u32), stepV: entry.grid.stepV.map(u32) },
    js: { rect: [entry.rect.minU, entry.rect.maxU, entry.rect.minV, entry.rect.maxV],
      constants: [entry.item.constants.radius, entry.item.constants.rradius, entry.item.constants.rr2].map(u32),
      incidence: entry.incidence === null ? null : u32(entry.incidence),
      spatial: entry.spatial ? Buffer.from(entry.spatial).toString('hex') : null },
  };
}

/** A light (game.movingLights() shape) as the oracle's light fields. */
export function lightData(light, contributions) {
  const v = light.values;
  return { name: light.name, location: light.location.map(f).map(u32), type: v.LightType, effect: v.LightEffect ?? 0,
    brightness: v.LightBrightness, hue: v.LightHue ?? 0, saturation: v.LightSaturation ?? 0, radius: v.LightRadius,
    period: v.LightPeriod ?? 0, phase: v.LightPhase ?? 0, cone: v.LightCone ?? 0, rotation: v.Rotation ?? [0, 0, 0],
    flickerKey: light.flickerKey ?? 0, contributions };
}

/** The frame data of a composed world frame: `lights` in light order and
 * `records` the composed light maps (moving-lights.mjs records with their
 * `moving` entries); `itemOf(light)` finds a light's contribution item. */
export function frameData({ time, A, W, lights, records }) {
  const slots = new Map();
  const out = { time: u32(time), A: [...A].map(u32), W: [...W].map(u32), lights: [], records: [] };
  lights.forEach((light, li) => {
    const data = lightData(light, []);
    out.lights.push(data);
    if (!slots.has(light.name)) slots.set(light.name, li);
  });
  for (const record of records) {
    const pairs = [];
    for (const entry of record.moving) {
      const li = slots.get(entry.item.name);
      if (li === undefined) throw new Error(`moving-light-chain: an entry of ${record.surfaceIndex} has no light`);
      pairs.push([li, out.lights[li].contributions.length]);
      out.lights[li].contributions.push(contributionData(record, entry));
    }
    out.records.push({ surfaceIndex: record.surfaceIndex, width: record.width, pixels: Float32Array.from(record.pixels),
      staticPixels: Float32Array.from(record.staticPixels), pairs });
  }
  return out;
}

/** Run the oracle over successive frames (one strobe state chained through
 * them). */
export function runChain(root, { levelBrightness, frames, strobe = [0, 0] }) {
  const input = { movingFrames: [{ levelBrightness: u32(levelBrightness), sines: [...rotationSineTable()].map(u32), strobe,
    frames: frames.map(({ time, A, W, lights }) => ({ time, A, W, lights })) }] };
  return JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
    ['scripts/native-dynamic-light-oracle.py', root], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 30 })).movingFrames[0];
}

/** Compare one frame with the oracle's: per contribution the rectangle,
 * radius constants, incidence and spatial bytes; per light map its static
 * copy plus the original's colour entries, added as moving-lights.mjs adds
 * them (`min(127/255, texel + entry/255)` per channel, in order). */
export function checkFrame(frame, original, assert, stats, where = '') {
  frame.lights.forEach((light, li) => {
    const result = original.lights[li], pair = `${light.type}/${light.effect}`;
    const row = stats.byPair[pair] ??= { contributions: 0, lit: 0 };
    stats.lights++;
    light.contributions.forEach((contribution, ci) => {
      const out = result.contributions[ci], at = `${where}${light.name} contribution ${ci}`, js = contribution.js;
      stats.contributions++; row.contributions++;
      assert.deepEqual(js.rect, out.rect, `${at}: rectangle`);
      assert.deepEqual(js.constants, out.constants, `${at}: radius constants`);
      if (js.incidence !== null) assert.equal(js.incidence, out.incidence, `${at}: incidence`);
      if (!out.spatial) return;
      assert.equal(js.spatial, out.spatial, `${at}: spatial bytes`);
      for (const word of out.merged) { stats.texels++; if (word & 0xffffff) { stats.lit++; row.lit++; } }
    });
  });
  const MAX = 127 / 255;
  for (const record of frame.records) {
    const expected = Float32Array.from(record.staticPixels);
    for (const [li, ci] of record.pairs) {
      const out = original.lights[li].contributions[ci];
      if (!out.merged) continue;
      const [minU, maxU, minV, maxV] = out.rect;
      for (let v = minV, k = 0; v < maxV; v++) for (let u = minU; u < maxU; u++, k++) {
        const word = out.merged[k];
        if (!(word & 0xffffff)) continue;
        const at = (v * record.width + u) * 3;
        expected[at] = Math.min(MAX, expected[at] + ((word >>> 16) & 255) / 255);
        expected[at + 1] = Math.min(MAX, expected[at + 1] + ((word >>> 8) & 255) / 255);
        expected[at + 2] = Math.min(MAX, expected[at + 2] + (word & 255) / 255);
      }
    }
    stats.maps++;
    assert.ok(Buffer.from(expected.buffer).equals(Buffer.from(record.pixels.buffer)), `${where}map ${record.surfaceIndex}: composed texels`);
  }
}
