// Shared by fog-capture-play.mjs (in the page, as an init script) and fog-replay.mjs (Node): the fog kernel call record and its output hash.
// A record is what fogMapKernel (src/runtime/volumetric-fog.mjs) sends the Rust loop: the frame's packed lights and colour tables (a `pack`),
// the nine grid words, the incoming early-out flag and the map's size; the capture adds the hash of the texels the loop answered and its
// final flag. The hash is two independent 32-bit lanes over the texels' 32-bit words (the map's byte length is a multiple of four).

export function hashTexels(bytes) {
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < words.length; i++) {
    const x = words[i];
    a = Math.imul(a ^ x, 16777619);
    b = Math.imul((b + x) ^ (b >>> 15), 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/** The recorder source a page installs as globalThis.DEUS_EX_FOG_RECORD (an object with onCall and frame). */
export const recorderSource = `(() => {
  ${hashTexels.toString().replace('export ', '')}
  const bytes64 = a => { let s = ''; const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); };
  const packIds = new WeakMap(), packs = [], packByHash = new Map(), calls = new Map();
  const state = { frames: 0, calls: 0, place: 0, nondeterministic: 0 };
  const packId = pack => {
    let id = packIds.get(pack);
    if (id !== undefined) return id;
    const key = hashTexels(new Uint8Array(pack.words.buffer, pack.words.byteOffset, pack.words.byteLength)) + ':' + hashTexels(pack.tables) + ':' + pack.count;
    id = packByHash.get(key);
    if (id === undefined) { id = packs.length; packs.push({ count: pack.count, words: bytes64(pack.words), tables: bytes64(pack.tables) }); packByHash.set(key, id); }
    packIds.set(pack, id);
    return id;
  };
  globalThis.DEUS_EX_FOG_RECORD = {
    state, packs, calls,
    frame() { state.frames++; },
    onCall(pack, grid, missIn, width, height, texels, missOut) {
      state.calls++;
      const id = packId(pack), key = id + '/' + grid.join(',') + '/' + missIn + '/' + width + 'x' + height, hash = hashTexels(texels);
      const have = calls.get(key);
      if (!have) calls.set(key, { pack: id, grid: Array.from(grid), missIn, width, height, hash, missOut, n: 1, place: state.place });
      else { have.n++; if (have.hash !== hash || have.missOut !== missOut) state.nondeterministic++; }
    },
    dump() { return { state, packs, calls: Array.from(calls.values()) }; },
  };
})();`;
