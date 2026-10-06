/** Galaxy's output (docs/galaxy-music.md "Phase 5: Output", docs/galaxy-audio.md
 * "Effects through Galaxy's mixer"): the AudioWorklet that owns the one
 * Galaxy library instance (the Rust kernel, native/galaxy-kernel,
 * src/runtime/galaxy-kernel.wasm) and plays its output: the music bus A
 * stored and the effects bus B (sound effects, ambient sounds) added onto the
 * same frames, as the renderer 0x106146a0 converts them at coincident heads.
 *
 * The original mixes on a winmm timer thread: every Latency/2 = 20 ms the
 * callback 0x106142a0 renders what the DirectSound play cursor advanced, in
 * mixer calls of n = remaining frames (each at most 512), under the library
 * lock the game thread's Update also holds. Here the schedule is fixed:
 * callbacks of exactly 882 frames (20 ms at 44.1 kHz), back to back in
 * output time, each rendered when the ring holds less than one 128-frame
 * render quantum. The original's cursor jitter and its two ring heads
 * (bus B about a ring ahead of bus A) are host timing and are not
 * reproduced.
 *
 * Messages.
 * - Page port (`this.port`): `init {wasm}` the kernel bytes (compiled here;
 *   some worklet scopes lack fetch); `connect {port, effectsChannels, pc,
 *   ahead}` a new simulation side: the library is opened afresh (glxInit's
 *   state, Init's EffectsChannels, the output open) and `port` becomes the
 *   batch source; `status {id}` answered with the counters (only on request).
 * - Simulation port: `batch {id, ops, modules}` (galaxy-music-library.mjs
 *   encodeMusicBatch), applied whole on arrival, which is always between two
 *   callbacks (Update's critical section against the timer callback). After
 *   a batch, and after a callback that changed them, `report {batch, state,
 *   active}` goes back (galaxy_music_state: order | playing << 8 | song
 *   length << 16 | loaded << 24; active: bit i = effect voice i's Active
 *   byte, the subsystem's "voice finished" poll).
 *
 * Self-contained (no imports) so that Vite serves and copies it as is; Node
 * imports it for the validator (registerProcessor is then absent). */

/** Op codes and arities; equal to galaxy-music-library.mjs MUSIC_OP and
 * OP_ARITY (the validator checks). */
export const OPS = Object.freeze({
  setSampleVolume: 1, setMusicVolume: 2, loadMusic: 3, unloadMusic: 4, stopMusic: 5,
  startMusic: 6, controlMusic: 7, clearVoiceActive: 8, setBreakFlag: 9,
  loadSample: 10, startSample: 11, controlSample: 12, stopSample: 13, setSampleReverb: 14,
});
export const ARITY = Object.freeze({ 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 3, 11: 6, 12: 4, 13: 1, 14: 27 });
export const CALLBACK_FRAMES = 882;
const SLACK = 1024, RING = 2048;

/** Each op of a batch message as (code, a, b, blob, args): `args` its
 * Int32 arguments (a, b the first two), `blob` the loadMusic/loadSample op's
 * bytes (a module with the slack, or a sample), else null. */
export function forEachMusicOp(message, visit) {
  const ops = message.ops;
  for (let i = 0; i < ops.length;) {
    const code = ops[i], arity = ARITY[code];
    if (arity === undefined || i + 1 + arity > ops.length) throw new Error(`Bad Galaxy library op ${code} at word ${i}`);
    const args = ops.subarray(i + 1, i + 1 + arity), a = args[0] ?? 0, b = args[1] ?? 0;
    const blob = code === OPS.loadMusic || code === OPS.loadSample ? new Uint8Array(message.modules[a], 0, b) : null;
    visit(code, a, b, blob, args);
    i += 1 + arity;
  }
}

/** The library behind the kernel's host exports (host.rs); one op = one call. */
export function createMusicKernel(exports) {
  const x = exports;
  const results = { load: null, control: null, stop: null, start: null, unload: null, sampleLoads: 0, sampleMismatches: 0,
    lastSample: null, voiceOps: 0, reverb: null, reverbCalls: 0 };
  return {
    open(effectsChannels, pc, ahead) { return x.galaxy_host_open(effectsChannels, pc, ahead); },
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
        case OPS.startSample: results.voiceOps++; return x.galaxy_sample_start(args[0], args[1] >>> 0, args[2], args[3], args[4], args[5] >>> 0);
        case OPS.controlSample: results.voiceOps++; return x.galaxy_sample_control(args[0] >>> 0, args[1], args[2], args[3]);
        case OPS.stopSample: results.voiceOps++; return x.galaxy_sample_stop(args[0] >>> 0);
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
    active: () => x.galaxy_effects_active() >>> 0,
    voicesPtr: () => x.galaxy_voices_ptr(),
    reverbState: () => x.galaxy_reverb_state() >>> 0,
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
    // The ring of rendered frames (float, per channel) and the callback's PCM view.
    this.left = new Float32Array(RING); this.right = new Float32Array(RING);
    this.read = 0; this.fill = 0; this.pcm = null; this.pcmPtr = 0; this.pcmMemory = null;
    this.reported = { batch: -1, state: -1, active: -1 };
    this.stats = { rate: globalThis.sampleRate ?? null, connects: 0, batches: 0, ops: 0, lastBatch: 0, loads: 0,
      callbacks: 0, quanta: 0, underruns: 0, reports: 0, fault: 0, error: null };
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
        this.config = { effectsChannels: data.effectsChannels, pc: data.pc, ahead: data.ahead };
        this.stats.connects++; this.stats.lastBatch = 0; this.stats.fault = 0;
        this.reported = { batch: -1, state: -1, active: -1 };
        this.sim.onmessage = ({ data: message }) => this.batch(message);
        this.start();
      } else if (data.type === 'status') {
        this.port.postMessage({ type: 'status', id: data.id, status: this.status() });
      }
    } catch (error) { this.stats.error = String(error?.message ?? error); }
  }

  /** Opens the library once both the kernel and a simulation side are here. */
  start() {
    if (!this.kernel || !this.config || this.open) return;
    if (this.stats.rate !== 44100) { this.stats.error = `the context runs at ${this.stats.rate} Hz, not 44100`; return; }
    const { effectsChannels, pc, ahead } = this.config;
    const status = this.kernel.open(effectsChannels, pc, ahead);
    if (status !== 0) { this.stats.error = `output open returned ${status}`; return; }
    this.open = true; this.read = 0; this.fill = 0;
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
    try {
      forEachMusicOp(message, (code, a, b, module, args) => {
        this.kernel.apply(code, a, b, module, args);
        this.stats.ops++;
        if (code === OPS.loadMusic) this.stats.loads++;
      });
    } catch (error) { this.stats.error = String(error?.message ?? error); }
    this.stats.batches++; this.stats.lastBatch = message.id;
  }

  /** The applied batch, the library state and the effect voices' Active
   * bits, to the simulation, when changed. */
  report() {
    if (!this.sim || !this.open) return;
    const state = this.kernel.state(), active = this.kernel.active();
    if (state === this.reported.state && active === this.reported.active && this.stats.lastBatch === this.reported.batch) return;
    this.reported.state = state; this.reported.active = active; this.reported.batch = this.stats.lastBatch;
    this.stats.reports++;
    this.sim.postMessage({ type: 'report', batch: this.stats.lastBatch, state, active });
  }

  /** One timer callback: 882 frames of bus A, int16 / 32768, into the ring. */
  render() {
    const ptr = this.kernel.render(CALLBACK_FRAMES);
    if (!ptr) { this.stats.fault = this.kernel.fault(); return false; }
    const memory = this.kernel.memory();
    if (ptr !== this.pcmPtr || memory !== this.pcmMemory) {
      this.pcm = new Int16Array(memory, ptr, CALLBACK_FRAMES * 2); this.pcmPtr = ptr; this.pcmMemory = memory;
    }
    const pcm = this.pcm, left = this.left, right = this.right;
    let at = (this.read + this.fill) % RING;
    for (let i = 0; i < CALLBACK_FRAMES; i++) {
      left[at] = pcm[2 * i] / 32768; right[at] = pcm[2 * i + 1] / 32768;
      if (++at === RING) at = 0;
    }
    this.fill += CALLBACK_FRAMES; this.stats.callbacks++;
    this.report();
    return true;
  }

  process(inputs, outputs) {
    const channels = outputs[0], left = channels[0], right = channels[1] ?? channels[0], n = left.length;
    this.stats.quanta++;
    if (this.open && !this.stats.fault && this.fill < n) this.render();
    if (this.fill < n) {
      // Nothing rendered: before the library opens, or after a fault.
      if (this.open) this.stats.underruns++;
      left.fill(0); right.fill(0);
      return true;
    }
    let at = this.read;
    for (let i = 0; i < n; i++) {
      left[i] = this.left[at]; right[i] = this.right[at];
      if (++at === RING) at = 0;
    }
    this.read = at; this.fill -= n;
    return true;
  }

  status() {
    return { ...this.stats, open: this.open, connected: Boolean(this.sim), queued: this.queue.length, fill: this.fill,
      state: this.open ? this.kernel.state() : null, reverb: this.open ? this.kernel.reverbState() & 3 : null,
      results: this.kernel ? { ...this.kernel.results } : null };
  }
}

if (typeof globalThis.registerProcessor === 'function') globalThis.registerProcessor('galaxy-music', GalaxyMusicProcessor);
