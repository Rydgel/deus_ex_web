// Groups the rows of a script-vm-fallback-census.mjs run (CENSUS_JSON) by what the JavaScript VM was handed: a native by its index
// (as a node, in a context, or as the value of a let), a script call by its function name, a statement by its op, a Rust body by
// its function. Self milliseconds a tick of the slowest tenth against the other ticks, the calls a tick, and microseconds a call.
//
//   node scripts/script-vm-fallback-groups.mjs CENSUS.json [rows=40] [--by diff|slow|mean]
import {readFileSync} from 'node:fs';

const [file, rowsArg] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const by = process.argv.includes('--by') ? process.argv[process.argv.indexOf('--by') + 1] : 'diff';
const census = JSON.parse(readFileSync(file, 'utf8'));
const group = key => {
  let m;
  if ((m = key.match(/^js (effect|value) native (\d+)/))) return `native ${m[2]} (${m[1]})`;
  if ((m = key.match(/^js (effect|value) 0x19\(.*?, native (\d+)/))) return `context native ${m[2]} (${m[1]})`;
  if ((m = key.match(/^js (effect|value) 0x19\(.*?, 0x1b (\w+)/))) return `context call ${m[2]} (${m[1]})`;
  if ((m = key.match(/^js (effect|value) 0x1[bc] (\w*)/))) return `call ${m[2] || '(final)'} (${m[1]})`;
  if ((m = key.match(/^js effect 0xf\((.*?), (?:native (\d+)|0x1b (\w+))/))) return `let from ${m[3] ? `call ${m[3]}` : `native ${m[2]}`}`;
  if (key.startsWith('js effect 0xf(')) return 'let other';
  if ((m = key.match(/^js statement (0x\w+|native \d+)/))) return `statement ${m[1]}`;
  if ((m = key.match(/^wasm (state )?(\w+)/))) return `wasm ${m[1] ?? ''}${m[2]}`;
  return null;
};
const groups = new Map();
for (const r of census.rows) {
  const g = group(r.key);
  if (!g) continue;
  const e = groups.get(g) ?? {slow: 0, rest: 0, slowCount: 0, restCount: 0};
  e.slow += r.slowSelf; e.rest += r.restSelf; e.slowCount += r.slowCount; e.restCount += r.restCount;
  groups.set(g, e);
}
const order = by === "slow" ? e => e.slow : by === "mean" ? e => 0.1 * e.slow + 0.9 * e.rest : e => e.slow - e.rest;
const f = (n, w = 7) => n.toFixed(3).padStart(w);
console.log(`${census.ticks} ticks, slowest tenth ${census.nSlow} at ${(census.msSlow / census.nSlow).toFixed(2)} ms, the rest ${(census.msRest / (census.ticks - census.nSlow)).toFixed(2)} ms`);
console.log('self ms a tick: slow / rest / diff | calls a tick slow / rest | us a call slow / rest | group');
for (const [name, e] of [...groups].sort((a, b) => order(b[1]) - order(a[1])).slice(0, Number(rowsArg) || 40)) {
  console.log(`${f(e.slow)} ${f(e.rest)} ${f(e.slow - e.rest)} | ${e.slowCount.toFixed(2).padStart(7)} ${e.restCount.toFixed(2).padStart(7)} | ` +
    `${(e.slowCount ? 1000 * e.slow / e.slowCount : 0).toFixed(1).padStart(7)} ${(e.restCount ? 1000 * e.rest / e.restCount : 0).toFixed(1).padStart(7)} | ${name}`);
}
