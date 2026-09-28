import { ClassDefaults } from './classes.mjs';
import { cross, dot, sub } from './geometry.mjs';

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
  const determinant = dot(u, cross(v, n));
  if (Math.abs(determinant) < 1e-10) throw new Error('Singular lightmap texture basis');
  const du = cross(v, n).map(x => x / determinant), dv = cross(n, u).map(x => x / determinant);
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

export async function createLighting(map, asset, assets) {
  const defaults = new ClassDefaults(assets), actors = new Map(), pendingActors = new Map(), notes = new Set();
  const sourceActors = new Map(map.actors.map(a => [a.index, a]));
  const levelInfo = map.actors.find(a => a.className === 'LevelInfo');
  const stats = { lightActors: 0, lightmaps: 0, shadowMasks: 0, litSurfaces: 0, unlitSurfaces: 0, missingLightmaps: 0 };
  async function actor(ref) {
    if (!ref) ref = levelInfo?.index;
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

  function refill(result) {
    const { points, normal, surface, lightEntries } = result, pixels = result.staticPixels ?? result.pixels;
    const ambient = zoneValues[result.zone] ?? levelValues;
    const rgb = lightColor(ambient.AmbientHue, ambient.AmbientSaturation, ambient.AmbientBrightness).map(c => c * .25);
    for (let p = 0; p < points.length; p++) pixels.set(rgb, p * 3);
    for (const { ref, shadow } of lightEntries) {
      const light = actors.get(ref);
      if (!light) throw new Error(`Unprepared light ${ref}`);
      if (!light.LightType || !light.LightBrightness) continue;
      if (Boolean(surface.flags & 0x100000) !== Boolean(light.bSpecialLit)) continue;
      const effect = light.LightEffect ?? 0;
      if (![0, 3, 8, 12, 13].includes(effect)) throw new Error(`Unsupported light effect ${effect}`);
      if (effect === 3) notes.add('Watery-shimmer lights use their static contribution; shimmer animation is not active.');
      if (![1, 9].includes(light.LightType)) notes.add(`Light type ${light.LightType} uses a steady snapshot; time-varying light animation is not active.`);
      if (!light.bStatic) notes.add('Steady TriggerLight brightness changes use explicit host invalidation; other script-controlled light changes are not active.');
      usedLights.add(ref); stats.lightActors = usedLights.size;
      const color = lightColor(light.LightHue, light.LightSaturation, 255)
        .map(c => c * light.LightBrightness / 255 * (levelValues.Brightness ?? 1));
      for (let p = 0; p < points.length; p++) {
        const weight = shadow[p] * lightAttenuation(light, points[p], normal);
        for (let c = 0; c < 3; c++) pixels[p * 3 + c] = Math.min(127 / 255, pixels[p * 3 + c] + color[c] * weight);
      }
    }
    if (result.staticPixels) compose(result);
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
    stats, notes,
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
    ownedRecords() { return owned; },
    invalidate(changes) {
      const entries = normalizeLightingChanges(changes), changedLights = [...new Set(entries.map(entry => entry.ref))];
      for (const { ref, values } of entries) if (values) updateActor(ref, values);
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
      const refs = lightReferences(model, lm);
      const lightEntries = refs.map((ref, lightIndex) => ({ ref, shadow: shadowMask(model, lm, lightIndex) }));
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
