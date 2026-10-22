/** A small PNG reader for the validators that compare screenshots (8-bit RGB or RGBA, non-interlaced: what Wine's and Chromium's screenshots are). */
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

/** 8-bit RGB or RGBA, non-interlaced PNG to {width, height, data (RGBA)}. */
export function decodePng(bytes) {
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  let width = 0, height = 0, channels = 0; const parts = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at), type = bytes.subarray(at + 4, at + 8).toString(), body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); assert.equal(body[8], 8); assert.equal(body[12], 0, 'not interlaced'); channels = { 2: 3, 6: 4 }[body[9]]; assert.ok(channels); }
    if (type === 'IDAT') parts.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts)), stride = width * channels, out = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0;
      const predictor = [0, a, b, (a + b) >> 1, (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })()][filter];
      line[x] = (line[x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) { const o = (y * width + x) * 4; out[o] = line[x * channels]; out[o + 1] = line[x * channels + 1]; out[o + 2] = line[x * channels + 2]; out[o + 3] = 255; }
    previous = line;
  }
  return { width, height, data: out };
}
