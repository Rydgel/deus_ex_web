/** Helpers shared by the embed builds (embed/build.mjs, embed/terminal/build.mjs). */
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';
import {gameDirectory} from '../scripts/game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** --url: the absolute HTTPS base a site will be served from, with a trailing slash. */
export function baseUrlOption(args) {
  const i = args.indexOf('--url');
  if (i < 0) return null;
  const url = (args[i + 1] ?? '').replace(/\/?$/, '/');
  if (!/^https:\/\/[^/]+\//.test(url)) throw new Error('--url must be an absolute https:// URL');
  return url;
}

/** The installed game's System, Textures and Maps packages. */
export async function gameAssets() {
  process.chdir(repositoryRoot);
  const game = gameDirectory(), files = [];
  for (const dir of ['System', 'Textures', 'Maps']) {
    for (const name of await readdir(path.join(game, dir))) {
      if (/\.(u|utx|dx)$/i.test(name)) files.push({path: `${dir}/${name}`, read: () => readFile(path.join(game, dir, name))});
    }
  }
  return {game, assets: new AssetStore(files)};
}

export function png(width, height, rgba) {
  const table = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
