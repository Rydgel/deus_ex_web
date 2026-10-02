/** Static lights on BSP light maps through Render.dll's light-manager path
 * (docs/static-lighting.md). */
import { fistp, normalLightTable } from './dynamic-lighting.mjs';
import { x87load, x87double, x87int32, x87mul, x87add, x87neg, x87div, x87store } from './script-vm.mjs';

const f = Math.fround;
const scratch = new DataView(new ArrayBuffer(4));
const bitsOf = value => { scratch.setFloat32(0, value, true); return scratch.getUint32(0, true); };
const floatOf = bits => { scratch.setUint32(0, bits >>> 0, true); return scratch.getFloat32(0, true); };

// Light-manager init (0x10b02112): the shadow weight matrix, eight weights
// per row; rows 3-7 are zero. Its total is 320.
const SHADOW_WEIGHTS = [[0, 24, 40, 24, 0, 0, 0, 0], [0, 40, 64, 40, 0, 0, 0, 0], [0, 24, 40, 24, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]];

/** The table at 0x10b3cae0 (init 0x10b02352): for each 7-bit run of shadow
 * bits p and weight row r, four packed bytes, byte b = trunc(sum of the row's
 * weights k whose bit k+b of p is set, times 255, over the total). */
export const shadowTable = (() => {
  const total = SHADOW_WEIGHTS.flat().reduce((a, b) => a + b, 0), table = new Uint8Array(128 * 16);
  for (let p = 0; p < 128; p++) for (let r = 0; r < 4; r++) for (let b = 0; b < 4; b++) {
    let sum = 0;
    for (let k = 0; k < 8; k++) if (p & (1 << (k + b))) sum += SHADOW_WEIGHTS[r][k];
    table[p * 16 + r * 4 + b] = Math.trunc(sum * 255 / total);
  }
  return table;
})();

/** 0x10b02650: a static light's illumination bytes from its shadow bits
 * (row-aligned, least significant bit first; `bits` from `offset`), rows
 * padded to whole bytes (`stride = ceil(width/8)·8`). No bits (a light with
 * no shadow map) is 0x7f everywhere. Each shadow row scatters the table's
 * three weight rows into the rows above, at and below it, the first and
 * last rows taking their own outer contribution; along a row a sliding
 * window repeats the first texel twice to the left and the row's last bit
 * (the padding's, when the width is not a multiple of eight) twice to the
 * right. A single-row map's lower contribution falls past the map. */
export function shadowIllumination(bits, offset, width, height) {
  const pitch = (width + 7) >> 3, stride = pitch * 8, out = new Uint8Array(stride * height);
  if (!bits) return out.fill(0x7f);
  for (let r = 0; r < height; r++) {
    const rows = [Math.max(r - 1, 0), r, height === 1 ? -1 : Math.min(r + 1, height - 1)];
    const at = offset + r * pitch;
    let window = bits[at] << 10;
    if (window & 0x400) window |= 0x300;
    for (let k = 0; k < pitch; k++) {
      window >>>= 8;
      window += k < pitch - 1 ? bits[at + k + 1] << 10 : (window & 0x200 ? 0xc00 : 0);
      for (const [half, pattern] of [[0, window & 0x7f], [4, (window >>> 4) & 0x7f]])
        for (let w = 0; w < 3; w++) {
          if (rows[w] < 0) continue;
          const base = rows[w] * stride + k * 8 + half, entry = pattern * 16 + w * 4;
          for (let b = 0; b < 4; b++) out[base + b] += shadowTable[entry + b];
        }
    }
  }
  return out;
}

/** SetupForSurf 0x10b07fcc-0x10b080cf: the static map's fill texel from the
 * zone's FGetHSV(AmbientHue, AmbientSaturation, AmbientBrightness), each
 * channel `clamp(FISTP(float(float(c·0.25)·256) − 0.5), 0, 255)` (exact
 * power-of-two products), alpha 0x7f. `hsv` is fgetHsv's [R, G, B];
 * returns [R, G, B]. */
export function ambientTexel(hsv) {
  return hsv.map(channel => {
    const n = fistp(Math.fround(Math.fround(channel * 0.25) * 256) - 0.5);
    return n < 0 ? 0 : n >= 255 ? 255 : n;
  });
}

/** The light manager's power tables (init 0x10b022d0, builder 0x10b024b0):
 * appPow(|x|, power) stored as floats, NaN as 0, over the 512 sign/exponent
 * patterns (mantissa 0) and the 1024 mantissas of [1, 2). appPow is Core's
 * call into the CRT pow, an x87 transcendental the host takes as the JS
 * double; `margin` is the smallest distance (relative) from an f32 rounding
 * midpoint, far above a double's error. */
function powerTables(power) {
  let margin = Infinity;
  const entry = x => {
    const value = Math.pow(Math.abs(x), power);
    if (Number.isNaN(value)) return 0;
    const stored = f(value);
    if (Number.isFinite(value) && value !== 0 && Number.isFinite(stored)) {
      const ulp = Math.abs(f(stored * (1 + 2 ** -23)) - stored) || 2 ** -149;
      const lower = Math.abs(value - stored) / ulp;
      margin = Math.min(margin, Math.abs(0.5 - lower) * ulp / Math.abs(value));
    }
    return stored;
  };
  const exponent = Float32Array.from({ length: 512 }, (_, e) => entry(floatOf(e << 23)));
  const mantissa = Float32Array.from({ length: 1024 }, (_, i) => entry(floatOf(0x3f800000 + (i << 13))));
  return { exponent, mantissa, margin };
}
const RSQRT = powerTables(-0.5);
/** A copy of the x^-0.5 tables (0x10b33650 mantissas, 0x10b3d384 exponents). */
export const rsqrtTables = () => ({ mantissa: RSQRT.mantissa.slice(), exponent: RSQRT.exponent.slice(), margin: RSQRT.margin });

/** The table inverse square root (spot body 0x10b051ef): ten mantissa bits
 * and the sign/exponent byte select the two entries, multiplied and stored. */
export function tableRsqrt(value) {
  const bits = bitsOf(value);
  return f(RSQRT.mantissa[(bits >>> 13) & 0x3ff] * RSQRT.exponent[bits >>> 23]);
}

/** The spot body's cone constants (0x10b04ffc-0x10b05053): c = 1 -
 * LightCone/256 on the stack, 1/(1-c) stored, then c/(1-c) and c². */
export function spotConstants(cone) {
  const c = x87add(x87double(1), x87neg(x87mul(x87int32(cone & 255), x87double(0.00390625))));
  const inverse = x87div(x87double(1), x87add(x87double(1), x87neg(c)));
  return { k4: x87store(inverse), k14: x87store(x87mul(inverse, c)), k10: x87store(x87mul(c, c)) };
}

/** Spot spatial function 0x10b04f80 (LE_StaticSpot, LE_Spotlight). `axis`
 * is the X axis of GMath.UnitCoords / Rotation (ViewRotation for a Pawn):
 * script-pawn-locomotion.mjs fcoordsAxes(rotation)[1]. Per texel with
 * illumination: the falloff index FISTP(float(d²)·rr2) (zero at 4096 and
 * above), zero unless the axis dot is positive and dot² exceeds d²·c²; then
 * s = (rsqrt(d²)·dot·k4 − k14) and the byte is the low byte of
 * FISTP(float(s²·table·illumination·incidence) − 0.5). Displacements and
 * sums follow the float stores in doubles; the s chain runs on the x87
 * model. */
export function spotLightSpatial(rect, grid, location, constants, write, illumination, { cone, axis }) {
  const { minU, maxU, minV, maxV } = rect, { rr2, incidence } = constants;
  const { k4, k14, k10 } = spotConstants(cone), table = NORMAL;
  const illum = typeof illumination === 'number' ? () => illumination : (u, v) => illumination.bytes[v * illumination.stride + u];
  const [sx, sy, sz] = grid.start, [ux, uy, uz] = grid.stepU, [vx, vy, vz] = grid.stepV;
  const [lx, ly, lz] = location, [ax, ay, az] = axis;
  const K4 = x87load(k4), K14 = x87neg(x87load(k14)), INC = x87load(incidence);
  let rowX = f(f(f(minV * vx) + sx) + f(minU * ux));
  let rowY = f(f(sy + f(minV * vy)) + f(minU * uy));
  let rowZ = x87store(x87add(x87add(x87mul(x87int32(minV), x87load(vz)), x87load(sz)), x87mul(x87int32(minU), x87load(uz))));
  for (let v = minV; v < maxV; v++) {
    let dx = f(rowX - lx), dy = f(rowY - ly), dz = f(rowZ - lz);
    for (let u = minU; u < maxU; u++) {
      let byte = 0;
      const light = illum(u, v);
      if (light) {
        const sum = dz * dz + dy * dy + dx * dx, distance = f(sum), index = fistp(f(sum * rr2));
        if (index >>> 0 < 0x1000) {
          const dot = az * dz + ay * dy + ax * dx, dot32 = f(dot);
          if (dot > 0 && distance * k10 < dot32 * dot32) {
            const s = x87add(x87mul(x87mul(x87load(tableRsqrt(distance)), x87load(dot32)), K4), K14);
            const value = x87store(x87mul(x87mul(x87mul(x87mul(s, s), x87load(table[index])), x87int32(light)), INC));
            byte = fistp(value - 0.5) & 255;
          }
        }
      }
      write(u, v, byte);
      dx = f(dx + ux); dy = f(dy + uy); dz = f(dz + uz);
    }
    rowX = f(rowX + vx); rowY = f(rowY + vy); rowZ = f(rowZ + vz);
  }
}
const NORMAL = normalLightTable();

/** Cylinder spatial function 0x10b04a80 (LE_Cylinder): the horizontal
 * distance only, `(1 − (dx² + dy²)·(1/R)²)·illumination` stored as a float,
 * less 0.5 through FISTP, kept when positive (low byte), else 0. There is no
 * radius cut beyond the texel rectangle. Same grid walk as the spot body. */
export function cylinderSpatial(rect, grid, location, constants, write, illumination) {
  const { minU, maxU, minV, maxV } = rect, { rradius } = constants;
  const illum = typeof illumination === 'number' ? () => illumination : (u, v) => illumination.bytes[v * illumination.stride + u];
  const [sx, sy, sz] = grid.start, [ux, uy, uz] = grid.stepU, [vx, vy, vz] = grid.stepV;
  const [lx, ly, lz] = location;
  let rowX = f(f(f(minV * vx) + sx) + f(minU * ux));
  let rowY = f(f(f(minV * vy) + sy) + f(minU * uy));
  let rowZ = x87store(x87add(x87add(x87mul(x87int32(minV), x87load(vz)), x87load(sz)), x87mul(x87int32(minU), x87load(uz))));
  for (let v = minV; v < maxV; v++) {
    let dx = f(rowX - lx), dy = f(rowY - ly), dz = f(rowZ - lz);
    for (let u = minU; u < maxU; u++) {
      const value = f((1 - (dy * dy + dx * dx) * rradius * rradius) * illum(u, v));
      const n = fistp(value - 0.5);
      write(u, v, n <= 0 ? 0 : n & 255);
      dx = f(dx + ux); dy = f(dy + uy); dz = f(dz + uz);
    }
    rowX = f(rowX + vx); rowY = f(rowY + vy); rowZ = f(rowZ + vz);
  }
}
