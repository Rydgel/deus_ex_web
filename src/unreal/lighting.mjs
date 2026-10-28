import { ClassDefaults } from './classes.mjs';
import { readObject } from './objects.mjs';
import { cross, dot, sub } from './geometry.mjs';
import { staticLightMap, ambientTexel, animateLightMap } from '../runtime/static-lighting.mjs';
import { fgetHsv, squareRootTable, normalLightTable } from '../runtime/dynamic-lighting.mjs';
import { scriptVmKernel } from '../runtime/script-vm-kernel.mjs';
import { createLightAnimationKernel } from '../runtime/light-animation-kernel.mjs';

/** The animated light-map merge runs in the Rust core (light-animation-kernel.mjs)
 * when the script-VM kernel is loaded as the lighting is created;
 * LIGHT_KERNEL=js in Node or ?lightKernel=js in the viewer keeps
 * animateLightMap. */
const lightKernelMode = () => (typeof process !== 'undefined' && process.env?.LIGHT_KERNEL)
  || globalThis.DEUS_EX_LIGHT_KERNEL || 'rust';

const normalize = v => { const d = Math.hypot(...v); if (!d) throw new Error('Zero lighting normal'); return v.map(n => n / d); };

/** Deus Ex Engine.dll FGetHSV (RVA 0xec8d0). Zone ambient uses its brightness
 * response; actor lights call it with brightness 255 and scale separately. */
export function lightColor(hue = 0, saturation = 0, brightness = 0) {
  const b = brightness * 1.4 / 255, value = Math.min(1, .7 * b / (.01 + Math.sqrt(b)));
  const rgb = hue <= 85 ? [(85 - hue) / 85, hue / 85, 0]
    : hue <= 170 ? [0, (170 - hue) / 85, (hue - 85) / 85]
      : [(hue - 170) / 85, 0, (255 - hue) / 84];
  return rgb.map(c => (c + (1 - c) * saturation / 255) * value);
}

/** Row-aligned, least-significant-bit-first visibility masks, one per light. */
export function shadowMask(model, lm, lightIndex) {
  const [width, height] = lm.clamp, pitch = Math.ceil(width / 8);
  const start = lm.dataOffset + lightIndex * pitch * height;
  if (start < 0 || start + pitch * height > model.lightBits.length) throw new Error('Shadow mask outside serialized lighting data');
  const sample = (x, y) => {
    x = Math.max(0, Math.min(width - 1, x)); y = Math.max(0, Math.min(height - 1, y));
    return (model.lightBits[start + y * pitch + (x >> 3)] >> (x & 7)) & 1;
  };
  // Original Render.dll builds this kernel, normalized by its total (320).
  const result = new Float32Array(width * height), weights = [24, 40, 24, 40, 64, 40, 24, 40, 24];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let total = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) total += sample(x + dx, y + dy) * weights[(dy + 1) * 3 + dx + 1];
    result[y * width + x] = total / 320;
  }
  return result;
}

export function lightmapBasis(model, surface, lm) {
  const u = model.vectors[surface.textureU], v = model.vectors[surface.textureV], n = model.vectors[surface.normal];
  // Render.dll inverts the facet's FCoords (Core FCoords::Inverse, at
  // 0x10b06175) without a test: a zero determinant makes every texel
  // position non-finite, which the spatial bodies turn into FISTP's integer
  // indefinite or a zero byte (docs/static-lighting.md). NaN stands for
  // that whole non-finite grid.
  const determinant = dot(u, cross(v, n));
  const du = determinant ? cross(v, n).map(x => x / determinant) : [NaN, NaN, NaN];
  const dv = determinant ? cross(n, u).map(x => x / determinant) : [NaN, NaN, NaN];
  const base = model.points[surface.base];
  return {
    normal: normalize(n),
    point(x, y) { return base.map((p, i) => p + du[i] * (lm.pan[0] + x * lm.scale[0]) + dv[i] * (lm.pan[1] + y * lm.scale[1])); },
    uv(point) { const p = sub(point, base); return [(dot(p, u) - lm.pan[0]) / lm.scale[0] + .5, (dot(p, v) - lm.pan[1]) / lm.scale[1] + .5]; },
  };
}

export function pointZone(model, point) {
  let index = 0;
  for (let visited = 0; visited <= model.nodes.length; visited++) {
    const node = model.nodes[index]; if (!node) throw new Error('Invalid BSP zone traversal');
    const side = dot(node.plane.slice(0, 3), point) - node.plane[3] >= 0 ? 1 : 0;
    const next = side ? node.front : node.back;
    if (next < 0) return node.zones[side];
    index = next;
  }
  throw new Error('Cyclic BSP zone traversal');
}

export function lightAttenuation(light, point, normal) {
  const delta = sub(light.Location ?? [0, 0, 0], point), distance = Math.hypot(...delta);
  const radius = ((light.LightRadius ?? 0) + 1) * 25, d = distance / radius;
  // NonIncidence 0x10b054e0: (1.02 - d) wherever FISTP(d^2*4093) < 4096.
  if (light.LightEffect === 13) return d * d * 4093 < 4095.5 ? 1.02 - d : 0;
  if (d >= 1) return 0;
  const incidence = distance > 1e-6 ? Math.abs(dot(delta, normal)) / distance : 1;
  // Native table stores smooth falloff / d, then multiplies plane distance / radius.
  let attenuation = incidence * (1 + 2 * d ** 3 - 3 * d ** 2);
  if (light.LightEffect === 8 || light.LightEffect === 12) {
    const [pitch, yaw] = (light.Rotation ?? [0, 0, 0]).map(n => n * Math.PI / 32768);
    const direction = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
    const cone = (light.LightCone ?? 0) / 255;
    const cosine = distance > 1e-6 ? -dot(delta, direction) / distance : 1;
    attenuation *= cone > 0 ? Math.max(0, (cosine - 1 + cone) / cone) ** 2 : 0;
  }
  return attenuation;
}

function lightReferences(model, lightMap) {
  if (lightMap.lightActors == null || lightMap.lightActors < 0) return [];
  const start = lightMap.lightActors;
  if (!Number.isInteger(start) || start >= model.lights.length) {
    throw new Error(`Invalid LightActors start ${start}`);
  }
  const refs = [];
  for (let index = start; index < model.lights.length; index++) {
    const ref = model.lights[index];
    if (!Number.isInteger(ref)) throw new Error(`Invalid light reference ${ref}`);
    if (ref === 0) return refs;
    refs.push(ref);
  }
  throw new Error('Unterminated surface light list');
}

/** Leaves[leaf].iPermeating's run of the level's Lights list, up to its zero
 * (as coronas.mjs leafPermeatingLights); none for leaf −1. */
function leafLights(model, leaf) {
  const start = leaf >= 0 ? model.leaves[leaf]?.permeating ?? -1 : -1, refs = [];
  if (start < 0) return refs;
  for (let index = start; index < model.lights.length && model.lights[index]; index++) refs.push(model.lights[index]);
  return refs;
}

/** SetupForSurf's facet test for a bDynamicLightMover surface
 * (0x10b06f7c..0x10b06fb2): `((L − O)·Z)` at the render pass's 24-bit
 * precision, in its order (z and y terms summed first), FCOMP against 0.0
 * at 0x10b2a5f0; the light passes only when the sum is greater. */
function inFrontOfFacet(location, origin, normal) {
  const f = Math.fround, [lx, ly, lz] = location.map(f), [ox, oy, oz] = origin.map(f), [zx, zy, zz] = normal.map(f);
  const z = f(lz - oz), y = f(ly - oy), x = f(lx - ox);
  return f(f(f(y * zy) + f(z * zz)) + f(x * zx)) > 0;
}

// A tracker facet [pBase, vTextureU, vTextureV, vNormal] as a one-surface model for lightmapBasis.
const FACET_SURFACE = Object.freeze({ base: 0, textureU: 0, textureV: 1, normal: 2 });

/** Whether a mover light map's cache header (`last`: Region.iLeaf, Location, Rotation) differs from these values: SetupForSurf
 * reuses the item only when all seven words match (0x10b07e39..0x10b07ebe: FCOMP's equality for Location, so a NaN never
 * matches; CMP for the leaf and Rotation). */
function headerDiffers(last, leaf, location, rotation) {
  const f = Math.fround;
  return !last || last[0] !== (leaf | 0) || last[1] !== f(location[0]) || last[2] !== f(location[1]) || last[3] !== f(location[2])
    || last[4] !== (rotation[0] | 0) || last[5] !== (rotation[1] | 0) || last[6] !== (rotation[2] | 0);
}

function changeValues(values) {
  if (values == null) return null;
  if (typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Light change values must be an object');
  const unsupported = Object.keys(values).filter(key => key !== 'LightBrightness');
  if (unsupported.length) throw new Error(`Unsupported script light update field: ${unsupported[0]}`);
  return values;
}

function normalizeLightingChanges(value) {
  const result = [];
  const append = (item, tuple = false) => {
    let ref, values;
    if (Number.isInteger(item)) ref = item;
    else if (tuple) [ref, values] = item;
    else if (item && typeof item === 'object') {
      ref = item.ref ?? item.index;
      values = item.values ?? item.patch;
    }
    if (!Number.isInteger(ref) || ref <= 0) throw new TypeError(`Invalid changed light reference: ${ref}`);
    result.push({ ref, values: changeValues(values) });
  };
  if (Number.isInteger(value)) append(value);
  else if (value && typeof value === 'object' && !Array.isArray(value) && ('ref' in value || 'index' in value)) append(value);
  else if (value instanceof Map) for (const entry of value) append(entry, true);
  else if (Array.isArray(value) && value.length === 2 && Number.isInteger(value[0]) && (value[1] == null || typeof value[1] === 'object')) append(value, true);
  else if (value != null && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') {
    for (const item of value) {
      if (Array.isArray(item)) append(item, true);
      else append(item);
    }
  } else throw new TypeError('invalidate() requires a light reference or iterable of changes');
  return result;
}

/** `kernel`: the script-VM kernel whose light.rs merges animated light maps,
 * null for animateLightMap, or undefined to decide now (lightKernelMode). */
export async function createLighting(map, asset, assets, { kernel } = {}) {
  const defaults = new ClassDefaults(assets), actors = new Map(), pendingActors = new Map(), notes = new Set();
  const sourceActors = new Map(map.actors.map(a => [a.index, a]));
  const levelInfo = map.actors.find(a => a.className === 'LevelInfo');
  const stats = { lightActors: 0, lightmaps: 0, shadowMasks: 0, litSurfaces: 0, unlitSurfaces: 0, missingLightmaps: 0 };
  async function actor(ref) {
    if (!ref) ref = levelInfo?.index;
    // A light list can name an actor the level no longer lists (deleted in
    // the editor, still exported): the original loads it through that
    // reference, and AddLight does not test bDeleteMe.
    if (ref && !sourceActors.has(ref) && asset.pkg.exports[ref - 1]?.serialSize)
      sourceActors.set(ref, { index: ref, values: readObject(asset.pkg, asset.bytes, ref).values });
    if (!ref || !sourceActors.has(ref)) throw new Error(`Missing lighting actor ${ref}`);
    if (!pendingActors.has(ref)) {
      const promise = defaults.forActor(asset, sourceActors.get(ref)).then(values => { actors.set(ref, values); return values; });
      pendingActors.set(ref, promise);
    }
    return pendingActors.get(ref);
  }
  await Promise.all(map.model.zones.map(z => actor(z.actor)));
  const levelValues = await actor(levelInfo.index);
  const zoneValues = map.model.zones.map(z => actors.get(z.actor) ?? levelValues);
  const usedLights = new Set(), caches = new WeakMap(), cacheRecords = new Set(), bySurface = new WeakMap(), owned = [];
  const chosenKernel = kernel !== undefined ? kernel : lightKernelMode() === 'js' ? null : scriptVmKernel;
  const animationKernel = chosenKernel ? createLightAnimationKernel(chosenKernel) : null;
  // spatial.rs (docs/static-lighting.md "Spatially dynamic effects") in the
  // merge kernel's instance, whose light_merge reruns it; the reference
  // merge calls the same instance's export. Without the core these lights
  // stay out of the light maps, with a note.
  const spatialKernel = (chosenKernel ?? scriptVmKernel)?.spatial ?? null;
  if (spatialKernel && !spatialKernel.ready) spatialKernel.tables(squareRootTable(), normalLightTable());
  let movingApplier = null;
  // Every mover brush's light maps: owner → whether it is a bDynamicLightMover (dynamicLightMover) and its bSpecialLit, its
  // records and its records by polygon. Each record keeps the cache header it was built for (`header`) and its pose.
  const movers = new Map();
  const moverOf = owner => {
    let mover = movers.get(owner);
    if (!mover) movers.set(owner, mover = { dynamic: false, specialLit: false, records: [], byPolygon: new Map() });
    return mover;
  };
  // The mover light maps placed again since the moving lights last asked (takeReposed), and how many placements there were.
  let reposed = new Set(), poseCount = 0;

  // Moving lights (docs/dynamic-lighting.md) add onto a copy of the static
  // texels, as SetupForSurf's per-frame pass copies the static cache item.
  function compose(result) {
    if (!result.moving?.length) {
      if (result.staticPixels) { result.pixels.set(result.staticPixels); result.staticPixels = null; }
      return;
    }
    if (!result.staticPixels) result.staticPixels = Float32Array.from(result.pixels);
    else result.pixels.set(result.staticPixels);
    movingApplier(result, result.moving);
  }

  // The original's per-light colour and the zone ambients through Engine
  // FGetHSV at the render pass's 24-bit precision (docs/static-lighting.md).
  const hsvCache = new Map(), ambientCache = new Map();
  const hsv = (hue, saturation) => {
    const key = (hue & 255) << 8 | saturation & 255;
    if (!hsvCache.has(key)) hsvCache.set(key, fgetHsv(hue, saturation, 255));
    return hsvCache.get(key);
  };
  const levelBrightness = Math.fround(levelValues.Brightness ?? 1);

  /** The light map's facet and texel grid as SetupForSurf sees them: a level
   * surface keeps its serialized float facet; a brush surface takes the
   * brush tracker's facet when its pose holds one (`relightPolygon`), else
   * moves with its transform, the authored one or the current pose's
   * (`relightMover`). */
  function geometry(result) {
    if (!result.staticGeometry && result.pose?.facet) {
      // DrawFrame fills the facet from the tracker surface's pBase and vectors (0x10b1a977..0x10b1aa38), and
      // ComputeFromActor's grid comes from its inverse: lightmapBasis on the facet, as fog-pass.mjs moverGrid.
      const { lightMap } = result, facet = result.pose.facet, [origin, axisU, axisV, normal] = [0, 3, 6, 9].map(i => facet.slice(i, i + 3));
      const placed = lightmapBasis({ points: [origin], vectors: [axisU, axisV, normal] }, FACET_SURFACE, lightMap);
      const p00 = placed.point(0, 0), p10 = placed.point(1, 0), p01 = placed.point(0, 1);
      result.staticGeometry = {
        facet: { origin, axisU, axisV, normal, pan: [lightMap.pan[0], lightMap.pan[1]], scale: lightMap.scale, clamp: lightMap.clamp },
        grid: { start: p00.map(Math.fround), stepU: p10.map((v, i) => Math.fround(v - p00[i])),
          stepV: p01.map((v, i) => Math.fround(v - p00[i])) },
      };
    }
    if (!result.staticGeometry) {
      const { model, surface, basis, lightMap, owner } = result, { transform, transformNormal } = result.pose ?? result;
      const base = model.points[surface.base], vectors = model.vectors, origin = transform(base);
      const along = vector => transform(base.map((v, i) => v + vector[i])).map((v, i) => v - origin[i]);
      const p00 = transform(basis.point(0, 0)), p10 = transform(basis.point(1, 0)), p01 = transform(basis.point(0, 1));
      result.staticGeometry = {
        facet: { origin, axisU: owner ? along(vectors[surface.textureU]) : vectors[surface.textureU],
          axisV: owner ? along(vectors[surface.textureV]) : vectors[surface.textureV],
          normal: owner ? transformNormal(vectors[surface.normal]) : vectors[surface.normal],
          pan: [lightMap.pan[0], lightMap.pan[1]], scale: lightMap.scale, clamp: lightMap.clamp },
        grid: { start: p00.map(Math.fround), stepU: p10.map((v, i) => Math.fround(v - p00[i])),
          stepV: p01.map((v, i) => Math.fround(v - p00[i])) },
      };
    }
    return result.staticGeometry;
  }

  function refill(result) {
    const { width, height, lightEntries, model, lightMap } = result, pixels = result.staticPixels ?? result.pixels;
    const zone = zoneValues[result.zone] ?? levelValues;
    const ambientKey = `${zone.AmbientHue ?? 0}:${zone.AmbientSaturation ?? 0}:${zone.AmbientBrightness ?? 0}`;
    if (!ambientCache.has(ambientKey))
      ambientCache.set(ambientKey, ambientTexel(fgetHsv(zone.AmbientHue ?? 0, zone.AmbientSaturation ?? 0, zone.AmbientBrightness ?? 0)));
    const lights = lightEntries.map(({ ref }) => {
      const values = actors.get(ref);
      if (!values) throw new Error(`Unprepared light ${ref}`);
      if (values.LightType && values.LightBrightness) { usedLights.add(ref); stats.lightActors = usedLights.size; }
      return { values, location: (values.Location ?? [0, 0, 0]).map(Math.fround), ref };
    });
    const { facet, grid } = geometry(result), animated = [];
    // A bDynamicLightMover's lights go to AddLight with no shadow mask: the
    // illumination is 0x7f everywhere (0x10b06fc4).
    result.baseTexels = staticLightMap({ width, height, ambient: ambientCache.get(ambientKey), lights,
      shadowBits: result.dynamicLight ? null : model.lightBits,
      shadowOffset: lightMap.dataOffset, facet, grid, levelBrightness, notes, hsv, animated, spatial: spatialKernel,
      timeSeconds: lightFrame?.timeSeconds ?? 0 });
    result.animated = animated;
    if (animated.length) animatedRecords.add(result); else animatedRecords.delete(result);
    const texels = result.texels = result.baseTexels.slice();
    result.animationMemo = {};
    if (animated.length && lightFrame) animateLightMap(result.baseTexels, texels, width, animated, lightFrame, animationOptions);
    // The kernel's copy starts from the bytes just merged (its old block, if
    // the new layout fits, is reused).
    result.lightKernel = animated.length && animationKernel
      ? animationKernel.register(result.baseTexels, width, animated, texels, result.lightKernel ?? null) : null;
    for (let i = 0; i < texels.length; i++) pixels[i] = texels[i] / 255;
    if (result.staticPixels) compose(result);
    return result;
  }
  // Light animation (docs/static-lighting.md): the current frame's inputs,
  // and every light map with an animated class 1 light.
  let lightFrame = null;
  const animatedRecords = new Set(), animationOptions = { levelBrightness, hsv, keyOf: ref => ref & 0xff, spatial: spatialKernel };

  /** SetupForSurf's rebuild of one mover light map for a new cache `header` at `pose` (a tracker facet, or transforms):
   * the brush's own light list with its shadow masks (0x10b070a5), or for a bDynamicLightMover the lights of
   * Leaves[iLeaf].iPermeating in the level's Lights list that lie in front of the facet and share the mover's
   * bSpecialLit, unshadowed (0x10b06efe..0x10b06fd5); leaf −1 lists none. */
  function rebuild(mover, result, header, pose) {
    result.header = header; result.pose = pose; result.staticGeometry = null;
    const { facet } = geometry(result);
    // moving-lights.mjs reachOwned's plane.
    result.normal = normalize(pose.facet ? facet.normal : pose.transformNormal(result.basis.normal));
    if (mover.dynamic) {
      const refs = leafLights(map.model, header[0]).filter(ref => {
        const values = actors.get(ref);
        if (!values) throw new Error(`Unprepared light ${ref}`);
        return inFrontOfFacet(values.Location ?? [0, 0, 0], facet.origin, facet.normal) && Boolean(values.bSpecialLit) === mover.specialLit;
      });
      result.lightEntries = refs.map(ref => ({ ref })); result.lightRefs = new Set(refs);
    }
    refill(result);
    reposed.add(result); poseCount++;
    return result;
  }

  function updateActor(ref, values = {}) {
    if (!Number.isInteger(ref) || ref <= 0) throw new TypeError(`Invalid lighting actor reference: ${ref}`);
    const current = actors.get(ref);
    if (!current) throw new Error(`Unprepared lighting actor ${ref}`);
    Object.assign(current, changeValues(values) ?? {});
    return current;
  }

  return {
    stats, notes, hsv, levelBrightness,
    /** The kernel's spatial.rs interface (null without the core). */
    spatial: spatialKernel,
    /** The light map's texel grid as SetupForSurf sees it (fog maps share it). */
    gridFor(result) { return geometry(result).grid; },
    async prepare(model) { await Promise.all([...new Set(model.lights.filter(Boolean))].map(actor)); },
    updateActor,
    /** `apply(result, contributions)` adds moving-light texels onto the static copy. */
    setMovingApplier(apply) { movingApplier = apply; },
    /** Replace a record's moving contributions. With a `region` (texel
     * rectangle covering both the old and new moving texels) only that part
     * returns to the static copy before the applier adds the new ones. */
    setMoving(result, contributions, region) {
      if (contributions?.length && !movingApplier) throw new Error('No moving-light applier is installed');
      result.moving = contributions?.length ? contributions : null;
      if (region === undefined) return compose(result);
      if (!region) { if (!result.moving) result.staticPixels = null; return; }
      if (!result.staticPixels) {
        if (!result.moving) return;
        result.staticPixels = Float32Array.from(result.pixels);
      } else {
        for (let v = region.minV; v < region.maxV; v++) {
          const from = (v * result.width + region.minU) * 3, to = (v * result.width + region.maxU) * 3;
          result.pixels.set(result.staticPixels.subarray(from, to), from);
        }
      }
      if (result.moving) movingApplier(result, result.moving);
      else result.staticPixels = null;
    },
    recordsFor(model, surfaceIndex) { return bySurface.get(model)?.get(surfaceIndex) ?? []; },
    /** Mark `owner`'s brush as a bDynamicLightMover (Mover +0x38c bit 0x10) before its surfaces are made: SetupForSurf
     * lights its surfaces from the level leaf the mover is in (relightMover), not from the brush's own light lists. */
    dynamicLightMover(owner, { specialLit = false } = {}) {
      Object.assign(moverOf(owner), { dynamic: true, specialLit: Boolean(specialLit) });
    },
    /** The cache header (Region.iLeaf, Location, Rotation) `owner`'s light maps were just built for by `surface`, with
     * nothing built again: the authored place's. */
    markMoverHeader(owner, leaf, location, rotation) {
      const header = [leaf | 0, ...location.map(Math.fround), ...rotation.map(n => n | 0)];
      for (const result of movers.get(owner)?.records ?? []) result.header = header;
    },
    /** Whether any of `owner`'s light maps would be built again: every brush-tracker surface's static cache item holds
     * its actor's Region.iLeaf, Location and Rotation (0x10b07f4a..0x10b07f86) and is reused only when they match
     * (headerDiffers). Nothing is allocated: Play asks every frame. */
    moverHeaderChanged(owner, leaf, location, rotation) {
      return movers.get(owner)?.records.some(result => headerDiffers(result.header, leaf, location, rotation)) ?? false;
    },
    /** SetupForSurf's cache header for each of `owner`'s light maps whose header differs (moverHeaderChanged), at the
     * pose `transform` and `transformNormal` (Unreal axes) give the brush at `location`/`rotation`: built again from
     * the brush's own light list with its shadow masks, or for a bDynamicLightMover from its leaf (rebuild). Returns the
     * records built again. */
    relightMover(owner, { leaf, location, rotation, transform, transformNormal }) {
      const mover = movers.get(owner), header = [leaf | 0, ...location.map(Math.fround), ...rotation.map(n => n | 0)];
      if (!mover) return [];
      const pose = { transform, transformNormal }, built = [];
      for (const result of mover.records)
        if (headerDiffers(result.header, leaf, location, rotation)) built.push(rebuild(mover, result, header, pose));
      return built;
    },
    /** The same for one drawn polygon of `owner` (a brush tracker draw item, sim-session.mjs moverItems), on the facet
     * the tracker holds for it (`facet`: pBase, vTextureU, vTextureV, vNormal): SetupForSurf runs only for drawn
     * surfaces, and DrawFrame's facet is the tracker's. A light map built on a transform until now is built again on
     * the facet. Returns the records built again. */
    relightPolygon(owner, polygon, { leaf, location, rotation, facet }) {
      const mover = movers.get(owner), records = mover?.byPolygon.get(polygon);
      if (!records) return [];
      let header = null, built = null;
      for (const result of records) {
        if (result.pose?.facet && !headerDiffers(result.header, leaf, location, rotation)) continue;
        header ??= [leaf | 0, ...location.map(Math.fround), ...rotation.map(n => n | 0)];
        (built ??= []).push(rebuild(mover, result, header, { facet: Array.from(facet) }));
      }
      return built ?? [];
    },
    /** The mover light maps placed again since the last call (the moving lights recompute what reaches them). */
    takeReposed() {
      const out = reposed;
      reposed = new Set();
      return out;
    },
    /** How many times a mover light map has been placed again. */
    get poseCount() { return poseCount; },
    /** The facet and texel grid a light map is built on (its current pose for a brush). */
    geometryFor(result) { return geometry(result); },
    /** SetupForSurf's per-frame class 1 merge for every light map with an
     * animated light (`frame` from static-lighting.mjs createLightFrame,
     * advanced once per drawn frame); returns the records whose texels
     * changed. `visible` may skip light maps not drawn this frame: the
     * merge does not depend on which surfaces are drawn. */
    animate(frame, visible = () => true) {
      lightFrame = frame;
      const changed = [];
      for (const result of animatedRecords) {
        if (!visible(result)) continue;
        const region = result.lightKernel
          ? animationKernel.animate(result.lightKernel, result.texels, frame, animationOptions, result.animationMemo ??= {})
          : animateLightMap(result.baseTexels, result.texels, result.width, result.animated, frame, animationOptions,
            result.animationMemo ??= {});
        if (!region) continue;
        const { texels, width } = result, pixels = result.staticPixels ?? result.pixels;
        for (let v = region.minV; v < region.maxV; v++)
          for (let i = (v * width + region.minU) * 3, end = (v * width + region.maxU) * 3; i < end; i++) pixels[i] = texels[i] / 255;
        if (result.staticPixels) compose(result);
        changed.push({ lightmap: result, region: result.staticPixels ? null : region });
      }
      return changed;
    },
    animatedRecords: () => [...animatedRecords],
    /** The light-map merge kernel (null for animateLightMap). */
    animationKernel,
    /** Free the kernel's blocks (the world is going). */
    dispose() { animationKernel?.dispose(); },
    ownedRecords() { return owned; },
    invalidate(changes) {
      const entries = normalizeLightingChanges(changes), changedLights = [...new Set(entries.map(entry => entry.ref))];
      // A light no light map lists (the world prepares every list before
      // Play starts) changes no cached texel: its values are not kept here.
      for (const { ref, values } of entries) if (values && actors.has(ref)) updateActor(ref, values);
      const affected = [...cacheRecords].filter(result => changedLights.some(ref => result.lightRefs.has(ref)));
      for (const result of affected) refill(result);
      return { changedLights, lightmaps: affected,
        affected: affected.map(result => ({ surfaceIndex: result.surfaceIndex, lightMapIndex: result.index, zone: result.zone, lightmap: result })) };
    },
    surface(model, surfaceIndex, zone, transform = p => p, transformNormal = n => n, owner = null) {
      const surface = model.surfaces[surfaceIndex], lm = model.lightMaps[surface.lightMap];
      if (!lm) { stats.missingLightmaps++; return null; }
      const [width, height] = lm.clamp;
      if (width < 1 || height < 1 || width > 1022 || height > 1022 || !lm.scale.every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid lightmap dimensions or scale');
      if (!caches.has(model)) caches.set(model, new Map());
      const cache = caches.get(model), key = `${surfaceIndex}:${zone}`;
      if (cache.has(key)) return cache.get(key);
      const basis = lightmapBasis(model, surface, lm), normal = normalize(transformNormal(basis.normal));
      // A texel's world point is transform(basis.point(x, y)), computed where needed (world.mjs texelSphere), not kept per texel
      // (docs/live-heap.md, step 1).
      // A bDynamicLightMover's surface lists no lights until relightMover gives it its leaf's.
      const mover = owner !== null ? moverOf(owner) : null;
      const refs = mover?.dynamic ? [] : lightReferences(model, lm), pitch = (width + 7) >> 3;
      if (refs.length && lm.dataOffset + refs.length * pitch * height > model.lightBits.length)
        throw new Error('Shadow mask outside serialized lighting data');
      const lightEntries = refs.map(ref => ({ ref }));
      stats.shadowMasks += lightEntries.length;
      const result = { width, height, pixels: new Float32Array(width * height * 3), uv: basis.uv, index: surface.lightMap, zone,
        model, surfaceIndex, surface, normal, lightEntries, lightRefs: new Set(refs), transform, transformNormal,
        basis, lightMap: lm, owner, staticPixels: null, moving: null, dynamicLight: Boolean(mover?.dynamic), pose: null, header: null };
      if (mover) {
        mover.records.push(result);
        if (!mover.byPolygon.has(surfaceIndex)) mover.byPolygon.set(surfaceIndex, []);
        mover.byPolygon.get(surfaceIndex).push(result);
      }
      refill(result);
      cache.set(key, result); cacheRecords.add(result); stats.lightmaps++;
      if (!bySurface.has(model)) bySurface.set(model, new Map());
      const surfaceRecords = bySurface.get(model);
      if (!surfaceRecords.has(surfaceIndex)) surfaceRecords.set(surfaceIndex, []);
      surfaceRecords.get(surfaceIndex).push(result);
      if (owner) owned.push(result);
      return result;
    },
  };
}
