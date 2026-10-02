import { ClassDefaults } from './classes.mjs';
import { readObject } from './objects.mjs';
import { cross, dot, sub } from './geometry.mjs';
import { staticLightMap, ambientTexel, animateLightMap } from '../runtime/static-lighting.mjs';
import { fgetHsv } from '../runtime/dynamic-lighting.mjs';
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
  let movingApplier = null;

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
  // FGetHSV on the x87 model (docs/static-lighting.md).
  const hsvCache = new Map(), ambientCache = new Map();
  const hsv = (hue, saturation) => {
    const key = (hue & 255) << 8 | saturation & 255;
    if (!hsvCache.has(key)) hsvCache.set(key, fgetHsv(hue, saturation, 255));
    return hsvCache.get(key);
  };
  const levelBrightness = Math.fround(levelValues.Brightness ?? 1);

  /** The light map's facet and texel grid as SetupForSurf sees them: a level
   * surface keeps its serialized float facet; a brush surface moves with its
   * transform (as moving-lights.mjs). */
  function geometry(result) {
    if (!result.staticGeometry) {
      const { model, surface, basis, transform, transformNormal, lightMap, owner } = result;
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
    result.baseTexels = staticLightMap({ width, height, ambient: ambientCache.get(ambientKey), lights, shadowBits: model.lightBits,
      shadowOffset: lightMap.dataOffset, facet, grid, levelBrightness, notes, hsv, animated });
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
  const animatedRecords = new Set(), animationOptions = { levelBrightness, hsv, keyOf: ref => ref & 0xff };

  function updateActor(ref, values = {}) {
    if (!Number.isInteger(ref) || ref <= 0) throw new TypeError(`Invalid lighting actor reference: ${ref}`);
    const current = actors.get(ref);
    if (!current) throw new Error(`Unprepared lighting actor ${ref}`);
    Object.assign(current, changeValues(values) ?? {});
    return current;
  }

  return {
    stats, notes, hsv, levelBrightness,
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
      const points = [];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) points.push(transform(basis.point(x, y)));
      const refs = lightReferences(model, lm), pitch = (width + 7) >> 3;
      if (refs.length && lm.dataOffset + refs.length * pitch * height > model.lightBits.length)
        throw new Error('Shadow mask outside serialized lighting data');
      const lightEntries = refs.map(ref => ({ ref }));
      stats.shadowMasks += lightEntries.length;
      const result = { width, height, pixels: new Float32Array(width * height * 3), uv: basis.uv, index: surface.lightMap, zone,
        model, surfaceIndex, surface, points, normal, lightEntries, lightRefs: new Set(refs), transform, transformNormal,
        basis, lightMap: lm, owner, staticPixels: null, moving: null };
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
