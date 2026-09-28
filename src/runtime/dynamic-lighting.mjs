/** Render.dll moving-light lightmap path: the SetupDynamics candidate gate,
 * FDynamicLight::Filter over the level BSP, FLightManager::AddLight's light
 * class, ComputeFromActor's per-light constants and texel rectangle, the
 * NonIncidence spatial function and the colour table merge. Evidence,
 * precision and remaining limits: docs/dynamic-lighting.md. */
import { x87load, x87double, x87int32, x87mul, x87add, x87neg, x87div, x87sqrt, x87store, x87storeDouble,
  x87cmp } from './script-vm.mjs';

const f = Math.fround;
const scratch = new DataView(new ArrayBuffer(4));
const bitsOf = value => { scratch.setFloat32(0, value, true); return scratch.getUint32(0, true); };
const floatOf = bits => { scratch.setUint32(0, bits >>> 0, true); return scratch.getFloat32(0, true); };

/** FISTP under the original round-to-nearest-even control word. */
export function fistp(value) {
  const floor = Math.floor(value), fraction = value - floor;
  if (fraction !== .5) return fraction > .5 ? floor + 1 : floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// Light manager init 0x10b0225b-0x10b022d0: entry i of 0x10b3e1b8 holds
// sqrt(1+i/1024)*sqrt(2)*2^-64 and the adjacent 0x10b3f1b8 twice the unscaled
// root, both stored as floats.
const SQUARE_ROOTS = (() => {
  const table = new Uint32Array(2048), root2 = Math.sqrt(2);
  for (let i = 0; i < 1024; i++) {
    const scaled = floatOf(bitsOf(f(Math.sqrt(floatOf(0x3f800000 + (i << 13))))) - 0x20000000);
    table[i] = bitsOf(f(scaled * root2));
    table[i + 1024] = bitsOf(f(scaled + scaled));
  }
  return table;
})();

/** A copy of the table's float bit patterns, for native comparison. */
export const squareRootTable = () => SQUARE_ROOTS.slice();

/** The table square root used for light distances (0x10b05666 and the three
 * rectangle roots in ComputeFromActor): ten mantissa bits and the low
 * exponent bit select the entry, the remaining exponent bits are halved. */
export function tableSqrt(value) {
  const bits = bitsOf(value);
  return floatOf(SQUARE_ROOTS[(bits >>> 13) & 0x7ff] + ((bits & 0x7f000000) >>> 1));
}

/** SetupDynamics 0x10b230e8-0x10b2311c: the per-frame moving-light gate. */
export function isMovingLightCandidate(values) {
  if (!values.LightType) return false;
  if ((values.bStatic || values.bNoDelete) && !values.bDynamicLight) return false;
  return Boolean(values.LightBrightness) && Boolean(values.LightRadius);
}

// Rows of the effect table 0x10b2a0f0 whose second or third word is set.
const ANIMATED_EFFECTS = new Set([1, 2, 3, 4, 5, 6, 7, 9, 10, 16, 18]);

/** FLightManager::AddLight 0x10b08b30 for a surface (no owner): 0 joins the
 * static cache, 1 is recomputed per frame with shadows, 2 per frame without
 * shadows and 3 is the bump-map class; null rejects the light. */
export function surfaceLightClass(values, { noDynamicLights = false } = {}) {
  if (!values.LightType || !values.LightBrightness) return null;
  if (values.LightEffect === 15) return 3;
  if (!values.bDynamicLight && (values.bStatic || values.bNoDelete)) {
    if (values.bStatic && values.LightType === 1 && !ANIMATED_EFFECTS.has(values.LightEffect ?? 0)) return 0;
    return noDynamicLights ? 0 : 1;
  }
  return noDynamicLights ? null : 2;
}

/** Engine.dll AActor::WorldLightRadius 0x1030d6a0. */
export const worldLightRadius = values => 25 * ((values.LightRadius & 255) + 1);

/** FDynamicLight::Filter 0x10b24a10 at every BSP node the light reaches:
 * the item moves to the front child when -R < Dist, to the back child when
 * Dist < R, and joins every coplanar surface with a light map and matching
 * PF_SpecialLit when both hold. Returns those surface indices. */
export function filterMovingLight(model, location, radius, specialLit = false) {
  const surfaces = new Set();
  if (!model.nodes.length) return surfaces;
  const [lx, ly, lz] = location.map(f), stack = [0];
  for (let visited = 0; stack.length; visited++) {
    if (visited > model.nodes.length) throw new Error('Cyclic BSP moving-light filter');
    const index = stack.pop(), node = model.nodes[index];
    if (!node) throw new Error(`Invalid BSP node ${index}`);
    const [px, py, pz, pw] = node.plane;
    const distance = f(pz * lz + py * ly + px * lx - pw);
    if (-radius < distance) {
      if (node.front >= 0) stack.push(node.front);
      if (distance < radius) {
        for (let coplanar = index; coplanar >= 0; coplanar = model.nodes[coplanar].coplanar) {
          const surfaceIndex = model.nodes[coplanar].surface, surface = model.surfaces[surfaceIndex];
          if (!surface || !(surface.lightMap >= 0) || !model.lightMaps.length) continue;
          if (Boolean(surface.flags & 0x100000) !== Boolean(specialLit)) continue;
          surfaces.add(surfaceIndex);
        }
      }
    }
    if (distance < radius && node.back >= 0) stack.push(node.back);
  }
  return surfaces;
}

const K85 = x87load(f(1 / 85)), K84 = x87load(f(1 / 84)), ZERO = x87load(0), ONE = x87load(1);

/** Engine.dll FGetHSV 0x103ec8d0 on the 80-bit model: the brightness
 * response stays on the stack, hue components and the green/blue
 * saturation terms are float stores, red keeps its extended sum. */
export function fgetHsv(hue, saturation, value) {
  hue &= 255; saturation &= 255;
  const scaled = x87mul(x87int32(value & 255), x87double(0.005490196078431372));
  let brightness = x87mul(x87div(x87double(0.7), x87add(x87sqrt(x87storeDouble(scaled)), x87double(0.01))),
    x87load(x87store(scaled)));
  if (x87cmp(brightness, ZERO) === 'lt') brightness = ZERO;
  else if (x87cmp(brightness, ONE) !== 'lt') brightness = ONE;
  const product = (n, k) => x87store(x87mul(x87int32(n), k));
  const [x, y, z] = hue < 86 ? [product(85 - hue, K85), product(hue, K85), 0]
    : hue < 171 ? [0, product(170 - hue, K85), product(hue - 85, K85)]
      : [product(hue - 170, K85), 0, product(255 - hue, K84)];
  const complement = component => x87add(ONE, x87neg(x87load(component)));
  const s = x87load(x87store(x87mul(x87int32(saturation), x87double(0.00392156862745098))));
  const red = x87add(x87mul(complement(x), s), x87load(x));
  const green = x87store(x87add(x87load(x87store(x87mul(x87load(x87store(complement(y))), s))), x87load(y)));
  const blue = x87store(x87add(x87load(x87store(x87mul(x87load(x87store(complement(z))), s))), x87load(z)));
  return [x87store(x87mul(red, brightness)), x87store(x87mul(x87load(green), brightness)),
    x87store(x87mul(x87load(blue), brightness))];
}

/** ComputeFromActor's per-light constants: radius, reciprocal and squared
 * table scale (0x10b05fd9-0x10b06027), brightness (0x10b060b3), colour
 * (0x10b0612f-0x10b06148) and the colour-table steps (0x10b064ff-0x10b0656d).
 * `hsv` is FGetHSV(hue, saturation, 255); steady lights keep it unchanged. */
export function movingLightConstants(values, levelBrightness, hsv) {
  const radius = f(worldLightRadius(values)), clamped = radius > 1 ? radius : 1;
  const reciprocal = 1 / clamped, brightness = f((values.LightBrightness & 255) * f(1 / 255));
  const scale = x87mul(x87load(levelBrightness), x87load(brightness));
  const color = hsv.map(channel => x87store(x87mul(scale, x87load(channel))));
  return { radius, rradius: f(reciprocal), rr2: f(reciprocal * reciprocal * 4093), color,
    steps: color.map(channel => fistp(f(channel * 65536) - .5)) };
}

/** Colour table entry for a spatial byte (0x10b06570-0x10b065e0). */
export const colorTableEntry = (step, spatial) => Math.min(127, (spatial * step) >> 16);

/** ComputeFromActor 0x10b0660e-0x10b06865: the texel rectangle a light can
 * reach on a facet (origin, texture U/V axes, normal) and its light map. */
export function movingLightRect(location, radius, facet) {
  const { origin: o, axisU: x, axisV: y, normal: z, pan, scale, clamp } = facet;
  const [lx, ly, lz] = location;
  const dx = lx - o[0], dy = ly - o[1], dz = lz - o[2];
  const plane = f(dy * z[1] + dz * z[2] + dx * z[0]);
  let disk = radius * radius * 1.05 - plane * plane;
  if (disk < 0) disk = 0;
  const r = tableSqrt(f(disk));
  const py = f(ly - f(plane * z[1])), px = f(lx - f(plane * z[0])), pz = lz - plane * z[2];
  const u = f((py - o[1]) * x[1] + (pz - o[2]) * x[2] + (px - o[0]) * x[0] - pan[0]);
  const v = f((py - o[1]) * y[1] + (pz - o[2]) * y[2] + (px - o[0]) * y[0] - pan[1]);
  const ru = f(tableSqrt(f(x[0] * x[0] + x[1] * x[1] + x[2] * x[2])) * r);
  const rv = f(tableSqrt(f(y[0] * y[0] + y[1] * y[1] + y[2] * y[2])) * r);
  return {
    minU: Math.max(0, fistp(f((u - ru) / scale[0]))), minV: Math.max(0, fistp(f((v - rv) / scale[1]))),
    maxU: Math.min(clamp[0], fistp(f((ru + u) / scale[0]))), maxV: Math.min(clamp[1], fistp(f((rv + v) / scale[1]))),
  };
}

/** NonIncidence spatial function 0x10b054e0. `grid` is the float texel grid
 * (start 0x10b38a90, U step 0x10b49e10, V step 0x10b3d378); an unshadowed
 * moving light has illumination 0x7f everywhere (0x10b02660). Calls
 * `write(u, v, byte)` for each texel of the rectangle. */
export function nonIncidenceSpatial(rect, grid, location, constants, write, illumination = 0x7f) {
  const { minU, maxU, minV, maxV } = rect, { rradius, rr2 } = constants;
  const [sx, sy, sz] = grid.start, [ux, uy, uz] = grid.stepU, [vx, vy, vz] = grid.stepV;
  const [lx, ly, lz] = location;
  let rowX = f(f(sx + f(vx * minV)) + f(ux * minU));
  let rowY = f(f(sy + f(vy * minV)) + f(uy * minU));
  let rowZ = f(vz * minV + sz + uz * minU);
  for (let v = minV; v < maxV; v++) {
    let dx = f(rowX - lx), dy = f(rowY - ly), dz = f(rowZ - lz);
    for (let u = minU; u < maxU; u++) {
      let spatial = 0;
      if (illumination) {
        const distanceSquared = dy * dy + dz * dz + dx * dx;
        if (fistp(f(distanceSquared * rr2)) >>> 0 < 0x1000) {
          const scaled = (1.02 - tableSqrt(f(distanceSquared)) * rradius) * illumination;
          spatial = fistp(f(scaled) - .5) & 0xff;
        }
      }
      write(u, v, spatial);
      dx = f(dx + ux); dy = f(dy + uy); dz = f(dz + uz);
    }
    rowX = f(rowX + vx); rowY = f(rowY + vy); rowZ = f(rowZ + vz);
  }
}
