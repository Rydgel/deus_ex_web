/** Static lights on BSP light maps through Render.dll's light-manager path
 * (docs/static-lighting.md). */

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
