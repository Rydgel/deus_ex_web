/** A growable little-endian byte sink: the write side of package.mjs's Reader (UE1 version-68 package encodings). */
export class ByteWriter {
  constructor(capacity = 256) {
    this.bytes = new Uint8Array(capacity);
    this.view = new DataView(this.bytes.buffer);
    this.length = 0;
  }
  reserve(extra) {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + extra) size *= 2;
    const bytes = new Uint8Array(size);
    bytes.set(this.bytes.subarray(0, this.length));
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer);
  }
  u8(value) { this.reserve(1); this.bytes[this.length++] = value & 0xff; return this; }
  u16(value) { this.reserve(2); this.view.setUint16(this.length, value & 0xffff, true); this.length += 2; return this; }
  u32(value) { this.reserve(4); this.view.setUint32(this.length, value >>> 0, true); this.length += 4; return this; }
  i32(value) { this.reserve(4); this.view.setInt32(this.length, value | 0, true); this.length += 4; return this; }
  f32(value) { this.reserve(4); this.view.setFloat32(this.length, value, true); this.length += 4; return this; }
  /** The raw bits of a float32, so a value read as bits goes back unchanged (NaN payloads included). */
  f32bits(bits) { return this.u32(bits); }
  raw(bytes) { this.reserve(bytes.length); this.bytes.set(bytes, this.length); this.length += bytes.length; return this; }
  /** UE1 signed compact index (Reader.compact): 6 bits, then 7 + 7 + 7 + 5. */
  compact(value) {
    value |= 0;
    const negative = value < 0;
    let magnitude = negative ? -value : value;
    if (value === -0x80000000) magnitude = 0x80000000;
    let byte = (negative ? 0x80 : 0) | (magnitude > 0x3f ? 0x40 : 0) | (magnitude & 0x3f);
    this.u8(byte);
    magnitude = Math.floor(magnitude / 64);
    for (let index = 1; magnitude > 0; index++) {
      const last = index === 4;
      byte = (magnitude & (last ? 0x1f : 0x7f)) | (!last && magnitude > 0x7f ? 0x80 : 0);
      this.u8(byte);
      magnitude = Math.floor(magnitude / (last ? 32 : 128));
      if (last) break;
    }
    return this;
  }
  /** An FString: a compact count including the terminator, positive for ANSI, negative for UCS-2 (appIsPureAnsi: every unit below 0x100). */
  string(text) {
    text = String(text ?? '');
    if (text === '') return this.compact(0);
    const wide = [...text].some(ch => ch.charCodeAt(0) > 0xff) || text.length !== [...text].length;
    if (!wide) {
      this.compact(text.length + 1);
      for (let i = 0; i < text.length; i++) this.u8(text.charCodeAt(i));
      return this.u8(0);
    }
    this.compact(-(text.length + 1));
    for (let i = 0; i < text.length; i++) this.u16(text.charCodeAt(i));
    return this.u16(0);
  }
  /** The bytes written so far (a copy). */
  finish() { return this.bytes.slice(0, this.length); }
  get offset() { return this.length; }
}
