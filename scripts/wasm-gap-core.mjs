/** The replay core of the Firefox wasm gap study (docs/firefox-60fps-plan.md "Firefox wasm gap"): one snapshot case recorded by
 * scripts/wasm-gap-hook.mjs (the memory before one export call, its arguments and the imports the call made) is loaded into a fresh
 * memory and the export called again and again, timed. The same file runs in Node and in a page (no Node imports here); the page gets
 * its bytes by fetch, Node from disk (scripts/wasm-gap-replay.mjs). Measurement only. */

/** The same hash as the hook's: every 32-bit word through a multiply-xor chain. */
export function hashMemory(buffer) {
  const words = new Uint32Array(buffer, 0, buffer.byteLength >>> 2);
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193) ^ (h >>> 15);
  return h >>> 0;
}
const atobBytes = text => { const binary = atob(text), out = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i); return out; };
const unserial = v => v !== null && typeof v === 'object' && 'big' in v ? BigInt(v.big) : v;

/** A case ready to call: `module` the compiled script core, `meta` the .json, `bytes` the .mem. */
export async function openCase(module, meta, bytes, extraImports = {}) {
  const memory = new WebAssembly.Memory({initial: bytes.byteLength >>> 16});
  let at = 0;
  const log = meta.log;
  const env = {memory};
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.kind !== 'function') continue;
    env[entry.name] = (...args) => {
      const e = log[at++];
      if (!e || e.name !== entry.name) throw new Error(`replay: ${entry.name} called out of order (expected ${e?.name}) at ${at}`);
      // (what the import wrote into the memory while the recording ran)
      if (e.writes) { const u8 = new Uint8Array(memory.buffer); for (const [offset, text] of e.writes) { const raw = atobBytes(text); u8.set(raw, offset); } }
      return unserial(e.ret);
    };
  }
  Object.assign(env, extraImports);
  const instance = await WebAssembly.instantiate(module, {env});
  // (after the instance: its data segments write the statics' initial values into the memory at instantiation)
  new Uint8Array(memory.buffer).set(bytes);
  // (a call made from inside a script run starts below the top of the shadow stack)
  if (meta.sp !== undefined && instance.exports.__stack_pointer) instance.exports.__stack_pointer.value = meta.sp;
  const f = instance.exports[meta.name];
  const args = meta.args.map(unserial);
  const c = {meta, memory, f, args, bytes, reset: () => { at = 0; }, dirty: null, instance};
  return c;
}

/** One call from the snapshot state; returns the result. */
export function callOnce(c) {
  c.reset();
  return c.f(...c.args);
}

/** The runs of 4 KiB pages the call changed (found by one call and a comparison against the snapshot). */
export function findDirty(c) {
  const u8 = new Uint8Array(c.memory.buffer), s = c.bytes, runs = [];
  const PAGE = 4096;
  let run = null;
  for (let p = 0; p * PAGE < s.length; p++) {
    const a = p * PAGE;
    let same = true;
    const end = Math.min(a + PAGE, s.length);
    for (let i = a; i < end; i += 4) if (u8[i] !== s[i] || u8[i + 1] !== s[i + 1] || u8[i + 2] !== s[i + 2] || u8[i + 3] !== s[i + 3]) { same = false; break; }
    if (same) { if (run) { runs.push(run); run = null; } continue; }
    if (run && run[1] === a) run[1] = end; else { if (run) runs.push(run); run = [a, end]; }
  }
  if (run) runs.push(run);
  return runs;
}

export function restore(c) {
  const u8 = new Uint8Array(c.memory.buffer);
  for (const [a, b] of c.dirty) u8.set(c.bytes.subarray(a, b), a);
}

/** Verify the replay: the result and the memory hash after the call equal the recorded ones. */
export function verify(c) {
  const result = callOnce(c);
  const after = hashMemory(c.memory.buffer);
  c.dirty = findDirty(c);
  restore(c);
  const back = hashMemory(c.memory.buffer);
  return {result: unserial(c.meta.result) === result || String(unserial(c.meta.result)) === String(result), resultSeen: result, afterEqual: after === c.meta.memoryAfter,
    restoredEqual: back === c.meta.memoryBefore, dirtyBytes: c.dirty.reduce((n, [a, b]) => n + b - a, 0), runs: c.dirty.length};
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const quant = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : NaN; };

/** Time the case for about `seconds`: the calls restore the state first when the call changes memory. Returns
 *  {calls, medianUs, minUs, p90Us, firstUs: [first 8 calls], windows: [[second, medianUs, calls]]} per call (a batch of `batch`
 *  calls when the call changes nothing and is too short for the clock). */
export function timeCase(c, seconds, now = () => performance.now(), coldMiB = 0) {
  const pure = c.dirty.length === 0 && !coldMiB;
  // (cold: a read through coldMiB of other memory before each call, so that the call starts with the caches and the TLB another 15 ms of work leaves)
  const thrash = coldMiB ? (() => { const w = new Uint32Array(coldMiB * 262144); let sink = 0; return () => { for (let i = 0; i < w.length; i += 16) sink += w[i]; w[0] = sink; }; })() : null;
  const t0 = now();
  // (a batch long enough for a clock of 1 us: the first call decides)
  let a = now(); callOnce(c); let one = now() - a;
  if (c.dirty.length) restore(c);
  // (a state-changing call too short for the clock is timed K times with its restores and K restores alone, the difference over K)
  const batch = (pure || (!coldMiB && c.dirty.length)) ? Math.max(1, Math.min(2000, Math.ceil(0.5 / Math.max(one, 0.002)))) : 1;
  const samples = [], firsts = [], windows = new Map();
  let calls = 0;
  for (;;) {
    let dt;
    if (batch > 1 && !pure) {
      let s = now();
      for (let i = 0; i < batch; i++) { restore(c); callOnce(c); }
      const withCalls = now() - s;
      s = now();
      for (let i = 0; i < batch; i++) restore(c);
      dt = (withCalls - (now() - s)) / batch * 1000;
    } else {
      if (c.dirty.length) restore(c);
      if (thrash) thrash();
      const s = now();
      if (batch === 1) callOnce(c); else for (let i = 0; i < batch; i++) callOnce(c);
      dt = (now() - s) / batch * 1000;
    }
    calls += batch;
    if (firsts.length < 8) firsts.push(+dt.toFixed(2));
    samples.push(dt);
    const w = Math.floor((now() - t0) / 1000);
    (windows.get(w) ?? windows.set(w, []).get(w)).push(dt);
    if (now() - t0 >= seconds * 1000) break;
  }
  const mean = list => list.reduce((x, y) => x + y, 0) / list.length;
  return {calls, batch, pure, medianUs: +median(samples).toFixed(2), meanUs: +mean(samples).toFixed(2), minUs: +Math.min(...samples).toFixed(2), p90Us: +quant(samples, 0.9).toFixed(2), firstUs: firsts,
    windows: [...windows].map(([w, list]) => [w, +mean(list).toFixed(2), list.length])};
}
