/** WebAssembly linear-memory watch for the opt-in hitch recorder
 * (hitch-log.mjs, ?hitchlog=1; the simulation worker installs it when the
 * flag crosses in its init message). `watchWasm()` wraps the Memory
 * constructor and `WebAssembly.instantiate` so that every memory created
 * afterwards is known; `wasmBytes()` is their total size now. Nothing here
 * runs unless a caller installs it. Measurement only. */
// (weakly: a memory the program has dropped, such as a left level's object arena, must stay collectable, or the watch itself keeps
// every past level's memory alive over a long session, docs/long-session.md; `seen` counts a memory once, as the import and the export
// of the same instance). Weakly is not enough in Firefox: a WeakRef read during SpiderMonkey's incremental marking marks its target,
// and these reads run each second on the page and each frame in the worker, so with the hitch log Firefox's incremental collections
// keep every memory until a non-incremental one (Gecko's minimize, which session-hour.mjs and map-memory-census.mjs force before a
// reading); docs/map-memory.md
const memories = new Set(), seen = new WeakSet();
let installed = false;
// (each with the frames that created it, for `wasmMemories`)
const sites = new WeakMap();
const watch = memory => {
  if (seen.has(memory)) return;
  seen.add(memory); memories.add(new WeakRef(memory));
  sites.set(memory, String(new Error().stack).split('\n').slice(2, 6).map(line => line.trim().replace(/^at /, '').replace(/\(?https?:\/\/[^/]+\//, '').replace(/\?[^:)]*/, '')).join(' < '));
};

export function watchWasm() {
  if (installed || typeof WebAssembly === 'undefined') return;
  installed = true;
  const Memory = WebAssembly.Memory;
  const scan = instance => { for (const value of Object.values(instance?.exports ?? {})) if (value instanceof Memory) watch(value); };
  WebAssembly.Memory = new Proxy(Memory, { construct(target, args) { const memory = Reflect.construct(target, args); watch(memory); return memory; } });
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async function (...args) { const result = await instantiate.apply(this, args); scan(result.instance ?? result); return result; };
  const Instance = WebAssembly.Instance;
  WebAssembly.Instance = new Proxy(Instance, { construct(target, args) { const instance = Reflect.construct(target, args); scan(instance); return instance; } });
}

// (over the memories still alive; a collected one is forgotten here)
export const wasmBytes = () => { let bytes = 0; for (const ref of memories) { const memory = ref.deref(); if (memory) bytes += memory.buffer.byteLength; else memories.delete(ref); } return bytes; };
export const wasmCount = () => { let count = 0; for (const ref of memories) if (ref.deref()) count++; else memories.delete(ref); return count; };
/** The live memories, each with its size (MB) and where it was created: what a growing `wasmBytes` is made of. */
export const wasmMemories = () => { const list = []; for (const ref of memories) { const memory = ref.deref(); if (memory) list.push({ mb: Math.round(memory.buffer.byteLength / 1048576), site: sites.get(memory) }); } return list; };
