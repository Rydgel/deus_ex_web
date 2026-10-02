// Volumetric lighting (fog maps, docs/volumetric-fog.md): ComputeFromActor's
// volumetric constants (Render.dll 0x10b06868-0x10b06c19) and SetupForSurf's
// fog-map block (0x10b07162-0x10b07c4a) on the x87 model.
import { x87load, x87double, x87int32, x87mul, x87add, x87neg, x87div, x87store, x87cmp } from './script-vm.mjs';
import { fistp, tableSqrt, colorTableEntry } from './dynamic-lighting.mjs';

const ld = x87load, st = x87store, sub = (a, b) => x87add(a, x87neg(b));
const f = Math.fround;
const ZERO = ld(0), ONE_F = ld(1), THREE = ld(3), S255 = ld(255);
const R_SCALE = x87double(25), V_BRIGHT = ld(0.015625), FOG_SCALE = ld(f(1 / 255));
const io = new DataView(new ArrayBuffer(4));
const bitsOf = v => (io.setFloat32(0, v, true), io.getUint32(0, true));

/** The inline FCoords::TransformPointBy (Origin subtracted) and
 * TransformVectorBy: each component `(d.x·A.x + d.y·A.y) + d.z·A.z` with the
 * differences and sums kept in 80 bits, stored to float32. `coords` is
 * {origin, x, y, z} (FSceneNode +0x34). */
export function coordsTransform(p, coords, point = true) {
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
  const steps = [...color, fog].map(channel => fistp(f(channel * 65536) - .5));
  const table = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    table[i * 4] = colorTableEntry(steps[2], i); table[i * 4 + 1] = colorTableEntry(steps[1], i);
    table[i * 4 + 2] = colorTableEntry(steps[0], i); table[i * 4 + 3] = colorTableEntry(steps[3], i);
  }
  const compare = x87cmp(distanceSq, ld(radiusSq));
  return {
    location: location.map(f), radius: st(radius), radiusSq, invRadius: st(invRadius), invRadiusSq: st(x87mul(invRadius, invRadius)),
    distanceSq: st(distanceSq), brightness: st(x87mul(x87mul(x87int32(volumeBrightness & 255), ld(brightness)), V_BRIGHT)),
    inside: compare === 'lt' || compare === 'un', fog, table,
  };
}

/** SetupForSurf's per-light sort (appQsort with 0x10b06c60): a light
 * nearer in camera Z sorts after a farther one. The comparator never returns
 * 0; equal depths keep the host sort's order (see docs). */
export const sortVolumetricLights = lights => lights.slice().sort((a, b) => b.location[2] - a.location[2]);

// One texel's fog fraction (0x10b075dc-0x10b07824 and 0x10b078f3-0x10b07b07):
// the light's sphere along the eye ray to P, `first` choosing the first
// light's extended scale or the later lights' float store. Returns the
// colour-table index, or -1 for the later-light skip.
function texelIndex(light, px, py, pz, state, first) {
  const [lx, ly, lz] = light.location;
  const dot = st(x87add(x87add(x87mul(ld(pz), ld(lz)), x87mul(ld(py), ld(ly))), x87mul(ld(px), ld(lx))));
  const miss = () => first ? 0 : -1;
  if (!light.inside && bitsOf(dot) >= 0x80000000) return miss();
  const pp = x87add(x87add(x87mul(ld(px), ld(px)), x87mul(ld(pz), ld(pz))), x87mul(ld(py), ld(py)));
  const dd = x87mul(ld(dot), ld(dot));
  if (state.missFlag) {
    const c = x87cmp(sub(x87mul(pp, ld(light.distanceSq)), dd), x87mul(pp, ld(light.radiusSq)));
    if (c === 'gt') return miss();
  }
  const h2 = st(sub(ld(light.distanceSq), x87div(dd, pp)));
  if (x87cmp(ld(light.radiusSq), ld(h2)) === 'lt' || x87cmp(ld(light.radiusSq), ld(h2)) === 'un') { state.missFlag = 1; return miss(); }
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
  if (!lessU(s, far)) return miss();
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
  if (below === 'lt' || below === 'un') return miss();
  if (bitsOf(st(v)) >= 0x3f800000) v = ONE_F;
  if (first) return fistp(st(x87mul(v, S255)));
  const vf = st(v);
  return vf === 0 && bitsOf(vf) === 0 ? -1 : fistp(st(x87mul(ld(vf), S255)));
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
