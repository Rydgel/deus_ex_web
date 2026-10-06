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
  let current = null, depth = 0, total = 0;
  const commit = batch => {
    batches.push(batch);
    if (batches.length > history) batches.shift();
    total++;
  };
  const record = op => {
    if (current) { current.push(op); return; }
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
    lock() { if (depth++ === 0) current = []; },
    unlock() {
      if (depth === 0) throw new Error('Galaxy music library: unlock without lock');
      if (--depth === 0) { const batch = current; current = null; if (batch.length) commit(batch); }
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
// docs/galaxy-music.md "Phase 5: Output". The library (glx* state, sequencer,
// mixer) lives in an AudioWorklet (src/viewer/galaxy-music-worklet.mjs). The
// simulation calls the `library` service object below, wherever it runs (the
// sim worker, or the page with ?sim=inline); each call becomes one op, and
// the ops between lock() and unlock() (Update's critical section,
// 0x1060e840..0x10618920) cross as one atomic batch on a MessagePort that
// goes straight to the worklet. A call outside lock() is its own batch, as
// every glx* entry takes the library lock itself. Nothing crosses the page's
// main thread in worker mode.
//
// Order read-back: Update copies the library's order position (byte
// [0x10698201]) into SongSection on every frame without a pending
// transition. The worklet reports {batch, state} after a callback when the
// applied batch or the order changed. order() returns the reported order
// when the report covers the last batch issued; otherwise it replays the
// sim's unacknowledged ops over the reported state (glxLoadMusic's reset
// seeds 0xff, glxControlMusic 1|2 stores value-1). This is host timing: in
// the original the mixer thread also advances the order asynchronously to
// the game thread's read.
import { readMusicExport } from '../unreal/music-module.mjs';

/** Op codes on the wire (src/viewer/galaxy-music-worklet.mjs decodes them). */
export const MUSIC_OP = Object.freeze({
  setSampleVolume: 1, setMusicVolume: 2, loadMusic: 3, unloadMusic: 4, stopMusic: 5,
  startMusic: 6, controlMusic: 7, clearVoiceActive: 8, setBreakFlag: 9,
});
/** Update's FArray::Add(1024) after the module bytes (0x1060a702..0x1060a735). */
export const MUSIC_SLACK = 1024;
const OP_WORDS = 3;

/** One batch as a message: `ops` holds [code, a, b] per op (Int32); a
 * loadMusic op holds the index of its module in `modules` and the byte
 * length. Module bytes are transferred, so they cross once: a copy, or with
 * `owned` the caller's own whole-buffer arrays, which are then detached.
 * Returns {message, transfer}. `ops` entries are [name, ...args] with
 * loadMusic's argument a Uint8Array. */
export function encodeMusicBatch(id, ops, { owned = false } = {}) {
  const words = new Int32Array(ops.length * OP_WORDS), modules = [];
  ops.forEach(([name, a = 0, b = 0], i) => {
    const code = MUSIC_OP[name];
    if (!code) throw new Error(`Unknown Galaxy music op ${name}`);
    words[i * OP_WORDS] = code;
    if (code === MUSIC_OP.loadMusic) {
      const bytes = a instanceof Uint8Array ? a : new Uint8Array(a);
      const copy = owned && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
      words[i * OP_WORDS + 1] = modules.length; words[i * OP_WORDS + 2] = copy.length;
      modules.push(copy.buffer);
    } else { words[i * OP_WORDS + 1] = a | 0; words[i * OP_WORDS + 2] = b | 0; }
  });
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

/** The simulation's `library` service (the Update translation calls it).
 * `post(message, transfer)` sends a batch toward the worklet; `report(data)`
 * takes the worklet's {type: 'report', batch, state} messages. */
export function createMusicLibraryProxy(post) {
  let depth = 0, open = null, issued = 0, reported = { batch: 0, ...stateOf(INITIAL_STATE) };
  // Unacknowledged batches' ops that touch the mirrored state.
  const pending = [];
  const counts = { batches: 0, ops: 0, modules: 0, moduleBytes: 0, reports: 0 };
  function flush(ops) {
    if (!ops.length) return;
    const id = ++issued, { message, transfer } = encodeMusicBatch(id, ops, { owned: true });
    counts.batches++; counts.ops += ops.length;
    for (const buffer of message.modules) { counts.modules++; counts.moduleBytes += buffer.byteLength; }
    post(message, transfer);
    const mirrored = ops.filter(([name]) => MIRRORED.has(name)).map(([name, a, b]) => [name, a, b]);
    if (mirrored.length) pending.push({ id, ops: mirrored });
  }
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
      return mirrorOrder(reported, [...pending.map(batch => batch.ops), open_]);
    },
    /** A worklet report: the last batch it applied and the library state. */
    report(data) {
      if (data?.type !== 'report') return;
      counts.reports++;
      reported = { batch: data.batch, ...stateOf(data.state) };
      while (pending.length && pending[0].id <= data.batch) pending.shift();
    },
    status() {
      return { issued, acknowledged: reported.batch, order: library.order(), reportedOrder: reported.order,
        playing: reported.playing, loaded: reported.loaded, songLength: reported.songLength, mirrored: pending.length, ...counts };
    },
  };
  return library;
}

/** The proxy over a MessagePort to the worklet (the sim worker's end of the
 * page's channel, or the page's own end with ?sim=inline). */
export function connectMusicLibraryPort(port) {
  const library = createMusicLibraryProxy((message, transfer) => port.postMessage(message, transfer));
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
