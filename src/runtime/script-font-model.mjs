/**
 * Recovered UFont glyph-metrics model for the Extension.dll text-measurement
 * natives (GC.GetTextExtent 1280 / GC.GetFontHeight 1281).
 *
 * Two layers, both verified against real data and the real bodies:
 *
 * Serialized layout (Font exports inside Engine.u / DeusExUI.u / Extension.u —
 * 33 shipped exports, every one matching exactly):
 *
 *   +0 u8    format byte (observed 0 in Engine/Extension, 2 in DeusExUI)
 *   +1 u8    page count
 *   +2 ..    per page, in order: a 4-byte page header followed by
 *            charsPerPage x 16-byte glyph records
 *   -4 i32   charsPerPage (the last four bytes of the export)
 *
 *   total size = 2 + pageCount * (4 + charsPerPage*16) + 4
 *
 *   The 4-byte page header is opaque to measurement (it carries the page's
 *   texture/palette references the draw path resolves; GetTextExtent and
 *   GetFontHeight never read it).  The glyph record is the FFontCharacter:
 *   {i32 startU, i32 startV, i32 uSize, i32 vSize} — uSize is the advance
 *   width the line scan accumulates, vSize the height the line-height max
 *   and GetFontHeight read.
 *
 * Runtime layout (what the native bodies dereference):
 *
 *   font +0x28 i32  charsPerPage — signed idiv divisor in the char mapper
 *   font +0x2c ptr  page table (TArray<FPage> data)
 *   font +0x30 i32  page count (TArray.Num)
 *   font +0x34 i32  page table Max (TArray.Max; written here, unread by metrics)
 *   page  +0x00 ptr texture (only surfaced through the lookup's texOut arg,
 *                         which both natives pass as null)
 *   page  +0x04 ptr glyph run (FFontCharacter[numChars])
 *   page  +0x08 i32 numChars — equals charsPerPage in every shipped font
 *   page  +0x0c i32 maxChars (TArray.Max)
 *
 * Lookup = Extension 0x10026880 over the mapper 0x10026950:
 *   ch &= 0xffff; page = ch / charsPerPage; rem = ch % charsPerPage (signed)
 *   miss iff page >= pageCount or rem >= page.numChars (signed jge compares)
 *   miss -> the static zero record at 0x100aeba0 (and 0x100aeba8/+0xc cleared);
 *   hit  -> page.chars + rem*16, and *texOut = page.texture when texOut != 0.
 *
 * Evidence: docs/script-font-model.md.  Nothing here is approximated.
 */
import {GC_DLL, GcStateModelBoundaryError} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

/** Runtime UFont fields the natives touch. */
export const UFONT = freeze({
  charsPerPage: 0x28,
  pages:        0x2c,
  pageCount:    0x30,
  pageMax:      0x34,
  objectSize:   0x38, // decode writes only +0x28..+0x34; block padded
});

/** Runtime FPage record (TArray element, 16 bytes). */
export const FONT_PAGE = freeze({
  texture:  0x00,
  chars:    0x04,
  numChars: 0x08,
  maxChars: 0x0c,
  size:     0x10,
});

/** Runtime FFontCharacter record (16 bytes). */
export const FONT_GLYPH = freeze({
  startU: 0x00,
  startV: 0x04,
  uSize:  0x08, // advance width — ScanLine 0x10029ae0 fild's this into the X run
  vSize:  0x0c, // height — the rescan's line-height max and GetFontHeight read it
  size:   0x10,
});

/** Address of the static zeroed record a glyph miss returns (Extension .bss). */
export const UFONT_MISS_GLYPH = 0x100aeba0;

export class UFontModelBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'UFontModelBoundaryError';
    this.code = `UFONT_MODEL_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fontFail = (message, details) => {
  throw new UFontModelBoundaryError(message, details);
};

/**
 * Decode a serialized Font export into the structural description both the
 * oracle image builder and writeFontImage consume:
 *   {format, pageCount, charsPerPage,
 *    pages: [{header: [b0,b1,b2,b3], chars: [[startU,startV,uSize,vSize]..]}]}
 */
export function decodeFontExport(bytes, label = 'font') {
  const len = bytes.length;
  if (len < 6) fontFail('Font export too small', {kind: 'SERIAL', value: len});
  const format = bytes[0];
  const pageCount = bytes[1];
  if (pageCount === 0) fontFail('Font export with zero pages', {kind: 'SERIAL'});
  const charsPerPage = bytes.length >= 4
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(len - 4, true)
    : 0;
  const expected = 2 + pageCount * (4 + charsPerPage * 16) + 4;
  if (expected !== len)
    fontFail(`Font export layout mismatch for ${label}`, {kind: 'SERIAL', value: {len, expected, pageCount, charsPerPage}});
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages = [];
  let pos = 2;
  for (let p = 0; p < pageCount; p++) {
    const header = [bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]];
    pos += 4;
    const chars = [];
    for (let i = 0; i < charsPerPage; i++) {
      chars.push([view.getInt32(pos, true), view.getInt32(pos + 4, true),
                  view.getInt32(pos + 8, true), view.getInt32(pos + 12, true)]);
      pos += 16;
    }
    pages.push({header, chars});
  }
  return {format, pageCount, charsPerPage, pages, serialSize: len};
}

/**
 * Lay a decoded font out as the runtime image the native lookup reads.
 * `heap` needs allocRaw(size) + write(addr, kind, value) — the validator's
 * GcHeap satisfies both.  The font block itself is +0x38 bytes; only the
 * +0x28..+0x34 span carries data (mirroring how the loader fills it).
 * Each page's +0 texture slot receives a distinct allocated sentinel block —
 * the field is a resolved UTexture* in the original; the metrics natives
 * never read it because they pass texOut = 0.
 */
export function writeFontImage(heap, decoded) {
  const font = heap.allocRaw(UFONT.objectSize);
  heap.bytes?.fill(0, font, font + UFONT.objectSize);
  const table = heap.allocRaw(decoded.pageCount * FONT_PAGE.size);
  for (let p = 0; p < decoded.pageCount; p++) {
    const page = decoded.pages[p];
    const chars = heap.allocRaw(page.chars.length * FONT_GLYPH.size);
    for (let i = 0; i < page.chars.length; i++) {
      const rec = page.chars[i];
      heap.write(chars + i * FONT_GLYPH.size + FONT_GLYPH.startU, 'i32', rec[0]);
      heap.write(chars + i * FONT_GLYPH.size + FONT_GLYPH.startV, 'i32', rec[1]);
      heap.write(chars + i * FONT_GLYPH.size + FONT_GLYPH.uSize, 'i32', rec[2]);
      heap.write(chars + i * FONT_GLYPH.size + FONT_GLYPH.vSize, 'i32', rec[3]);
    }
    const texture = heap.allocRaw(4);
    heap.write(table + p * FONT_PAGE.size + FONT_PAGE.texture, 'u32', texture);
    heap.write(table + p * FONT_PAGE.size + FONT_PAGE.chars, 'u32', chars);
    heap.write(table + p * FONT_PAGE.size + FONT_PAGE.numChars, 'i32', page.chars.length);
    heap.write(table + p * FONT_PAGE.size + FONT_PAGE.maxChars, 'i32', page.chars.length);
  }
  heap.write(font + UFONT.charsPerPage, 'i32', decoded.charsPerPage);
  heap.write(font + UFONT.pages, 'u32', table);
  heap.write(font + UFONT.pageCount, 'i32', decoded.pageCount);
  heap.write(font + UFONT.pageMax, 'i32', decoded.pageCount);
  return font;
}

/**
 * Extension 0x10026880 + 0x10026950 translated: map a UTF-16 code unit to its
 * glyph record.  Returns {startU, startV, uSize, vSize}; every field zero on
 * a miss (the static zero record at 0x100aeba0).  `texOut` models the third
 * argument — nonzero makes the function write the page texture pointer (a
 * real runtime pointer, modelled as the stored sentinel dword) or zero there.
 *
 * The mapper divides by the signed dword at font+0x28 with `idiv`: a zero
 * divisor traps into the native's SEH frame (a #DE -> fail-assert path that
 * is unreachable for any shipped font and cannot be reproduced against the
 * shared heap) and a negative remainder would index before the glyph run —
 * both are rejected here as unverifiable boundaries.
 */
export function uFontGlyph(L, font, ch, texOut = 0) {
  ch &= 0xffff;
  const cpp = L.read(font + UFONT.charsPerPage, 'i32');
  if (cpp === 0)
    fontFail('UFont glyph lookup with zero charsPerPage hits a native #DE', {kind: 'DIVISOR'});
  const page = Math.trunc(ch / cpp);
  const rem = ch - page * cpp;
  const count = L.read(font + UFONT.pageCount, 'i32');
  let hit = page < count; // signed jge: miss iff page >= pageCount
  let glyph = 0;
  let texture = 0;
  if (hit) {
    const table = L.read(font + UFONT.pages, 'u32');
    const pageRec = table + page * FONT_PAGE.size;
    if (page < 0 || rem < 0)
      fontFail('UFont glyph lookup produced a negative page/index (reads outside the table — unverifiable)', {kind: 'DIVISOR', value: {ch, cpp, page, rem}});
    hit = rem < L.read(pageRec + FONT_PAGE.numChars, 'i32'); // signed jge
    if (hit) glyph = L.read(pageRec + FONT_PAGE.chars, 'u32') + rem * FONT_GLYPH.size;
    texture = hit ? L.read(pageRec + FONT_PAGE.texture, 'u32') : 0;
    if (texOut)
      L.write(texOut, 'u32', texture);
  } else if (texOut) {
    L.write(texOut, 'u32', 0);
  }
  if (!hit) return {startU: 0, startV: 0, uSize: 0, vSize: 0, texture: 0};
  return {
    startU: L.read(glyph + FONT_GLYPH.startU, 'i32'),
    startV: L.read(glyph + FONT_GLYPH.startV, 'i32'),
    uSize:  L.read(glyph + FONT_GLYPH.uSize, 'i32'),
    vSize:  L.read(glyph + FONT_GLYPH.vSize, 'i32'),
    texture,
  };
}
