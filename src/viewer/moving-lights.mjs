import { filterMovingLight, surfaceLightClass, movingLightConstants, movingLightRect, nonIncidenceSpatial,
  normalLightIncidence, normalLightSpatial, colorTableEntry, fgetHsv, fistp } from '../runtime/dynamic-lighting.mjs';
import { lightTypeBrightness, spotLightSpatial } from '../runtime/static-lighting.mjs';
import { fcoordsAxes } from '../runtime/script-pawn-locomotion.mjs';
import { createMovingComposeKernel } from '../runtime/moving-compose-kernel.mjs';
import {switchReader} from '../runtime/switch-reader.mjs';

const MAX = 127 / 255, TWO_52 = 4503599627370496, f = Math.fround;
// The effect table at 0x10b2a0f0 (docs/static-lighting.md): the normal body
// 0x10b03360 for None, the three wavers, Warp and Unused; the spot body
// 0x10b04f80 for StaticSpot and Spotlight; NonIncidence 0x10b054e0; Shell
// 0x10b05740 (spatial.rs). OmniBumpMap is AddLight's class 3. The other
// rows (Cylinder and the spatially dynamic effects) are not reached by a
// class 2 light in the shipped content (scripts/census-moving-lights.mjs).
const NORMAL_BODY = new Set([0, 1, 2, 3, 11, 19]), SPOT_BODY = new Set([8, 12]);
// The merge-dynamic rows (TorchWaver, FireWaver, WateryShimmer): the merge
// 0x10b03040 modulates their spatial bytes with the light noise.
const MODULATED = new Set([1, 2, 3]);
// LightTypes GlobalLighting leaves at the brightness: Steady (0x10b05a00 is
// `ret`), BackdropLight, and the untranslated texture-palette types.
const STEADY_TYPES = new Set([1, 6, 8, 9]);
const union = rects => rects.length ? {
  minU: Math.min(...rects.map(r => r.minU)), maxU: Math.max(...rects.map(r => r.maxU)),
  minV: Math.min(...rects.map(r => r.minV)), maxV: Math.max(...rects.map(r => r.maxV)) } : null;

/** 'incremental' (default) recomposes only the light maps a changed light or
 * mover reaches; MOVING_LIGHTS=full in Node or ?movingLights=full in the
 * viewer keeps the whole-frame recompute as the reference. */
const movingLightsMode = switchReader('MOVING_LIGHTS', 'DEUS_EX_MOVING_LIGHTS', 'incremental');

/** Where the incremental mode composes the light maps it recomposes: 'rust' (default) in the Rust core with the light atlas bytes
 * (moving-compose-kernel.mjs, moving.rs), 'js' the JavaScript bodies below (the references: addDirect, and light-atlas.mjs update), 'verify'
 * both, comparing every float and byte (`stats.verify`). MOVING_COMPOSE=js in Node or ?movingCompose=js in the viewer. */
const movingComposeMode = () => (typeof process !== 'undefined' && process.env?.MOVING_COMPOSE)
  || globalThis.DEUS_EX_MOVING_COMPOSE || 'rust';

/** Per-frame moving lights over the world's lightmap records: the recovered
 * Render.dll surface path (docs/dynamic-lighting.md) as a lighting.mjs
 * applier. A class 2 light is set up for each surface it reaches every
 * frame (SetupForSurf 0x10b0850f-0x10b088f9): ComputeFromActor with
 * GlobalLighting's LightType function, the unshadowed illumination (0x7f),
 * the effect row's spatial body, and the merge 0x10b03040 from index 0,
 * which modulates the wavers' bytes with the frame's light noise.
 *
 * `update(lights, frame, visible, drawnRecords)` takes the frame's light
 * animation inputs (static-lighting.mjs createLightFrame: Level.TimeSeconds,
 * the noise tables, the shared strobe state and the modulation tables);
 * without one every light is taken steady and unmodulated, with a note.
 * `visible(record)`, when given, says which light maps are drawn: the
 * original rebuilds the per-frame map only for a drawn surface, so the
 * incremental mode leaves the others stale and recomposes them, from that
 * frame's inputs, when they are drawn again (their texels depend on the
 * frame's inputs only). `drawnRecords`, when given with `visible`, lists
 * the drawn light maps, so only those are looked at. The full mode, the
 * reference, recomposes all.
 *
 * Host work only, identical texels in both modes: a light map's moving
 * texels depend only on its static copy and its contributions, applied in
 * light order. A contribution keeps the spatial bytes of its rectangle
 * while the light's location and fields (and, for brush light maps, the
 * light map's pose) stay the same; its per-texel addends are rebuilt when its
 * colour or modulation changes (a LightType function, a new noise frame).
 * The incremental mode recomposes a light map only when one of its
 * contributions changes; a change in the relative order of the remaining
 * lights recomputes every light map, as the full mode does. */
export function createMovingLights(lighting, model, { mode = movingLightsMode(), compose: composeMode = movingComposeMode(), atlas = null, kernel = null } = {}) {
  const hsv = new Map(), notes = new Set(), incremental = mode !== 'full';
  // The Rust core's composition and atlas conversion (incremental mode, with a light atlas to write).
  const composer = incremental && composeMode !== 'js' && atlas && kernel?.moving ? createMovingComposeKernel(kernel.moving) : null;
  const verifying = composer && composeMode === 'verify';
  const stats = { batches: 0, jobs: 0, bandTexels: 0, packedTexels: 0, skipped: 0, fallbacks: 0, verify: { jobs: 0, bandDiffer: 0, writtenDiffer: 0, atlasDiffer: 0, reaches: 0, reachDiffer: 0 } };
  const verifyAtlas = [];
  // spatial.rs, through the lighting's kernel (null without the core).
  const spatial = lighting.spatial?.ready ? lighting.spatial : null;
  let signature = null, active = new Set(), frameIndex = -1;

  /** The facet and grid SetupForSurf takes for both a light map's static
   * cache and its moving lights: the one its static texels were built on
   * (lighting.mjs geometryFor; a mover's light map is placed again on a new
   * cache header). `movingGeometry` keeps them for validation. */
  function geometry(record) {
    const placed = lighting.geometryFor(record), { facet, grid } = placed;
    if (record.movingGeometry?.facet !== facet) record.movingGeometry = { facet, start: grid.start, stepU: grid.stepU, stepV: grid.stepV };
    return placed;
  }

  /** The rectangle's spatial bytes of one contribution (row-major, the
   * rectangle's width): the effect row's body with illumination 0x7f. */
  function spatialBytes(entry) {
    if (entry.spatial) return entry.spatial;
    const { item, rect, grid, incidence } = entry, { kind, location, constants } = item;
    const width = rect.maxU - rect.minU, bytes = new Uint8Array(width * (rect.maxV - rect.minV));
    const write = (u, v, byte) => { bytes[(v - rect.minV) * width + u - rect.minU] = byte; };
    if (kind === 'shell') {
      // Shell 0x10b05740 (spatial.rs), with the render pass's 24-bit rr2;
      // Shell reads no incidence.
      bytes.set(spatial.run({ effect: 14, rect, grid, location, rradius: constants.rradius,
        rr2: constants.rr2, incidence: 0, period: 0, phase: 0, time: 0, illumination: null }));
    } else if (kind === 'spot') {
      spotLightSpatial(rect, grid, location, { ...constants, incidence }, write, 0x7f, { cone: item.cone, axis: item.axis });
    } else if (kind === 'nonIncidence') nonIncidenceSpatial(rect, grid, location, constants, write);
    else normalLightSpatial(rect, grid, location, { ...constants, incidence }, write);
    return entry.spatial = bytes;
  }

  // The merge's modulated byte for (noise entry, spatial byte), computed
  // when first asked in its noise input's frame: createLightFrame's
  // `modulation` table entry, `fistp(f(factor·byte) − 0.5) & 255`, without
  // building all 65,536 entries a frame.
  const modulators = new Map();
  function modulator(effect, frame) {
    let m = modulators.get(effect);
    if (!m) modulators.set(effect, m = { value: new Uint8Array(65536), valid: new Uint8Array(65536), token: -1, frame: null, fn: null });
    // Effects 1 and 2 read table A (new every frame), 3 reads W.
    const token = effect === 3 ? frame.noise.version : frame.frameIndex;
    if (m.frame === frame && m.token === token) return m.fn;
    m.valid.fill(0);
    m.frame = frame; m.token = token;
    const factor = frame.factors[effect], { value, valid } = m;
    m.fn = (row, byte) => {
      const at = row << 8 | byte;
      if (!valid[at]) {
        const v = f(factor[row] * byte) - 0.5;
        value[at] = (v >= 0 && v < TWO_52 ? (v + TWO_52) - TWO_52 : v < 0 && v > -TWO_52 ? (v - TWO_52) + TWO_52 : fistp(v)) & 255;
        valid[at] = 1;
      }
      return value[at];
    };
    return m.fn;
  }

  /** A colour's per-byte amounts: `colorTableEntry(step, byte) / 255` per
   * channel (the colour table at 0x10b064ff, as the page adds it). */
  const amountsOf = colour => colour.amounts ??= colour.steps.map(step =>
    Float64Array.from({ length: 256 }, (_, byte) => colorTableEntry(step, byte) / 255));

  /** The merge's per-texel addends of one contribution for its light's
   * current colour (`item.colour`): the sample offsets and the three
   * channel values. The modulation index counts every rectangle texel from
   * 0 (the merge's start index at 0x10b088de is 0). */
  function addends(record, entry) {
    const { item, rect } = entry, { modulate } = item.colour, [red, green, blue] = amountsOf(item.colour);
    const bytes = spatialBytes(entry), { width } = record;
    const at = new Int32Array(bytes.length), amounts = new Float64Array(bytes.length * 3);
    let index = 0, k = 0, n = 0;
    for (let v = rect.minV; v < rect.maxV; v++) for (let u = rect.minU; u < rect.maxU; u++, index++, k++) {
      let byte = bytes[k];
      if (modulate && byte) byte = modulate(index & 0xff, byte);
      if (!byte) continue;
      at[n] = (v * width + u) * 3;
      amounts[n * 3] = red[byte]; amounts[n * 3 + 1] = green[byte]; amounts[n * 3 + 2] = blue[byte];
      n++;
    }
    return { at: at.subarray(0, n), amounts: amounts.subarray(0, n * 3), token: item.colour.token };
  }

  /** One contribution added straight onto the texels, in addends' order
   * (the same additions; nothing kept). Returns the texels written. */
  function addDirect(record, entry) {
    const { item, rect } = entry, { modulate } = item.colour, [red, green, blue] = amountsOf(item.colour);
    const bytes = spatialBytes(entry), { width, pixels } = record;
    let index = 0, k = 0, written = 0;
    for (let v = rect.minV; v < rect.maxV; v++) {
      let i = (v * width + rect.minU) * 3;
      for (let u = rect.minU; u < rect.maxU; u++, index++, k++, i += 3) {
        let byte = bytes[k];
        if (modulate && byte) byte = modulate(index & 0xff, byte);
        if (!byte) continue;
        pixels[i] = Math.min(MAX, pixels[i] + red[byte]);
        pixels[i + 1] = Math.min(MAX, pixels[i + 1] + green[byte]);
        pixels[i + 2] = Math.min(MAX, pixels[i + 2] + blue[byte]);
        written++;
      }
    }
    return written;
  }

  /** lighting.mjs applier: adds each contribution onto the static copy, the
   * saturating merge at 127 per channel. A steady contribution keeps its
   * addends between recompositions; a time-varying one (its colour or
   * modulation changes from frame to frame) is added directly. */
  function apply(record, contributions) {
    const { pixels } = record;
    let written = 0;
    for (const contribution of contributions) {
      const colour = contribution.item.colour;
      contribution.composed = colour.token;
      if (!incremental || contribution.item.timeVarying) { written += addDirect(record, contribution); continue; }
      const cached = contribution.addends;
      const { at, amounts } = cached?.token === colour.token ? cached : contribution.addends = addends(record, contribution);
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

  /** A light's colour for `frame`: GlobalLighting (0x10b05e90) applies the
   * LightType function to the brightness (Level.TimeSeconds, the noise's
   * table A at the light's flicker key, the shared strobe state), then
   * ComputeFromActor's colour steps; the wavers take the frame's modulation
   * table. `token` changes exactly when the addends do. */
  function colourOf(item, frame) {
    const { values, levelBrightness, effect } = item;
    const type = values.LightType & 255;
    if (!frame && type !== 1) notes.add(`Moving light type ${type} is taken steady: no light animation frame was supplied.`);
    if (type === 8 || type === 9) notes.add(`Light type ${type} (texture palette) is not translated and stays steady.`);
    // Steady and BackdropLight leave the brightness as it is (and the
    // texture-palette types are not translated): no type function to run.
    const brightness = frame && !STEADY_TYPES.has(type) ? lightTypeBrightness(values, { timeSeconds: frame.timeSeconds,
      noise: frame.noise, strobe: frame.strobe, flickerKey: item.flickerKey }) : item.baseBrightness;
    let base = item.colourBase;
    if (!base || base.brightness !== brightness) {
      const key = (values.LightHue & 255) * 256 + (values.LightSaturation & 255);
      if (!hsv.has(key)) hsv.set(key, fgetHsv(values.LightHue, values.LightSaturation, 255));
      const { steps } = movingLightConstants(values, levelBrightness, hsv.get(key), brightness);
      base = item.colourBase = { brightness, steps, key: steps.join(','), amounts: null };
    }
    let modulate = null, noise = '';
    if (MODULATED.has(effect)) {
      if (frame) {
        modulate = modulator(effect, frame);
        noise = effect === 3 ? `W${frame.noise.version}` : `A${frame.frameIndex}`;
        composer?.modulation(effect, frame, effect === 3 ? frame.noise.version : frame.frameIndex);
      } else notes.add('Moving torch, fire and watery lights are unmodulated: no light animation frame was supplied.');
    }
    // The colour tables' amounts belong to the steps; the modulation table
    // to the frame.
    return { steps: base.steps, get amounts() { return base.amounts; }, set amounts(value) { base.amounts = value; },
      modulate, token: noise ? `${base.key}${noise}` : base.key };
  }

  function contribution(light) {
    const values = light.values, lightClass = surfaceLightClass(values);
    if (lightClass === 3) notes.add('Moving bump-map lights (LE_OmniBumpMap) add no light-map texels, as in the original.');
    if (lightClass !== 2) return null;
    const effect = values.LightEffect ?? 0;
    const kind = NORMAL_BODY.has(effect) ? 'normal' : SPOT_BODY.has(effect) ? 'spot' : effect === 13 ? 'nonIncidence'
      : effect === 14 && spatial ? 'shell' : null;
    if (!kind) {
      notes.add(effect === 14 ? 'Moving Shell lights need the Rust core (spatial.rs) and stay unlit without it.'
        : `Moving lights with effect ${effect} are not implemented (no class 2 light reaches it in the shipped maps) and stay unlit.`);
      return null;
    }
    const key = (values.LightHue & 255) * 256 + (values.LightSaturation & 255);
    if (!hsv.has(key)) hsv.set(key, fgetHsv(values.LightHue, values.LightSaturation, 255));
    const item = { name: light.name, effect, kind, values, location: light.location.map(Math.fround), levelBrightness: light.levelBrightness,
      flickerKey: light.flickerKey ?? 0, constants: movingLightConstants(values, light.levelBrightness, hsv.get(key)),
      // ComputeFromActor's brightness before GlobalLighting (0x10b060b3).
      baseBrightness: Math.fround((values.LightBrightness & 255) * Math.fround(1 / 255)),
      // Its colour or modulation may change from frame to frame.
      timeVarying: MODULATED.has(effect) || !STEADY_TYPES.has(values.LightType & 255) };
    // The spot body's axis: the X axis of GMath.UnitCoords / Rotation, the
    // ViewRotation of a Pawn (0x10b04f89-0x10b04fda; game.mjs movingLights
    // reads the one the body reads).
    if (kind === 'spot') Object.assign(item, { cone: values.LightCone ?? 0,
      axis: fcoordsAxes((values.Rotation ?? [0, 0, 0]).map(n => n | 0))[1] });
    return item;
  }

  /** One contribution of `item` to `record`, or null for an empty
   * rectangle: a straddled surface whose rectangle is empty receives no
   * texel, so its per-frame light map equals the static one. */
  function reachRecord(record, item) {
    const { facet, grid } = geometry(record);
    const rect = movingLightRect(item.location, item.constants.radius, facet);
    if (rect.minU >= rect.maxU || rect.minV >= rect.maxV) return null;
    const incidence = item.kind === 'normal' || item.kind === 'spot' ? normalLightIncidence(item.location, facet, item.constants.rradius) : null;
    return { item, rect, grid, incidence, spatial: null, addends: null };
  }
  /** Mover polygons join the level BSP through the brush tracker, whose
   * fragment nodes Filter does not walk here yet; they take Filter's
   * node-plane straddle test alone, on the light map's current facet. */
  function reachOwned(record, item) {
    if (Boolean(record.surface.flags & 0x100000) !== Boolean(item.values.bSpecialLit)) return null;
    const radius = item.constants.radius, { origin } = geometry(record).facet, [nx, ny, nz] = record.normal, [lx, ly, lz] = item.location;
    const distance = (lx - origin[0]) * nx + (ly - origin[1]) * ny + (lz - origin[2]) * nz;
    return -radius < distance && distance < radius ? reachRecord(record, item) : null;
  }
  /** Every contribution of one light: the level surfaces FDynamicLight::Filter
   * reaches, then the brush surfaces. */
  function reachLight(item, visit) {
    const { radius } = item.constants, specialLit = Boolean(item.values.bSpecialLit);
    for (const surfaceIndex of filterMovingLight(model, item.location, radius, specialLit))
      for (let record = lighting.firstRecordFor(model, surfaceIndex); record; record = record.nextOfSurface) {
        const entry = reachRecord(record, item);
        if (entry) visit(record, entry);
      }
    for (const record of lighting.ownedRecords()) {
      const entry = reachOwned(record, item);
      if (entry) visit(record, entry);
    }
  }

  /** Recompose one record from its contributions (light order) and report
   * its dirty rectangle: the old and new moving texels. */
  function recompose(record, contributions, changed) {
    const previous = record.movingRegion ?? null;
    const region = contributions && union(contributions.map(entry => entry.rect));
    const dirty = union([previous, region].filter(Boolean));
    record.movingTexels = 0;
    // Validation: the light frame this composition used.
    record.movingFrame = frameIndex;
    lighting.setMoving(record, contributions, dirty);
    record.movingRegion = record.movingTexels ? region : null;
    if (previous || record.movingTexels) changed.push({ lightmap: record, region: dirty });
  }

  function updateFull(lights, frame = null) {
    frameIndex = frame?.frameIndex ?? -1;
    const items = lights.map(light => {
      const item = contribution(light);
      if (item) item.colour = colourOf(item, frame);
      return item;
    });
    const next = JSON.stringify([lights.map(light => [light.location, light.values, light.levelBrightness]),
      items.map(item => item?.colour.token ?? null), lighting.poseCount]);
    if (next === signature) return [];
    signature = next;
    const touched = new Map();
    for (const item of items) {
      if (!item) continue;
      reachLight(item, (record, entry) => {
        if (!touched.has(record)) touched.set(record, []);
        touched.get(record).push(entry);
      });
    }
    const changed = [];
    for (const record of new Set([...active, ...touched.keys()]))
      recompose(record, touched.get(record) ?? null, changed);
    active = new Set(touched.keys());
    return changed;
  }

  // Incremental state: per light key (its name; a repeated name adds its
  // occurrence), its signature, contribution and reached records. A light
  // that leaves the list (an ElectricityEmitter's LightType flicker) is
  // parked, and comes back with its contributions when its signature is
  // unchanged and no mover light map was placed again meanwhile.
  const lightStates = new Map(), parked = new Map();
  let order = [];
  const lightKeys = lights => {
    const seen = new Map();
    return lights.map(({ name }) => {
      const count = seen.get(name) ?? 0; seen.set(name, count + 1);
      return count ? `${name}\u0000${count}` : name;
    });
  };
  // A light's inputs, kept to tell whether its contribution is unchanged.
  const inputsOf = light => ({ location: [light.location[0], light.location[1], light.location[2]],
    values: { ...light.values, ...(light.values.Rotation ? { Rotation: [...light.values.Rotation] } : {}) },
    levelBrightness: light.levelBrightness, flickerKey: light.flickerKey ?? 0 });
  function sameInputs(inputs, light) {
    if (!inputs || inputs.levelBrightness !== light.levelBrightness || inputs.flickerKey !== (light.flickerKey ?? 0)) return false;
    const a = inputs.location, b = light.location;
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false;
    const x = inputs.values, y = light.values;
    let count = 0;
    for (const key in y) {
      count++;
      const p = x[key], q = y[key];
      if (Array.isArray(q)) { if (!Array.isArray(p) || p.length !== q.length || p.some((v, i) => v !== q[i])) return false; }
      else if (!Object.is(p, q)) return false;
    }
    return count === Object.keys(x).length;
  }
  /** Whether `light` differs from the kept `inputs` in its Rotation alone (a turning spotlight's axis): everything a contribution's
   * reach depends on, the location and the radius among them, is unchanged. */
  function rotationOnly(inputs, light) {
    if (!inputs || inputs.levelBrightness !== light.levelBrightness || inputs.flickerKey !== (light.flickerKey ?? 0)) return false;
    const a = inputs.location, b = light.location;
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false;
    const x = inputs.values, y = light.values;
    let count = 0, turned = false;
    for (const key in y) {
      count++;
      const p = x[key], q = y[key];
      if (Array.isArray(q)) {
        if (!Array.isArray(p) || p.length !== q.length) return false;
        if (p.some((v, i) => v !== q[i])) { if (key !== 'Rotation') return false; turned = true; }
      } else if (!Object.is(p, q)) return false;
    }
    return turned && count === Object.keys(x).length;
  }
  let updates = 0;

  // Light maps whose recomposition from the lights waits until they are drawn.
  const pending = new Set();
  function updateIncremental(lights, frame = null, visible = null, drawnRecords = null) {
    frameIndex = frame?.frameIndex ?? -1;
    const stamp = ++updates;
    const keys = lightKeys(lights), present = new Set(keys);
    // The mover light maps placed again (a new cache header) since the last update.
    const moved = lighting.takeReposed();
    if (moved.size) parked.clear();
    // The kept lights must keep their relative order, or a light map's
    // contribution order may change: every light map is recomputed then.
    const kept = keys.filter(key => lightStates.has(key)), before = order.filter(key => present.has(key));
    const dirty = new Set();
    if (kept.length !== before.length || kept.some((key, i) => key !== before[i])) {
      for (const record of active) dirty.add(record);
      lightStates.clear(); parked.clear();
    }
    // A light map placed again invalidates parked brush contributions,
    // including those of a light leaving now.
    for (const [key, state] of lightStates) if (!present.has(key)) {
      for (const record of state.reach.keys()) dirty.add(record);
      lightStates.delete(key);
      if (!moved.size) parked.set(key, state);
    }
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i], key = keys[i];
      let state = lightStates.get(key);
      const same = state && sameInputs(state.inputs, light);
      if (!state && sameInputs(parked.get(key)?.inputs, light)) {
        state = parked.get(key); parked.delete(key); lightStates.set(key, state);
        for (const record of state.reach.keys()) dirty.add(record);
      } else if (!same && state?.item?.kind === 'spot' && rotationOnly(state.inputs, light)) {
        // A turning spotlight: the surfaces it reaches, their rectangles and incidence do not depend on the axis, only the spatial bytes
        // (and the cone and axis the item carries) do, so the contributions are made again over the same reach; the mover light maps
        // placed again since have theirs made on their new facets.
        parked.delete(key);
        const item = contribution(light), reach = new Map();
        item.colour = colourOf(item, frame);
        for (const [record, old] of state.reach) {
          dirty.add(record);
          if (!moved.has(record)) reach.set(record, { item, rect: old.rect, grid: old.grid, incidence: old.incidence, spatial: null, addends: null });
        }
        for (const record of moved) {
          const entry = reachOwned(record, item);
          if (entry) { reach.set(record, entry); dirty.add(record); }
        }
        if (verifying) verifyReach(item, reach);
        lightStates.set(key, state = { inputs: inputsOf(light), item, reach });
        continue;
      } else if (!same) {
        if (state) for (const record of state.reach.keys()) dirty.add(record);
        parked.delete(key);
        const item = contribution(light), reach = new Map();
        if (item) {
          item.colour = colourOf(item, frame);
          reachLight(item, (record, entry) => { reach.set(record, entry); dirty.add(record); });
        }
        lightStates.set(key, state = { inputs: inputsOf(light), item, reach });
        continue;
      } else if (moved.size && state.item) {
        for (const record of state.reach.keys()) if (moved.has(record)) { state.reach.delete(record); dirty.add(record); }
        for (const record of moved) {
          const entry = reachOwned(record, state.item);
          if (entry) { state.reach.set(record, entry); dirty.add(record); }
        }
      }
      // The frame's colour: a LightType function or a new noise frame
      // changes the addends, not the spatial bytes; the time-varying
      // lights' maps are checked below.
      // (A steady light's colour does not depend on the frame.)
      if (state.item?.timeVarying) {
        const colour = colourOf(state.item, frame);
        state.item.colour = colour;
      }
    }
    order = keys;
    const changed = [], states = keys.map(key => lightStates.get(key));
    const contributionsOf = record => {
      const contributions = [];
      for (const state of states) { const entry = state.reach.get(record); if (entry) contributions.push(entry); }
      return contributions;
    };
    composer?.begin();
    const compose = (record, contributions) => {
      if (!(composer && contributions.length && composeInKernel(record, contributions)))
        recompose(record, contributions.length ? contributions : null, changed);
      if (contributions.length) active.add(record); else { active.delete(record); composer?.drop(record); }
      record.movingTimeVarying = contributions.some(entry => entry.item.timeVarying);
    };
    // A map whose time-varying lights' colour or modulation changed since it
    // was composed (its contributions are current: any other change made
    // it pending).
    // (A contribution whose spatial bytes are all 0, `dead`, which only the Rust composition finds out, writes no texel in any frame: it is
    // not looked at, so a light map with nothing else to recompose is left as it is, where the reference recomposes it unchanged.)
    const outdated = record => {
      if (!record.movingTimeVarying) return false;
      for (const entry of record.moving) if ((entry.dead !== true || verifying) && entry.composed !== entry.item.colour.token) return true;
      return false;
    };
    for (const record of dirty) pending.add(record);
    if (!visible) {
      for (const record of pending) compose(record, contributionsOf(record));
      pending.clear();
      for (const state of states) if (state.item?.timeVarying)
        for (const record of state.reach.keys()) if (outdated(record)) compose(record, record.moving);
    } else if (drawnRecords) {
      // The drawn maps, enumerated: nothing else is looked at.
      for (const record of drawnRecords) {
        if (pending.delete(record)) compose(record, contributionsOf(record));
        else if (outdated(record)) compose(record, record.moving);
      }
    } else {
      // The pending maps and the time-varying lights' maps, each tested once.
      for (const record of pending) {
        record.movingStamp = stamp;
        if (visible(record)) { pending.delete(record); compose(record, contributionsOf(record)); }
      }
      for (const state of states) {
        if (!state.item?.timeVarying) continue;
        for (const record of state.reach.keys()) {
          if (record.movingStamp === stamp) continue;
          record.movingStamp = stamp;
          if (visible(record) && outdated(record)) compose(record, record.moving);
        }
      }
    }
    if (composer?.jobs) finishKernel(changed);
    return changed;
  }

  /** Verify mode: a turning spotlight's reach carried over (`reach`) against the reach made in full for its item: the same light maps, with
   * the same rectangles, incidence and grids. */
  function verifyReach(item, reach) {
    const fresh = new Map(), v = stats.verify;
    reachLight(item, (record, entry) => fresh.set(record, entry));
    v.reaches++;
    let differ = fresh.size !== reach.size;
    for (const [record, entry] of fresh) {
      const kept = reach.get(record);
      if (!kept || kept.grid !== entry.grid && JSON.stringify(kept.grid) !== JSON.stringify(entry.grid) || kept.incidence !== entry.incidence
        || JSON.stringify(kept.rect) !== JSON.stringify(entry.rect)) differ = true;
    }
    if (differ) v.reachDiffer++;
  }

  /** The Rust core's composition of one light map (moving-compose-kernel.mjs): the work of `recompose`, `setMoving` and `apply`, queued
   * for the frame's batch. Returns false when the light map composes here instead (a colour step outside int32, no atlas tile), or in
   * verify mode, where it composes here and the batch is compared with it. */
  function composeInKernel(record, contributions) {
    const kept = composer.prepare(record, contributions, spatialBytes);
    if (!composer.eligible(kept)) { stats.fallbacks++; return false; }
    const previous = record.movingRegion ?? null, { region } = kept;
    const dirty = !previous ? region : previous.minU === region.minU && previous.maxU === region.maxU && previous.minV === region.minV
      && previous.maxV === region.maxV ? region : union([previous, region]);
    // Nothing a contribution can write and nothing written before: the reference restores the static texels already there.
    if (!kept.live.length && !previous && !verifying) {
      lighting.beginMoving(record, contributions);
      for (const contribution of contributions) contribution.composed = contribution.item.colour.token;
      record.movingTexels = 0; record.movingFrame = frameIndex;
      stats.skipped++;
      return true;
    }
    // (The atlas rectangle of a kept block's own region is kept with it.)
    let rect = kept.rect;
    if (kept.rectOf !== dirty) {
      rect = atlas.rectOf(record, dirty);
      if (!rect) { stats.fallbacks++; return false; }
      kept.rect = rect; kept.rectOf = dirty;
    }
    if (!verifying) {
      lighting.beginMoving(record, contributions);
      for (const contribution of contributions) contribution.composed = contribution.item.colour.token;
      record.movingFrame = frameIndex;
    }
    composer.add(record, kept, dirty, rect, previous);
    return !verifying;
  }

  /** Run the batch and take its results: the light maps' floats and the atlas bytes (or, in verify mode, compare them with the
   * JavaScript bodies' that ran already). */
  function finishKernel(changed) {
    composer.run();
    const count = composer.jobs;
    stats.jobs += count;
    { const t = composer.texels; stats.bandTexels += t.band; stats.packedTexels += t.packed; stats.batches++; }
    for (let i = 0; i < count; i++) {
      const { record, kept, previous, dirty, rect } = composer.job(i), written = composer.written(i);
      if (verifying) {
        // The JavaScript bodies composed this light map: its rows are the reference, the atlas bytes are compared after the atlas update.
        const band = composer.band(i), v = stats.verify, width = record.width;
        const reference = new Uint32Array(record.pixels.buffer, record.pixels.byteOffset + dirty.minV * width * 12, band.length);
        const got = new Uint32Array(band.buffer, band.byteOffset, band.length);
        v.jobs++;
        for (let k = 0; k < got.length; k++) if (got[k] !== reference[k]) { v.bandDiffer++; break; }
        if (written !== record.movingTexels) v.writtenDiffer++;
        const words = composer.words(), at = composer.packedAt(i);
        verifyAtlas.push({ record, rect, packed: words.slice(at, at + (rect.right - rect.left + 1) * (rect.bottom - rect.top + 1)) });
        continue;
      }
      record.movingTexels = written;
      record.movingRegion = written ? kept.region : null;
      // (The rows are restored even when nothing was written: the reference restores the region, and the light map may hold texels a
      // composition in lighting.mjs `compose` added.)
      composer.copyBand(i);
      if (previous || written) {
        atlas.writePacked(record, rect, composer.words(), composer.packedAt(i), composer);
        changed.push({ lightmap: record, region: dirty, atlas: true });
      }
    }
  }

  /** Verify mode, after the atlas took the changed light maps: the pages' bytes against the packed texels the core made. */
  function checkAtlas() {
    for (const { record, rect, packed } of verifyAtlas.splice(0)) {
      const tile = atlas.tiles.get(record), { page, x, y } = tile, width = rect.right - rect.left + 1;
      let differ = false;
      for (let row = 0, rows = rect.bottom - rect.top + 1; row < rows && !differ; row++) {
        const at = ((y + rect.top + row) * atlas.size + x + rect.left) * 4;
        for (let c = 0; c < width && !differ; c++) {
          const word = packed[row * width + c], i = at + c * 4;
          if (page.pixels[i] !== (word & 255) || page.pixels[i + 1] !== (word >>> 8 & 255) || page.pixels[i + 2] !== (word >>> 16 & 255)
            || page.pixels[i + 3] !== word >>> 24) differ = true;
        }
      }
      if (differ) stats.verify.atlasDiffer++;
    }
  }

  return { apply, update: incremental ? updateIncremental : updateFull, mode: incremental ? 'incremental' : 'full',
    compose: composer ? (verifying ? 'verify' : 'rust') : 'js', stats, checkAtlas, dispose: () => composer?.dispose(),
    notes, records: () => [...active], get surfaces() { return active.size; } };
}
