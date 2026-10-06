import { lightAttenuation } from '../unreal/lighting.mjs';
import { filterMovingLight, surfaceLightClass, movingLightConstants, movingLightRect, nonIncidenceSpatial,
  normalLightIncidence, normalLightSpatial, colorTableEntry, fgetHsv } from '../runtime/dynamic-lighting.mjs';

const MAX = 127 / 255, UNSHADOWED = 0x7f / 255, ORIGIN = [0, 0, 0], f = Math.fround;
// Remaining normal/spot effect snapshots. Steady effect 0 uses the recovered
// integer normal body; effect 13 uses the recovered NonIncidence body and
// effect 14 (Shell: the EMP and nano-virus grenades' ExplosionLight) the
// original body in the Rust core (spatial.rs).
const FLOAT_EFFECTS = new Set([0, 1, 2, 3, 8, 11, 12, 19]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const union = rects => rects.length ? {
  minU: Math.min(...rects.map(r => r.minU)), maxU: Math.max(...rects.map(r => r.maxU)),
  minV: Math.min(...rects.map(r => r.minV)), maxV: Math.max(...rects.map(r => r.maxV)) } : null;

/** 'incremental' (default) recomposes only the light maps a changed light or
 * mover reaches; MOVING_LIGHTS=full in Node or ?movingLights=full in the
 * viewer keeps the whole-frame recompute as the reference. */
const movingLightsMode = () => (typeof process !== 'undefined' && process.env?.MOVING_LIGHTS)
  || globalThis.DEUS_EX_MOVING_LIGHTS || 'incremental';

/** Per-frame moving lights over the world's lightmap records: the recovered
 * Render.dll surface path (docs/dynamic-lighting.md) as a lighting.mjs
 * applier. Each light touches only ComputeFromActor's texel rectangle, so
 * `update` returns the records whose texels changed with that region.
 *
 * Host work only, identical texels in both modes: a light map's moving
 * texels depend only on its static copy and its contributions, applied in
 * light order. The incremental mode keeps each light's contributions while
 * its location, values and level brightness (and, for brush light maps, the
 * mover's offset) stay the same, recomposes a light map only when one of its
 * contributions changes, and caches each contribution's per-texel addends so
 * a recomposition replays the same float operations without re-evaluating
 * the spatial functions. A change in the relative order of the remaining
 * lights recomputes every light map, as the full mode does. */
export function createMovingLights(lighting, model, { mode = movingLightsMode() } = {}) {
  const hsv = new Map(), notes = new Set(), incremental = mode !== 'full';
  // spatial.rs, through the lighting's kernel (null without the core).
  const spatial = lighting.spatial?.ready ? lighting.spatial : null;
  /** Shell 0x10b05740 for an unshadowed light (illumination 0x7f), with
   * the render pass's 24-bit rr2 (Shell reads no incidence). */
  const shellSpatial = (rect, grid, location, constants, write) => {
    const bytes = spatial.run({ effect: 14, rect, grid, location, rradius: constants.rradius,
      rr2: f(f(constants.rradius * constants.rradius) * 4093), incidence: 0, period: 0, phase: 0, time: 0, illumination: null });
    for (let v = rect.minV, k = 0; v < rect.maxV; v++) for (let u = rect.minU; u < rect.maxU; u++, k++) write(u, v, bytes[k]);
  };
  const bodyOf = ({ effect, originalNormal }) => effect === 14 ? shellSpatial : originalNormal ? normalLightSpatial
    : effect === 13 ? nonIncidenceSpatial : null;
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
    for (const { item, rect, grid, incidence } of contributions) {
      const { originalNormal, constants, location, values } = item, spatialFunction = bodyOf(item);
      if (spatialFunction) {
        const [red, green, blue] = constants.steps;
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

  /** `apply`'s per-texel addends for one contribution, in its visiting
   * order: the sample offsets and the three channel values it adds. */
  function addends(record, { item, rect, grid, incidence }) {
    const { originalNormal, constants, location, values } = item, spatialFunction = bodyOf(item);
    const { width } = record, offset = record.movingOffset ?? ORIGIN, at = [], amounts = [];
    if (spatialFunction) {
      const [red, green, blue] = constants.steps;
      spatialFunction(rect, grid, location, originalNormal ? { ...constants, incidence } : constants, (u, v, spatial) => {
        if (!spatial) return;
        at.push((v * width + u) * 3);
        amounts.push(colorTableEntry(red, spatial) / 255, colorTableEntry(green, spatial) / 255, colorTableEntry(blue, spatial) / 255);
      });
    } else {
      const light = { ...values, Location: location }, color = constants.color;
      for (let v = rect.minV; v < rect.maxV; v++) for (let u = rect.minU; u < rect.maxU; u++) {
        const p = v * width + u, weight = UNSHADOWED * lightAttenuation(light, add(record.points[p], offset), record.normal);
        if (!weight) continue;
        at.push(p * 3);
        amounts.push(color[0] * weight, color[1] * weight, color[2] * weight);
      }
    }
    return { at: Int32Array.from(at), amounts: Float64Array.from(amounts) };
  }

  /** `apply` from cached addends: the same capped additions in the same order.
   * A contribution is rebuilt whenever its light or mover changes, so its
   * cache never outlives its inputs. */
  function applyCached(record, contributions) {
    const { pixels } = record;
    let written = 0;
    for (const contribution of contributions) {
      const { at, amounts } = contribution.addends ??= addends(record, contribution);
      for (let k = 0, j = 0; k < at.length; k++, j += 3) {
        const i = at[k];
        pixels[i] = Math.min(MAX, pixels[i] + amounts[j]);
        pixels[i + 1] = Math.min(MAX, pixels[i + 1] + amounts[j + 1]);
        pixels[i + 2] = Math.min(MAX, pixels[i + 2] + amounts[j + 2]);
      }
      written += at.length;
    }
    record.movingTexels = written;
  }

  function contribution(light) {
    const values = light.values, lightClass = surfaceLightClass(values);
    if (lightClass === 3) notes.add('Moving bump-map lights (LE_OmniBumpMap) add no light-map texels, as in the original.');
    if (lightClass !== 2) return null;
    const effect = values.LightEffect ?? 0;
    const originalNormal = effect === 0 && values.LightType === 1;
    if (effect !== 13 && !(effect === 14 && spatial) && !FLOAT_EFFECTS.has(effect)) {
      notes.add(`Moving lights with effect ${effect} are not implemented and stay unlit.`);
      return null;
    }
    if (effect !== 13 && effect !== 14 && !originalNormal)
      notes.add('Moving spot lights and unrecovered normal-light effect/type variants still use the float static-light reconstruction.');
    if ([1, 2, 3].includes(effect)) notes.add('Moving torch, fire and watery lights omit their per-texel random modulation.');
    if (values.LightType !== 1) notes.add(`Moving light type ${values.LightType} uses a steady snapshot; its time variation is not active.`);
    const key = (values.LightHue & 255) * 256 + (values.LightSaturation & 255);
    if (!hsv.has(key)) hsv.set(key, fgetHsv(values.LightHue, values.LightSaturation, 255));
    return { effect, originalNormal, values, location: light.location.map(Math.fround),
      constants: movingLightConstants(values, light.levelBrightness, hsv.get(key)) };
  }

  /** One contribution of `item` to `record` at the mover `offset`, or null
   * for an empty rectangle: a straddled surface whose rectangle is empty
   * receives no texel, so its per-frame light map equals the static one. */
  function reachRecord(record, item, offset) {
    const { facet, grid } = geometry(record, offset);
    const rect = movingLightRect(item.location, item.constants.radius, facet);
    if (rect.minU >= rect.maxU || rect.minV >= rect.maxV) return null;
    const incidence = item.originalNormal ? normalLightIncidence(item.location, facet, item.constants.rradius) : null;
    return { item, rect, grid, incidence };
  }
  /** Mover polygons join the level BSP through the brush tracker, which is
   * not recovered; they take Filter's node-plane straddle test alone. */
  function reachOwned(record, item, offset) {
    if (Boolean(record.surface.flags & 0x100000) !== Boolean(item.values.bSpecialLit)) return null;
    const radius = item.constants.radius, origin = record.surfaceOrigin ??= record.transform(
      record.model.points[record.surface.base]), [nx, ny, nz] = record.normal, [lx, ly, lz] = item.location;
    const distance = (lx - origin[0] - offset[0]) * nx + (ly - origin[1] - offset[1]) * ny + (lz - origin[2] - offset[2]) * nz;
    return -radius < distance && distance < radius ? reachRecord(record, item, offset) : null;
  }
  /** Every contribution of one light: the level surfaces FDynamicLight::Filter
   * reaches, then the brush surfaces. */
  function reachLight(item, moverOffsets, visit) {
    const { radius } = item.constants, specialLit = Boolean(item.values.bSpecialLit);
    for (const surfaceIndex of filterMovingLight(model, item.location, radius, specialLit))
      for (const record of lighting.recordsFor(model, surfaceIndex)) {
        const entry = reachRecord(record, item, ORIGIN);
        if (entry) visit(record, entry);
      }
    for (const record of lighting.ownedRecords()) {
      const entry = reachOwned(record, item, moverOffsets.get(record.owner) ?? ORIGIN);
      if (entry) visit(record, entry);
    }
  }

  /** Recompose one record from its contributions (light order) and report
   * its dirty rectangle: the old and new moving texels. */
  function recompose(record, contributions, moverOffsets, changed) {
    const previous = record.movingRegion ?? null;
    const region = contributions && union(contributions.map(entry => entry.rect));
    const dirty = union([previous, region].filter(Boolean));
    record.movingOffset = record.owner ? moverOffsets.get(record.owner) ?? ORIGIN : null;
    record.movingTexels = 0;
    lighting.setMoving(record, contributions, dirty);
    record.movingRegion = record.movingTexels ? region : null;
    if (previous || record.movingTexels) changed.push({ lightmap: record, region: dirty });
  }

  function updateFull(lights, moverOffsets = new Map()) {
    const next = JSON.stringify([lights.map(light => [light.location, light.values, light.levelBrightness]), [...moverOffsets]]);
    if (next === signature) return [];
    signature = next;
    const touched = new Map();
    for (const light of lights) {
      const item = contribution(light);
      if (!item) continue;
      reachLight(item, moverOffsets, (record, entry) => {
        if (!touched.has(record)) touched.set(record, []);
        touched.get(record).push(entry);
      });
    }
    const changed = [];
    for (const record of new Set([...active, ...touched.keys()]))
      recompose(record, touched.get(record) ?? null, moverOffsets, changed);
    active = new Set(touched.keys());
    return changed;
  }

  // Incremental state: per light key (its name; a repeated name adds its
  // occurrence), its signature, contribution and reached records; per mover
  // name, the offset last applied. A light that leaves the list (an
  // ElectricityEmitter's LightType flicker) is parked, and comes back with its
  // contributions when its signature and every mover are unchanged.
  const lightStates = new Map(), parked = new Map(), moverStates = new Map();
  let order = [];
  const lightKeys = lights => {
    const seen = new Map();
    return lights.map(({ name }) => {
      const count = seen.get(name) ?? 0; seen.set(name, count + 1);
      return count ? `${name}\u0000${count}` : name;
    });
  };
  const lightSignature = light => JSON.stringify([light.location, light.values, light.levelBrightness]);
  const sameOffset = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

  function updateIncremental(lights, moverOffsets = new Map()) {
    const keys = lightKeys(lights), present = new Set(keys);
    // Movers whose offset changed (a vanished entry counts as changed).
    const moved = new Set();
    for (const [name, offset] of moverOffsets) {
      const last = moverStates.get(name);
      if (!last || !sameOffset(last, offset)) { moved.add(name); moverStates.set(name, [offset[0], offset[1], offset[2]]); }
    }
    for (const name of [...moverStates.keys()]) if (!moverOffsets.has(name)) { moved.add(name); moverStates.delete(name); }
    if (moved.size) parked.clear();
    // The kept lights must keep their relative order, or a light map's
    // contribution order may change: every light map is recomputed then.
    const kept = keys.filter(key => lightStates.has(key)), before = order.filter(key => present.has(key));
    const dirty = new Set();
    if (kept.length !== before.length || kept.some((key, i) => key !== before[i])) {
      for (const record of active) dirty.add(record);
      lightStates.clear(); parked.clear();
    }
    // A mover that moved invalidates parked brush contributions, including
    // those of a light leaving now.
    for (const [key, state] of lightStates) if (!present.has(key)) {
      for (const record of state.reach.keys()) dirty.add(record);
      lightStates.delete(key);
      if (!moved.size) parked.set(key, state);
    }
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i], key = keys[i], sig = lightSignature(light);
      let state = lightStates.get(key);
      if (!state && parked.get(key)?.sig === sig) {
        state = parked.get(key); parked.delete(key); lightStates.set(key, state);
        for (const record of state.reach.keys()) dirty.add(record);
      } else if (!state || state.sig !== sig) {
        if (state) for (const record of state.reach.keys()) dirty.add(record);
        parked.delete(key);
        const item = contribution(light), reach = new Map();
        if (item) reachLight(item, moverOffsets, (record, entry) => { reach.set(record, entry); dirty.add(record); });
        lightStates.set(key, state = { sig, item, reach });
      } else if (moved.size && state.item) {
        for (const record of state.reach.keys()) if (record.owner && moved.has(record.owner)) {
          state.reach.delete(record); dirty.add(record);
        }
        for (const record of lighting.ownedRecords()) {
          if (!moved.has(record.owner)) continue;
          const entry = reachOwned(record, state.item, moverOffsets.get(record.owner) ?? ORIGIN);
          if (entry) { state.reach.set(record, entry); dirty.add(record); }
        }
      }
    }
    order = keys;
    const changed = [], states = keys.map(key => lightStates.get(key));
    for (const record of dirty) {
      const contributions = [];
      for (const state of states) { const entry = state.reach.get(record); if (entry) contributions.push(entry); }
      recompose(record, contributions.length ? contributions : null, moverOffsets, changed);
      if (contributions.length) active.add(record); else active.delete(record);
    }
    return changed;
  }

  return { apply: incremental ? applyCached : apply, update: incremental ? updateIncremental : updateFull, mode: incremental ? 'incremental' : 'full',
    notes, records: () => [...active], get surfaces() { return active.size; } };
}
