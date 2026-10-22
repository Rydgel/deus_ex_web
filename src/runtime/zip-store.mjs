/** A zip archive of stored (uncompressed) files: how the page hands the player their saves when it cannot write a folder (Firefox, Safari:
 * docs/save-storage.md "Export"). A `.dxs` save is already a package, a few MB each, so the entries are stored, not deflated: the writer is a CRC-32
 * and the three zip records (local header, central directory, end of central directory), PKWARE's APPNOTE 4.3. Names are UTF-8 (general flag bit 11),
 * with `/` separators; no Zip64 (an archive of 4 GiB or 65535 entries is refused: a save folder is far below either). */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();

/** The CRC-32 (IEEE 802.3, the zip's) of `bytes`. */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time words for a millisecond time, in the player's local time as the format has it (years from 1980, seconds in twos). */
export function dosDateTime(milliseconds) {
  const when = new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now());
  const year = Math.min(2107, Math.max(1980, when.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
  };
}

/** `entries`: [{path, bytes, modified?}]; returns the archive as a Uint8Array. */
export function createStoredZip(entries) {
  if (entries.length > 0xffff) throw new RangeError('A zip archive holds at most 65535 entries here');
  const encoder = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const pushLocal = chunk => { parts.push(chunk); offset += chunk.length; };
  for (const { path, bytes, modified } of entries) {
    const name = encoder.encode(String(path).replaceAll('\\', '/')), data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (name.length > 0xffff || data.length > 0xffffffff || offset > 0xffffffff) throw new RangeError('A zip entry is too large or its name too long here');
    const { date, time } = dosDateTime(modified), crc = crc32(data);
    const local = new Uint8Array(30 + name.length), view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true); view.setUint16(8, 0, true);
    view.setUint16(10, time, true); view.setUint16(12, date, true); view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, name.length, true); view.setUint16(28, 0, true);
    local.set(name, 30);
    const record = new Uint8Array(46 + name.length), cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    pushLocal(local); pushLocal(data);
  }
  const directoryStart = offset;
  let directorySize = 0;
  for (const record of central) { parts.push(record); directorySize += record.length; }
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  if (directoryStart + directorySize > 0xffffffff) throw new RangeError('A zip archive of more than 4 GiB is not written here');
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true); ev.setUint32(16, directoryStart, true);
  parts.push(end);
  const out = new Uint8Array(offset + directorySize + 22);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
