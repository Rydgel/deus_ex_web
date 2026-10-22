/**
 * The bytes of an .ini file, as the original reads and writes them (docs/config-persistence.md).
 *
 * Reading (appLoadFileToString, Core 0x1010323d): a file that starts with FF FE is UTF-16LE; otherwise each byte is one
 * TCHAR (Latin-1). config-cache.mjs read the files this way from the start.
 *
 * Writing (appSaveStringToFile, Core 0x10148c40, read from the disassembly): the string is scanned once; a character
 * of 0x100 or more makes the whole file Unicode, which is written as the two bytes FF FE and then Len UTF-16LE
 * characters; otherwise it is written as Len bytes, one per character. The terminating NUL is never written, and
 * FConfigFile::Write (DeusEx.exe 0x10915760) hands it the whole file text, so a one-character change rewrites the file.
 */

/** appLoadFileToString's decoding of a file's bytes. */
export function decodeIniBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return data[0] === 0xff && data[1] === 0xfe
    ? new TextDecoder('utf-16le').decode(data.subarray(2))
    : new TextDecoder('latin1').decode(data);
}

/** appSaveStringToFile's bytes for a file text. */
export function encodeIniText(text) {
  const string = String(text);
  let unicode = false;
  for (let i = 0; i < string.length; i++) if (string.charCodeAt(i) >= 0x100) { unicode = true; break; }
  if (!unicode) {
    const out = new Uint8Array(string.length);
    for (let i = 0; i < string.length; i++) out[i] = string.charCodeAt(i);
    return out;
  }
  const out = new Uint8Array(2 + string.length * 2);
  out[0] = 0xff; out[1] = 0xfe;
  for (let i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i);
    out[2 + i * 2] = code & 0xff; out[3 + i * 2] = code >> 8;
  }
  return out;
}

/** Whether two byte arrays hold the same bytes. */
export function sameBytes(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
