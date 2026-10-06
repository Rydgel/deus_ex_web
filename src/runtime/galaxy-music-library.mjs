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
