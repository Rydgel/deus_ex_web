/** WebAssembly linear-memory watch for the opt-in hitch recorder
 * (hitch-log.mjs, ?hitchlog=1; the simulation worker installs it when the
 * flag crosses in its init message). `watchWasm()` wraps the Memory
 * constructor and `WebAssembly.instantiate` so that every memory created
 * afterwards is known; `wasmBytes()` is their total size now. Nothing here
 * runs unless a caller installs it. Measurement only. */
const memories = new Set();
let installed = false;

export function watchWasm() {
  if (installed || typeof WebAssembly === 'undefined') return;
  installed = true;
  const Memory = WebAssembly.Memory;
  const scan = instance => { for (const value of Object.values(instance?.exports ?? {})) if (value instanceof Memory) memories.add(value); };
  WebAssembly.Memory = new Proxy(Memory, { construct(target, args) { const memory = Reflect.construct(target, args); memories.add(memory); return memory; } });
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async function (...args) { const result = await instantiate.apply(this, args); scan(result.instance ?? result); return result; };
  const Instance = WebAssembly.Instance;
  WebAssembly.Instance = new Proxy(Instance, { construct(target, args) { const instance = Reflect.construct(target, args); scan(instance); return instance; } });
}

export const wasmBytes = () => { let bytes = 0; for (const memory of memories) bytes += memory.buffer.byteLength; return bytes; };
export const wasmCount = () => memories.size;
