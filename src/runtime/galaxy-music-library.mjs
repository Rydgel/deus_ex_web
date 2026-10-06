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
