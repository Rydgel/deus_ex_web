/**
 * The host half of the Rust AI event manager (docs/ai-event-manager.md, native/script-vm/src/aievent.rs).
 */

// Core's GCRCTable as appInit fills it (UE1 appCRCInit: polynomial 0x04C11DB7, MSB first).
const CRC = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let c = (index << 24) >>> 0;
  for (let bit = 0; bit < 8; bit++) c = (c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) : (c << 1)) >>> 0;
  CRC[index] = c;
}
/** appStrihash of an event name (UEventManager::GetEventHash, inlined in FindEvent 0x103834b0): per UTF-16 unit, upper-cased
 * for a-z, the CRC step on its low byte and then its high byte. */
export function aiNameHash(text) {
  let hash = 0;
  const step = (h, byte) => ((h >>> 8) ^ CRC[(h ^ byte) & 0xff]) >>> 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0x61 && c <= 0x7a) c -= 0x20;
    hash = step(hash, c & 0xff);
    hash = step(hash, (c >> 8) & 0xff);
  }
  return hash >>> 0;
}
