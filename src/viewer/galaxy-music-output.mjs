/** The page's part of Galaxy's music output (docs/galaxy-music.md "Phase 5:
 * Output"): it creates the AudioWorkletNode that owns the library
 * (galaxy-music-worklet.mjs), hands it the kernel bytes, and wires one
 * MessageChannel per simulation side, so that the simulation (the sim worker,
 * or the page with ?sim=inline) and the worklet talk directly. Per frame the
 * page does nothing for music; status crosses only when asked.
 *
 * Host choices: the context is the page's AudioContext at 44100 Hz (created
 * by the caller on a user gesture); the pan table is built at x87 precision
 * control 64 (the sequencer oracle's 0x037f control word). `ahead` is the
 * fill galaxy_render pins on the coincident-head path, which the worklet no
 * longer plays (its timer callback keeps 0x10697cdc itself, output.rs); the
 * write cursor's lead is the worklet's WRITE_LEAD (a labelled placeholder). */
export const MUSIC_PAN_PC = 64;
export const MUSIC_AHEAD = 176400 - 882 * 4;

export function createMusicOutput({ effectsChannels = 16 } = {}) {
  let node = null, starting = null, pending = null, nextStatus = 1, last = null, error = null, asked = -Infinity;
  const waiters = new Map();
  const config = { effectsChannels, latency: 40 };
  const connect = port => node.port.postMessage({ type: 'connect', port, effectsChannels: config.effectsChannels,
    pc: MUSIC_PAN_PC, ahead: MUSIC_AHEAD, latency: config.latency }, [port]);
  const output = {
    /** EffectsChannels (Init clamps it to 0..32) and Latency (clamped to
     * 10..250 by 0x10605ad0; the output open clamps it to 5..495) from DeusEx.ini. */
    configure({ effectsChannels: channels, latency = config.latency }) { config.effectsChannels = channels; config.latency = latency; },
    /** A new simulation side: returns its port; the worklet gets the other
     * end now, or when it exists. The library is opened afresh for it. */
    simulationPort() {
      const channel = new MessageChannel();
      if (node) connect(channel.port1);
      else { pending?.close(); pending = channel.port1; }
      return channel.port2;
    },
    /** Builds the node on `context` (once). */
    start(context) {
      return starting ??= (async () => {
        try {
          if (context.sampleRate !== 44100) throw new Error(`Galaxy music needs a 44100 Hz context, got ${context.sampleRate}`);
          const [wasm] = await Promise.all([
            fetch(new URL('../runtime/galaxy-kernel.wasm', import.meta.url)).then(response => {
              if (!response.ok) throw new Error(`Cannot load the Galaxy kernel: HTTP ${response.status}`);
              return response.arrayBuffer();
            }),
            context.audioWorklet.addModule(new URL('./galaxy-music-worklet.mjs', import.meta.url)),
          ]);
          node = new AudioWorkletNode(context, 'galaxy-music', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          node.port.onmessage = ({ data }) => {
            if (data.type !== 'status') return;
            last = data.status;
            waiters.get(data.id)?.(data.status); waiters.delete(data.id);
          };
          node.connect(context.destination);
          node.port.postMessage({ type: 'init', wasm }, [wasm]);
          if (pending) { connect(pending); pending = null; }
        } catch (caught) { error = String(caught?.message ?? caught); throw caught; }
      })();
    },
    /** The worklet's counters as last received (a refresh is requested, at
     * most every 250 ms). */
    status() {
      const now = performance.now();
      if (node && now - asked >= 250) { asked = now; node.port.postMessage({ type: 'status', id: 0 }); }
      return { running: Boolean(node), error, worklet: last };
    },
    /** A fresh copy of the worklet's counters (the last one if the audio
     * thread does not answer within a second, e.g. a suspended context). */
    async refresh() {
      if (!node) return output.status();
      const id = nextStatus++;
      const status = await new Promise(resolve => {
        const timer = setTimeout(() => { waiters.delete(id); resolve(last); }, 1000);
        waiters.set(id, value => { clearTimeout(timer); resolve(value); });
        node.port.postMessage({ type: 'status', id });
      });
      return { running: true, error, worklet: status };
    },
  };
  return output;
}
