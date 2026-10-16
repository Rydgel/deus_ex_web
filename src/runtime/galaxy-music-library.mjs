// ---- Galaxy music library: the service interface and the recording mirror (phase 4) ----
//
/** The Galaxy music library as the subsystem sees it (docs/galaxy-music.md,
 * docs/galaxy-music/update-transition.md §6).
 *
 * UGalaxyAudioSubsystem (galaxy-music.mjs) drives the library through one
 * service object; in the browser the library (glx* functions and the module
 * player) runs inside an AudioWorklet that the host builds against the same
 * method names:
 *
 *   lock(), unlock()                   Update's EnterCriticalSection 0x10609549
 *                                      .. LeaveCriticalSection 0x1060abd6; the
 *                                      ops between them are one atomic batch
 *   setSampleVolume(volume, mode)      glxSetSampleVolume 0x1060ec00
 *   setMusicVolume(volume, mode)       glxSetMusicVolume 0x1060eb60
 *   loadMusic(bytes)                   glxLoadMusic(&Mem{'MEMO', 0xc, Data, Num, 0}, 2)
 *                                      0x10618be0; bytes = Data after Add(1024)
 *   unloadMusic()                      glxUnloadMusic 0x10619450
 *   stopMusic(), startMusic()          0x106183a0, 0x106122a0
 *   controlMusic(cmd, value)           glxControlMusic 0x1060d0e0
 *   clearVoiceActive(first, count)     Update's loop 0x1060a82a..0x1060a844:
 *                                      byte +0x0f of voices [first, first+count)
 *   setBreakFlag()                     byte [0x10697ca8] = 1 (0x1060a88d)
 *   order()                            byte [0x10698201] as last known to the
 *                                      game thread
 *
 * The original only logs the return values (the "%s failed: %i" lines), so a
 * method may return undefined (an asynchronous host) and the subsystem never
 * changes its behaviour on a result.
 *
 * createMirrorMusicLibrary below is a host stand-in for headless runs and
 * validation, not the library: it records the ops and mirrors the few bytes
 * whose rules the subsystem's calls alone decide. It has no loader and no
 * sequencer, so the order position never advances on its own. Its gates follow
 * the instructions (validated against the real library under Unicorn by
 * scripts/validate-galaxy-music-update.mjs, tier 2):
 *
 * - glxSetSampleVolume / glxSetMusicVolume: 0x11 outside 0..127; mode 0 sets
 *   the master and a zero step, otherwise the step is -mode when the signed
 *   master byte is >= the target, else mode; the target is the volume.
 * - glxLoadMusic: 1 while a module is loaded ([0x10698348] != 0); 2 while
 *   playing (the reset 0x1060e850); otherwise the reset (order 0xff, break
 *   flag 0, [0x10698200] = 1, music master 0x7f) and the loader. The mirror
 *   does not parse the module: it counts the load as a success with an
 *   unknown song length, and the loader's own music master store (the
 *   header GV) as unknown.
 * - glxUnloadMusic: 2 while playing, else no module.
 * - glxStopMusic: 4 when not playing, 3 without a module, else not playing.
 * - glxStartMusic: 2 when playing, 3 without a module, else playing.
 * - glxControlMusic: pos = value < 0 ? value + order + 2 : value; commands 1
 *   and 2 refuse (0x11) pos > song length (signed), else order = (pos - 1) &
 *   0xff; command 1 also sets the break flag and zeroes [0x10697cdc]; command
 *   3 stores [0x10698200]; others 0x11. The song length is the loader's
 *   result, which the mirror does not know: pos <= 0 is always accepted, and
 *   a larger pos is applied and counted in `uncertain` (the real library
 *   refuses it when the module has fewer orders).
 */
export function createMirrorMusicLibrary({history = 256} = {}) {
  // The library state the subsystem's calls decide. glxInit seeds the order
  // byte with 0xff (0x1060e0b6) and starts with no module and nothing playing.
  const state = {order: 0xff, breakFlag: 0, loopFlag: null, playing: false, loaded: false, songLength: null,
    musicMaster: null, musicStep: null, musicTarget: null, sampleMaster: null, sampleStep: null, sampleTarget: null,
    uncertain: 0, module: null, loads: 0};
  // Recorded batches: each lock()..unlock() with at least one op, and each
  // op issued outside a batch as a batch of its own (SetInstantMusicVolume
  // runs outside Update's lock). Bounded: the last `history` batches.
  const batches = [];
  // One reused buffer for the open batch: an empty lock()..unlock() (every
  // steady-state Update) allocates nothing.
  const open = [];
  let depth = 0, total = 0;
  const commit = batch => {
    batches.push(batch);
    if (batches.length > history) batches.shift();
    total++;
  };
  const record = op => {
    if (depth) { open.push(op); return; }
    commit([op]);
  };
  const volume = (prefix, value, mode) => {
    if (!Number.isInteger(value) || value < 0 || value > 127) return 0x11;
    if (mode === 0) { state[`${prefix}Master`] = value; state[`${prefix}Step`] = 0; }
    else {
      const master = state[`${prefix}Master`];
      // movsx of the master byte against the volume; unknown master: unknown step.
      state[`${prefix}Step`] = master === null ? null : (((master << 24 >> 24) >= value ? -mode : mode) << 24 >> 24);
    }
    state[`${prefix}Target`] = value;
    return 0;
  };
  const position = value => {
    const pos = value < 0 ? value + state.order + 2 : value;
    if (state.songLength !== null) return pos > state.songLength ? null : pos;
    if (pos > 0) state.uncertain++;
    return pos;
  };
  return {
    kind: 'mirror',
    state,
    batches,
    get totalBatches() { return total; },
    /** The recorded batches since the last call, oldest first. */
    takeBatches() { const out = batches.splice(0); return out; },
    lock() { depth++; },
    unlock() {
      if (depth === 0) throw new Error('Galaxy music library: unlock without lock');
      if (--depth === 0 && open.length) { commit(open.slice()); open.length = 0; }
    },
    setSampleVolume(value, mode) { record({op: 'setSampleVolume', volume: value, mode}); return volume('sample', value, mode); },
    setMusicVolume(value, mode) { record({op: 'setMusicVolume', volume: value, mode}); return volume('music', value, mode); },
    loadMusic(bytes) {
      record({op: 'loadMusic', length: bytes?.length ?? null});
      if (!bytes) return 0x11;
      if (state.loaded) return 1;
      if (state.playing) return 2;
      Object.assign(state, {order: 0xff, breakFlag: 0, loopFlag: 1, musicMaster: null, loaded: true, songLength: null,
        module: bytes, loads: state.loads + 1});
      return 0;
    },
    unloadMusic() {
      record({op: 'unloadMusic'});
      if (state.playing) return 2;
      state.loaded = false; state.module = null; state.songLength = null;
      return 0;
    },
    stopMusic() {
      record({op: 'stopMusic'});
      if (!state.playing) return 4;
      if (!state.loaded) return 3;
      state.playing = false;
      return 0;
    },
    startMusic() {
      record({op: 'startMusic'});
      if (state.playing) return 2;
      if (!state.loaded) return 3;
      state.playing = true;
      return 0;
    },
    controlMusic(cmd, value) {
      record({op: 'controlMusic', cmd, value});
      if (cmd === 3) { state.loopFlag = value & 0xff; return 0; }
      if (cmd !== 1 && cmd !== 2) return 0x11;
      const pos = position(value | 0);
      if (pos === null) return 0x11;
      state.order = (pos - 1) & 0xff;
      if (cmd === 1) state.breakFlag = 1;
      return 0;
    },
    clearVoiceActive(first, count) { record({op: 'clearVoiceActive', first, count}); },
    setBreakFlag() { record({op: 'setBreakFlag'}); state.breakFlag = 1; },
    order() { return state.order; },
  };
}
// ---- end of the recording mirror -------------------------------------------------

// ---- Galaxy music library: browser host transport (phase 5) -----------------
//
// docs/galaxy-music.md "Phase 5: Output", docs/galaxy-audio.md "Effects
// through Galaxy's mixer". The library (glx* state, sequencer, sample voices,
// mixer) lives in an AudioWorklet (src/viewer/galaxy-music-worklet.mjs). The
// simulation calls the `library` service object below, wherever it runs (the
// sim worker, or the page with ?sim=inline); each call becomes one op, and
// the ops between lock() and unlock() (Update's critical section,
// 0x1060e840..0x10618920) cross as one atomic batch on a MessagePort that
// goes straight to the worklet. A call outside lock() is its own batch, as
// every glx* entry takes the library lock itself. Nothing crosses the page's
// main thread in worker mode.
//
// Read-backs. Update reads two things the mixer thread changes on its own
// schedule: the order position (byte [0x10698201], copied into SongSection
// every frame without a pending transition) and each effect voice's Active
// byte (+0x0f, glxControlVoice(voice, GLX_GETSTATUS), the "voice finished"
// poll). The worklet reports {batch, state, active} after a batch and after a
// callback that changed them. order() and voiceActive() return the reported
// values when the report covers the last batch issued; otherwise they replay
// the sim's unacknowledged ops over the report (glxLoadMusic's reset seeds
// 0xff, glxControlMusic 1|2 stores value-1; glxStartSample sets Active,
// glxStopSample clears it). This is host timing: in the original the mixer
// thread also changes both asynchronously to the game thread's read.
//
// Samples. RegisterSound (0x10606af0) runs glxLoadSample on the game thread;
// the mixer thread reads the record and data it allocated. Here the
// simulation side runs the translated loader in its own kernel instance (the
// sample registry: it needs the record's C4Speed at once, for Update's
// frequency), and the loadSample op carries the bytes to the worklet, which
// runs the same loader. Both start from an empty sample heap when the
// library opens, so the handles (the records' model addresses) agree; the
// op carries the registry's handle and the worklet checks it.
import { readMusicExport } from '../unreal/music-module.mjs';

/** Op codes on the wire (src/viewer/galaxy-music-worklet.mjs decodes them). */
export const MUSIC_OP = Object.freeze({
  setSampleVolume: 1, setMusicVolume: 2, loadMusic: 3, unloadMusic: 4, stopMusic: 5,
  startMusic: 6, controlMusic: 7, clearVoiceActive: 8, setBreakFlag: 9,
  loadSample: 10, startSample: 11, controlSample: 12, stopSample: 13, setSampleReverb: 14,
  loadHostSample: 15, attachSample: 16, releaseSample: 17,
});
/** Int32 arguments per op after its code (loadMusic/loadSample/attachSample:
 * blob index, byte length[, handle]; setSampleReverb: the 0x6c-byte glxReverb
 * as 27 words; loadHostSample: rate, frames, handle; releaseSample: handle). */
export const OP_ARITY = Object.freeze({ 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 3, 11: 6, 12: 4, 13: 1, 14: 27,
  15: 3, 16: 3, 17: 1 });
/** The ops whose first argument is a blob (bytes in `modules`). */
const BLOB_OPS = new Set([MUSIC_OP.loadMusic, MUSIC_OP.loadSample, MUSIC_OP.attachSample]);
/** Update's FArray::Add(1024) after the module bytes (0x1060a702..0x1060a735). */
export const MUSIC_SLACK = 1024;
/** Voice handles: glxVoices at the preferred base, 0xa0 bytes each. */
export const VOICE_BASE = 0x1068dca0, VOICE_SIZE = 0xa0;

/** One batch as a message: `ops` holds [code, ...args] per op (Int32, the
 * arity of OP_ARITY); a blob op (loadMusic, loadSample, attachSample) holds
 * the index of its bytes in `modules` and the byte length. Blob bytes are
 * transferred, so they cross once: a copy, or with `owned` the caller's own
 * whole-buffer arrays, which are then detached. Returns {message, transfer}.
 * `ops` entries are [name, ...args]: loadMusic's argument a Uint8Array;
 * loadSample's the bytes and the expected handle; attachSample's the 16-bit
 * PCM and the handle; setSampleReverb's 27 words. */
export function encodeMusicBatch(id, ops, { owned = false } = {}) {
  let length = 0;
  for (const [name] of ops) {
    const code = MUSIC_OP[name];
    if (!code) throw new Error(`Unknown Galaxy library op ${name}`);
    length += 1 + OP_ARITY[code];
  }
  const words = new Int32Array(length), modules = [];
  let at = 0;
  for (const [name, ...args] of ops) {
    const code = MUSIC_OP[name];
    words[at++] = code;
    if (BLOB_OPS.has(code)) {
      const bytes = args[0] instanceof Uint8Array ? args[0] : new Uint8Array(args[0]);
      const copy = owned && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
      words[at++] = modules.length; words[at++] = copy.length;
      if (code !== MUSIC_OP.loadMusic) words[at++] = args[1] | 0;
      modules.push(copy.buffer);
    } else if (code === MUSIC_OP.setSampleReverb) {
      const block = args[0];
      for (let i = 0; i < 27; i++) words[at++] = block[i] | 0;
    } else for (let i = 0; i < OP_ARITY[code]; i++) words[at++] = (args[i] ?? 0) | 0;
  }
  return { message: { type: 'batch', id, ops: words, modules }, transfer: [words.buffer, ...modules] };
}

// The library state order() starts from, as galaxy_music_state packs it.
const stateOf = packed => ({ order: packed & 0xff, playing: Boolean(packed & 0x100), songLength: (packed >>> 16) & 0xff,
  loaded: Boolean(packed & 0x1000000) });
// glxInit leaves order 0xff, nothing loaded or playing.
const INITIAL_STATE = 0xff;

/** The order position the library would hold after `ops` on `state`, for
 * the ops that write it or gate those writes (glxLoadMusic 0x10618be0 and
 * its reset 0x1060e850, glxUnloadMusic, glxStopMusic, glxStartMusic,
 * glxControlMusic 0x1060d0e0). Assumed, not known: that a pending load
 * succeeds; a pending load's song length is unknown, so a control after it
 * is taken as in range. Sequencer progress is not modelled. */
function mirrorOrder(state, batches) {
  let { order, playing, loaded, songLength } = state;
  for (const ops of batches) for (const [name, a, b] of ops) {
    if (name === 'loadMusic') { if (!loaded && !playing) { order = 0xff; loaded = true; songLength = null; } }
    else if (name === 'unloadMusic') { if (!playing) loaded = false; }
    else if (name === 'stopMusic') { if (playing && loaded) playing = false; }
    else if (name === 'startMusic') { if (!playing && loaded) playing = true; }
    else if (name === 'controlMusic' && (a === 1 || a === 2)) {
      const position = b < 0 ? b + order + 2 : b;
      if (songLength === null || !(position > songLength)) order = (position - 1) & 0xff;
    }
  }
  return order;
}
const MIRRORED = new Set(['loadMusic', 'unloadMusic', 'stopMusic', 'startMusic', 'controlMusic']);
/** The voice slot of a voice handle, or -1. */
export const voiceSlot = voice => {
  const off = (voice >>> 0) - VOICE_BASE;
  return off >= 0 && off % VOICE_SIZE === 0 && off / VOICE_SIZE < 256 ? off / VOICE_SIZE : -1;
};
/** Active after the start (glxStartSample sets +0x0f, 0x10612480; a sample
 * without Data leaves it) or the stop (glxStopSample clears it). */
const activeAfter = op => op[0] === 'startSample' ? 1 : 0;

let kernelBytes = null;
async function galaxyKernelBytes() {
  return kernelBytes ??= (async () => {
    const url = new URL('./galaxy-kernel.wasm', import.meta.url);
    if (url.protocol === 'file:') {
      const module = 'node:fs/promises';
      return (await import(/* @vite-ignore */ module)).readFile(url);
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Cannot load the Galaxy kernel: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  })();
}

/** The simulation side's sample registry: glxLoadSample (effects.rs, the
 * translated 0x10618e60 with GLX_LOADFROMMEMORY) in a kernel instance of its
 * own, opened as the worklet opens its library (an empty sample heap). It
 * keeps the 0x48-byte records and drops the data. `load(bytes)` returns
 * {handle, c4Speed, type, length, loopStart, loopEnd} or {handle: 0, fault}
 * (fault 0: the loader returned no sample; else the effects.rs fault, e.g.
 * 0x130 for a loader that is not translated). */
export async function createSampleRegistry() {
  const { instance } = await WebAssembly.instantiate(await galaxyKernelBytes(), {});
  const x = instance.exports;
  x.galaxy_reset(16);
  return {
    load(bytes) {
      const ptr = x.galaxy_input(bytes.length);
      new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
      const handle = x.galaxy_sample_load(bytes.length) >>> 0;
      const fault = x.galaxy_fault();
      if (!handle || fault) {
        // A fault is sticky in the kernel; this instance only loads samples, so
        // a fresh library keeps the heap where it was (nothing was allocated
        // past the record: the loader that faulted is not translated).
        if (fault) x.galaxy_clear_fault();
        return { handle: 0, fault };
      }
      const record = new DataView(x.memory.buffer, x.galaxy_sample_record(handle), 0x48);
      const out = { handle, type: record.getUint16(0x2c, true), length: record.getUint32(0x30, true),
        loopStart: record.getUint32(0x34, true), loopEnd: record.getUint32(0x38, true), c4Speed: record.getUint32(0x3c, true) };
      x.galaxy_sample_forget(handle);
      return out;
    },
    /** A host-decoded speech record (effects.rs `host_sample`, a stand-in
     * for the MPEG loader's): the same 0x48-byte heap allocation the worklet
     * makes for its loadHostSample op. */
    loadHost(rate, frames) {
      const handle = x.galaxy_sample_host(rate >>> 0, frames >>> 0) >>> 0;
      return { handle, type: 0x24, length: frames >>> 0, loopStart: 0, loopEnd: 0, c4Speed: rate >>> 0, host: true };
    },
  };
}

/** The simulation's `library` service (the Update translation calls it).
 * `post(message, transfer)` sends a batch toward the worklet; `report(data)`
 * takes the worklet's {type: 'report', batch, state, active} messages.
 * With `samples` (a createSampleRegistry promise, or the registry) the
 * service also carries the effect voices: registerSample, startSample,
 * controlSample, stopSample, voiceActive, setSampleReverb. */
export function createMusicLibraryProxy(post, { samples = null } = {}) {
  let depth = 0, open = null, issued = 0,
    reported = { batch: 0, ...stateOf(INITIAL_STATE), active: 0, any: false, positions: new Map() };
  // Unacknowledged batches' ops that touch the mirrored state.
  const pending = [];
  const counts = { batches: 0, ops: 0, modules: 0, moduleBytes: 0, reports: 0, samples: 0, sampleBytes: 0, voiceOps: 0,
    hostSamples: 0, attaches: 0, attachBytes: 0, releases: 0 };
  let registry = null, registryError = null;
  const ready = samples ? Promise.resolve(samples).then(r => { registry = r; }, error => { registryError = String(error?.message ?? error); }) : null;
  const registered = new Map();
  function flush(ops) {
    if (!ops.length) return;
    const id = ++issued, { message, transfer } = encodeMusicBatch(id, ops, { owned: true });
    counts.batches++; counts.ops += ops.length;
    for (const buffer of message.modules) { counts.modules++; counts.moduleBytes += buffer.byteLength; }
    post(message, transfer);
    const mirrored = [];
    for (const op of ops) {
      if (MIRRORED.has(op[0])) mirrored.push([op[0], op[1], op[2]]);
      else if (op[0] === 'startSample' || op[0] === 'stopSample') mirrored.push([op[0], op[0] === 'startSample' ? voiceSlotOf(op[1]) : voiceSlot(op[1])]);
    }
    if (mirrored.length) pending.push({ id, ops: mirrored });
  }
  // glxStartSample's fixed voice: 0x1068dc00 + 0xa0 * Voice (0x106123fd).
  const voiceOf = voice => (0x1068dc00 + VOICE_SIZE * voice) >>> 0;
  const voiceSlotOf = voice => voiceSlot(voiceOf(voice));
  const call = op => { if (depth) open.push(op); else flush([op]); };
  const library = {
    lock() { if (depth++ === 0) open = []; },
    unlock() {
      if (!depth) throw new Error('Galaxy music library unlock without lock');
      if (--depth === 0) { const ops = open; open = null; flush(ops); }
    },
    setSampleVolume(volume, mode) { call(['setSampleVolume', volume, mode]); },
    setMusicVolume(volume, mode) { call(['setMusicVolume', volume, mode]); },
    /** glxLoadMusic(&Mem{Data, Num}, GLX_LOADFROMMEMORY); `bytes` already
     * ends with the 1024-byte slack. Copied at the call. */
    loadMusic(bytes) { call(['loadMusic', new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice()]); },
    unloadMusic() { call(['unloadMusic']); },
    stopMusic() { call(['stopMusic']); },
    startMusic() { call(['startMusic']); },
    controlMusic(cmd, value) { call(['controlMusic', cmd, value]); },
    clearVoiceActive(firstVoice, count) { call(['clearVoiceActive', firstVoice, count]); },
    setBreakFlag() { call(['setBreakFlag']); },
    /** Byte [0x10698201] as this side knows it (see the file comment). */
    order() {
      const open_ = open?.filter(([name]) => MIRRORED.has(name)) ?? [];
      if (!pending.length && !open_.length) return reported.order;
      return mirrorOrder(reported, [...pending.map(batch => batch.ops.filter(([name]) => MIRRORED.has(name))), open_]);
    },
    // ---- effect voices ----
    /** Whether this service carries effect voices (a registry was given). */
    effects: Boolean(samples),
    /** Resolves once the sample registry exists. */
    ready: () => ready,
    /** RegisterSound's glxLoadSample for `key` (once per key per library):
     * {handle, c4Speed, ...} at once from the registry, the bytes to the
     * worklet in the loadSample op. */
    registerSample(key, bytes) {
      let entry = registered.get(key);
      if (entry) return entry;
      if (!registry) throw new Error(registryError ?? 'Galaxy sample registry not ready');
      entry = registry.load(bytes);
      registered.set(key, entry);
      if (entry.handle) {
        counts.samples++; counts.sampleBytes += bytes.length;
        call(['loadSample', new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice(), entry.handle]);
      }
      return entry;
    },
    /** A speech MP3's record (docs/galaxy-audio.md "Speech through Galaxy's
     * voices"; the stand-in of effects.rs `host_sample`): {handle, c4Speed =
     * `rate`, ...} at once from the registry, and the loadHostSample op that
     * makes the worklet's same record. Its PCM comes later (attachSample). */
    registerHostSample(key, rate, frames) {
      let entry = registered.get(key);
      if (entry) return entry;
      if (!registry) throw new Error(registryError ?? 'Galaxy sample registry not ready');
      entry = registry.loadHost(rate, frames);
      registered.set(key, entry);
      counts.hostSamples++;
      call(['loadHostSample', rate, frames, entry.handle]);
      return entry;
    },
    /** The host's 16-bit PCM for a host record (copied at the call). The
     * worklet holds a start of that record until its PCM is here. */
    attachSample(handle, pcm) {
      counts.attaches++; counts.attachBytes += pcm.length;
      call(['attachSample', new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice(), handle]);
    },
    /** Drops a host record's PCM in the worklet (no voice plays it). */
    releaseSample(handle) { counts.releases++; call(['releaseSample', handle]); },
    /** The mixer's read head of a voice playing a host record (samples since
     * its start: voice +0x46 minus +0x4e), as the worklet last reported it,
     * or null (not reported: a held start, another sample, no report yet). */
    voicePosition(voice) {
      const slot = voiceSlot(voice);
      return slot < 0 ? null : reported.positions.get(slot) ?? null;
    },
    /** glxStartSample(voice, sample, frequency, volume, pan, flags): the fixed
     * voice's handle (the subsystem passes channel + 1). */
    startSample(voice, sample, frequency, volume, pan, flags = 0) {
      counts.voiceOps++;
      call(['startSample', voice, sample, frequency, volume, pan, flags]);
      return voiceOf(voice);
    },
    controlSample(voice, frequency, volume, pan) { counts.voiceOps++; call(['controlSample', voice, frequency, volume, pan]); },
    stopSample(voice) { counts.voiceOps++; call(['stopSample', voice]); },
    /** glxSetSampleReverb(&block): `words` = the 0x6c-byte glxReverb as 27 int32. */
    setSampleReverb(words) { call(['setSampleReverb', words]); },
    /** Whether the worklet has reported at least once (its library is open). */
    live: () => reported.any,
    /** glxControlVoice(voice, GLX_GETSTATUS): Active (+0x0f) as this side knows it. */
    voiceActive(voice) {
      const slot = voiceSlot(voice);
      if (slot < 0) return 0;
      if (open) for (let i = open.length - 1; i >= 0; i--) {
        const op = open[i];
        if ((op[0] === 'startSample' && voiceSlotOf(op[1]) === slot) || (op[0] === 'stopSample' && voiceSlot(op[1]) === slot)) return activeAfter(op);
      }
      for (let b = pending.length - 1; b >= 0; b--) {
        const ops = pending[b].ops;
        for (let i = ops.length - 1; i >= 0; i--) if (!MIRRORED.has(ops[i][0]) && ops[i][1] === slot) return activeAfter(ops[i]);
      }
      return slot < 32 ? (reported.active >>> slot) & 1 : 0;
    },
    /** A worklet report: the last batch it applied, the library state, the
     * effect voices' Active bits and the host voices' read heads. */
    report(data) {
      if (data?.type !== 'report') return;
      counts.reports++;
      reported = { batch: data.batch, ...stateOf(data.state), active: data.active >>> 0, any: true,
        positions: new Map(data.positions ?? []) };
      while (pending.length && pending[0].id <= data.batch) pending.shift();
    },
    status() {
      return { issued, acknowledged: reported.batch, order: library.order(), reportedOrder: reported.order,
        playing: reported.playing, loaded: reported.loaded, songLength: reported.songLength, mirrored: pending.length,
        active: reported.active, live: reported.any, registry: registry ? 'ready' : registryError ?? 'pending', ...counts };
    },
  };
  return library;
}

/** The proxy over a MessagePort to the worklet (the sim worker's end of the
 * page's channel, or the page's own end with ?sim=inline). With `effects`
 * the service carries the effect voices (its own sample registry). */
export function connectMusicLibraryPort(port, { effects = false } = {}) {
  const library = createMusicLibraryProxy((message, transfer) => port.postMessage(message, transfer),
    { samples: effects ? createSampleRegistry() : null });
  port.onmessage = ({ data }) => library.report(data);
  return library;
}

/** Validation driver until the Update translation drives the library: the
 * library calls of Update's first-music case (docs/galaxy-music/
 * update-transition.md §2.3, the order the sequencer oracle's load and start
 * ops use) for `song` (a Music package) and `section`, in one critical
 * section: SetVolumes' glxSetSampleVolume(127, 0) / glxSetMusicVolume(76, 0)
 * (the installed volumes), glxLoadMusic of the UMusic bytes plus the slack,
 * SetVolumes again, glxStopMusic, voice +0x0f cleared for 32 voices from
 * EffectsChannels, glxStartMusic, glxControlMusic(2, section), the break
 * flag. `{unregister: true}` runs UnregisterMusic's glxStopMusic and
 * glxUnloadMusic instead. */
export async function driveMusicLibrary(library, assets, { song = null, section = 0, unregister = false, effectsChannels = 16,
  sampleVolume = 127, musicVolume = 76 } = {}) {
  if (!library) throw new Error('No Galaxy music library (?music=0)');
  if (unregister) { library.lock(); library.stopMusic(); library.unloadMusic(); library.unlock(); return { unregistered: true }; }
  const asset = await assets.get(song);
  const index = asset.pkg.exports.findIndex(entry => entry.className === 'Music') + 1;
  if (!index) throw new Error(`${song} holds no Music export`);
  const module = readMusicExport(asset, index).bytes, bytes = new Uint8Array(module.length + MUSIC_SLACK);
  bytes.set(module);
  library.lock();
  library.setSampleVolume(sampleVolume, 0); library.setMusicVolume(musicVolume, 0);
  library.loadMusic(bytes);
  library.setSampleVolume(sampleVolume, 0); library.setMusicVolume(musicVolume, 0);
  library.stopMusic(); library.clearVoiceActive(effectsChannels, 32); library.startMusic();
  library.controlMusic(2, section & 0xff); library.setBreakFlag();
  library.unlock();
  return { song, section, bytes: bytes.length };
}
// ---- end of the browser host transport ---------------------------------------
