import { PackageError } from './package.mjs';
import { readObject } from './objects.mjs';

export const TEXTURE_FORMAT = { P8: 0, RGB565: 2, RGB8: 4, BGRA8: 5 };

export function readPalette(asset, index) {
  const object = readObject(asset.pkg, asset.bytes, index), r = object.reader;
  if (object.entry.className !== 'Palette') throw new Error('Expected a Palette');
  const count = r.compact();
  if (count < 1 || count > 256) throw new PackageError('Invalid palette size', r.offset);
  const colors = r.take(count * 4);
  if (r.offset !== r.bytes.length) throw new PackageError('Trailing palette data', r.offset);
  return colors;
}

export function readTexture(asset, index) {
  const object = readObject(asset.pkg, asset.bytes, index), r = object.reader;
  if (!/Texture$/.test(object.entry.className)) throw new Error(`Expected texture, found ${object.entry.className}`);
  function mipChain(hasSkipOffset) {
    const count = r.u8();
    if (count > 16) throw new PackageError('Invalid mip count', r.offset);
    const mips = [];
    for (let i = 0; i < count; i++) {
      const end = hasSkipOffset ? r.u32() : null;
      const data = r.take(r.compact());
      if (end !== null && end !== object.entry.serialOffset + r.offset) throw new PackageError('Invalid mip data end offset', r.offset);
      const width = r.u32(), height = r.u32(), uBits = r.u8(), vBits = r.u8();
      if (width < 1 || height < 1 || width > 8192 || height > 8192 || width !== 2 ** uBits || height !== 2 ** vBits) {
        throw new PackageError('Invalid mip dimensions', r.offset);
      }
      if (i && (width !== Math.max(1, mips[i - 1].width >> 1) || height !== Math.max(1, mips[i - 1].height >> 1))) {
        throw new PackageError('Noncontiguous mip chain', r.offset);
      }
      mips.push({ width, height, data });
    }
    return mips;
  }
  const mips = mipChain(asset.pkg.version >= 63);
  const compressedMips = object.values.bHasComp ? mipChain(asset.pkg.version >= 68) : [];
  return {
    name: object.entry.path, className: object.entry.className,
    format: object.values.Format ?? 0, palette: object.values.Palette ?? 0,
    mips, compressedMips, values: object.values, properties: object.properties,
    nativeBytes: r.bytes.length - r.offset, native: r.bytes.subarray(r.offset),
  };
}

/** Palette alpha is not surface alpha: P8 masking is specifically palette index zero.
 * `masked === true` is the D3D masked upload: D3DDrv.dll's P8 fillers
 * (FTexFiller8888_P8::BeginUpload 0x10002363, FTexFiller1555_P8::BeginUpload
 * 0x100028f4) store 0 into AlphaPalette[0] under PF_Masked, so index zero is
 * transparent black and filtering blends edge texels toward black, not toward
 * the palette's (often magenta) entry. `masked === 'point'` keeps the palette
 * colour with index-zero alpha for point-sampled HUD tiles: masked styles
 * discard those texels, and the unmasked styles sharing the texture see the
 * unmasked colour. */
export function decodePixels(mip, format, palette, masked = false) {
  const { width, height, data } = mip;
  const stride = { 0: 1, 2: 2, 4: 3, 5: 4 }[format];
  if (!stride) throw new Error(`Unsupported texture format ${format}`);
  if (data.length !== width * height * stride) throw new Error(`Texture size mismatch: ${data.length} bytes for ${width}×${height}, format ${format}`);
  if (format === 0 && !palette) throw new Error('P8 texture has no palette');
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const out = p * 4, input = p * stride;
    if (format === 0) {
      const index = data[input], pal = index * 4;
      if (pal + 3 >= palette.length) throw new Error(`Palette index out of range: ${index}`);
      if (masked === true && index === 0) continue;
      rgba[out] = palette[pal]; rgba[out + 1] = palette[pal + 1]; rgba[out + 2] = palette[pal + 2];
      rgba[out + 3] = masked && index === 0 ? 0 : 255;
    } else if (format === 2) {
      const n = data[input] | data[input + 1] << 8;
      rgba[out] = Math.round(((n >> 11) & 31) * 255 / 31);
      rgba[out + 1] = Math.round(((n >> 5) & 63) * 255 / 63);
      rgba[out + 2] = Math.round((n & 31) * 255 / 31); rgba[out + 3] = 255;
    } else {
      rgba[out] = data[input + (format === 5 ? 2 : 0)];
      rgba[out + 1] = data[input + 1]; rgba[out + 2] = data[input + (format === 5 ? 0 : 2)];
      rgba[out + 3] = format === 5 ? data[input + 3] : 255;
    }
  }
  return { width, height, data: rgba };
}

export class TextureStore {
  constructor(assets) { this.assets = assets; this.cache = new Map(); }
  async get(asset, ref, masked = false, ancestry = []) {
    const object = await this.assets.resolve(asset, ref);
    if (ancestry.includes(object.key)) throw new Error(`Cyclic procedural texture: ${object.key}`);
    const key = `${object.key}:${masked}`;
    if (!this.cache.has(key)) {
      const pending = (async () => {
        const texture = readTexture(object.asset, object.index);
        if (texture.className === 'FireTexture') {
          // Procedural (docs/fire-texture.md): no stored pixels; the sparks
          // follow the mips (a compact count of 8-byte records).
          const palette = texture.palette ? await this.assets.resolve(object.asset, texture.palette) : null;
          const native = texture.native;
          let at = 0, b = native[at++], count = b & 0x3f;
          if (b & 0x40) { let shift = 6, next; do { next = native[at++]; count |= (next & 0x7f) << shift; shift += 7; } while (next & 0x80); }
          if (b & 0x80) count = -count;
          if (count < 0 || at + count * 8 > native.length) throw new Error(`Invalid FireTexture sparks: ${object.key}`);
          return { ...texture, key: object.key, asset: object.asset, masked: false, procedural: 'FireTexture',
            fire: { sparks: native.slice(at, at + count * 8), palette: palette ? readPalette(palette.asset, palette.index) : null } };
        }
        if (texture.className === 'WetTexture') {
          // Procedural (docs/fire-texture.md "Wet textures"): the drops are
          // ADrop structs (FDrop's 8 bytes, SerializeBin order); the source
          // is a P8 texture whose mip 0 indices the wet texture refracts.
          const drops = new Uint8Array(2048);
          for (const p of texture.properties) {
            if (p.name !== 'Drops') continue;
            if (p.struct !== 'ADrop' || p.data.length !== 8 || p.arrayIndex > 255) throw new Error(`Invalid WetTexture drop: ${object.key}`);
            drops.set(p.data, p.arrayIndex * 8);
          }
          const paletteOf = async (asset, ref) => {
            if (!ref) return null;
            const p = await this.assets.resolve(asset, ref);
            return readPalette(p.asset, p.index);
          };
          let source = null;
          if (texture.values.SourceTexture) {
            const s = await this.assets.resolve(object.asset, texture.values.SourceTexture);
            const image = readTexture(s.asset, s.index);
            if (image.format !== 0 || !image.mips[0]?.data.length) throw new Error(`WetTexture source is not a stored P8 image: ${s.key}`);
            source = { key: s.key, uBits: Math.log2(image.mips[0].width), vBits: Math.log2(image.mips[0].height),
              pixels: image.mips[0].data, palette: await paletteOf(s.asset, image.palette), values: image.values };
          }
          return { ...texture, key: object.key, asset: object.asset, masked, procedural: 'WetTexture',
            wet: { drops, source, palette: await paletteOf(object.asset, texture.palette) } };
        }
        if (texture.values.SourceTexture && texture.mips.every(mip => mip.data.length === 0)) {
          const source = await this.get(object.asset, texture.values.SourceTexture, masked, [...ancestry, object.key]);
          return { ...texture, mips: source.mips, key: object.key, asset: object.asset, masked,
            procedural: `Static source image: ${source.key}` };
        }
        let palette;
        if (texture.palette) {
          const p = await this.assets.resolve(object.asset, texture.palette);
          palette = readPalette(p.asset, p.index);
        }
        if (!texture.mips.length) throw new Error(`No stored mip data: ${object.key}`);
        const mips = texture.mips.map(mip => decodePixels(mip, texture.format, palette, masked));
        return { ...texture, mips, key: object.key, asset: object.asset, masked };
      })();
      this.cache.set(key, pending);
      pending.catch(() => this.cache.delete(key));
    }
    return this.cache.get(key);
  }
}
