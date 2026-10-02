/** Galaxy music loader bridge: the Rust kernel (native/galaxy-kernel) owns
 * Galaxy's song state and runs the translated glxLoadMusic (IT branch). JS
 * only copies module bytes in and dumps out.
 *
 * Dump format ("GLXD", version 1), shared with scripts/native-galaxy-music-oracle.py:
 *   'GLXD' u32 version, then sections: tag[4] u32 length payload
 *   STAT u32 glxLoadMusic result
 *   SCAL song scalars in SCALARS order (little-endian, widths below)
 *   NAME 0x106981e0[32]  ORDR 0x10698220[256]  PANS 0x106886c0[256]
 *   SCRT 0x106841a8[0xc80] (IT loader statics)  VOIC 0x1068dca0[256*0xa0]
 *   INST u16 slot, u32 allocation size, the glxInstrument + glxSample bytes
 *        (each set sample Data pointer at +0x14a+n*0x48+0x44 reads 0xffffffff)
 *   SDAT u16 slot, u16 sample, u32 size, the Data allocation (after INST)
 *   PATT u16 pattern, 0x28 header bytes (Events at +0x24 = 0xffffffff), u32 size, events
 *   ALOG (u8 op 1 malloc / 2 realloc / 3 free, u32 size)*
 *   SLOG (u8 op 1 seek / 2 read / 3 tell, u32 a, u32 b, u32 pos before)*
 *        seek: a offset, b whence; read: a size, b count; tell: 0, 0
 */
export const SCALARS = [
  ['channels', 1], ['playing', 1], ['songLength', 1], ['musicMaster', 1], ['initialSpeed', 2], ['initialTempo', 2],
  ['playerMode', 1], ['minPeriod', 2], ['maxPeriod', 2], ['reset10698208', 4], ['reset10697ce6', 2],
  ['reset10698141', 1], ['reset10697ca8', 1], ['tempo', 2], ['speed', 2], ['orderPosition', 1],
  ['reset10698140', 1], ['reset10698200', 1], ['firstMusicVoice', 1],
];

export const STATUS = {
  ok: 0, alreadyLoaded: 1, musicPlaying: 2, damagedFile: 0x10,
  unsupportedFormat: 0x101, unsupportedTable: 0x102, unsupportedPattern: 0x103,
  unsupportedSample: 0x104, unsupportedCoding: 0x105,
};
export const HAZARD = {
  slackRead: 1, shortRead: 2, patternOverread: 4, uninitInstrument: 8, shortHeader: 0x10,
  unwrittenSampleTail: 0x100, // informational: looped-sample allocation tail never written
};
export const MUTANT = {
  none: 0, noFadeIn: 1, padding30: 2, dFineSwap: 3, noteCutKeepsVolume: 4,
  effectMemoryPerPattern: 5, clearOrderTail: 6, s9xRaw: 7, volumeClampDword: 8,
};

let pending;
export function loadGalaxyKernel() {
  return pending ??= (async () => {
    const url = new URL('./galaxy-kernel.wasm', import.meta.url);
    let bytes;
    if (url.protocol === 'file:') {
      const module = 'node:fs/promises';
      bytes = await (await import(/* @vite-ignore */ module)).readFile(url);
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Cannot load Galaxy kernel: HTTP ${response.status}`);
      bytes = await response.arrayBuffer();
    }
    return createGalaxyKernel((await WebAssembly.instantiate(bytes)).instance);
  })();
}

export function createGalaxyKernel(instance) {
  const x = instance.exports;
  return {
    /** A fresh library: glxInit's state, then EffectsChannels effect voices. */
    reset(effectsChannels = 16) { x.galaxy_reset(effectsChannels); },
    /** glxLoadMusic(&Mem{module, len + 1024}, GLX_LOADFROMMEMORY). */
    load(module) {
      const ptr = x.galaxy_input(module.length);
      new Uint8Array(x.memory.buffer, ptr, module.length).set(module);
      const status = x.galaxy_load(module.length);
      return {status, hazards: x.galaxy_hazards()};
    },
    unload() { return x.galaxy_unload(); },
    clearLogs() { x.galaxy_clear_logs(); },
    /** The dump built by the last load (a copy). */
    lastDump() { return new Uint8Array(x.memory.buffer, x.galaxy_dump_ptr(), x.galaxy_dump_len()).slice(); },
    /** A dump of the current state. */
    dump(status) { const ptr = x.galaxy_dump(status); return new Uint8Array(x.memory.buffer, ptr, x.galaxy_dump_len()).slice(); },
    setMutant(id) { x.galaxy_set_mutant(id); },
  };
}

/** Sections of a GLXD dump: [{tag, offset, payload}] (offset of the payload in the dump). */
export function glxdSections(dump) {
  const view = new DataView(dump.buffer, dump.byteOffset, dump.byteLength);
  const magic = String.fromCharCode(...dump.subarray(0, 4));
  if (magic !== 'GLXD' || view.getUint32(4, true) !== 1) throw new Error('Not a GLXD v1 dump');
  const out = [];
  for (let at = 8; at < dump.length;) {
    const tag = String.fromCharCode(...dump.subarray(at, at + 4)), size = view.getUint32(at + 4, true);
    out.push({tag, offset: at + 8, payload: dump.subarray(at + 8, at + 8 + size)});
    at += 8 + size;
  }
  return out;
}

/** Named scalars of a SCAL payload. */
export function glxdScalars(payload) {
  const out = {};
  let at = 0;
  for (const [name, width] of SCALARS) {
    let v = 0;
    for (let i = width - 1; i >= 0; i--) v = v * 256 + payload[at + i];
    out[name] = v; at += width;
  }
  return out;
}
