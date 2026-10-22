/** Which bytes of a SaveInfo.dxs Play wrote differ from the original's for the same moment, and why (docs/travel.md "Play, step 4").
 *
 * The files must have the same layout (the same size and tables); each differing byte is placed in the header's GUID, a name-table entry, a tag's value in an
 * export or the snapshot's pixels, and is *expected* only where it is a host input or a reading of the clock:
 *   GUID                       new for every package the original saves as well
 *   Texture<N> / Palette<N>    the name table entry of an object the unique-name counter numbered
 *   Year .. Second, saveTime   the time stamp (the clock) and the play time (the player's saveTime property accumulates between the two readings)
 *   Texture.InternalTime       appSeconds() when the texture was made (a clock)
 *   the texture's mip bytes    the picture of the frame
 * Anything else is `unexpected`. */
import { parsePackage, Reader } from '../src/unreal/package.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';
import { writeSaveInfo } from '../src/runtime/save-info-write.mjs';

const SIZE_CODES = [1, 2, 4, 12, 16];
const EXPECTED_TAGS = { DeusExSaveInfo: new Set(['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second', 'saveTime']), Texture: new Set(['InternalTime']), Palette: new Set() };

/** The tags of one export: [{name, index, start, end}] (the value's bytes), and the offset after the `None` that ends them. */
export function walkTags(bytes, start, names) {
  const r = new Reader(bytes);
  r.seek(start);
  const tags = [];
  for (;;) {
    const name = names[r.compact()]?.name;
    if (name === undefined || name === 'None') return { tags, end: r.offset };
    const info = r.u8(), type = info & 15, code = (info >> 4) & 7;
    if (type === 10) r.compact();
    let size;
    if (type === 3) { r.u8(); size = 0; }                          // a bool: the size byte (0); its value is in the info byte
    else { size = code < 5 ? SIZE_CODES[code] : code === 5 ? r.u8() : code === 6 ? r.u16() : r.u32(); }
    let index = 0;
    if (type !== 3 && (info & 0x80)) {
      const first = r.u8();
      if (first < 0x80) index = first;
      else if ((first & 0xc0) === 0x80) index = ((first & 0x3f) << 8) | r.u8();
      else { index = ((first & 0x3f) << 24) | (r.u8() << 16) | (r.u8() << 8) | r.u8(); }
    }
    tags.push({ name, index, start: r.offset, end: r.offset + size });
    r.seek(r.offset + size);
  }
}

const kindOf = name => /^Texture\d+$/.test(name) ? 'Texture' : /^Palette\d+$/.test(name) ? 'Palette' : name;
const tailOf = pkg => pkg.names.slice(pkg.names.findIndex(entry => entry.name === 'Core') + 1).map(entry => entry.name);

/** Play's file written again with the original's *process history*: the order of the three object names at the end of the name table and of the Texture and
 * Palette exports (the original's FName and GObjObjects indices of that session; docs/travel.md "Play, step 4"). The writer reproduces 46 originals byte for byte
 * given those two orders, so what remains in a comparison is Play's own content. Returns `{bytes, history}`; `bytes` is Play's own when the orders already agree
 * or the files differ in more than the order. */
export function inOriginalsHistory(play, real) {
  const p = parsePackage(play), r = parsePackage(real);
  const playTail = tailOf(p), realTail = tailOf(r);
  const playTexture = p.exports.findIndex(entry => entry.className === 'Texture'), realTexture = r.exports.findIndex(entry => entry.className === 'Texture');
  const history = { nameTail: { play: playTail.join(' '), real: realTail.join(' ') }, textureFirst: { play: playTexture === 0, real: realTexture === 0 } };
  if (playTail.join() === realTail.join() && playTexture === realTexture) return { bytes: play, history, reordered: false };
  const byKind = new Map(playTail.map(name => [kindOf(name), name]));
  const nameTail = realTail.map(name => byKind.get(kindOf(name)));
  if (nameTail.some(name => name === undefined) || playTexture < 0) return { bytes: play, history, reordered: false };
  try {
    const info = parseSaveInfo(play), values = readObject(p, play, playTexture + 1).values;
    const bytes = writeSaveInfo({ properties: info.properties, snapshot: { pitch: 256, height: 128, data: info.snapshot.image.data }, textureFirst: realTexture === 0,
      guid: Uint8Array.from(Buffer.from(p.guid, 'hex')), textureName: info.snapshot.texture, paletteName: info.snapshot.palette,
      internalTime: [values.InternalTime, values['InternalTime[1]']], nameTail });
    return { bytes, history, reordered: true };
  } catch { return { bytes: play, history, reordered: false }; }
}

export function explainSaveInfoDifferences(playAsWritten, real) {
  const { bytes: play, history, reordered } = inOriginalsHistory(playAsWritten, real);
  if (play.length !== real.length) return { sameLayout: false, play: play.length, real: real.length, groups: [], unexpected: [], history, reordered };
  const pkg = parsePackage(real);
  const regions = [{ from: 36, to: 52, label: 'package GUID', expected: true }];
  let at = 64;
  for (const entry of pkg.names) {
    const wide = false;
    void wide;
    const length = (() => { const r = new Reader(real); r.seek(at); r.string(); return r.offset - at + 4; })();
    regions.push({ from: at, to: at + length, label: `name table: ${entry.name}`, expected: /^(Texture|Palette)\d+$/.test(entry.name) });
    at += length;
  }
  for (const entry of pkg.exports) {
    const { tags, end } = walkTags(real, entry.serialOffset, pkg.names);
    for (const tag of tags) regions.push({ from: tag.start, to: tag.end, label: `${entry.className}.${tag.name}${tag.index ? `[${tag.index}]` : ''}`, expected: EXPECTED_TAGS[entry.className]?.has(tag.name) ?? false });
    if (entry.className === 'Texture') {
      const r = new Reader(real);
      r.seek(end); r.compact(); r.u32();
      const count = r.compact();
      regions.push({ from: r.offset, to: r.offset + count, label: 'Texture: the snapshot\'s pixels', expected: true });
    }
  }
  const groups = new Map(), unexpected = [];
  for (let i = 0; i < real.length; i++) {
    if (play[i] === real[i]) continue;
    const region = regions.find(candidate => i >= candidate.from && i < candidate.to);
    const label = region?.label ?? `byte ${i} (outside every field)`;
    const group = groups.get(label) ?? { label, count: 0, first: i, last: i, expected: Boolean(region?.expected) };
    group.count++; group.last = i;
    groups.set(label, group);
    if (!region?.expected) unexpected.push({ offset: i, label, play: play[i], real: real[i] });
  }
  return { sameLayout: true, groups: [...groups.values()], unexpected, history, reordered };
}
