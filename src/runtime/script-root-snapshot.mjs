/** RootWindow.GenerateSnapshot (native 1524): the pixel work of XRootWindow::GenerateSnapshot (Extension.dll 0x10039410), the
 * grey path every script call takes (the exec 0x1003cf30 passes no existing texture, bFilter, and a zero colour flag).
 * docs/root-snapshot.md.
 *
 * The method reads the render device's viewport frame (SizeX x SizeY, URenderDevice::ReadPixels: one dword per pixel, byte 0
 * blue, 1 green, 2 red), and fills an 8-bit paletted texture of the snapshot size (`SetSnapshotSize`: root +0x738 x +0x73c)
 * rounded up to powers of two, whose palette is the grey ramp (i, i, i, 255). Each destination pixel (x, y) averages the
 * source box that starts at the float32 accumulators (srcX, srcY) (+= SizeX / snapW, SizeY / snapH per step) and spans
 * dx < stepX, dy < stepY source pixels, skipping those past the frame; each channel average is turned into a byte by the
 * exec's x87 code, and the byte stored is the integer third of the three channel bytes.
 *
 * Exactness: a source byte times 1/255 (the double 0x1005e3c0, an odd part of 49 bits) sums exactly in the 64-bit significand, so
 * a channel total is S * (1/255) for the integer S of the box; the rest depends only on (S, n) and runs once per pair on the x87
 * helpers. Blue is averaged on the register stack (extended product, scaled by the unrounded 1.0 / n, times 256.0f, stored to
 * float32); green and red are stored to float32 first and multiplied by the float32 1 / n. Each result is
 * fistp(float32 - 0.5f) clamped to 0..255. */
import {x87double as D, x87load as L, x87mul as M, x87add as A, x87neg as N, x87div, x87store as S, x87int32, x87fistp} from './script-vm.mjs';

const ONE_OVER_255 = 0.00392156862745098;     // the double at Extension 0x1005e3c0
const clampByte = value => value < 0 ? 0 : value >= 255 ? 255 : value;

/** The power-of-two ceilings the exec computes for U and V (unsigned compares; 0 stays 0, above 0x10000 wraps to 0). */
export function potCeiling(size) {
  const n = size >>> 0;
  if (n === 0) return 0;
  for (let power = 1; power <= 0x8000; power *= 2) if (n <= power) return power;
  return n > 0x10000 ? 0 : 0x10000;
}

// Per-(S, n) channel bytes, exact on the x87 helpers; the keys are small integers.
const blueCache = new Map(), greenRedCache = new Map();
function toByte(float32Product) {
  // fld float32; fsub 0.5f; fistp (round to nearest even); clamp to a byte.
  return clampByte(x87fistp(A(L(float32Product), N(L(0.5)))));
}
function blueByte(sum, count) {
  const key = sum * 4096 + count;
  let value = blueCache.get(key);
  if (value === undefined) {
    const total = M(x87int32(sum), D(ONE_OVER_255));                      // the accumulated extended total (exact)
    const scaled = M(total, x87div(D(1), x87int32(count)));              // times 1.0 / n, unrounded
    value = toByte(S(M(scaled, L(256))));
    blueCache.set(key, value);
  }
  return value;
}
function greenRedByte(sum, count) {
  const key = sum * 4096 + count;
  let value = greenRedCache.get(key);
  if (value === undefined) {
    const total = S(M(x87int32(sum), D(ONE_OVER_255)));                   // fstp to float32
    const inverse = S(x87div(D(1), x87int32(count)));                     // fst to float32
    const averaged = S(M(L(inverse), L(total)));
    value = toByte(S(M(L(averaged), L(256))));
    greenRedCache.set(key, value);
  }
  return value;
}

/** The snapshot of a frame: `pixels` the SizeX * SizeY dwords ReadPixels returned (blue in the low byte), `snapW` x `snapH` the
 * root's snapshot size. Returns {pitch, height, data}: the P8 texture's USize (pitch) and VSize and its bytes (only the
 * snapW x snapH corner is written; the rest is zero, as the texture comes from Init). */
export function snapshotGrey(pixels, sizeX, sizeY, snapW, snapH) {
  const pitch = potCeiling(snapW), height = potCeiling(snapH);
  const data = new Uint8Array(pitch * height);
  const fSizeX = S(x87int32(sizeX)), fSizeY = S(x87int32(sizeY));
  const stepX = S(x87div(L(fSizeX), x87int32(snapW))), stepY = S(x87div(L(fSizeY), x87int32(snapH)));
  const f = Math.fround;
  if (0 < fSizeY) {
    let srcY = 0, destY = 0, row = 0;
    do {
      if (0 < fSizeX) {
        let srcX = 0, destX = 0;
        do {
          if (destX < snapW && destY < snapH) {
            let blue = 0, green = 0, red = 0, count = 0;
            if (0 < stepX) {
              for (let dx = 0; dx < stepX; dx++) {
                if (!(0 < stepY)) continue;
                for (let dy = 0; dy < stepY; dy++) {
                  if (!(dx + srcX < fSizeX) || !(dy + srcY < fSizeY)) continue;
                  count++;
                  const pixel = pixels[Math.trunc(srcX) + dx + (Math.trunc(srcY) + dy) * sizeX];
                  blue += pixel & 0xff; green += (pixel >>> 8) & 0xff; red += (pixel >>> 16) & 0xff;
                }
              }
            }
            const total = blueByte(blue, count) + greenRedByte(green, count) + greenRedByte(red, count);
            data[row + destX] = Math.floor(total / 3);
          }
          srcX = f(srcX + stepX); destX++;
        } while (srcX < fSizeX);
      }
      srcY = f(srcY + stepY); row += pitch; destY++;
    } while (srcY < fSizeY);
  }
  return {pitch, height, data};
}
