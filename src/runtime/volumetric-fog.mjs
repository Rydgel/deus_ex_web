// Volumetric lighting (fog maps, docs/volumetric-fog.md): ComputeFromActor's
// volumetric constants (Render.dll 0x10b06868-0x10b06c19) and SetupForSurf's
// fog-map block (0x10b07162-0x10b07c4a). They run inside the render pass,
// under precision control 24 (docs/render-pass-precision.md): the x87 model
// here rounds every arithmetic result to 24 bits (x87-pc24.mjs).
import { x87load, x87double, x87int32, x87store, x87cmp } from './script-vm.mjs';
import { p24mul as x87mul, p24add as x87add, p24div as x87div, p24sub as sub, r24 } from './x87-pc24.mjs';
import { fistp, tableSqrt, colorTableEntry, squareRootTable } from './dynamic-lighting.mjs';

const ld = x87load, st = x87store;
const f = Math.fround;
const ZERO = ld(0), ONE_F = ld(1), THREE = ld(3), S255 = ld(255);
const R_SCALE = x87double(25), V_BRIGHT = ld(0.015625), FOG_SCALE = ld(f(1 / 255));
const io = new DataView(new ArrayBuffer(4));
const bitsOf = v => (io.setFloat32(0, v, true), io.getUint32(0, true));

/** The inline FCoords::TransformPointBy (Origin subtracted) and
 * TransformVectorBy: each component `(d.x·A.x + d.y·A.y) + d.z·A.z`, the
 * differences and sums held in registers (24-bit significands in the render
 * pass), stored to float32. `coords` is {origin, x, y, z} (FSceneNode
 * +0x34). Finite inputs take doubles rounded with r24 (exact, as every
 * operand is a float32); others the BigInt model. */
export function coordsTransform(p, coords, point = true) {
  const { origin, x: ax, y: ay, z: az } = coords;
  if ([p, origin, ax, ay, az].every(v => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]))) {
    const d0 = point ? r24(f(p[0]) - f(origin[0])) : f(p[0]), d1 = point ? r24(f(p[1]) - f(origin[1])) : f(p[1]);
    const d2 = point ? r24(f(p[2]) - f(origin[2])) : f(p[2]);
    const row = a => f(r24(r24(r24(d0 * f(a[0])) + r24(d1 * f(a[1]))) + r24(d2 * f(a[2]))));
    return [row(ax), row(ay), row(az)];
  }
  return coordsTransformExact(p, coords, point);
}

/** coordsTransform on the BigInt PC 24 model (any input; the reference
 * validate-volumetric-fog compares the double form with). */
export function coordsTransformExact(p, coords, point = true) {
  const d = [0, 1, 2].map(i => point ? sub(ld(p[i]), ld(coords.origin[i])) : ld(p[i]));
  return [coords.x, coords.y, coords.z].map(a => st(x87add(x87add(x87mul(d[0], ld(a[0])), x87mul(d[1], ld(a[1]))), x87mul(d[2], ld(a[2])))));
}

/** The fog attenuation table (light-manager init 0x10b020cf-0x10b0210f):
 * row a, column v = trunc((127 − a)·v / 127). */
export const FOG_ATTENUATION = (() => {
  const t = new Uint8Array(128 * 128);
  for (let a = 0; a < 128; a++) for (let v = 0; v < 128; v++) t[a * 128 + v] = Math.trunc((127 - a) * v / 127);
  return t;
})();

/** ComputeFromActor's volumetric constants for a light flagged volumetric
 * (info +0x30). `location` is the light in camera space (info +0x08, the
 * TransformPointBy of its Location), `color` the GlobalLighting colour
 * already scaled by Level.Brightness·brightness (info +0x6c), `brightness`
 * info +0x20, and the byte properties VolumeRadius (+0x1ea),
 * VolumeBrightness (+0x1e9) and VolumeFog (+0x1eb). */
export function volumetricLight({ location, color, brightness, volumeRadius, volumeBrightness, volumeFog }) {
  const radius = x87mul(x87int32(((volumeRadius & 255) + 1) | 0), R_SCALE);
  const radiusSq = st(x87mul(radius, radius));
  const invRadius = x87div(ONE_F, radius);
  const [X, Y, Z] = location.map(ld);
  const distanceSq = x87add(x87add(x87mul(X, X), x87mul(Y, Y)), x87mul(Z, Z));
  const fog = st(x87mul(x87int32(volumeFog & 255), FOG_SCALE));
  // The 256-entry colour table (0x10b06a35-0x10b06b60): BGRA bytes from
  // 16.16 steps of R, G, B and the fog fraction, each capped at 127.
  // fstp of channel·65536.0 (exact), then fsub 0.5f under PC 24.
  const steps = [...color, fog].map(channel => fistp(f(f(channel * 65536) - .5)));
  const table = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    table[i * 4] = colorTableEntry(steps[2], i); table[i * 4 + 1] = colorTableEntry(steps[1], i);
    table[i * 4 + 2] = colorTableEntry(steps[0], i); table[i * 4 + 3] = colorTableEntry(steps[3], i);
  }
  const compare = x87cmp(distanceSq, ld(radiusSq));
  return {
    location: location.map(f), radius: st(radius), radiusSq, invRadius: st(invRadius), invRadiusSq: st(x87mul(invRadius, invRadius)),
    distanceSq: st(distanceSq), brightness: st(x87mul(x87mul(x87int32(volumeBrightness & 255), ld(brightness)), V_BRIGHT)),
    inside: compare === 'lt' || compare === 'un', fog, table, color: color.map(Math.fround),
  };
}

/** SetupForSurf's per-light sort (appQsort with 0x10b06c60): a light
 * nearer in camera Z sorts after a farther one. The comparator never returns
 * 0; equal depths keep the host sort's order (see docs). */
export const sortVolumetricLights = lights => lights.slice().sort((a, b) => b.location[2] - a.location[2]);

// The light's sphere along the eye ray to P (SetupForSurf's per-texel body
// 0x10b075dc-0x10b07824 / 0x10b078f3-0x10b07b07 and FLightManager::Fog
// 0x10b02c83-0x10b02e7f): the clamped chord value in 80 bits, or null for a
// miss. `vertex` selects Fog's out-of-line Core SizeSquared, which sums
// (x² + y²) + z² where the surface loop sums (x² + z²) + y².
function chordValue(light, px, py, pz, state, vertex = false) {
  const [lx, ly, lz] = light.location;
  const dot = st(x87add(x87add(x87mul(ld(pz), ld(lz)), x87mul(ld(py), ld(ly))), x87mul(ld(px), ld(lx))));
  if (!light.inside && bitsOf(dot) >= 0x80000000) return null;
  const pp = vertex ? x87add(x87add(x87mul(ld(px), ld(px)), x87mul(ld(py), ld(py))), x87mul(ld(pz), ld(pz)))
    : x87add(x87add(x87mul(ld(px), ld(px)), x87mul(ld(pz), ld(pz))), x87mul(ld(py), ld(py)));
  const dd = x87mul(ld(dot), ld(dot));
  if (state.missFlag) {
    const c = x87cmp(sub(x87mul(pp, ld(light.distanceSq)), dd), x87mul(pp, ld(light.radiusSq)));
    if (c === 'gt') return null;
  }
  const h2 = st(sub(ld(light.distanceSq), x87div(dd, pp)));
  if (x87cmp(ld(light.radiusSq), ld(h2)) === 'lt' || x87cmp(ld(light.radiusSq), ld(h2)) === 'un') { state.missFlag = 1; return null; }
  state.missFlag = 0;
  const length = tableSqrt(st(pp));
  const t = st(x87div(ld(dot), ld(length)));
  const w = tableSqrt(st(sub(ld(light.radiusSq), ld(h2))));
  let s = st(sub(ld(t), ld(length))), clamped = false, far;
  const lessU = (a, b) => { const c = x87cmp(ld(a), ld(b)); return c === 'lt' || c === 'un'; };
  if (!lessU(t, w) && x87cmp(ld(t), ld(w)) !== 'eq') {
    if (lessU(s, -w)) { s = -w; clamped = true; }
    far = w;
  } else {
    if (lessU(s, -w)) s = -w;
    far = t;
  }
  if (!lessU(s, far)) return null;
  const hn = st(x87mul(ld(h2), ld(light.invRadiusSq)));
  const a = x87mul(ld(far), ld(light.invRadius));
  const c = sub(THREE, x87mul(ld(hn), THREE));
  let v;
  if (clamped) v = x87add(...(p => [p, p])(x87mul(x87mul(sub(c, x87mul(a, a)), a), ld(light.brightness))));
  else {
    const b = x87mul(ld(s), ld(light.invRadius));
    const A = x87mul(a, sub(c, x87mul(a, a)));
    v = x87mul(sub(A, x87mul(sub(c, x87mul(b, b)), b)), ld(light.brightness));
  }
  const below = x87cmp(v, ZERO);
  if (below === 'lt' || below === 'un') return null;
  return bitsOf(st(v)) >= 0x3f800000 ? ONE_F : v;
}

// One texel's colour-table index: the first light writes table[0] for a
// miss and scales the 80-bit value, later lights skip a miss (-1) and scale
// the float store.
function texelIndex(light, px, py, pz, state, first) {
  const v = chordValue(light, px, py, pz, state);
  if (!v) return first ? 0 : -1;
  if (first) return fistp(st(x87mul(v, S255)));
  const vf = st(v);
  return vf === 0 && bitsOf(vf) === 0 ? -1 : fistp(st(x87mul(ld(vf), S255)));
}

/** FLightManager::Fog (0x10b02c00) for a mesh vertex under PF_RenderFog:
 * the vertex in frame space against the sorted volumetric lights. Each
 * light's chord value is doubled; a = min(1, 2v·fog), each channel
 * min(1, 2v·colour + (1 − a)·old), alpha min(1, old + a). Returns the FPlane
 * [R, G, B, A]. `state.missFlag` is the shared early-out flag. */
export function fogVertex(point, lights, state = { missFlag: 0 }) {
  let r = 0, g = 0, b = 0, alpha = 0;
  const clampStore = value => { const f32 = st(value); return bitsOf(f32) >= 0x3f800000 ? 1 : f32; };
  for (const light of sortVolumetricLights(lights)) {
    const v = chordValue(light, point[0], point[1], point[2], state, true);
    const twice = st(x87add(v ?? ZERO, v ?? ZERO));
    if (bitsOf(twice) === 0) continue;
    const a = clampStore(x87mul(ld(twice), ld(light.fog)));
    const k = sub(ONE_F, ld(a));
    const [cr, cg, cb] = light.color;
    r = clampStore(x87add(x87mul(ld(twice), ld(cr)), x87mul(k, ld(r))));
    g = clampStore(x87add(x87mul(ld(twice), ld(cg)), x87mul(k, ld(g))));
    b = clampStore(x87add(x87mul(ld(twice), ld(cb)), x87mul(k, ld(b))));
    alpha = clampStore(x87add(ld(alpha), ld(a)));
  }
  return [r, g, b, alpha];
}

/** SetupForSurf's fog map for one surface: `grid` {base, stepU, stepV} in
 * world space, `width`×`height` texels, `coords` the frame (FSceneNode
 * +0x34), `lights` from volumetricLight. Returns BGRA bytes (7-bit
 * channels), rows of `width`, or null without lights. `state.missFlag` is
 * the global early-out flag 0x10b4ea00, which persists across surfaces. */
export function fogMap({ grid, width, height, coords, lights, state = { missFlag: 0 } }) {
  if (!lights.length) return null;
  const base = coordsTransform(grid.base, coords), stepU = coordsTransform(grid.stepU, coords, false);
  const stepV = coordsTransform(grid.stepV, coords, false);
  const out = new Uint8Array(width * height * 4);
  let first = true;
  for (const light of sortVolumetricLights(lights)) {
    let [rx, ry, rz] = base;
    for (let v = 0; v < height; v++) {
      let px = rx, py = ry, pz = rz;
      for (let u = 0; u < width; u++) {
        const index = texelIndex(light, px, py, pz, state, first), at = (v * width + u) * 4;
        const t = light.table;
        if (first) { out[at] = t[index * 4]; out[at + 1] = t[index * 4 + 1]; out[at + 2] = t[index * 4 + 2]; out[at + 3] = t[index * 4 + 3]; }
        else if (index >= 0) {
          const alpha = t[index * 4 + 3], row = alpha * 128;
          for (let c = 0; c < 3; c++) out[at + c] = Math.min(127, FOG_ATTENUATION[row + out[at + c]] + t[index * 4 + c]);
          out[at + 3] = Math.min(127, out[at + 3] + alpha);
        }
        px = f(stepU[0] + px); py = f(stepU[1] + py); pz = f(pz + stepU[2]);
      }
      rx = f(stepV[0] + rx); ry = f(ry + stepV[1]); rz = f(rz + stepV[2]);
    }
    first = false;
  }
  return out;
}

/** The same fog map through the Rust core (native/script-vm/src/fog.rs):
 * `kernel.fog` from script-vm-kernel.mjs. The early-out flag lives in the
 * kernel; `state.missFlag` is written before and read back after. Returns
 * null when the surface exceeds the kernel's buffers. */
const kernelsWithTable = new WeakSet();
// FOG_EXACT=1 (Node only) keeps every texel on the Ext model, for A/B runs
// of fog.rs's certain-rounding fast path.
const FOG_EXACT = typeof process !== 'undefined' && process.env?.FOG_EXACT === '1';
/** The frame's lights sorted and packed for the kernel: the words (nine per light) and the colour tables. */
function packLights(lights) {
  const sorted = sortVolumetricLights(lights), words = new Uint32Array(sorted.length * 9), tables = new Uint8Array(sorted.length * 1024);
  sorted.forEach((light, k) => {
    words.set([...light.location.map(bitsOf), bitsOf(light.radiusSq), bitsOf(light.invRadius), bitsOf(light.invRadiusSq),
      bitsOf(light.distanceSq), bitsOf(light.brightness), light.inside ? 1 : 0], k * 9);
    tables.set(light.table, k * 1024);
  });
  return { count: sorted.length, words, tables };
}
// A frame's surfaces share one `lights` array (fog-pass.mjs lightsFor: one per frame's coords, never changed after), and the sort, the words
// and the 1 KB colour tables depend on it alone: they are built once for the array and written into the kernel when the kernel holds another
// (Firefox, Underground: the per-surface sort and copies were 1.5 to 2 ms of a 14 ms fog phase). FOG_LIGHTS=each in Node, ?fogLights=each in
// the page, keep the pack and the writes for every surface.
const lightPacks = new WeakMap(), kernelLights = new WeakMap();
const lightsEachSurface = () => globalThis.DEUS_EX_FOG_LIGHTS === 'each' || (typeof process !== 'undefined' && process.env?.FOG_LIGHTS === 'each');
export function fogMapKernel(kernel, { grid, width, height, coords, lights, state = { missFlag: 0 } }) {
  if (!lights.length) return null;
  const fog = kernel.fog;
  if (!kernelsWithTable.has(fog)) { fog.sqrt(squareRootTable()); if (FOG_EXACT) fog.setExact(true); kernelsWithTable.add(fog); }
  let pack;
  if (lightsEachSurface()) { pack = packLights(lights); fog.lights(pack.words); fog.tables(pack.tables); kernelLights.delete(fog); }
  else {
    pack = lightPacks.get(lights);
    if (!pack) lightPacks.set(lights, pack = packLights(lights));
    if (kernelLights.get(fog) !== lights) { fog.lights(pack.words); fog.tables(pack.tables); kernelLights.set(fog, lights); }
  }
  fog.grid([...coordsTransform(grid.base, coords), ...coordsTransform(grid.stepU, coords, false),
    ...coordsTransform(grid.stepV, coords, false)].map(bitsOf));
  fog.setMiss(state.missFlag);
  const texels = fog.map(width, height, pack.count);
  state.missFlag = fog.miss();
  return texels;
}
