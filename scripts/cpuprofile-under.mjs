// What a V8 CPU profile (bench-sim --cpu-profile) spends under one frame, split at boundaries: for every sample whose stack holds the
// anchor (its innermost occurrence), the stack segment below the anchor is cut at the first frame matching --stop (the work nested
// inside, such as JavaScript nodes or natives that the anchor's callee runs); the sample's leaf is named when it lies inside the
// segment, otherwise the sample is counted as nested work under the boundary frame. Host measurement only.
//
//   node scripts/cpuprofile-under.mjs PROFILE.cpuprofile --anchor '^callFunction$' [--stop '^(nodeEffect|nodeValue|invokeNative)$'] [--top 30]
//     [--ticks N] (divides milliseconds by the timed tick count, default 1200)
import {readFileSync} from 'node:fs';

const args = process.argv.slice(2), opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const file = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const anchor = new RegExp(opt('anchor', '^callFunction$')), stop = opt('stop', null) ? new RegExp(opt('stop')) : null;
const top = Number(opt('top', 30)), ticks = Number(opt('ticks', 1200));
const profile = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const name = n => `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.replace(/^.*\/src\//, 'src/')}:${n.callFrame.lineNumber + 1}`;
const bare = n => n.callFrame.functionName || '(anonymous)';
const self = new Map(), nested = new Map();
let total = 0, all = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i]) / 1000;
  all += dt;
  const chain = [];
  for (let id = profile.samples[i]; id !== undefined; id = parent.get(id)) chain.push(nodes.get(id));
  // chain is leaf-first; the innermost anchor is the first match from the leaf
  const j = chain.findIndex(n => anchor.test(bare(n)));
  if (j < 0) continue;
  total += dt;
  let k = j - 1, cut = -1;
  for (; k >= 0; k--) if (stop && stop.test(bare(chain[k]))) { cut = k; break; }
  if (cut >= 0) { const key = bare(chain[cut]); nested.set(key, (nested.get(key) ?? 0) + dt); }
  else { const key = j === 0 ? '(anchor itself)' : name(chain[0]); self.set(key, (self.get(key) ?? 0) + dt); }
}
const per = ms => (ms / ticks).toFixed(3).padStart(8);
console.log(`under ${anchor}: ${per(total)} ms a tick of ${per(all)} (the whole profile)`);
console.log('\nleaf inside the segment (ms a tick):');
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${per(v)}  ${k}`);
if (nested.size) {
  console.log('\nnested work below the first boundary frame (ms a tick):');
  for (const [k, v] of [...nested].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${per(v)}  ${k}`);
}
