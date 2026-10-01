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
    const type = texture.sparks[i * 8];
    const handler = SPARKS[type];
    if (!handler) throw new Error(`Fire spark type ${type} is not translated`);
    handler(texture, globals, i);
  }
}

const SPARKS = [];

/** ConstantTimeTick 0x10507ff0 for a texture of at least 8×8. */
export function fireConstantTimeTick(texture, globals) {
  if (texture.uSize < 8 || texture.vSize < 8) return;
  redrawSparks(texture, globals);
  if (texture.bRising & 1) fireUpdateRising(texture.pixels, texture.renderTable, texture.uSize, texture.vSize);
  else fireUpdateStill(texture.pixels, texture.renderTable, texture.uSize, texture.vSize);
  postDrawSparks(texture);
}
