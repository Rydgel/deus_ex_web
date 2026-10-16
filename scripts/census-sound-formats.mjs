#!/usr/bin/env node
/** Census of every shipped Sound export by the loader Galaxy.dll would give
 * it (docs/audio-output-scope.md "Census", docs/galaxy-music/effects.md §1).
 *
 * RegisterSound hands a sound's bytes to glxLoadSample 0x10618e60, which
 * peeks 0x50 bytes and dispatches in this order (0x10618f1c..0x10618f9c):
 * `+8 == 'AS  '` → 0x1062b640, `+0 == '.snd'` → 0x1062b4c0, `+8 == 'WAVE'` →
 * the WAV loader 0x10619940, `+0x4c == 'SCRS'` → 0x1062b410, anything else →
 * the MPEG loader 0x10620b30. Inside the WAV loader the `fmt ` tag picks the
 * body: 1 PCM (translated), 0x11 IMA ADPCM (0x10619b12: a type 0x2000 ring
 * voice the decoder thread expands with 0x1061a170), 0x55 MPEG (0x10619c14:
 * 0x10620b30); any other tag reads no data and returns 0.
 *
 * Every package under the installation is read, one at a time (System *.u,
 * Sounds *.uax, Maps *.dx for MyLevel sounds, Music *.umx, Textures *.utx).
 * For the MPEG path the first frame header is decoded (version, layer, rate,
 * mode) and an ID3v2 tag or a Xing/Info/LAME header is noted, since those
 * decide an MP3 decoder's delay and padding handling. Listed apart: any loader
 * or WAV tag other than PCM mono, and any MPEG stream that is not mono Layer
 * III (a stereo record is the ring path's stereo pair).
 *
 *   node scripts/census-sound-formats.mjs [--json out.json]
 */
import {readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeSoundResource} from '../src/runtime/script-sound-resource.mjs';
import {gameDirectory} from './game-directory.mjs';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const root = gameDirectory();
const FOLDERS = [['System', /\.u$/i], ['Sounds', /\.uax$/i], ['Maps', /\.dx$/i], ['Music', /\.umx$/i], ['Textures', /\.utx$/i]];

const ascii = (b, at, n) => at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : '';
const u16 = (b, at) => b[at] | b[at + 1] << 8;
const u32 = (b, at) => (b[at] | b[at + 1] << 8 | b[at + 2] << 16 | b[at + 3] << 24) >>> 0;

/** glxLoadSample's dispatch on the first 0x50 bytes. */
function loaderOf(b) {
  if (ascii(b, 8, 4) === 'AS  ') return 'AS';
  if (ascii(b, 0, 4) === '.snd') return 'snd';
  if (ascii(b, 8, 4) === 'WAVE') return 'WAVE';
  if (ascii(b, 0x4c, 4) === 'SCRS') return 'SCRS';
  return 'MPEG';
}

/** The WAV loader's view: fmt tag, channels, rate, bits, and whether a
 * `smpl` loop and a `data` chunk are present. */
function waveInfo(b) {
  const out = {tag: null, channels: null, rate: null, bits: null, data: false, loops: 0};
  let at = 12;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4), size = u32(b, at + 4), body = at + 8;
    if (id === 'fmt ' && body + 16 <= b.length) {
      out.tag = u16(b, body); out.channels = u16(b, body + 2); out.rate = u32(b, body + 4); out.bits = u16(b, body + 14);
    } else if (id === 'data') out.data = true;
    else if (id === 'smpl' && body + 32 <= b.length) out.loops = u32(b, body + 28);
    at = body + size + (size & 1);
  }
  return out;
}

const MPEG_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]};
const MPEG_VERSION = {3: '1', 2: '2', 0: '2.5'}, MPEG_LAYER = {1: 'III', 2: 'II', 3: 'I'};
const MODES = ['stereo', 'joint', 'dual', 'mono'];

/** The first MPEG audio frame header, after an ID3v2 tag if any. */
function mpegInfo(b) {
  let at = 0, id3 = false;
  if (ascii(b, 0, 3) === 'ID3' && b.length >= 10) {
    id3 = true;
    at = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  }
  for (; at + 4 <= b.length && at < 4096; at++) {
    if (b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) continue;
    const version = b[at + 1] >> 3 & 3, layer = b[at + 1] >> 1 & 3, rateIndex = b[at + 2] >> 2 & 3, mode = b[at + 3] >> 6;
    if (version === 1 || layer === 0 || rateIndex === 3) continue;
    // Layer III side information length: 17/32 bytes (MPEG-1 mono/stereo), 9/17 (MPEG-2/2.5).
    const side = version === 3 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17);
    const crc = (b[at + 1] & 1) === 0 ? 2 : 0;
    const tag = ascii(b, at + 4 + crc + side, 4);
    return {frameAt: at, id3, version: MPEG_VERSION[version], layer: MPEG_LAYER[layer], rate: MPEG_RATES[version][rateIndex],
      mode: MODES[mode], xing: tag === 'Xing' || tag === 'Info' ? tag : null,
      lame: ascii(b, at, Math.min(b.length - at, 1024)).includes('LAME')};
  }
  return {frameAt: null, id3};
}

async function* packageFiles() {
  for (const [folder, pattern] of FOLDERS) {
    const dir = path.join(root, folder);
    let names;
    try { names = (await readdir(dir)).filter(n => pattern.test(n)).sort(); } catch { continue; }
    for (const name of names) yield {folder, name, path: path.join(dir, name)};
  }
}

const counts = new Map(), perPackage = [], odd = [], errors = [];
const bump = (key, n = 1) => counts.set(key, (counts.get(key) ?? 0) + n);
let packages = 0, sounds = 0;
for await (const file of packageFiles()) {
  packages++;
  const store = new AssetStore([{path: file.path, read: () => readFile(file.path)}]);
  let asset;
  try { asset = await store.get(file.name.replace(/\.[^.]+$/, '')); } catch (error) { errors.push(`${file.folder}/${file.name}: ${error.message}`); continue; }
  const local = new Map();
  for (const entry of asset.pkg.exports) {
    if (entry.className !== 'Sound') continue;
    sounds++;
    const where = `${file.folder}/${file.name} ${entry.path ?? entry.objectName}`;
    let decoded;
    try { decoded = decodeSoundResource({pkg: asset.pkg, bytes: asset.bytes, entry}); } catch (error) { errors.push(`${where}: ${error.message}`); continue; }
    const start = entry.serialOffset + decoded.lazy.inlineOffset;
    const bytes = asset.bytes.subarray(start, start + decoded.lazy.byteCount);
    const loader = loaderOf(bytes), format = String(decoded.lazy.formatName).toLowerCase();
    let key;
    if (loader === 'WAVE') {
      const w = waveInfo(bytes);
      const body = w.tag === 1 ? 'PCM' : w.tag === 0x11 ? 'IMA-ADPCM' : w.tag === 0x55 ? 'MPEG-in-WAV' : `tag-${w.tag}`;
      key = `WAVE ${body} ch${w.channels} ${w.bits}-bit ${w.rate} Hz${w.loops ? ' looped' : ''}`;
      if (w.tag !== 1 || w.channels !== 1 || !w.data) odd.push(`${where}: ${key}${w.data ? '' : ' (no data chunk)'}`);
    } else if (loader === 'MPEG') {
      const m = mpegInfo(bytes);
      key = m.frameAt === null ? `MPEG path, no frame header${m.id3 ? ' (ID3v2)' : ''}`
        : `MPEG-${m.version} Layer ${m.layer} ${m.rate} Hz ${m.mode}${m.id3 ? ' ID3v2' : ''}${m.xing ? ` ${m.xing}` : ''}${m.lame ? ' LAME' : ''}${m.frameAt ? ` first frame at ${m.frameAt}` : ''}`;
      // A stereo MPEG record takes the ring path's stereo pair (two voices); Play's host decode is mono.
      if (m.frameAt === null || m.layer !== 'III' || m.mode !== 'mono') odd.push(`${where}: ${key}`);
    } else {
      key = `${loader} loader`;
      odd.push(`${where}: ${key}`);
    }
    key += ` [format name ${format}]`;
    bump(key); local.set(key, (local.get(key) ?? 0) + 1);
  }
  if (local.size) perPackage.push({package: `${file.folder}/${file.name}`, kinds: Object.fromEntries(local)});
}

console.log(`${packages} packages read, ${sounds} Sound exports, ${errors.length} unreadable`);
for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${key}`);
console.log(`\nPackages holding sounds (${perPackage.length}):`);
for (const p of perPackage) console.log(`  ${p.package}: ${Object.entries(p.kinds).map(([k, n]) => `${n} ${k.replace(/ \[format name .*\]$/, '')}`).join('; ')}`);
console.log(`\nOutside the translated WAVE PCM mono path and mono MPEG Layer III (${odd.length}):`);
for (const line of odd) console.log(`  ${line}`);
if (errors.length) { console.log('\nErrors:'); for (const e of errors) console.log(`  ${e}`); }
if (jsonOut) await writeFile(jsonOut, JSON.stringify({packages, sounds, counts: Object.fromEntries(counts), perPackage, odd, errors}, null, 1));
