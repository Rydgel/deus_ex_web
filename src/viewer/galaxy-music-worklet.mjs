/** Galaxy's output (docs/galaxy-music.md "Phase 5: Output", docs/galaxy-audio.md
 * "Effects through Galaxy's mixer", docs/audio-output-scope.md §6): the
 * AudioWorklet that owns the one Galaxy library instance (the Rust kernel,
 * native/galaxy-kernel, src/runtime/galaxy-kernel.wasm) and plays its
 * DirectSound secondary buffer.
 *
 * The original mixes on a winmm timer thread: every Latency/2 = 20 ms the
 * callback 0x106142a0 reads the buffer's play and write cursors, renders
 * what they advanced into a 176,400-byte staging ring with the music bus A
 * at head A (just behind the play cursor) and the effects bus B at head B =
 * A + D (ahead of it), and copies both segments into the buffer, under the
 * library lock the game thread's Update also holds. Here the translated
 * callback (output.rs) runs on the kernel's model of that buffer: the play
 * cursor is this processor's own consumption position, the write cursor is
 * play + WRITE_LEAD, so D = 7,056 (Galaxy's Latency bytes) + WRITE_LEAD, and
 * the output is the buffer read at the play position (D = 8,820 as
 * measured, WRITE_LEAD below). Music is therefore
 * heard size − D bytes after the effects the same mixer call rendered, as in
 * the original. Host timing (scope §7 item 6): the callbacks are exactly
 * 882 frames of consumption apart (20 ms at 44.1 kHz), the first one when
 * the library opens; a callback falls inside a 128-frame quantum, which is
 * split there. The original's cursor jitter is not reproduced.
 *
 * Messages.
 * - Page port (`this.port`): `init {wasm}` the kernel bytes (compiled here;
 *   some worklet scopes lack fetch); `connect {port, effectsChannels, pc,
 *   ahead, latency, writeLead}` a new simulation side: the library is opened
 *   afresh (glxInit's state, Init's EffectsChannels, the output open at
 *   `latency` with a fresh secondary buffer played from its start) and
 *   `port` becomes the batch source; `status {id}` answered with the
 *   counters (only on request); `latency {id}` answered with the effect
 *   starts' timing (below).
 * - Simulation port: `batch {id, ops, modules}` (galaxy-music-library.mjs
 *   encodeMusicBatch), applied whole on arrival, which is always between two
 *   callbacks (Update's critical section against the timer callback). After
 *   a batch, and after a callback that changed them, `report {batch, state,
 *   active, positions, windows}` goes back (galaxy_music_state: order |
 *   playing << 8 | song length << 16 | loaded << 24; active: bit i = effect
 *   voice i's Active byte, the subsystem's "voice finished" poll; positions:
 *   [slot, read head] of each voice playing host-decoded speech; windows:
 *   [slot, available, bytes], the lip-sync window at that read head).
 *
 * Start timing (Stage 7 row 7.5.2, docs/audio-latency.md; a measurement,
 * nothing reads it back): for the last LATENCY_STARTS batches holding an
 * effect start (glxStartSample of a loaded sample, not a host record), the
 * batch id, this scope's clock at its arrival, the consumed frame then, the
 * frame at which the next callback's render begins (its head B), the clock
 * when the audio thread renders that frame (`playedAt`) and `takenAt`, the
 * time it is taken at the context's rate from the start of its burst (the
 * render calls of one device callback: a call 3 ms or more after the last
 * starts a burst; its first frame is taken at the call, each later frame
 * one frame time after the one before, as the device plays the block).
 * `clock` is performance.timeOrigin + performance.now() where the scope has
 * `performance`, else Date.now().
 *
 * Self-contained (no imports) so that Vite serves and copies it as is; Node
 * imports it for the validator (registerProcessor is then absent). */

/** Op codes and arities; equal to galaxy-music-library.mjs MUSIC_OP and
 * OP_ARITY (the validator checks). */
export const OPS = Object.freeze({
  setSampleVolume: 1, setMusicVolume: 2, loadMusic: 3, unloadMusic: 4, stopMusic: 5,
  startMusic: 6, controlMusic: 7, clearVoiceActive: 8, setBreakFlag: 9,
  loadSample: 10, startSample: 11, controlSample: 12, stopSample: 13, setSampleReverb: 14,
  loadHostSample: 15, attachSample: 16, releaseSample: 17,
});
export const ARITY = Object.freeze({ 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 3, 11: 6, 12: 4, 13: 1, 14: 27,
  15: 4, 16: 3, 17: 1 });
export const CALLBACK_FRAMES = 882;
const LATENCY_STARTS = 256;
const CLOCK = typeof globalThis.performance?.now === 'function' ? 'performance' : 'date';
const clock = CLOCK === 'performance' ? () => performance.timeOrigin + performance.now() : () => Date.now();
/** The write cursor's lead over the play cursor at the first callback, in
 * bytes: D's host part (scope §3.1, §7 item 2), a labelled HOST INPUT
 * measured on the reference machine (CrossOver's dsound in the bottle
 * "DeusEx", 2026-10-16, scripts/galaxy-output-capture.sh): D = (B − A) mod
 * size = 8,820 bytes in every sample of two launches, before and after a map
 * load, so the lead is 8,820 − 7,056 = 1,764 bytes (441 frames, 10 ms).
 * Another machine's DirectSound would give another value, as another
 * Windows driver would have. validate-galaxy-output-poll.mjs checks it
 * against the stored capture. A `connect` message may override it
 * (validators). */
export const WRITE_LEAD = 1764;
const SLACK = 1024;
// glxVoices at the preferred base, 0xa0 bytes each (galaxy-music-library.mjs VOICE_BASE).
const VOICE_BASE = 0x1068dca0, VOICE_SIZE = 0xa0;
const slotOf = voice => { const off = (voice >>> 0) - VOICE_BASE; return off >= 0 && off % VOICE_SIZE === 0 && off / VOICE_SIZE < 32 ? off / VOICE_SIZE : -1; };

/** Each op of a batch message as (code, a, b, blob, args): `args` its
 * Int32 arguments (a, b the first two), `blob` the loadMusic/loadSample/
 * attachSample op's bytes (a module with the slack, a sample, or a host
 * decode's 16-bit PCM), else null. */
export function forEachMusicOp(message, visit) {
  const ops = message.ops;
  for (let i = 0; i < ops.length;) {
    const code = ops[i], arity = ARITY[code];
    if (arity === undefined || i + 1 + arity > ops.length) throw new Error(`Bad Galaxy library op ${code} at word ${i}`);
    const args = ops.subarray(i + 1, i + 1 + arity), a = args[0] ?? 0, b = args[1] ?? 0;
    const blob = code === OPS.loadMusic || code === OPS.loadSample || code === OPS.attachSample
      ? new Uint8Array(message.modules[a], 0, b) : null;
    visit(code, a, b, blob, args);
    i += 1 + arity;
  }
}

/** The library behind the kernel's host exports (host.rs); one op = one call.
 *
 * Host-decoded speech (docs/galaxy-audio.md "Speech on Galaxy's ring
 * transport"): loadHostSample makes the record (effects.rs `host_sample`, the
 * registry's same allocation; type 0x4024 or 0x4044), attachSample gives it
 * the page's decoded PCM and releaseSample drops it. The voice plays on
 * Galaxy's ring transport (ring.rs: glxStartSample's ring branch, the
 * mixer's refill posts, the decoder thread fed by the PCM). A start of a
 * record whose PCM has not arrived is held: the voice is stopped as
 * glxStartSample stops it first, the start's arguments are kept (a
 * controlSample updates them, a stopSample or a later start drops the hold),
 * the slot counts as Active, and glxStartSample runs when the PCM arrives
 * (host timing: the original's decoder reads its MP3 bytes from the start). */
export function createMusicKernel(exports) {
  const x = exports;
  const results = { load: null, control: null, stop: null, start: null, unload: null, sampleLoads: 0, sampleMismatches: 0,
    lastSample: null, voiceOps: 0, reverb: null, reverbCalls: 0, hostSamples: 0, attaches: 0, releases: 0, holds: 0, heldStarts: 0 };
  // Host records by handle ({attached}); held starts by voice slot.
  const hosts = new Map(), held = new Map();
  const start = (voice, sample, frequency, volume, pan, flags) =>
    x.galaxy_sample_start(voice, sample >>> 0, frequency, volume, pan, flags >>> 0);
  return {
    // A fresh library (a new simulation side): its sample heap starts again, so no host record or hold carries over.
    open(effectsChannels, pc, ahead) { hosts.clear(); held.clear(); return x.galaxy_host_open(effectsChannels, pc, ahead); },
    apply(code, a, b, module, args = null) {
      switch (code) {
        case OPS.setSampleVolume: return x.galaxy_set_sample_volume(a, b);
        case OPS.setMusicVolume: return x.galaxy_set_music_volume(a, b);
        case OPS.loadMusic: {
          // glxLoadMusic(&Mem{Data, len + 1024}, 2): the module and the slack.
          if (module.length < SLACK) throw new Error('Galaxy loadMusic bytes lack the 1024-byte slack');
          const ptr = x.galaxy_input(module.length - SLACK);
          new Uint8Array(x.memory.buffer, ptr, module.length).set(module);
          return results.load = x.galaxy_music_load(module.length - SLACK);
        }
        case OPS.unloadMusic: return results.unload = x.galaxy_music_unload();
        case OPS.stopMusic: return results.stop = x.galaxy_music_stop();
        case OPS.startMusic: return results.start = x.galaxy_music_start();
        case OPS.controlMusic: return results.control = x.galaxy_music_control(a, b);
        case OPS.clearVoiceActive: x.galaxy_music_clear_active(a >>> 0, b >>> 0); return 0;
        case OPS.setBreakFlag: x.galaxy_music_break(); return 0;
        case OPS.loadSample: {
          // glxLoadSample(&Mem{bytes, len}, 2): the simulation's registry ran the
          // same loader from the same empty heap; its handle must be ours.
          const ptr = x.galaxy_input(module.length);
          new Uint8Array(x.memory.buffer, ptr, module.length).set(module);
          const handle = x.galaxy_sample_load(module.length) >>> 0;
          results.sampleLoads++; results.lastSample = handle;
          if (handle !== args[2] >>> 0) {
            results.sampleMismatches++;
            throw new Error(`Galaxy sample handle 0x${handle.toString(16)} differs from the registry's 0x${(args[2] >>> 0).toString(16)}`);
          }
          return handle;
        }
        case OPS.startSample: {
          results.voiceOps++;
          const [voice, sample, frequency, volume, pan, flags] = args, handle = 0x1068dc00 + VOICE_SIZE * voice, slot = slotOf(handle);
          held.delete(slot);
          const host = hosts.get(sample >>> 0);
          if (host && !host.attached && slot >= 0) {
            x.galaxy_sample_stop(handle >>> 0);
            held.set(slot, { voice, sample: sample >>> 0, frequency, volume, pan, flags });
            results.holds++;
            return handle >>> 0;
          }
          return start(voice, sample, frequency, volume, pan, flags);
        }
        case OPS.controlSample: {
          results.voiceOps++;
          const hold = held.get(slotOf(args[0]));
          if (hold) { hold.frequency = args[1]; hold.volume = args[2]; hold.pan = args[3]; return 0; }
          return x.galaxy_sample_control(args[0] >>> 0, args[1], args[2], args[3]);
        }
        case OPS.stopSample: results.voiceOps++; held.delete(slotOf(args[0])); return x.galaxy_sample_stop(args[0] >>> 0);
        case OPS.loadHostSample: {
          const handle = x.galaxy_sample_host(args[0] >>> 0, args[1] >>> 0, (args[3] || 1) >>> 0) >>> 0;
          results.hostSamples++;
          if (handle !== args[2] >>> 0) {
            results.sampleMismatches++;
            throw new Error(`Galaxy host sample handle 0x${handle.toString(16)} differs from the registry's 0x${(args[2] >>> 0).toString(16)}`);
          }
          hosts.set(handle, { attached: false });
          return handle;
        }
        case OPS.attachSample: {
          const handle = args[2] >>> 0, host = hosts.get(handle);
          if (!host) throw new Error(`Galaxy attachSample to an unknown host sample 0x${handle.toString(16)}`);
          const ptr = x.galaxy_input(module.length);
          new Uint8Array(x.memory.buffer, ptr, module.length).set(module);
          if (!x.galaxy_sample_attach(handle, module.length)) return 0;
          host.attached = true; results.attaches++;
          for (const [slot, hold] of held) if (hold.sample === handle) {
            held.delete(slot); results.heldStarts++;
            start(hold.voice, hold.sample, hold.frequency, hold.volume, hold.pan, hold.flags);
          }
          return handle;
        }
        case OPS.releaseSample: {
          const handle = args[0] >>> 0, host = hosts.get(handle);
          if (!host) throw new Error(`Galaxy releaseSample of an unknown host sample 0x${handle.toString(16)}`);
          for (const [slot, hold] of held) if (hold.sample === handle) held.delete(slot);
          host.attached = false; results.releases++;
          return x.galaxy_sample_release(handle);
        }
        case OPS.setSampleReverb: {
          // glxSetSampleReverb(&Reverb): Update's 0x6c-byte block as 27 words.
          new Uint8Array(x.memory.buffer, x.galaxy_reverb_block(), 0x6c).set(new Uint8Array(args.buffer, args.byteOffset, 0x6c));
          results.reverbCalls++;
          return results.reverb = x.galaxy_set_sample_reverb();
        }
        default: throw new Error(`Unknown Galaxy music op ${code}`);
      }
    },
    state: () => x.galaxy_music_state() >>> 0,
    /** The effect voices' Active bits, a held start counting as Active. */
    active: () => { let bits = x.galaxy_effects_active() >>> 0; for (const slot of held.keys()) bits |= 1 << slot; return bits >>> 0; },
    /** [slot, read head] for each Active voice playing a host record: voice
     * +0x46 (the position, in samples for 16-bit data) minus +0x4e (the
     * data start), the samples the mixer has passed. */
    positions: () => {
      if (!hosts.size) return [];
      const out = [], view = new DataView(x.memory.buffer, x.galaxy_voices_ptr(), 32 * VOICE_SIZE);
      for (let slot = 0; slot < 32; slot++) {
        const at = slot * VOICE_SIZE;
        if (!view.getUint8(at + 0x0f) || !hosts.has(view.getUint32(at + 0x42, true))) continue;
        out.push([slot, (view.getUint32(at + 0x46, true) - view.getUint32(at + 0x4e, true)) >>> 0]);
      }
      return out;
    },
    /** The lip-sync window of each Active voice playing a host record, as
     * Update's step 12 reads it for a streamed record (0x1060a0e9..0x1060a10e,
     * 0x10609180): from the ring at `V+0x46 − V+0x52`, the samples below the
     * loop end `V+0x56` (unsigned), at most 1024, zero after them:
     * [slot, available, 2048 bytes]. */
    windows: () => {
      if (!hosts.size) return [];
      const out = [], view = new DataView(x.memory.buffer, x.galaxy_voices_ptr(), 32 * VOICE_SIZE);
      for (let slot = 0; slot < 32; slot++) {
        const at = slot * VOICE_SIZE;
        if (!view.getUint8(at + 0x0f) || !hosts.has(view.getUint32(at + 0x42, true))) continue;
        const ring = x.galaxy_ring_bytes(slot);
        if (!ring) continue;
        const pos = view.getUint32(at + 0x46, true), start = view.getUint32(at + 0x52, true), end = view.getUint32(at + 0x56, true);
        const available = pos >= end ? 0 : Math.min(1024, end - pos), from = 2 * ((pos - start) >>> 0);
        const bytes = new Uint8Array(2048);
        if (available && from + 2 * available <= 0x1001f) bytes.set(new Uint8Array(x.memory.buffer, ring + from, 2 * available));
        out.push([slot, available, bytes]);
      }
      return out;
    },
    /** The decoder thread's refills posted during the last callback (ring.rs). */
    deliver: () => x.galaxy_ring_deliver() >>> 0,
    /** Whether `sample` is a host record (speech), whose start the PCM may hold. */
    isHost: sample => hosts.has(sample >>> 0),
    /** The voice slots whose start waits for its host record's PCM. */
    heldSlots: () => [...held.keys()],
    voicesPtr: () => x.galaxy_voices_ptr(),
    reverbState: () => x.galaxy_reverb_state() >>> 0,
    /** The secondary buffer at `latency` ms (the open's DirectSound setup). */
    openOutput: latency => x.galaxy_output_open(latency),
    /** One timer callback with the cursors (play, write); 0 or a fault. */
    callback: (play, write) => x.galaxy_output_callback(play >>> 0, write >>> 0) >>> 0,
    /** The output's state words (output.rs galaxy_output_state). */
    output: index => x.galaxy_output_state(index) >>> 0,
    secondaryPtr: () => x.galaxy_output_secondary(),
    render: frames => x.galaxy_render(frames),
    fault: () => x.galaxy_fault(),
    memory: () => x.memory.buffer,
    results,
  };
}

const Base = globalThis.AudioWorkletProcessor ?? class {};

export class GalaxyMusicProcessor extends Base {
  constructor(options) {
    super(options);
    this.kernel = null; this.open = false; this.sim = null; this.config = null; this.queue = [];
    // The secondary buffer (int16 frames, read in place), the play cursor in
    // bytes, the frames of consumption left before the next callback.
    this.size = 0; this.play = 0; this.untilCallback = 0; this.view = null; this.viewMemory = null;
    // Frames consumed since the library opened; the start timing records and the render bursts (see the file comment).
    this.consumed = 0; this.starts = []; this.waiting = [];
    this.lastCall = -Infinity; this.burstAt = 0; this.burstFrame = 0;
    this.reported = { batch: -1, state: -1, active: -1, positions: '' };
    this.stats = { rate: globalThis.sampleRate ?? null, connects: 0, batches: 0, ops: 0, lastBatch: 0, loads: 0,
      callbacks: 0, quanta: 0, underruns: 0, resyncs: 0, refills: 0, reports: 0, fault: 0, error: null };
    this.port.onmessage = ({ data }) => this.page(data);
  }

  page(data) {
    try {
      if (data.type === 'init') {
        WebAssembly.instantiate(data.wasm, {}).then(({ instance }) => {
          this.kernel = createMusicKernel(instance.exports);
          this.start();
        }, error => { this.stats.error = String(error?.message ?? error); });
      } else if (data.type === 'connect') {
        if (this.sim) { this.sim.onmessage = null; this.sim.close(); }
        this.sim = data.port; this.queue = []; this.open = false;
        this.config = { effectsChannels: data.effectsChannels, pc: data.pc, ahead: data.ahead, latency: data.latency ?? 40,
          writeLead: data.writeLead ?? WRITE_LEAD };
        this.stats.connects++; this.stats.lastBatch = 0; this.stats.fault = 0;
        this.reported = { batch: -1, state: -1, active: -1, positions: '' };
        this.sim.onmessage = ({ data: message }) => this.batch(message);
        this.start();
      } else if (data.type === 'status') {
        this.port.postMessage({ type: 'status', id: data.id, status: this.status() });
      } else if (data.type === 'latency') {
        this.port.postMessage({ type: 'latency', id: data.id, latency: { clock: CLOCK, consumed: this.consumed, starts: this.starts } });
      }
    } catch (error) { this.stats.error = String(error?.message ?? error); }
  }

  /** Opens the library once both the kernel and a simulation side are here. */
  start() {
    if (!this.kernel || !this.config || this.open) return;
    if (this.stats.rate !== 44100) { this.stats.error = `the context runs at ${this.stats.rate} Hz, not 44100`; return; }
    const { effectsChannels, pc, ahead, latency } = this.config;
    const status = this.kernel.open(effectsChannels, pc, ahead);
    if (status !== 0) { this.stats.error = `output open returned ${status}`; return; }
    // A fresh secondary buffer (CreateSoundBuffer), played from its start.
    this.kernel.openOutput(latency);
    this.size = this.kernel.output(0); this.play = 0; this.untilCallback = 0; this.view = null;
    this.consumed = 0; this.starts = []; this.waiting = [];
    this.open = true;
    for (const message of this.queue.splice(0)) this.apply(message);
    this.report();
  }

  batch(message) {
    if (message?.type !== 'batch') return;
    if (!this.open) { this.queue.push(message); return; }
    this.apply(message);
    this.report();
  }

  apply(message) {
    let effectStart = false;
    try {
      forEachMusicOp(message, (code, a, b, module, args) => {
        if (code === OPS.startSample && !this.kernel.isHost(args[1])) effectStart = true;
        this.kernel.apply(code, a, b, module, args);
        this.stats.ops++;
        if (code === OPS.loadMusic) this.stats.loads++;
      });
    } catch (error) { this.stats.error = String(error?.message ?? error); }
    // Not a start queued before the library opened (its first callback, the resync, places nothing).
    if (effectStart && this.open && this.stats.callbacks > 0) {
      const start = { batch: message.id, at: clock(), frame: this.consumed, first: null, playedAt: null, takenAt: null };
      this.starts.push(start); this.waiting.push(start);
      if (this.starts.length > LATENCY_STARTS) this.starts.shift();
      if (this.waiting.length > LATENCY_STARTS) this.waiting.shift();
    }
    this.stats.batches++; this.stats.lastBatch = message.id;
  }

  /** The applied batch, the library state, the effect voices' Active bits
   * and the host voices' read heads, to the simulation, when changed. */
  report() {
    if (!this.sim || !this.open) return;
    const state = this.kernel.state(), active = this.kernel.active(), positions = this.kernel.positions();
    const key = positions.length ? positions.join(';') : '';
    if (state === this.reported.state && active === this.reported.active && this.stats.lastBatch === this.reported.batch
      && key === this.reported.positions) return;
    this.reported.state = state; this.reported.active = active; this.reported.batch = this.stats.lastBatch; this.reported.positions = key;
    this.stats.reports++;
    const windows = positions.length ? this.kernel.windows() : [];
    this.sim.postMessage({ type: 'report', batch: this.stats.lastBatch, state, active, positions, windows },
      windows.map(([, , bytes]) => bytes.buffer));
  }

  /** One timer callback 0x106142a0 at the current play cursor. */
  callback() {
    const play = this.play, write = (play + this.config.writeLead) % this.size;
    // Starts applied since the last callback begin where this callback's bus B render begins.
    for (const start of this.waiting) if (start.first === null)
      start.first = this.consumed + ((this.kernel.output(2) - play + this.size) % this.size) / 4;
    if (this.kernel.callback(play, write)) { this.stats.fault = this.kernel.fault(); return false; }
    // The stream decoder thread's messages posted during the callback (ring.rs: after the callback, in post order).
    this.stats.refills += this.kernel.deliver();
    if (this.kernel.fault()) { this.stats.fault = this.kernel.fault(); return false; }
    this.stats.callbacks++; this.stats.resyncs = this.kernel.output(6);
    this.report();
    return true;
  }

  /** The secondary buffer's frames, viewed in place (again after a memory growth). */
  frames() {
    const memory = this.kernel.memory();
    if (this.view === null || memory !== this.viewMemory) {
      this.view = new Int16Array(memory, this.kernel.secondaryPtr(), this.size >> 1); this.viewMemory = memory;
    }
    return this.view;
  }

  process(inputs, outputs) {
    const channels = outputs[0], left = channels[0], right = channels[1] ?? channels[0], n = left.length;
    this.stats.quanta++;
    const now = clock();
    if (now - this.lastCall >= 3) { this.burstAt = now; this.burstFrame = this.consumed; }
    this.lastCall = now;
    let i = 0;
    while (this.open && !this.stats.fault && i < n) {
      if (this.untilCallback === 0) {
        if (!this.callback()) break;
        this.untilCallback = CALLBACK_FRAMES;
      }
      const run = Math.min(n - i, this.untilCallback), size = this.size;
      const view = this.frames();
      let at = this.play >> 1;
      for (let k = 0; k < run; k++) {
        left[i + k] = view[at] / 32768; right[i + k] = view[at + 1] / 32768;
        at += 2; if (at === size >> 1) at = 0;
      }
      this.play = (this.play + 4 * run) % size; i += run; this.untilCallback -= run; this.consumed += run;
    }
    while (this.waiting.length && this.waiting[0].first !== null && this.waiting[0].first < this.consumed) {
      const start = this.waiting.shift();
      start.playedAt = now; start.takenAt = this.burstAt + (start.first - this.burstFrame) * 1000 / this.stats.rate;
    }
    if (i < n) {
      // Nothing to play: before the library opens, or after a fault.
      if (this.open) this.stats.underruns++;
      left.fill(0, i); right.fill(0, i);
    }
    return true;
  }

  status() {
    return { ...this.stats, open: this.open, connected: Boolean(this.sim), queued: this.queue.length, play: this.play,
      writeLead: this.config?.writeLead ?? null, heads: this.open ? [this.kernel.output(1), this.kernel.output(2)] : null,
      state: this.open ? this.kernel.state() : null, reverb: this.open ? this.kernel.reverbState() & 3 : null,
      results: this.kernel ? { ...this.kernel.results } : null };
  }
}

if (typeof globalThis.registerProcessor === 'function') globalThis.registerProcessor('galaxy-music', GalaxyMusicProcessor);
