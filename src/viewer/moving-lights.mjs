import { lightAttenuation } from '../unreal/lighting.mjs';
import { filterMovingLight, surfaceLightClass, movingLightConstants, movingLightRect, nonIncidenceSpatial,
  normalLightIncidence, normalLightSpatial, colorTableEntry, fgetHsv } from '../runtime/dynamic-lighting.mjs';

const MAX = 127 / 255, UNSHADOWED = 0x7f / 255, ORIGIN = [0, 0, 0];
// Remaining normal/spot effect snapshots. Steady effect 0 uses the recovered
// integer normal body; effect 13 uses the recovered NonIncidence body.
const FLOAT_EFFECTS = new Set([0, 1, 2, 3, 8, 11, 12, 19]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const union = rects => rects.length ? {
  minU: Math.min(...rects.map(r => r.minU)), maxU: Math.max(...rects.map(r => r.maxU)),
  minV: Math.min(...rects.map(r => r.minV)), maxV: Math.max(...rects.map(r => r.maxV)) } : null;

/** Per-frame moving lights over the world's lightmap records: the recovered
 * Render.dll surface path (docs/dynamic-lighting.md) as a lighting.mjs
 * applier. Each light touches only ComputeFromActor's texel rectangle, so
 * `update` returns the records whose texels changed with that region. */
export function createMovingLights(lighting, model) {
  const hsv = new Map(), notes = new Set();
  let signature = null, active = new Set();

  function geometry(record, offset) {
    if (!record.movingGeometry) {
      const { model: owner, surface, basis, transform, transformNormal, lightMap } = record;
      const base = owner.points[surface.base], vectors = owner.vectors;
      const origin = transform(base), along = vector => transform(add(base, vector)).map((v, i) => v - origin[i]);
      const p00 = transform(basis.point(0, 0)), p10 = transform(basis.point(1, 0)), p01 = transform(basis.point(0, 1));
      // Level surfaces keep their serialized float facet; brushes move with the mover.
      const world = !record.owner;
      record.movingGeometry = {
        facet: { origin, axisU: world ? vectors[surface.textureU] : along(vectors[surface.textureU]),
          axisV: world ? vectors[surface.textureV] : along(vectors[surface.textureV]),
          normal: world ? vectors[surface.normal] : transformNormal(vectors[surface.normal]),
          pan: [lightMap.pan[0], lightMap.pan[1]], scale: lightMap.scale, clamp: lightMap.clamp },
        start: p00, stepU: p10.map((v, i) => Math.fround(v - p00[i])), stepV: p01.map((v, i) => Math.fround(v - p00[i])),
      };
    }
    const { facet, start, stepU, stepV } = record.movingGeometry;
    return { facet: { ...facet, origin: add(facet.origin, offset) },
      grid: { start: add(start, offset).map(Math.fround), stepU, stepV } };
  }

  /** lighting.mjs applier: adds each light's rectangle onto the static copy. */
  function apply(record, contributions) {
    const { pixels, width } = record, offset = record.movingOffset ?? ORIGIN;
    let written = 0;
    for (const { item: { effect, originalNormal, constants, location, values }, rect, grid, incidence } of contributions) {
      if (effect === 13 || originalNormal) {
        const [red, green, blue] = constants.steps;
        const spatialFunction = originalNormal ? normalLightSpatial : nonIncidenceSpatial;
        spatialFunction(rect, grid, location, originalNormal ? { ...constants, incidence } : constants, (u, v, spatial) => {
          if (!spatial) return;
          const at = (v * width + u) * 3; written++;
          pixels[at] = Math.min(MAX, pixels[at] + colorTableEntry(red, spatial) / 255);
          pixels[at + 1] = Math.min(MAX, pixels[at + 1] + colorTableEntry(green, spatial) / 255);
          pixels[at + 2] = Math.min(MAX, pixels[at + 2] + colorTableEntry(blue, spatial) / 255);
        });
        continue;
      }
      const light = { ...values, Location: location }, color = constants.color;
      for (let v = rect.minV; v < rect.maxV; v++) for (let u = rect.minU; u < rect.maxU; u++) {
        const p = v * width + u, weight = UNSHADOWED * lightAttenuation(light, add(record.points[p], offset), record.normal);
        if (!weight) continue;
        written++;
        for (let c = 0; c < 3; c++) pixels[p * 3 + c] = Math.min(MAX, pixels[p * 3 + c] + color[c] * weight);
      }
    }
    record.movingTexels = written;
  }

  function contribution(light) {
    const values = light.values, lightClass = surfaceLightClass(values);
    if (lightClass === 3) notes.add('Moving bump-map lights (LE_OmniBumpMap) add no light-map texels, as in the original.');
    if (lightClass !== 2) return null;
    const effect = values.LightEffect ?? 0;
    const originalNormal = effect === 0 && values.LightType === 1;
    if (effect !== 13 && !FLOAT_EFFECTS.has(effect)) {
      notes.add(`Moving lights with effect ${effect} are not implemented and stay unlit.`);
      return null;
    }
    if (effect !== 13 && !originalNormal)
      notes.add('Moving spot lights and unrecovered normal-light effect/type variants still use the float static-light reconstruction.');
    if ([1, 2, 3].includes(effect)) notes.add('Moving torch, fire and watery lights omit their per-texel random modulation.');
    if (values.LightType !== 1) notes.add(`Moving light type ${values.LightType} uses a steady snapshot; its time variation is not active.`);
    const key = (values.LightHue & 255) * 256 + (values.LightSaturation & 255);
    if (!hsv.has(key)) hsv.set(key, fgetHsv(values.LightHue, values.LightSaturation, 255));
    return { effect, originalNormal, values, location: light.location.map(Math.fround),
      constants: movingLightConstants(values, light.levelBrightness, hsv.get(key)) };
  }

  function update(lights, moverOffsets = new Map()) {
    const next = JSON.stringify([lights.map(light => [light.location, light.values, light.levelBrightness]), [...moverOffsets]]);
    if (next === signature) return [];
    signature = next;
    // A straddled surface whose rectangle is empty receives no texel; its
    // per-frame light map equals the static one, so it is not recomposed.
    const touched = new Map(), reach = (record, item, offset) => {
      const { facet, grid } = geometry(record, offset);
      const rect = movingLightRect(item.location, item.constants.radius, facet);
      if (rect.minU >= rect.maxU || rect.minV >= rect.maxV) return;
      if (!touched.has(record)) touched.set(record, []);
      const incidence = item.originalNormal ? normalLightIncidence(item.location, facet, item.constants.rradius) : null;
      touched.get(record).push({ item, rect, grid, incidence });
    };
    const owned = lighting.ownedRecords();
    for (const light of lights) {
      const item = contribution(light);
      if (!item) continue;
      const { radius } = item.constants, specialLit = Boolean(item.values.bSpecialLit);
      for (const surfaceIndex of filterMovingLight(model, item.location, radius, specialLit))
        for (const record of lighting.recordsFor(model, surfaceIndex)) reach(record, item, ORIGIN);
      // Mover polygons join the level BSP through the brush tracker, which is
      // not recovered; they take Filter's node-plane straddle test alone.
      for (const record of owned) {
        if (Boolean(record.surface.flags & 0x100000) !== specialLit) continue;
        const offset = moverOffsets.get(record.owner) ?? ORIGIN, origin = record.surfaceOrigin ??= record.transform(
          record.model.points[record.surface.base]), [nx, ny, nz] = record.normal, [lx, ly, lz] = item.location;
        const distance = (lx - origin[0] - offset[0]) * nx + (ly - origin[1] - offset[1]) * ny + (lz - origin[2] - offset[2]) * nz;
        if (-radius < distance && distance < radius) reach(record, item, offset);
      }
    }
    const changed = [];
    for (const record of new Set([...active, ...touched.keys()])) {
      const contributions = touched.get(record) ?? null, previous = record.movingRegion ?? null;
      const region = contributions && union(contributions.map(entry => entry.rect));
      const dirty = union([previous, region].filter(Boolean));
      record.movingOffset = record.owner ? moverOffsets.get(record.owner) ?? ORIGIN : null;
      record.movingTexels = 0;
      lighting.setMoving(record, contributions, dirty);
      record.movingRegion = record.movingTexels ? region : null;
      if (previous || record.movingTexels) changed.push({ lightmap: record, region: dirty });
    }
    active = new Set(touched.keys());
    return changed;
  }

  return { apply, update, notes, records: () => [...active], get surfaces() { return active.size; } };
}
