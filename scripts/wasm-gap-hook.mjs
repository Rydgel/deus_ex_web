/** Node preload for the Firefox wasm gap study (docs/firefox-60fps-plan.md "Firefox wasm gap"): records, in a real run, how long each
 * export of the script core takes and keeps the inputs of chosen calls so that scripts/wasm-gap-replay.mjs can replay them, in Node
 * and in Firefox, against the same .wasm. Measurement only; nothing here is part of the game.
 *
 *   GAP_STATS=out.json                    per export (all instances): calls and inclusive ms of the real clock
 *   GAP_SNAP=DIR GAP_SNAPS=name:n,name:n  at the n-th call (counted over all instances) of an export: the memory before the call,
 *                                         the arguments, the imports the call made (name, arguments, result) and the memory's hash after
 *   node --import ./scripts/wasm-gap-hook.mjs scripts/bench-sim.mjs ...
 */
import {writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const realNow = performance.now.bind(performance);
const stats = new Map();
const snapDir = process.env.GAP_SNAP;
const snapAt = new Set((process.env.GAP_SNAPS ?? '').split(',').filter(Boolean));   // 'name:ordinal'
const counts = new Map();
if (snapDir) mkdirSync(snapDir, {recursive: true});

/** The same hash in Node and in the page: every 32-bit word of the memory through a multiply-xor chain. */
export function hashMemory(buffer) {
  const words = new Uint32Array(buffer, 0, buffer.byteLength >>> 2);
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193) ^ (h >>> 15);
  return h >>> 0;
}
const serial = v => typeof v === 'bigint' ? {big: v.toString()} : v;

let current = null;   // the snapshot in progress: {log, shadow, memory, depth}
/** The byte runs [from, to) in which two equal-length byte views differ (runs closer than 16 bytes merged). */
const diffRuns = (shadow, now) => {
  const runs = [], CH = 65536;
  const sb = Buffer.from(shadow.buffer, shadow.byteOffset, shadow.byteLength), nb = Buffer.from(now.buffer, now.byteOffset, now.byteLength);
  for (let off = 0; off < sb.length; off += CH) {
    const end = Math.min(off + CH, sb.length);
    if (sb.compare(nb, off, end, off, end) === 0) continue;
    let i = off;
    while (i < end) {
      while (i < end && sb[i] === nb[i]) i++;
      if (i >= end) break;
      let j = i, last = i;
      while (j < end && j - last <= 16) { if (sb[j] !== nb[j]) last = j; j++; }
      runs.push([i, last + 1]);
      i = last + 1;
    }
  }
  return runs;
};
const wrapImports = imports => {
  if (!snapDir || !imports?.env) return imports;
  const env = {...imports.env}, memory = imports.env.memory;
  for (const [name, fn] of Object.entries(env)) {
    if (typeof fn !== 'function') continue;
    env[name] = (...args) => {
      const mine = current && current.memory === memory;
      if (mine) {
        // (the memory as the wasm left it at this call; what the import changes is then the difference at its return)
        if (current.depth++ > 0) current.nested = true;
        const now = new Uint8Array(memory.buffer);
        if (now.length === current.shadow.length) current.shadow.set(now); else current.grew = true;
      }
      let result;
      try { result = fn(...args); } finally { if (mine) current.depth--; }
      if (mine) {
        const entry = {name, args: args.map(serial), ret: serial(result)};
        const now = new Uint8Array(memory.buffer);
        if (now.length === current.shadow.length) {
          const runs = diffRuns(current.shadow, now);
          if (runs.length) entry.writes = runs.map(([a, b]) => [a, Buffer.from(now.subarray(a, b)).toString('base64')]);
        } else current.grew = true;
        current.log.push(entry);
      }
      return result;
    };
  }
  return {...imports, env};
};

const wrapInstance = (instance, imports) => {
  const memory = imports?.env?.memory ?? instance.exports.memory;
  const exports = {};
  for (const [name, value] of Object.entries(instance.exports)) {
    if (typeof value !== 'function') { exports[name] = value; continue; }
    exports[name] = (...args) => {
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      let snap = null;
      if (snapDir && snapAt.has(`${name}:${count}`) && memory) {
        snap = {log: [], before: new Uint8Array(memory.buffer).slice(), args: args.map(serial), sp: instance.exports.__stack_pointer?.value, memory, depth: 0};
        snap.shadow = snap.before.slice();
        current = snap;
      }
      const t = realNow();
      let result;
      try { result = value(...args); }
      finally {
        const dt = realNow() - t;
        const entry = stats.get(name) ?? {calls: 0, ms: 0, each: []};
        entry.calls++; entry.ms += dt; if (entry.each.length < 300000) entry.each.push(dt); stats.set(name, entry);
        if (snap) {
          current = null;
          writeFileSync(join(snapDir, `${name}-${count}.mem`), snap.before);
          writeFileSync(join(snapDir, `${name}-${count}.json`), JSON.stringify({
            name, ordinal: count, sp: snap.sp, nested: snap.nested || snap.grew || undefined, args: snap.args, result: serial(result), log: snap.log, bytes: snap.before.byteLength,
            memoryBefore: hashMemory(snap.before.buffer), memoryAfter: hashMemory(memory.buffer), ms: dt,
          }));
          console.error(`gap: snapshot ${name} #${count}: ${(snap.before.byteLength / 1048576).toFixed(1)} MiB, ${snap.log.length} imports, ${dt.toFixed(3)} ms`);
        }
      }
      return result;
    };
  }
  return new Proxy(instance, {get: (target, key) => key === 'exports' ? Object.freeze(exports) : Reflect.get(target, key, target)});
};

const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async function (source, imports) {
  const result = await instantiate.call(this, source, wrapImports(imports));
  if (source instanceof WebAssembly.Module) return wrapInstance(result, imports);
  return {...result, instance: wrapInstance(result.instance, imports)};
};

process.on('exit', () => {
  if (process.env.GAP_SMAPS) {
    // (what the kernel did with the big anonymous mappings the memories live in: Rss and transparent huge pages)
    const out = [];
    for (const block of readFileSync('/proc/self/smaps', 'utf8').split(/^(?=[0-9a-f]+-[0-9a-f]+ )/m)) {
      const head = /^([0-9a-f]+)-([0-9a-f]+) (\S+)/.exec(block);
      const num = k => Number((new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(block) ?? [0, 0])[1]);
      if (head && head[3] === 'rw-p' && num('Rss') >= 8000) out.push(`${head[1]}-${head[2]} size ${Math.round(num('Size') / 1024)} rss ${Math.round(num('Rss') / 1024)} huge ${Math.round(num('AnonHugePages') / 1024)}`);
    }
    writeFileSync(process.env.GAP_SMAPS, out.join('\n') + '\n');
  }
  if (!process.env.GAP_STATS) return;
  // (and the ordinal of the call at the 50th, 75th and 90th percentile of the duration among the calls after the first third)
  const pick = v => { const from = Math.floor(v.each.length / 3), list = v.each.slice(from).map((ms, i) => [ms, from + i + 1]).sort((a, b) => a[0] - b[0]);
    return Object.fromEntries([50, 75, 90, 99].map(p => { const at = list[Math.min(list.length - 1, Math.floor(list.length * p / 100))]; return ['p' + p, at ? {ordinal: at[1], ms: +at[0].toFixed(4)} : null]; })); };
  const rows = [...stats].map(([name, v]) => ({name, calls: v.calls, ms: +v.ms.toFixed(3), ...pick(v)})).sort((a, b) => b.ms - a.ms);
  writeFileSync(process.env.GAP_STATS, JSON.stringify(rows, null, 1));
});
