/** Render.dll LOD-mesh lighting: FLightManager::SetupForActor's ambient,
 * candidate gathering, sort, visibility cache and fades; FLightManager::Light's
 * per-vertex diffuse and specular sum; DrawLodMesh's face/vertex normals and
 * unlit colour; D3DDrv's diffuse packing. Evidence, precision and remaining
 * limits: docs/mesh-lighting.md.
 *
 * All of it runs inside the render pass, under x87 precision control 24
 * (docs/render-pass-precision.md): float operands make each x87 operation a
 * binary32 one (`f(a op b)`); a double constant takes x87-pc24.mjs's exact
 * rounding. */
import { x87load, x87double, x87neg, x87store, x87cmp, x87int32, x87ftol } from './script-vm.mjs';
import { p24add as x87add, p24mul as x87mul, p24div as x87div, r24prod, r24sum } from './x87-pc24.mjs';
import { fgetHsv, movingLightConstants, tableSqrt, worldLightRadius, fistp } from './dynamic-lighting.mjs';
import { lightTypeBrightness } from './static-lighting.mjs';

const f = Math.fround;
const scratch = new DataView(new ArrayBuffer(4));
const bitsOf = value => { scratch.setFloat32(0, value, true); return scratch.getUint32(0, true); };
const floatOf = bits => { scratch.setUint32(0, bits >>> 0, true); return scratch.getFloat32(0, true); };

export const PF = Object.freeze({ Masked: 0x2, Translucent: 0x4, Environment: 0x10, Modulated: 0x40,
  TwoSided: 0x100, NoSmooth: 0x800, Flat: 0x4000, Unlit: 0x400000, Selected: 0x2000000, RenderFog: 0x40000000 });

// Light-manager Init 0x10b022d0: 0x10b024b0(0x10b33650, 0x10b3d384, -0.5).
// The exponent table covers all 512 sign/exponent patterns (the sign is
// dropped by FCHS), the mantissa table the top ten mantissa bits. Each entry
// is the CRT pow result stored as a float, zero when it is a NaN.
const RSQRT_EXPONENT = new Float32Array(512), RSQRT_MANTISSA = new Float32Array(1024);
for (let i = 0; i < 512; i++) {
  const value = Math.abs(floatOf(i << 23)), entry = f(Math.pow(value, -0.5));
  RSQRT_EXPONENT[i] = Number.isNaN(entry) ? 0 : entry;
}
for (let i = 0; i < 1024; i++) RSQRT_MANTISSA[i] = f(Math.pow(floatOf(0x3f800000 + (i << 13)), -0.5));

/** Copies of the table bit patterns, for native comparison. */
export const rsqrtTables = () => ({
  mantissa: Array.from(RSQRT_MANTISSA, bitsOf), exponent: Array.from(RSQRT_EXPONENT, bitsOf) });

/** The table reciprocal square root (0x10b0fefa, 0x10b1088e): mantissa entry
 * times exponent entry, stored as a float. */
export function tableRsqrt(value) {
  const bits = bitsOf(value);
  return f(RSQRT_MANTISSA[(bits >>> 13) & 0x3ff] * RSQRT_EXPONENT[bits >>> 23]);
}

const NORMAL_EPSILON = floatOf(0x3a83126f); // 0x10b2ac2c, 0.001f

/** DrawLodMesh 0x10b0fe60-0x10b0ff85: the face normal of (v0, v1, v2),
 * normalized with the table reciprocal root and added to the three vertex
 * normals in place. `normals[i]` are mutable float triples. Returns the unit
 * face normal the back-face test uses. At 24 bits: `a = p2 − p0` and
 * `bx = p0x − p1x` stay on the stack, `by`, `bz` are stored; `n = b × a`
 * with each product rounded; `|n|²` as `(x² + y²) + z²`, plus ε. */
export function accumulateFaceNormal(p0, p1, p2, n0, n1, n2) {
  const ax = f(p2[0] - p0[0]), ay = f(p2[1] - p0[1]), az = f(p2[2] - p0[2]);
  const bz = f(p0[2] - p1[2]), by = f(p0[1] - p1[1]), bx = f(p0[0] - p1[0]);
  const nz = f(f(bx * ay) - f(by * ax)), ny = f(f(bz * ax) - f(bx * az)), nx = f(f(by * az) - f(bz * ay));
  const scale = tableRsqrt(f(f(f(f(nx * nx) + f(ny * ny)) + f(nz * nz)) + NORMAL_EPSILON));
  const face = [f(nx * scale), f(ny * scale), f(nz * scale)];
  for (const normal of [n0, n1, n2]) for (let i = 0; i < 3; i++) normal[i] = f(face[i] + normal[i]);
  return face;
}

/** DrawLodMesh 0x10b0ffa3-0x10b0ffbb: the back-face test's dot,
 * `(n.x·p.x + n.z·p.z) + n.y·p.y` at 24 bits, times Frame.Mirror (+0x20, a
 * float: ±1, +1 in the root frame and -1 in an odd-depth mirror frame). */
export const faceDot = (face, p0, mirror = 1) =>
  f(f(f(f(face[0] * p0[0]) + f(face[2] * p0[2])) + f(face[1] * p0[1])) * mirror);
/** Whether DrawLodMesh keeps a face (0x10b0ff90-0x10b0ffc9): the face is not
 * PF_Invisible (+0x0c bit 0, tested above) and either PF_TwoSided or
 * `faceDot < 0` (an unordered compare keeps nothing: NaN is not less). */
export const faceKept = (face, p0, mirror, flags) => !(flags & 1) && ((flags & PF.TwoSided) !== 0 || faceDot(face, p0, mirror) < 0);

/** DrawLodMesh 0x10b10863-0x10b1090f: normalize a summed vertex normal and
 * return the plane [x, y, z, W] with W = (P.x·n.x + P.y·n.y) + P.z·n.z, each
 * operation at 24 bits. */
export function vertexNormalPlane(point, normal) {
  const [x, y, z] = normal;
  const scale = tableRsqrt(f(f(f(f(x * x) + f(y * y)) + f(z * z)) + NORMAL_EPSILON));
  const ex = f(scale * x), ey = f(scale * y), ez = f(scale * z);
  return [ex, ey, ez, f(f(f(point[0] * ex) + f(point[1] * ey)) + f(point[2] * ez))];
}

/** DrawLodMesh 0x10b10924-0x10b10942: Fatness displaces a vertex along its
 * rounded normal by Fatness/16 - 8 units after W was taken. */
export const fatnessScale = fatness => f((fatness & 255) * 0.0625 - 8);
export const fattenPoint = (point, plane, scale) =>
  [f(scale * plane[0] + point[0]), f(scale * plane[1] + point[1]), f(scale * plane[2] + point[2])];

/** URender 0x10b26230: the actor's poly flags as DrawActorSprite passes them. */
export function actorPolyFlags(actor, { rendMap = 5, noLighting = false } = {}) {
  let flags = actor.Style === 2 ? PF.Masked : actor.Style === 3 ? PF.Translucent : actor.Style === 4 ? PF.Modulated : 0;
  if (actor.bNoSmooth) flags |= PF.NoSmooth;
  if (actor.bSelected) flags |= PF.Selected;
  if (actor.bMeshEnviroMap) flags |= PF.Environment;
  if (!actor.bMeshCurvy) flags |= PF.Flat;
  if (actor.bUnlit || !(actor.ZoneNumber & 255) || rendMap !== 5 || noLighting) flags |= PF.Unlit;
  return flags >>> 0;
}

/** DrawLodMesh 0x10b0f6d2: the colour every PF_Unlit face uses. */
export function unlitColor(ambientGlow, scaleGlow) {
  let value = (ambientGlow & 255) * 0.00390625 + scaleGlow * 0.5;
  value = value < 0 ? 0 : value < 1 ? value : 1;
  return [f(value), f(value), f(value)];
}

/** D3DDrv DrawGouraudPolygon 0x10005942-0x100059ac: FISTP(float(L·scale·255))
 * per channel, packed ARGB with alpha 0xff. SetTexture's stage scale is
 * float(MaxColor·(1/255)); 8888 devices use MaxColor 255, giving exactly 1. */
export const D3D_MAX_COLOR_SCALE = f(255 * f(1 / 255));
export function d3dDiffuse(light, scale = D3D_MAX_COLOR_SCALE) {
  const channel = value => fistp(f(value * scale * 255)) & 255;
  return (0xff000000 | (channel(light[0]) << 16) | (channel(light[1]) << 8) | channel(light[2])) >>> 0;
}

// The texture-palette LightTypes (8, 9) are not translated (no map light
// uses them; scripts/census-moving-lights.mjs) and stay steady.
export const LIGHT_TYPE_UNSUPPORTED = new Set([8, 9]);

/** Core's Sort<T> (0x10b0b830) over candidate lights, with
 * Compare(A, B) = A.key > B.key ? -1 : 1. Unstable, reproduced exactly. */
export function sortLightCandidates(items) {
  const compare = (a, b) => (a.key > b.key ? -1 : 1);
  const swap = (i, j) => { const t = items[i]; items[i] = items[j]; items[j] = t; };
  if (items.length < 2) return items;
  const stack = [[0, items.length - 1]];
  while (stack.length) {
    let [min, max] = stack.pop();
    for (;;) {
      const count = max - min + 1;
      if (count <= 8) {
        while (max > min) {
          let best = min;
          for (let item = min + 1; item <= max; item++) if (compare(items[item], items[best]) > 0) best = item;
          swap(best, max--);
        }
        break;
      }
      swap(min + (count >> 1), min);
      let innerMin = min, innerMax = max + 1;
      for (;;) {
        while (++innerMin <= max && compare(items[innerMin], items[min]) <= 0);
        while (--innerMax > min && compare(items[innerMax], items[min]) >= 0);
        if (innerMin > innerMax) break;
        swap(innerMin, innerMax);
      }
      swap(min, innerMax);
      // Recurse into the smaller partition first, as UnTemplate.h does.
      if (innerMax - 1 - min >= max - innerMin) {
        if (min + 1 < innerMax) stack.push([min, innerMax - 1]);
        if (innerMin < max) { min = innerMin; continue; }
      } else {
        if (innerMin < max) stack.push([innerMin, max]);
        if (min + 1 < innerMax) { max = innerMax - 1; continue; }
      }
      break;
    }
  }
  return items;
}

// FGetHSV and the per-light constants are pure functions of a few bytes and
// floats; the 80-bit model is exact but slow, so results are memoized.
const hsvCache = new Map(), constantCache = new WeakMap();
function cachedHsv(hue, saturation, value) {
  const key = (hue & 255) << 16 | (saturation & 255) << 8 | value & 255;
  let hsv = hsvCache.get(key);
  if (!hsv) hsvCache.set(key, hsv = fgetHsv(hue & 255, saturation & 255, value & 255));
  return hsv;
}
function cachedConstants(values, levelBrightness, hsv) {
  // cachedHsv owns immutable arrays, so their identity retains all three
  // channels. The remaining 32 + 8 + 8 bits fit exactly in a JS number.
  // Keep the float bits (including signed zero), without building a string
  // and a temporary HSV-bit array for every selected light on every actor.
  let entries = constantCache.get(hsv);
  if (!entries) constantCache.set(hsv, entries = new Map());
  const key = bitsOf(levelBrightness) * 65536 + ((values.LightRadius & 255) << 8 | values.LightBrightness & 255);
  let constants = entries.get(key);
  if (!constants) entries.set(key, constants = movingLightConstants(values, levelBrightness, hsv));
  return constants;
}

/** One light manager per renderer: the per-call stamp, the per-actor visibility
 * caches (GCache items Index*256+0x30) and Strobe's global state
 * (light-globals.mjs; `strobe` shares the simulation's when given). */
export function createMeshLightManager({ strobe = { time: 0, flag: 0 } } = {}) {
  return { stamp: 0, caches: new Map(), strobe, diagnostics: new Set() };
}
const ZERO_NOISE = { A: new Float32Array(256) };

/** FLightManager::SetupForActor (0x10b08c70) followed by the per-light
 * ComputeFromActor colour, for one draw of `actor` (the light sink).
 *
 * `actor` supplies the reflected fields it reads plus `index` (UObject Index,
 * the cache key) and `location`/`zone`/`iLeaf`/`zoneNumber`.
 * `scene` supplies `levelInfo` ({ambient [brightness, hue, saturation],
 * brightness, timeSeconds}), `model` ({leaves, lights}), `lightOf(ref)`,
 * `leafLights` (moving lights filtered into the actor's leaf), `lineCheck(light)`
 * (true when the BSP segment from the actor to the light is clear), `viewport`
 * ({currentTime, lastUpdateTime, frameCount}), `rendMap`, `noLighting`,
 * `worldToCamera(location)` (the Frame coordinates) and `alive(light)`.
 * A light is {values, location, index} with `values` its reflected fields. */
export function setupForActor(manager, actor, scene) {
  const result = setupAmbient(actor, scene);
  const leaf = scene.model.leaves[actor.iLeaf];
  if (!lightsActor(actor, scene)) return result;
  const stamp = ++manager.stamp;
  const elapsed = (scene.viewport.currentTime - scene.viewport.lastUpdateTime) * 768;
  const step = Math.min(255, Math.max(0, Math.trunc(elapsed)));
  let cache = manager.caches.get(actor.index), newCache = false;
  if (cache) cache = cache.filter(entry => scene.alive(entry.light) && entry.light.index === entry.index);
  else { cache = []; newCache = true; }
  // The original stamps the light actor itself (ExtraTag), so identity is the
  // actor; `scene.current` refreshes a cached entry to this frame's fields.
  const tags = new Map(), list = [], identity = light => light.actor ?? light;
  const consider = (light, fade) => {
    if (list.length >= 120 || tags.get(identity(light))?.stamp === stamp) return;
    // 0x10b090a7-0x10b09194 at 24 bits: the differences on the stack,
    // (dz² + dy²) + dx² stored, R² against it, the key
    // `(1 − √d²/R)·brightness·1024.0` stored before FISTP.
    const values = light.values, dx = f(f(light.location[0]) - f(actor.location[0]));
    const dy = f(f(light.location[1]) - f(actor.location[1])), dz = f(f(light.location[2]) - f(actor.location[2]));
    const dist2 = f(f(f(dz * dz) + f(dy * dy)) + f(dx * dx));
    const radius = f(worldLightRadius(values));
    if (Boolean(values.bSpecialLit) !== Boolean(actor.bSpecialLit) || !(f(radius * radius) > dist2)) return;
    let brightness = values.LightBrightness & 255, r = radius;
    if ((values.LightEffect & 255) === 17) { brightness = f(brightness * 0.75); r = f(r * 0.75); }
    const key = fistp(f(f(f(1 - f(tableSqrt(dist2) / r)) * brightness) * 1024));
    const tag = { stamp, key, fade };
    tags.set(identity(light), tag);
    list.push({ light, key, tag });
  };
  for (const entry of cache) consider(scene.current?.(entry.light) ?? entry.light, entry.fade);
  if (leaf && leaf.permeating >= 0 && list.length < 120)
    for (let i = leaf.permeating; i < scene.model.lights.length && scene.model.lights[i] && list.length < 120; i++)
      consider(scene.lightOf(scene.model.lights[i]), 0);
  for (const light of scene.leafLights ?? []) { if (list.length >= 120) break; consider(light, 255); }
  sortLightCandidates(list);
  let count = 0, staticCount = 0, threshold = -1;
  const added = [];
  for (const { light, key, tag } of list) {
    const values = light.values, bStatic = Boolean(values.bStatic);
    if (key >= threshold && (bStatic ? staticCount : count) < 8) {
      let visible;
      if (!bStatic && values.bMovable) visible = true;
      else if (!newCache && ((light.index ^ scene.viewport.frameCount) & 15) !== 0) visible = Boolean(tag.fade & 1);
      else {
        visible = scene.lineCheck(light);
        result.traced.push(light);
        if (visible && newCache) tag.fade = 255;
      }
      if (visible) {
        count++;
        if (bStatic) staticCount++;
        if (threshold === -1) threshold = Math.trunc(key / 8);
        added.push(light);
        tag.fade = Math.min(255, tag.fade + step) | 1;
        continue;
      }
    }
    tag.fade = Math.max(0, tag.fade - step) & ~1;
    if (tag.fade > 0) added.push(light);
  }
  const written = [];
  for (const { light, tag } of list) if (written.length < 16 && tag.fade > 1) written.push({ light, fade: tag.fade, index: light.index });
  manager.caches.set(actor.index, written);
  return finishSetup(manager, actor, scene, result, added.map(light => ({ light, fade: tags.get(identity(light)).fade })));
}

/** SetupForActor's ambient (the zone's FGetHSV plus AmbientGlow) and the
 * empty result the light selection fills. */
export function setupAmbient(actor, scene) {
  const zone = actor.zone ?? scene.levelInfo;
  // 0x10b08da6-0x10b08dde at 24 bits: AmbientGlow·(1/255) (a double), or for
  // 255 `fsin(CurrentTime·8.0)·0.2 + 0.25` (FSIN is the host's sin; the
  // products and sum round exactly once each).
  const glow = f((actor.AmbientGlow & 255) === 255
    ? r24sum(r24prod(Math.sin(r24prod(scene.viewport.currentTime, 8)), 0.2), 0.25)
    : r24prod(actor.AmbientGlow & 255, 1 / 255));
  const hsv = cachedHsv(zone.ambient[1], zone.ambient[2], zone.ambient[0]);
  const ambient = [f(glow + hsv[0]), f(glow + hsv[1]), f(glow + hsv[2])];
  return { ambient, scaleGlow: f(actor.ScaleGlow), lights: [], flags: 0, traced: [] };
}
/** Whether SetupForActor selects lights for `actor` at all. */
export const lightsActor = (actor, scene) =>
  !(actor.bUnlit || actor.iLeaf === -1 || !scene.model.leaves.length || scene.rendMap !== 5 || scene.noLighting);

/** SetupForActor's tail: AddLight for each selected light in order
 * (`added`: {light, fade} with the light's final fade), with its
 * ComputeFromActor colour. */
export function finishSetup(manager, actor, scene, result, added) {
  // AddLight (0x10b08b30) with an owner: skip the owner itself and dark or
  // typeless lights; every accepted light is class 2.
  for (let i = 0; i < added.length; i++) {
    const light = added[i].light, tagFade = added[i].fade, values = light.values;
    if (light.actor === actor.self || !(values.LightType & 255) || !(values.LightBrightness & 255)) continue;
    if (result.lights.length >= 256) break; // (0x10b495c0 - 0x10b401c0) / 0x94 FLightInfo slots
    const type = values.LightType & 255;
    if (LIGHT_TYPE_UNSUPPORTED.has(type)) manager.diagnostics.add(`LightType ${type} function is not applied to mesh lighting`);
    if (type === 4 && !scene.noise) manager.diagnostics.add('Flicker mesh lights read a zero noise table: no light noise is running');
    const levelBrightness = f(scene.levelInfo.brightness);
    // ComputeFromActor's GlobalLighting (0x10b0611c): the LightType function
    // at the render pass's 24 bits, with this frame's Level.TimeSeconds,
    // the light noise's table A (Flicker, at the light's flicker key) and
    // the shared Strobe state; then the clamp to [0, 1].
    // A Steady light keeps LightBrightness/255 (most lights; no call needed).
    const brightness = type === 1 ? f((values.LightBrightness & 255) * f(1 / 255))
      : f(lightTypeBrightness(values, { timeSeconds: scene.levelInfo.timeSeconds, noise: scene.noise ?? ZERO_NOISE,
        strobe: manager.strobe, flickerKey: light.flickerKey ?? 0 }));
    const hsv = cachedHsv(values.LightHue, values.LightSaturation, 255);
    const constants = cachedConstants(values, levelBrightness, hsv);
    const color = brightness === f((values.LightBrightness & 255) * f(1 / 255)) ? constants.color
      : movingLightConstants(values, levelBrightness, hsv, brightness).color;
    // 0x10b097ed-0x10b0980c: fild fade, fmul the double 1/255, kept on the
    // stack for the three colour products.
    const fade = r24prod(tagFade, 1 / 255);
    result.lights.push({ light, location: scene.worldToCamera(light.location), radius: constants.radius,
      rradius: constants.rradius, color: color.map(channel => f(fade * channel)), brightness, tagFade });
  }
  return result;
}

const ld = x87load, st = x87store, sub = (a, b) => x87add(a, x87neg(b));
const X_ZERO = x87load(0), X_ONE = x87double(1), X_ONE_HALF = x87double(1.5), X_SIX = x87double(6), X_GLOW = x87double(1.4);

/** FLightManager::Light (0x10b027f0) on the BigInt x87 model at precision
 * control 24 (x87-pc24.mjs: each operation rounded once to 24 bits, the
 * double constants 1.0, 1.5, 6.0 and 1.4 included), in the original order
 * with its float stores. This is the reference translation; `lightVertex`
 * below is the binary32 path Play uses. */
export function lightVertexX87(setup, point, plane, flags) {
  let r = 0.5, g = 0.5, b = 0.5;
  if (!(flags & PF.Unlit)) {
    r = g = b = 0;
    const [px, py, pz] = point.map(ld), [nx, ny, nz, nw] = plane.map(ld);
    const p2 = st(x87add(x87add(x87mul(px, px), x87mul(py, py)), x87mul(pz, pz)));
    for (const info of setup.lights) {
      const [lx, ly, lz] = info.location.map(ld);
      const dz = st(sub(lz, pz)), dy = st(sub(ly, py)), dxe = sub(lx, px), dx = st(dxe);
      const dist2 = st(x87add(x87add(x87mul(dxe, ld(dx)), x87mul(ld(dy), ld(dy))), x87mul(ld(dz), ld(dz))));
      const dist = tableSqrt(dist2);
      const num = x87add(x87add(x87mul(ld(dy), ny), x87mul(ld(dz), nz)), x87mul(ld(dx), nx));
      const c = x87add(x87div(num, ld(dist)), X_ONE);
      let diffuse = st(sub(x87mul(c, c), X_ONE_HALF));
      if (x87cmp(ld(diffuse), X_ZERO) === 'lt' || Number.isNaN(diffuse)) diffuse = 0;
      const planeDot = sub(x87add(x87add(x87mul(lz, nz), x87mul(ly, ny)), x87mul(lx, nx)), nw);
      const s2 = ld(st(x87add(planeDot, planeDot)));
      const [tx, ty, tz] = [nx, ny, nz].map(n => ld(st(x87mul(s2, n))));
      const [rx, ry, rz] = [sub(lx, tx), sub(ly, ty), sub(lz, tz)].map(v => ld(st(v)));
      const specular = sub(x87add(x87add(x87mul(rx, px), x87mul(rz, pz)), x87mul(ry, py)), ld(p2));
      const total = x87cmp(specular, X_ZERO) === 'gt'
        ? x87add(x87div(x87mul(x87mul(specular, specular), X_SIX), x87mul(ld(dist2), ld(p2))), ld(diffuse))
        : ld(diffuse);
      const amount = x87mul(total, sub(X_ONE, x87mul(ld(dist), ld(info.rradius))));
      if (x87cmp(amount, X_ZERO) === 'gt') {
        const [cr, cg, cb] = info.color.map(ld);
        const green = st(x87mul(amount, cg)), blue = st(x87mul(amount, cb));
        r = st(x87add(x87mul(amount, cr), ld(r)));
        g = st(x87add(ld(green), ld(g)));
        b = st(x87add(ld(blue), ld(b)));
      }
    }
  }
  const scale = x87mul(ld(setup.scaleGlow), X_GLOW), [ar, ag, ab] = setup.ambient;
  const clamp = value => (x87cmp(value, X_ONE) === 'gt' ? 1 : st(value));
  return [clamp(x87add(x87mul(ld(r), scale), ld(ar))), clamp(x87add(x87mul(ld(g), scale), ld(ag))),
    clamp(x87add(x87mul(scale, ld(b)), ld(ab)))];
}

/** FLightManager::Light (0x10b027f0) for a camera-space `point` with normal
 * plane `plane` [x, y, z, W]; returns the clamped [r, g, b]. Every operation
 * is binary32 (precision control 24 with float operands), `ScaleGlow·1.4`
 * (a double) rounded once from the exact product; validate-mesh-lighting
 * compares it with the original and with lightVertexX87. */
export function lightVertex(setup, point, plane, flags) {
  let r = 0, g = 0, b = 0;
  if (flags & PF.Unlit) r = g = b = 0.5;
  else {
    const px = f(point[0]), py = f(point[1]), pz = f(point[2]);
    const nx = f(plane[0]), ny = f(plane[1]), nz = f(plane[2]), nw = f(plane[3]);
    const p2 = f(f(f(px * px) + f(py * py)) + f(pz * pz));
    for (const info of setup.lights) {
      const [lx, ly, lz] = info.location;
      const dz = f(lz - pz), dy = f(ly - py), dx = f(lx - px);
      const dist2 = f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz)), dist = tableSqrt(dist2);
      const c = f(f(f(f(f(dy * ny) + f(dz * nz)) + f(dx * nx)) / dist) + 1);
      let diffuse = f(f(c * c) - 1.5);
      if (!(diffuse >= 0)) diffuse = 0;
      const planeDot = f(f(f(f(lz * nz) + f(ly * ny)) + f(lx * nx)) - nw), s2 = f(planeDot + planeDot);
      const rx = f(lx - f(s2 * nx)), ry = f(ly - f(s2 * ny)), rz = f(lz - f(s2 * nz));
      const specular = f(f(f(f(rx * px) + f(rz * pz)) + f(ry * py)) - p2);
      const total = specular > 0 ? f(f(f(f(specular * specular) * 6) / f(dist2 * p2)) + diffuse) : diffuse;
      const amount = f(total * f(1 - f(dist * info.rradius)));
      if (amount > 0) {
        const [cr, cg, cb] = info.color;
        r = f(f(amount * cr) + r);
        g = f(f(amount * cg) + g);
        b = f(f(amount * cb) + b);
      }
    }
  }
  const scale = r24prod(f(setup.scaleGlow), 1.4), [ar, ag, ab] = setup.ambient;
  const clamp = value => (value > 1 ? 1 : value);
  return [clamp(f(f(r * scale) + ar)), clamp(f(f(g * scale) + ag)), clamp(f(f(scale * b) + ab))];
}
