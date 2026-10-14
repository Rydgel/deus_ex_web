// Reads a ?hitchlog=1 dump (src/viewer/hitch-log.mjs, docs/hitch-log.md): the file
// Ctrl+Shift+H saves. Prints the frame-time percentiles of the whole session, the
// slow seconds with what the worker, the page and WebGL were doing in each, the
// growth of heaps and resources, the shader programs created after play began,
// and the frames around the longest draw gaps.
//   node scripts/analyze-hitchlog.mjs <deusex-hitchlog-*.json> [--gap 50] [--list 30] [--slow 0.6]
// (a run.json from the Linux harness, {dump, samples, ...}, reads too.)
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/analyze-hitchlog.mjs <hitchlog.json> [--gap 50] [--list 30] [--slow 0.6]'); process.exit(2); }
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : Number(process.argv[i + 1]); };
const spikeGap = option('gap', 50), listN = option('list', 30), slowFraction = option('slow', 0.6);
const raw = JSON.parse(readFileSync(file, 'utf8'));
const run = raw.dump ? raw : null, d = raw.dump ?? raw;
const ci = Object.fromEntries(d.columns.map((c, i) => [c, i]));
const f = (v, n = 1) => Number.isFinite(v) ? v.toFixed(n) : '-';
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const m = d.meta;
console.log(`file ${file}`);
if (run) console.log(`args ${run.args.join(' ')}\nstatus ${JSON.stringify(run.status)} ended ${run.ended} errors ${run.errors.length}`);
console.log(`saved ${m.saved} after ${m.elapsedS} s | ${m.userAgent}`);
console.log(`gl ${m.glRenderer} | dpr ${m.devicePixelRatio} pixelRatio ${m.pixelRatio} canvas ${m.canvas} | cores ${m.hardwareConcurrency} mem ${m.deviceMemory} GB | memory API ${m.hasMemoryApi} | url ${m.url}`);

// ---- whole-session summary (computed in the page over every frame it kept)
const s = d.summary;
console.log(`\nframes ${s.frames}, drawn ${s.drawn}; draw gap ms p50 ${f(s.drawGapMs.p50)} p95 ${f(s.drawGapMs.p95)} p99 ${f(s.drawGapMs.p99)} max ${f(s.drawGapMs.max)}`);
console.log('draw gaps over (ms): ' + Object.entries(s.gapsOver).map(([k, v]) => `>${k}:${v}`).join(' ') + `; programs created ${s.programsCreated}; hitch limit ${d.hitchLimitMs} ms`);

// ---- seconds
const firstPlay = Math.max(0, d.seconds.findIndex(x => x.drawn > 0));
const S = d.seconds.slice(firstPlay), play = S.filter(x => x.map && !x.error);
const drawnMedian = q(play.map(x => x.drawn), 0.5);
const slow = play.filter(x => x.drawn < drawnMedian * slowFraction);
console.log(`\nseconds ${S.length}; drawn fps median ${drawnMedian}; slow seconds (< ${Math.round(slowFraction * 100)}% of median): ${slow.length}`);
if (slow.length) {
  console.log('  t(s)  fps dtMax | animMax(page: phase) | workerMax posts lat | glMs compile/upload/sync/draw | heapMB wasmW | what');
  const kinds = {};
  for (const x of slow.slice(0, listN)) {
    const worker = x.wMax >= 0.6 * x.dtMax, page = x.animMax >= 0.6 * x.dtMax, gl = x.glCompileMs + x.glUploadMs + x.glSyncMs + x.glDrawMs >= 0.6 * x.dtMax;
    const what = gl ? 'WebGL calls' : worker ? 'worker frame' : page ? `page frame (${x.phaseKey})` : x.wLatMax >= 0.6 * x.dtMax ? 'post-to-worker latency' : 'neither thread: browser, GPU or OS';
    kinds[what] = (kinds[what] ?? 0) + 1;
    console.log(`  ${String(Math.round(x.t / 1000)).padStart(5)} ${String(x.drawn).padStart(4)} ${String(Math.round(x.dtMax)).padStart(5)} | ${String(Math.round(x.animMax)).padStart(5)} ${x.phaseKey.padEnd(9)} | ${String(Math.round(x.wMax)).padStart(5)} ${String(x.wPostsMax).padStart(3)} ${String(Math.round(x.wLatMax)).padStart(4)} | ${x.glCompileMs}/${x.glUploadMs}/${x.glSyncMs}/${x.glDrawMs} | ${x.heapMB ?? '-'} ${x.wasmWorkerMB} | ${what}`);
  }
  console.log('  slow seconds by cause: ' + JSON.stringify(kinds));
  if (slow.length > 1) { const iv = []; for (let i = 1; i < slow.length; i++) iv.push(f((slow[i].t - slow[i - 1].t) / 1000, 0)); console.log('  spacing between slow seconds (s): ' + iv.slice(0, 60).join(' ')); }
}

// ---- growth
console.log('\nevery 30 s: t  drawn  pageHeapMB/total  wasmPage/Worker MB  geometries textures programs calls  created in that second');
for (let i = 0; i < S.length; i += 30) {
  const x = S[i];
  console.log(`  ${String(Math.round(x.t / 1000)).padStart(5)}s ${String(x.drawn).padStart(3)} heap ${x.heapMB ?? '-'}/${x.heapTotalMB ?? '-'} wasm ${x.wasmPageMB}/${x.wasmWorkerMB} geom ${x.geometries} tex ${x.textures} prog ${x.programs} calls ${x.calls} ${JSON.stringify(x.created)}`);
}
const first = S[Math.min(10, S.length - 1)], last = S.at(-1);
console.log(`growth ${Math.round(first.t / 1000)}s -> ${Math.round(last.t / 1000)}s: pageHeap ${first.heapMB} -> ${last.heapMB} MB, wasm worker ${first.wasmWorkerMB} -> ${last.wasmWorkerMB} MB, geometries ${first.geometries} -> ${last.geometries}, textures ${first.textures} -> ${last.textures}, programs ${first.programs} -> ${last.programs}`);
const heap = S.map(x => x.heapMB).filter(x => x != null);
const drops = []; for (let i = 1; i < heap.length; i++) if (heap[i - 1] - heap[i] > 40) drops.push(`${Math.round(S[i].t / 1000)}s ${heap[i - 1]}->${heap[i]}`);
console.log(`page heap drops > 40 MB: ${drops.length} ${drops.slice(0, 20).join(' ')}; audio underruns ${last.underruns}`);
const hidden = S.filter(x => x.visible !== 'visible' || x.focus === false);
console.log(`seconds not visible or without focus: ${hidden.length}`);

// ---- programs and events
const t0 = (S[0]?.t ?? 0);
const late = d.programs.filter(p => p.t > t0 + 5000);
console.log(`\nprograms created: ${d.programs.length}, after the first 5 s of play: ${late.length}`);
for (const p of late.slice(0, 20)) console.log(`  t=${f(p.t / 1000)}s id=${p.id} ${p.name} key=${p.key}`);
const kinds = {}; for (const e of d.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log('events by kind ' + JSON.stringify(kinds));
const byFn = {};
for (const e of d.events) if (e.kind === 'slowGL' && e.t > t0) { const k = (byFn[e.fn] ??= { n: 0, ms: 0, max: 0 }); k.n++; k.ms += e.ms; k.max = Math.max(k.max, e.ms); }
console.log('slow GL calls (>= 2 ms) after play began: ' + JSON.stringify(byFn));
const loaf = d.events.filter(e => e.kind === 'loaf' && e.t > t0).sort((a, b) => b.ms - a.ms).slice(0, 8);
for (const e of loaf) console.log(`  long animation frame t=${f(e.t / 1000)}s ${e.ms} ms blocking ${e.blocking} render@${e.renderStart} scripts ${JSON.stringify(e.scripts)}`);

// ---- frames around the longest gaps (rows kept in the dump)
const R = d.rows, draws = R.filter(r => r[ci.drawn]);
// A worker frame in which several steps are each several times their usual cost at once, with no work to explain it,
// is a pause of the worker's thread (a garbage collection, or the thread being descheduled), not slow code.
const stepMedian = Object.fromEntries(d.meta.workerKeys.map(k => [k, q(R.map(r => r[ci[`w.${k}`]]).filter(x => x >= 0), 0.5)]));
const pauseLike = row => row && d.meta.workerKeys.filter(k => row[ci[`w.${k}`]] > Math.max(4 * stepMedian[k], 4)).length >= 3;
const gaps = [];
for (let i = 1; i < draws.length; i++) if (draws[i][ci.t] - draws[i - 1][ci.t] < 5000) gaps.push({ t: draws[i][ci.t], gap: draws[i][ci.t] - draws[i - 1][ci.t] });
gaps.sort((a, b) => b.gap - a.gap);
const spikes = gaps.filter(g => g.gap > spikeGap);
console.log(`\ndraw gaps > ${spikeGap} ms among the ${R.length} kept frames: ${spikes.length}`);
for (const g of spikes.slice(0, listN)) {
  const inside = R.filter(r => r[ci.t] > g.t - g.gap - 5 && r[ci.t] <= g.t + 5);
  const worker = inside.filter(r => r[ci['w.dur']] >= 0).sort((a, b) => b[ci['w.dur']] - a[ci['w.dur']])[0];
  const max = k => f(Math.max(0, ...inside.map(r => r[ci[k]])), 0);
  const big = worker ? d.meta.workerKeys.map(k => [k, worker[ci[`w.${k}`]]]).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}=${f(v, 0)}`).join(' ') : '';
  const events = d.events.filter(e => e.t >= g.t - g.gap && e.t <= g.t && e.kind !== 'program').map(e => `${e.kind}${e.ms ? ':' + f(e.ms, 0) : ''}${e.fn ? ':' + e.fn : ''}`).slice(0, 4);
  console.log(`  t=${f(g.t / 1000, 2)}s gap ${f(g.gap, 0)} | worker ${worker ? f(worker[ci['w.dur']], 0) : '-'}${pauseLike(worker) ? ' PAUSE-LIKE' : ''} [${big}] posts ${worker ? worker[ci['w.posts']] : '-'} lat ${worker ? f(worker[ci['w.lat']], 0) : '-'} | page animate ${max('animate')} gl compile ${max('gl.compile')} upload ${max('gl.upload')} sync ${max('gl.sync')} draw ${max('gl.draw')} | ${events.join(',')}`);
}
if (run?.gc) {
  const by = new Map();
  for (const e of run.gc) if (/^(MajorGC|MinorGC)$/.test(e.name)) (by.get(e.thread) ?? by.set(e.thread, []).get(e.thread)).push(e);
  for (const [thread, list] of by) {
    const major = list.filter(e => e.name === 'MajorGC'), minor = list.filter(e => e.name === 'MinorGC');
    console.log(`GC ${thread}: major ${major.length} (max ${f(Math.max(0, ...major.map(e => e.dur)) / 1000, 0)} ms), minor ${minor.length} (max ${f(Math.max(0, ...minor.map(e => e.dur)) / 1000, 1)} ms)`);
  }
}
