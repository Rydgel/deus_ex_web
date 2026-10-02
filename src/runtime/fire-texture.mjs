import {x87load, x87double, x87int32, x87mul, x87add, x87store, x87storeDouble, x87fistp} from './script-vm.mjs';

/** Fire.dll's UFireTexture (docs/fire-texture.md), translated from the
 * hash-pinned DLL and checked by validate-native-fire-texture.
 *
 * `globals` is the module state every fractal texture shares: the 256-byte
 * sine table (0x1051723c) and its two derived tables (0x10518250 clamped
 * sine+0x20, 0x10518f84 sine+0x80), and the lagged-XOR random generator
 * (0x10518358, 64 dwords; byte index 0x10518558).
 *
 * `texture` holds the fields at their retail meaning: uBits, uSize, vSize,
 * uMask, vMask, globalPhase, auxPhase, fxFrequency, bRising, sparksLimit,
 * activeSparkNum, sparks (Uint8Array, 8 bytes each: Type Heat X Y A B C D),
 * renderTable (1028 bytes), starStatus and pixels (the P8 mip 0). */

/** The generator inlined at every random draw: read the dword 0x80 bytes
 * ahead, step the index by 4 and XOR the read value into the new slot. */
export function fireRandom(globals) {
  const random = globals.random, index = globals.randomIndex;
  const read = (index + 0x80) & 0xfc, next = (index + 4) & 0xfc;
  const value = random.getUint32(read, true);
  globals.randomIndex = next;
  random.setUint32(next, (random.getUint32(next, true) ^ value) >>> 0, true);
  return value;
}

/** The rising fire update (Pentium Pro form 0x10515cf0, reached from
 * ConstantTimeTick through 0x1050e4d0): in place, top row down,
 * `P[y][x] = RenderTable[P[y+1][x-1] + P[y+1][x] + P[y+1][x+1] + P[y+2][x]]`
 * with columns wrapping in the row and the last two rows reading the first
 * two as they were before the update. */
export function fireUpdateRising(pixels, renderTable, width, height) {
  const top = pixels.slice(0, 2 * width);
  const at = (y, x) => {
    if (y >= height) return top[(y - height) * width + x];
    return pixels[y * width + x];
  };
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const left = (x + width - 1) % width, right = (x + 1) % width;
      pixels[row + x] = renderTable[at(y + 1, left) + at(y + 1, x) + at(y + 1, right) + at(y + 2, x)];
    }
  }
}

/** The non-rising fire update (Pentium Pro form 0x10515f30, through
 * 0x1050e504): `P[y][x] = RenderTable[P[y][x-1] + P[y][x] + P[y][x+1] +
 * P[y+1][x]]` over the old values (the pipeline loads ahead of its stores and
 * keeps the row's first pixel for the wrap), the last row reading the first
 * as it was. */
export function fireUpdateStill(pixels, renderTable, width, height) {
  const first = pixels.slice(0, width), row = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    row.set(pixels.subarray(base, base + width));
    const below = y + 1 < height ? pixels.subarray(base + width, base + 2 * width) : first;
    for (let x = 0; x < width; x++) {
      const left = (x + width - 1) % width, right = (x + 1) % width;
      pixels[base + x] = renderTable[row[left] + row[x] + row[right] + below[x]];
    }
  }
}

/** PostDrawSparks 0x10505930: while StarStatus is set, each Stars spark
 * (type 0x16) keeps the pixel under it in ByteB and, below 0x26, writes its
 * ByteA there; StarStatus clears when no Stars spark is active. */
export function postDrawSparks(texture) {
  if (!texture.starStatus) return;
  let found = false;
  const sparks = texture.sparks, pixels = texture.pixels;
  for (let i = 0; i < texture.activeSparkNum; i++) {
    const s = i * 8;
    if (sparks[s] !== 0x16) continue;
    found = true;
    const p = (sparks[s + 3] << texture.uBits) + sparks[s + 2];
    const pixel = pixels[p];
    sparks[s + 5] = pixel;
    if (pixel < 0x26) pixels[p] = sparks[s + 4];
  }
  if (!found) texture.starStatus = 0;
}

/** RedrawSparks 0x105025b0: AuxPhase += FX_Frequency, GlobalPhase++, then
 * each active spark by type (the jump table at 0x10505874). */
export function redrawSparks(texture, globals) {
  texture.auxPhase = (texture.auxPhase + texture.fxFrequency) & 255;
  texture.globalPhase = (texture.globalPhase + 1) | 0;
  for (let i = 0; i < texture.activeSparkNum; i++) {
    // Types above 0x2b skip the table (ja 0x10505858); 0x1f's entry is that
    // same continue.
    const type = texture.sparks[i * 8];
    if (type > 0x2b || type === 0x1f) continue;
    const handler = SPARKS[type];
    if (!handler) throw new Error(`Fire spark type ${type} is not translated`);
    handler(texture, globals, i);
  }
}

// Mip-0 offset of (x, y) as `(y << UBits) + x`, unmasked as the cases index.
const at = (t, x, y) => (y << t.uBits) + x;
const byte = value => value & 255;

const SPARKS = [];
// SPARK_Burn (0x1050260d): a random byte at the spark.
SPARKS[0x00] = (t, g, i) => {
  const s = i * 8, p = at(t, t.sparks[s + 2], t.sparks[s + 3]);
  t.pixels[p] = byte(fireRandom(g));
};
// SPARK_Sparkle (0x1050266a): Heat at (X + A·r1>>8, Y + B·r2>>8), masked.
SPARKS[0x01] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  const x = sp[s + 2] + ((sp[s + 4] * byte(fireRandom(g))) >> 8);
  const y = sp[s + 3] + ((sp[s + 5] * byte(fireRandom(g))) >> 8);
  t.pixels[at(t, x & t.uMask, y & t.vMask)] = sp[s + 1];
};
// SPARK_Pulse (0x10502742): Heat at the spark, then Heat += D.
SPARKS[0x02] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  t.pixels[at(t, sp[s + 2], sp[s + 3])] = sp[s + 1];
  sp[s + 1] = byte(sp[s + 1] + sp[s + 7]);
};
// SPARK_Cylinder (0x105027fa): min(sin(A+64)+Heat, 255) at
// (X + sin(A)·B>>8 & UMask, Y); A += D.
SPARKS[0x09] = (t, g, i) => {
  const s = i * 8, sp = t.sparks, sine = g.sine, a = sp[s + 4];
  const color = Math.min(sine[(a + 0x40) & 255] + sp[s + 1], 255);
  const x = byte(sp[s + 2] + ((sine[a] * sp[s + 5]) >> 8)) & t.uMask;
  t.pixels[x + (sp[s + 3] << t.uBits)] = color;
  sp[s + 4] = byte(a + sp[s + 7]);
};
// SPARK_Cylinder3D (0x1050287e): the front half of the Cylinder only.
SPARKS[0x0a] = (t, g, i) => {
  const s = i * 8, sp = t.sparks, sine = g.sine, a = sp[s + 4], k = (a + 0x40) & 255;
  if (k < 0x80) {
    const color = Math.min(sine[k] + sp[s + 1], 255);
    const x = byte(sp[s + 2] + ((sine[a] * sp[s + 5]) >> 8)) & t.uMask;
    t.pixels[x + (sp[s + 3] << t.uBits)] = color;
  }
  sp[s + 4] = byte(sp[s + 4] + sp[s + 7]);
};
// SPARK_Lissajous (0x10502988): sineClamped(A+64) at
// (X + sin(A)·Heat>>8 & UMask, Y + sin(B)·Heat>>8 & VMask); A += C, B += D.
SPARKS[0x0b] = (t, g, i) => {
  const s = i * 8, sp = t.sparks, sine = g.sine, heat = sp[s + 1], a = sp[s + 4], b = sp[s + 5];
  const y = byte(sp[s + 3] + ((sine[b] * heat) >> 8)) & t.vMask;
  const x = byte(sp[s + 2] + ((sine[a] * heat) >> 8)) & t.uMask;
  t.pixels[(y << t.uBits) + x] = g.sineClamped[(a + 0x40) & 255];
  sp[s + 4] = byte(sp[s + 4] + sp[s + 6]);
  sp[s + 5] = byte(sp[s + 5] + sp[s + 7]);
};
// SPARK_Jugglers (0x1050290d): min(sin(A+64)+Heat, 255) at
// (X, Y + sin(A)·B>>8 & VMask); A += D.
SPARKS[0x0c] = (t, g, i) => {
  const s = i * 8, sp = t.sparks, sine = g.sine, a = sp[s + 4];
  const color = Math.min(sine[(a + 0x40) & 255] + sp[s + 1], 255);
  const y = byte(sp[s + 3] + ((sine[a] * sp[s + 5]) >> 8)) & t.vMask;
  t.pixels[(y << t.uBits) + sp[s + 2]] = color;
  sp[s + 4] = byte(a + sp[s + 7]);
};
// Type 0x1d (0x10502a43): sineClamped(A+64) at (X + sin(A)·Heat>>8 & UMask, Y); A += C.
SPARKS[0x1d] = (t, g, i) => {
  const s = i * 8, sp = t.sparks, a = sp[s + 4];
  const x = byte(sp[s + 2] + ((g.sine[a] * sp[s + 1]) >> 8)) & t.uMask;
  t.pixels[x + (sp[s + 3] << t.uBits)] = g.sineClamped[(a + 0x40) & 255];
  sp[s + 4] = byte(a + sp[s + 6]);
};
// Type 0x1e (0x10502aba): sineClamped(B+64) at (X, Y + sin(B)·Heat>>8 & VMask); B += D.
SPARKS[0x1e] = (t, g, i) => {
  const s = i * 8, sp = t.sparks, b = sp[s + 5];
  const y = byte(sp[s + 3] + ((g.sine[b] * sp[s + 1]) >> 8)) & t.vMask;
  t.pixels[(y << t.uBits) + sp[s + 2]] = g.sineClamped[(b + 0x40) & 255];
  sp[s + 5] = byte(b + sp[s + 7]);
};
const signed = value => (value << 24) >> 24;

/** The kill at 0x10505837: the last active spark moves into this slot. */
function killSpark(t, i) {
  t.activeSparkNum -= 1;
  t.sparks.copyWithin(i * 8, t.activeSparkNum * 8, t.activeSparkNum * 8 + 8);
}
/** A new temporary spark at ActiveSparkNum (the caller checked the limit);
 * bytes it does not set keep whatever the slot held. */
function emitSpark(t, bytes) {
  const n = t.activeSparkNum++, base = n * 8;
  for (const [offset, value] of Object.entries(bytes)) t.sparks[base + Number(offset)] = value;
}
/** The temporaries' random walk: a signed A (or B) moves X (or Y) by one
 * toward its sign when (rand & 0x7f) < |A|, wrapping in the texture. One draw
 * each. Returns B as loaded (signed) for the callers' gravity. */
function walk(t, g, s) {
  const sp = t.sparks, a = signed(sp[s + 4]), r = fireRandom(g) & 0x7f;
  if (a < 0) { if (r < -a) sp[s + 2] = byte(sp[s + 2] - 1) & t.uMask; }
  else if (r < a) sp[s + 2] = byte(sp[s + 2] + 1) & t.uMask;
  const b = signed(sp[s + 5]), q = fireRandom(g) & 0x7f;
  if (b < 0) { if (q < -b) sp[s + 3] = byte(sp[s + 3] - 1) & t.vMask; }
  else if (q < b) sp[s + 3] = byte(sp[s + 3] + 1) & t.vMask;
  return b;
}
const drawHeat = (t, s) => { t.pixels[at(t, t.sparks[s + 2], t.sparks[s + 3])] = t.sparks[s + 1]; };

// SPARK_Blaze (0x10502b27): below the limit, a draw under 0x80 emits a 0x20
// with the spark's Heat/X/Y/C/D and random A and B.
SPARKS[0x04] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum >= t.sparksLimit || byte(fireRandom(g)) >= 0x80) return;
  const n = t.activeSparkNum;
  emitSpark(t, {0: 0x20, 1: sp[s + 1], 2: sp[s + 2], 3: sp[s + 3]});
  t.sparks[n * 8 + 4] = byte(fireRandom(g));
  t.sparks[n * 8 + 5] = byte(fireRandom(g));
  t.sparks[n * 8 + 6] = sp[s + 6]; t.sparks[n * 8 + 7] = sp[s + 7];
};
// SPARK_OzHasSpoken (0x10502c5a): a 0x21 rising (B 0x81, D 2) with a random
// sideways A; its C is the slot's.
SPARKS[0x05] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum >= t.sparksLimit || byte(fireRandom(g)) >= 0x80) return;
  const n = t.activeSparkNum;
  emitSpark(t, {0: 0x21, 1: sp[s + 1], 2: sp[s + 2], 3: sp[s + 3]});
  t.sparks[n * 8 + 4] = byte((fireRandom(g) & 0x7f) - 0x3f);
  t.sparks[n * 8 + 5] = 0x81; t.sparks[n * 8 + 7] = 2;
};
// SPARK_Cone (0x10502d4b): a draw under 0x40 emits a 0x22 (B 0, C 0x32) with
// a random sideways A; its D is the slot's.
SPARKS[0x06] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum >= t.sparksLimit || byte(fireRandom(g)) >= 0x40) return;
  const n = t.activeSparkNum;
  emitSpark(t, {0: 0x22, 1: sp[s + 1], 2: sp[s + 2], 3: sp[s + 3]});
  t.sparks[n * 8 + 4] = byte((fireRandom(g) & 0x7f) - 0x3f);
  t.sparks[n * 8 + 5] = 0; t.sparks[n * 8 + 6] = 0x32;
};
// SPARK_BlazeRight / BlazeLeft (0x10502e3c / 0x10502f0a): a 0x22 thrown up
// (B 0xe3) to the right (A 0x3f..0x7e) or left (A 0x80..0xbf), C the spark's.
const blazeSide = base => (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum >= t.sparksLimit || byte(fireRandom(g)) >= 0x40) return;
  const n = t.activeSparkNum;
  emitSpark(t, {0: 0x22, 1: sp[s + 1], 2: sp[s + 2], 3: sp[s + 3]});
  t.sparks[n * 8 + 4] = byte((fireRandom(g) & 0x3f) + base);
  t.sparks[n * 8 + 5] = 0xe3; t.sparks[n * 8 + 6] = sp[s + 6];
};
SPARKS[0x07] = blazeSide(0x3f);
SPARKS[0x08] = blazeSide(0x80);
// SPARK_Emit / Fountain (0x10502ffe / 0x105030bc): a draw under 0x40 emits a
// 0x21 / 0x2a copying Heat, X, Y, A, B and D; its C is the slot's.
const emitter = type => (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum >= t.sparksLimit || byte(fireRandom(g)) >= 0x40) return;
  emitSpark(t, {0: type, 1: sp[s + 1], 2: sp[s + 2], 3: sp[s + 3], 4: sp[s + 4], 5: sp[s + 5], 7: sp[s + 7]});
};
SPARKS[0x0d] = emitter(0x21);
SPARKS[0x0e] = emitter(0x2a);

// Temporary 0x20 (0x105045d6): Heat -= 5, dying on the borrow; else draws
// Heat and walks.
SPARKS[0x20] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 1] = byte(sp[s + 1] + 0xfb);
  if (sp[s + 1] >= 0xfb) return killSpark(t, i);
  drawHeat(t, s); walk(t, g, s);
};
// Temporary 0x21 (0x10504760): Heat -= D, dying at or below D.
SPARKS[0x21] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 1] = byte(sp[s + 1] - sp[s + 7]);
  if (sp[s + 1] <= sp[s + 7]) return killSpark(t, i);
  drawHeat(t, s); walk(t, g, s);
};
// Temporary 0x22 (0x10504a7c): C counts down to death; draws, walks and
// falls (B += 3 while below 0x7a).
SPARKS[0x22] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 6] = byte(sp[s + 6] - 1);
  if (sp[s + 6] === 0) return killSpark(t, i);
  drawHeat(t, s);
  const b = walk(t, g, s);
  if (b < 0x7a) sp[s + 5] = byte(b + 3);
};
// Temporary 0x2a (0x10504c1c): Heat -= D, dying at or below 0x32; falls on
// odd GlobalPhase while B is below 0x7c.
SPARKS[0x2a] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 1] = byte(sp[s + 1] - sp[s + 7]);
  if (sp[s + 1] <= 0x32) return killSpark(t, i);
  drawHeat(t, s);
  const b = walk(t, g, s);
  if ((t.globalPhase & 1) && b < 0x7c) sp[s + 5] = byte(b + 3);
};

/** The wander at 0x1050341f/0x10503642: an odd draw moves X by
 * (rand & 15) - 7, then an odd draw moves Y the same way. */
function wander(t, g, s) {
  const sp = t.sparks;
  if (fireRandom(g) & 1) sp[s + 2] = byte((fireRandom(g) & 0xf) + sp[s + 2] - 7) & t.uMask;
  if (fireRandom(g) & 1) sp[s + 3] = byte((fireRandom(g) & 0xf) + sp[s + 3] - 7) & t.vMask;
}
// SPARK_Organic (0x1050317a): a draw under 0x80 emits a 0x23 within C of the
// spark (rand·C>>8 each way), A random, B 0x81, C 0xff; Heat and D are the slot's.
SPARKS[0x11] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum >= t.sparksLimit || byte(fireRandom(g)) >= 0x80) return;
  const n = t.activeSparkNum++, d = n * 8;
  sp[d] = 0x23;
  sp[d + 2] = byte(sp[s + 2] + ((byte(fireRandom(g)) * sp[s + 6]) >> 8)) & t.uMask;
  sp[d + 3] = byte(sp[s + 3] + ((byte(fireRandom(g)) * sp[s + 6]) >> 8)) & t.vMask;
  sp[d + 4] = byte(fireRandom(g) - 0x7f); sp[d + 5] = 0x81; sp[d + 6] = 0xff;
};
// SPARK_WanderOrganic (0x10503307): below the limit always emits a 0x23 within
// 0..31 of the spark; then the spark wanders.
SPARKS[0x12] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum < t.sparksLimit) {
    const n = t.activeSparkNum++, d = n * 8;
    sp[d] = 0x23;
    sp[d + 2] = byte((fireRandom(g) & 0x1f) + sp[s + 2]) & t.uMask;
    sp[d + 3] = byte((fireRandom(g) & 0x1f) + sp[s + 3]) & t.vMask;
    sp[d + 4] = byte(fireRandom(g) - 0x7f); sp[d + 5] = 0x81; sp[d + 6] = 0xff;
  }
  wander(t, g, s);
};
// SPARK_RandomCloud (0x1050352a): the same with a 0x24 (A -15..16, C 0).
SPARKS[0x13] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum < t.sparksLimit) {
    const n = t.activeSparkNum++, d = n * 8;
    sp[d] = 0x24;
    sp[d + 2] = byte((fireRandom(g) & 0x1f) + sp[s + 2]) & t.uMask;
    sp[d + 3] = byte((fireRandom(g) & 0x1f) + sp[s + 3]) & t.vMask;
    sp[d + 4] = byte((fireRandom(g) & 0x1f) - 0xf); sp[d + 5] = 0x81; sp[d + 6] = 0;
  }
  wander(t, g, s);
};
/** 0x23/0x24's drift: one draw moves X toward A's sign when (rand & 0x7f) <
 * |A|; Y rises two rows. */
function drift(t, g, s) {
  const sp = t.sparks, a = signed(sp[s + 4]), r = fireRandom(g) & 0x7f;
  if (a < 0 ? r < -a : r < a) sp[s + 2] = byte(sp[s + 2] + (a < 0 ? -1 : 1)) & t.uMask;
  sp[s + 3] = byte(sp[s + 3] - 2) & t.vMask;
}
// Temporary 0x23 (0x10504dcf): C -= 3, dying at or below 0xbe; draws C and drifts.
SPARKS[0x23] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 6] = byte(sp[s + 6] - 3);
  if (sp[s + 6] <= 0xbe) return killSpark(t, i);
  t.pixels[at(t, sp[s + 2], sp[s + 3])] = sp[s + 6];
  drift(t, g, s);
};
// Temporary 0x24 (0x10504ebd): C += 4, dying at 0xfa or above; draws C and drifts.
SPARKS[0x24] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 6] = byte(sp[s + 6] + 4);
  if (sp[s + 6] >= 0xfa) return killSpark(t, i);
  t.pixels[at(t, sp[s + 2], sp[s + 3])] = sp[s + 6];
  drift(t, g, s);
};

/** A walk by explicit signed steps (the 0x26-0x29/0x2b forms): X by dx,
 * then Y by dy, one draw each. */
function walkBy(t, g, s, dx, dy) {
  const sp = t.sparks, r = fireRandom(g) & 0x7f;
  if (dx < 0) { if (r < -dx) sp[s + 2] = byte(sp[s + 2] - 1) & t.uMask; }
  else if (r < dx) sp[s + 2] = byte(sp[s + 2] + 1) & t.uMask;
  const q = fireRandom(g) & 0x7f;
  if (dy < 0) { if (q < -dy) sp[s + 3] = byte(sp[s + 3] - 1) & t.vMask; }
  else if (q < dy) sp[s + 3] = byte(sp[s + 3] + 1) & t.vMask;
}
/** CustomCloud/Flocks jitter: X += (r1 & 7) - (r2 & 7), then Y the same. */
function jitter(t, g, s) {
  const sp = t.sparks;
  let a = fireRandom(g) & 7, b = fireRandom(g) & 7;
  sp[s + 2] = byte(a - b + sp[s + 2]) & t.uMask;
  a = fireRandom(g) & 7; b = fireRandom(g) & 7;
  sp[s + 3] = byte(a - b + sp[s + 3]) & t.vMask;
}

/** UFireTexture::DrawFlashRamp (0x105022f0): a jagged line from (X, Y) by the
 * signed deltas XD, YD (magnitude, sign in bit 0), colour ramping from
 * Color1 to Color2. A segment whose major delta is negative is drawn from its
 * other end with the colours swapped. N = max(XD, YD) | 1 random bytes
 * jitter the minor axis (6-bit fixed point); the colour steps in 23-bit
 * fixed point (idiv by N). */
export function drawFlashRamp(t, g, [x0, y0, xd0, yd0], color1, color2) {
  let x = x0, y = y0, xd = xd0, yd = yd0, c1 = color1, c2 = color2;
  // 0x105022f9-0x1050233c: an odd YD with 2·YD >= XD flips; otherwise an odd
  // XD with 2·YD < XD does.
  const flip = ((yd & 1) && 2 * yd >= xd) || ((xd & 1) && 2 * yd < xd);
  if (flip) {
    x = byte(x + ((xd & 1) ? -xd : xd));
    y = byte(y + ((yd & 1) ? -yd : yd));
    xd ^= 1; yd ^= 1;
    [c1, c2] = [c2, c1];
  }
  const n = Math.max(xd, yd) | 1, jag = new Uint8Array(n);
  let sum = 0;
  for (let k = 0; k < n; k++) { const r = byte(fireRandom(g)); jag[k] = r; sum += r; }
  const yStep = (yd & 1) ? -1 : 1, ySigned = (yd & 1) ? -yd : yd;
  const xStep = (xd & 1) ? -1 : 1, xSigned = (xd & 1) ? -xd : xd;
  const colorStep = ((((c2 - c1) << 23) / n) | 0);
  let color = c1 << 23;
  if (xd >= yd) {
    const increment = ((((ySigned << 6) - sum) / n) | 0);
    let acc = y << 6;
    for (let k = 0; k < xd; k++) {
      acc = (acc + jag[k] + increment) | 0;
      const p = (((acc >> 6) & t.vMask) << t.uBits) + (x & t.uMask);
      x = byte(x + xStep);
      color = (color + colorStep) | 0;
      t.pixels[p] = byte(color >> 23);
    }
  } else {
    const increment = ((((xSigned << 6) - sum) / n) | 0);
    let acc = x << 6;
    for (let k = 0; k < yd; k++) {
      acc = (acc + jag[k] + increment) | 0;
      const p = ((y & t.vMask) << t.uBits) + ((acc >> 6) & t.uMask);
      y = byte(y + yStep);
      color = (color + colorStep) | 0;
      t.pixels[p] = byte(color >> 23);
    }
  }
}

// SPARK_Flocks (0x10503fb7): a 0x27 within 0..31 heading A (B = A, A 0), C =
// B, D = D; A += C; then the spark jitters.
SPARKS[0x0f] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum < t.sparksLimit) {
    const n = t.activeSparkNum++, d = n * 8;
    sp[d] = 0x27;
    sp[d + 2] = byte((fireRandom(g) & 0x1f) + sp[s + 2]) & t.uMask;
    sp[d + 3] = byte((fireRandom(g) & 0x1f) + sp[s + 3]) & t.vMask;
    sp[d + 5] = sp[s + 4]; sp[d + 4] = 0; sp[d + 6] = sp[s + 5]; sp[d + 7] = sp[s + 7]; sp[d + 1] = sp[s + 1];
    sp[s + 4] = byte(sp[s + 4] + sp[s + 6]);
  }
  jitter(t, g, s);
};
// SPARK_Eels (0x1050374d): a draw under 0x14, below the limit, emits a 0x26
// within 0..31 with random A and B and the spark's Heat and C; then wanders.
SPARKS[0x10] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (byte(fireRandom(g)) < 0x14 && t.activeSparkNum < t.sparksLimit) {
    const n = t.activeSparkNum++, d = n * 8;
    sp[d + 1] = sp[s + 1]; sp[d] = 0x26;
    sp[d + 2] = byte((fireRandom(g) & 0x1f) + sp[s + 2]) & t.uMask;
    sp[d + 3] = byte((fireRandom(g) & 0x1f) + sp[s + 3]) & t.vMask;
    sp[d + 4] = byte(fireRandom(g)); sp[d + 5] = byte(fireRandom(g)); sp[d + 6] = sp[s + 6];
  }
  wander(t, g, s);
};
// SPARK_CustomCloud (0x10503ca5): a 0x25 within 0..31 with the spark's A, B
// and C = D; then the spark jitters.
SPARKS[0x14] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum < t.sparksLimit) {
    const n = t.activeSparkNum++, d = n * 8;
    sp[d] = 0x25;
    sp[d + 2] = byte((fireRandom(g) & 0x1f) + sp[s + 2]) & t.uMask;
    sp[d + 3] = byte((fireRandom(g) & 0x1f) + sp[s + 3]) & t.vMask;
    sp[d + 4] = sp[s + 4]; sp[d + 5] = sp[s + 5]; sp[d + 6] = sp[s + 7];
  }
  jitter(t, g, s);
};
// SPARK_LocalCloud (0x10503e9e): a 0x25 within C (rand·C>>8) with A, B and C = D.
SPARKS[0x15] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum >= t.sparksLimit) return;
  const n = t.activeSparkNum++, d = n * 8;
  sp[d] = 0x25;
  sp[d + 2] = byte(sp[s + 2] + ((byte(fireRandom(g)) * sp[s + 6]) >> 8)) & t.uMask;
  sp[d + 3] = byte(sp[s + 3] + ((byte(fireRandom(g)) * sp[s + 6]) >> 8)) & t.vMask;
  sp[d + 4] = sp[s + 4]; sp[d + 5] = sp[s + 5]; sp[d + 6] = sp[s + 7];
};
// SPARK_Stars (0x105042ed): B at the spark (PostDrawSparks does the rest).
SPARKS[0x16] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  t.pixels[at(t, sp[s + 2], sp[s + 3])] = sp[s + 5];
};
/** Line/RampLightning (0x10504315 / 0x105043ed): with Heat, a running C
 * counts down while the flash draws (X, Y)+(A, B); an idle one re-arms when a
 * draw reaches D, for (rand + 1) & 5 ticks. */
const lightning = shift => (t, g, i) => {
  const s = i * 8, sp = t.sparks, heat = sp[s + 1];
  if (!heat) return;
  if (sp[s + 6] > 0) {
    sp[s + 6] -= 1;
    drawFlashRamp(t, g, [sp[s + 2], sp[s + 3], sp[s + 4], sp[s + 5]], heat, heat >> shift);
    return;
  }
  if (byte(fireRandom(g)) < sp[s + 7]) return;
  sp[s + 6] = byte(fireRandom(g) + 1) & 5;
};
SPARKS[0x17] = lightning(0);
SPARKS[0x18] = lightning(3);
// SPARK_SphereLightning (0x105044c8): a draw reaching D flashes a ray of
// length C at a random angle, centred (C>>1 back), Heat to Heat>>2.
SPARKS[0x19] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (byte(fireRandom(g)) < sp[s + 7]) return;
  const a = byte(fireRandom(g)), radius = sp[s + 6], half = radius >> 1, heat = sp[s + 1];
  const dx = ((g.sine[a] * radius) >> 8) - half, dy = ((g.sine[(a + 0x40) & 255] * radius) >> 8) - half;
  const encode = v => byte(v > 0 ? v & ~1 : (-v) | 1);
  drawFlashRamp(t, g, [sp[s + 2], sp[s + 3], encode(dx), encode(dy)], heat, heat >> 2);
};
// SPARK_Wheel (0x105041d1): a 0x27 at the spark heading A (B = A, A 0), C =
// B, D = D; then A += C.
SPARKS[0x1a] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum < t.sparksLimit) {
    const n = t.activeSparkNum++, d = n * 8;
    sp[d] = 0x27; sp[d + 2] = sp[s + 2]; sp[d + 3] = sp[s + 3];
    sp[d + 5] = sp[s + 4]; sp[d + 4] = 0; sp[d + 6] = sp[s + 5]; sp[d + 7] = sp[s + 7]; sp[d + 1] = sp[s + 1];
  }
  sp[s + 4] = byte(sp[s + 4] + sp[s + 6]);
};
// SPARK_Gametes (0x105039f9): a draw under 0x14, below the limit, emits a
// 0x2b within 0..31 with random A and D and the spark's Heat and C; then wanders.
SPARKS[0x1b] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (byte(fireRandom(g)) < 0x14 && t.activeSparkNum < t.sparksLimit) {
    const n = t.activeSparkNum++, d = n * 8;
    sp[d] = 0x2b; sp[d + 1] = sp[s + 1];
    sp[d + 2] = byte((fireRandom(g) & 0x1f) + sp[s + 2]) & t.uMask;
    sp[d + 3] = byte((fireRandom(g) & 0x1f) + sp[s + 3]) & t.vMask;
    sp[d + 4] = byte(fireRandom(g)); sp[d + 6] = sp[s + 6]; sp[d + 7] = byte(fireRandom(g));
  }
  wander(t, g, s);
};
// SPARK_Sprinkler (0x1050425f): a 0x28 copying the spark (D 2); then A += D.
SPARKS[0x1c] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  if (t.activeSparkNum < t.sparksLimit) {
    const n = t.activeSparkNum++, d = n * 8;
    sp[d] = 0x28; sp[d + 2] = sp[s + 2]; sp[d + 3] = sp[s + 3]; sp[d + 1] = sp[s + 1];
    sp[d + 4] = sp[s + 4]; sp[d + 5] = sp[s + 5]; sp[d + 6] = sp[s + 6]; sp[d + 7] = 2;
  }
  sp[s + 4] = byte(sp[s + 4] + sp[s + 7]);
};
// Temporary 0x25 (0x10504fd6): C += 4, dying at 0xfa or above; draws C and walks.
SPARKS[0x25] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 6] = byte(sp[s + 6] + 4);
  if (sp[s + 6] >= 0xfa) return killSpark(t, i);
  t.pixels[at(t, sp[s + 2], sp[s + 3])] = sp[s + 6];
  walk(t, g, s);
};
// Temporary 0x26 (0x10505162): C counts down to death; draws Heat and walks.
SPARKS[0x26] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 6] = byte(sp[s + 6] - 1);
  if (sp[s + 6] === 0xff) return killSpark(t, i);
  drawHeat(t, s); walk(t, g, s);
};
// Temporary 0x27 (0x105054be): C counts down; draws Heat, steers by the
// sine+0x80 table at B, and the A/B word advances by D·16.
SPARKS[0x27] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 6] = byte(sp[s + 6] - 1);
  if (sp[s + 6] === 0xff) return killSpark(t, i);
  drawHeat(t, s);
  const b = sp[s + 5], dy = signed(g.sineSigned[b]), dx = signed(g.sineSigned[(b + 0x40) & 255]);
  const word = ((sp[s + 4] | (sp[s + 5] << 8)) + (sp[s + 7] << 4)) & 0xffff;
  sp[s + 4] = word & 255; sp[s + 5] = word >> 8;
  walkBy(t, g, s, dx, dy);
};
// Temporary 0x28 (0x10505672): C counts down; draws Heat, steers X by
// sin(A+64)+0x80 and Y by B; A += D.
SPARKS[0x28] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 6] = byte(sp[s + 6] - 1);
  if (sp[s + 6] === 0xff) return killSpark(t, i);
  drawHeat(t, s);
  const a = sp[s + 4], dx = signed(byte(g.sine[(a + 0x40) & 255] + 0x80)), dy = signed(sp[s + 5]);
  sp[s + 4] = byte(sp[s + 7] + a);
  walkBy(t, g, s, dx, dy);
};
// Temporary 0x29 (0x105048ef): Heat -= C, dying at 0xfa or above; draws and walks.
SPARKS[0x29] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 1] = byte(sp[s + 1] - sp[s + 6]);
  if (sp[s + 1] >= 0xfa) return killSpark(t, i);
  drawHeat(t, s); walk(t, g, s);
};
// Temporary 0x2b (0x105052ed): C counts down; draws Heat; A += 7 folds into a
// 0..63 triangle that, with D, picks sine steps for X and Y.
SPARKS[0x2b] = (t, g, i) => {
  const s = i * 8, sp = t.sparks;
  sp[s + 6] = byte(sp[s + 6] - 1);
  if (sp[s + 6] === 0xff) return killSpark(t, i);
  drawHeat(t, s);
  sp[s + 4] = byte(sp[s + 4] + 7);
  let fold = sp[s + 4] & 0x7f;
  if (fold > 0x3f) fold = 0x7f - fold;
  const angle = byte(sp[s + 7] + fold);
  const dy = signed(byte(g.sine[(angle + 0x40) & 255] - 0x7f)), dx = signed(byte(g.sine[angle] - 0x7f));
  walkBy(t, g, s, dx, dy);
};

// SPARK_Signal (0x10502778): Heat above C draws; Heat += D, and a carry
// draws a new random Heat.
SPARKS[0x03] = (t, g, i) => {
  const s = i * 8, sp = t.sparks, heat = sp[s + 1];
  if (heat > sp[s + 6]) t.pixels[at(t, sp[s + 2], sp[s + 3])] = heat;
  const next = byte(sp[s + 1] + sp[s + 7]);
  sp[s + 1] = next;
  if (next < sp[s + 7]) sp[s + 1] = byte(fireRandom(g));
};

/** ConstantTimeTick 0x10507ff0 for a texture of at least 8×8. */
export function fireConstantTimeTick(texture, globals) {
  if (texture.uSize < 8 || texture.vSize < 8) return;
  redrawSparks(texture, globals);
  if (texture.bRising & 1) fireUpdateRising(texture.pixels, texture.renderTable, texture.uSize, texture.vSize);
  else fireUpdateStill(texture.pixels, texture.renderTable, texture.uSize, texture.vSize);
  postDrawSparks(texture);
}

const SINE_SCALE = x87load(0.00390625), TWO_PI = x87load(6.2831854820251465);
const SINE_AMPLITUDE = x87double(127.5), SINE_OFFSET = x87double(127.44999694824219);
// An x87 value after an FSTP qword (53-bit significand) as a JS number.
const doubleOf = v => v.sig === 0n ? 0 : (v.neg ? -1 : 1) * Number(v.sig) * 2 ** v.exp;

/** The module tables' construction (0x10501020), once, at the first
 * UFractalTexture: sine[i] = fistp(f32(appSin(i/256·2π)·127.5 + 127.45)),
 * the clamped sine+0x20 and the sine+0x80 tables, and 512 bytes of appRand()
 * with the index at 0. `appSin` is the host's double sine (Core calls the CRT
 * sin, an x87 transcendental; docs/fire-texture.md gives the margins). */
export function fireTables(appRand) {
  const sine = new Uint8Array(256), sineClamped = new Uint8Array(256), sineSigned = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const angle = doubleOf(x87storeDouble(x87mul(x87mul(x87int32(i), SINE_SCALE), TWO_PI)));
    const value = x87store(x87add(x87mul(x87double(Math.sin(angle)), SINE_AMPLITUDE), SINE_OFFSET));
    sine[i] = x87fistp(x87load(value)) & 255;
  }
  for (let i = 0; i < 256; i++) {
    sineClamped[i] = Math.min(sine[i] + 0x20, 0xff);
    sineSigned[i] = (sine[i] + 0x80) & 255;
  }
  const random = new Uint8Array(512);
  for (let i = 0; i < 512; i++) random[i] = appRand() & 255;
  return {sine, sineClamped, sineSigned, random: new DataView(random.buffer), randomIndex: 0};
}

/** Load state: UFireTexture::Serialize (0x10508300) reads the sparks and
 * grows the array to the raw SparksLimit; PostLoad (0x10507b70, from
 * 0x10507d62) rebuilds RenderTable when RenderHeat differs from OldRenderHeat
 * (`trunc(clamp(i/4 + 1 - (255 - RenderHeat)/16, 0, 255))` for i < 1024),
 * and, when the array is not already SparksLimit long, clamps SparksLimit to
 * 4..8192, drops temporaries (type >= 0x1f) from the top while
 * ActiveSparkNum exceeds it, caps ActiveSparkNum and resizes the array to the
 * limit. New slots are zero here (the allocator's memory is not
 * cleared in the original). `sparks` is the serialized array. */
export function firePostLoad(texture, sparks) {
  const t = texture;
  t.uMask = t.uSize - 1; t.vMask = t.vSize - 1;
  if ((t.oldRenderHeat | 0) !== t.renderHeat) {
    for (let i = 0; i < 0x400; i++) {
      const value = i * 0.25 + 1 - (255 - t.renderHeat) * 0.0625;
      t.renderTable[i] = value < 0 ? 0 : value >= 255 ? 255 : Math.trunc(value);
    }
    t.oldRenderHeat = t.renderHeat;
  }
  let num = Math.max(sparks.length >> 3, t.sparksLimit);
  let array = new Uint8Array(num * 8);
  array.set(sparks);
  // The clamp and resize run only when the size differs from the raw limit
  // (0x10507e15), so a limit above 8192 that Serialize grew to stands.
  if (num === t.sparksLimit) { t.sparks = array; return t; }
  const limit = Math.max(4, Math.min(0x2000, t.sparksLimit));
  t.sparksLimit = limit;
  if (num > limit) {
    if (t.activeSparkNum > limit) {
      for (let k = t.activeSparkNum - 1; k >= 0; k--) {
        if (array[k * 8] < 0x1f) continue;
        t.activeSparkNum -= 1;
        array.copyWithin(k * 8, t.activeSparkNum * 8, t.activeSparkNum * 8 + 8);
        if (t.activeSparkNum <= limit) break;
      }
    }
    t.activeSparkNum = Math.min(t.activeSparkNum, limit);
    array = array.slice(0, limit * 8);
  } else if (num < limit) {
    const grown = new Uint8Array(limit * 8);
    grown.set(array);
    array = grown;
  }
  t.sparks = array;
  return t;
}
