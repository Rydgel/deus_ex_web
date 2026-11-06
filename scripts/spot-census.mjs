// A slow-spot census: where on a map does a browser's frame cost most? The fixed routes of scripts/frame-time-set.mjs (the census scan, roam)
// never stood at a mirror, in a corridor's mouth or beside a large light; this visits up to N spread-out spots of each map instead (the
// 2026-11-06 report: ~30 fps beside the two large mirrors of 10_Paris_Club in Firefox, a spot no route measured).
//
// For each map the placed navigation points are read from the map file (scripts/map-nav-points.mjs: PathNode, PlayerStart, PatrolPoint,
// HidePoint, AmbushPoint, SpawnPoint), N of them are taken by farthest-point sampling, and scripts/hitch-run.mjs --places visits each at four
// headings 90 degrees apart (Unreal yaw 0, 16384, 32768, 49152): placeProbe, --settle ms (500) to settle, then --record ms (750) of frames
// from the hitch log. One session per map, a browser run through the shared heavy lock (flock) and a memory-limited systemd scope
// (MemoryMax 8G), taken per map so that another worker can interleave. Per spot the page's frame (the `animate` column: p50, p95, max over
// the window's frames), the means of every phase column (p.* the page's phases, gl.* the WebGL ms and counts, w.* the worker's), the player's
// position at the end of the window (a placement the sim refused shows there) and the top phases are written to <dir>/<browser>-<map>.spots.json;
// a summary table over the maps sorted by page p50 goes to <dir>/<browser>-summary.md. Host measurement only: no simulation state is touched
// beyond the player's placement, as the validators' placeProbe does.
//
//   node scripts/spot-census.mjs [--maps a,b,...|all] [--browser firefox|chromium] [--points 40] [--settle 500] [--record 750] [--z 8]
//     [--dir .cache/perf/spot-census] [--god|--no-god] [--no-guard] (no flock/systemd-run) [--lock PATH] [--query k=v] [--url URL]
//     [--skip REGEX] (maps not measured; default DXMP_*, Entry, DX, DXOnly) [--timeout-min 30] (a map's session is killed when its output has not advanced for this long)
//   node scripts/spot-census.mjs --figures RUN.json...      (the spots of raw hitch-run.mjs --places runs, one line each)
//   node scripts/spot-census.mjs --summary [--dir ...] [--browser ...] [--over 16.7] [--rows 60]     (the table only, from the saved <map>.spots.json files;
//     --rebuild first rewrites those from the raw <map>.json runs)
// A spot where the player is in a conversation at the end of its window (a ScriptedPawn that sees the placed player starts one) is measured
// once more and, if it still is, left out of the table (`valid` false in the JSON); every placement ends a running conversation first.
import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mapNames, navPoints, farthestPoints} from './map-nav-points.mjs';

const YAWS = [0, 16384, 32768, 49152];
const option = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? f : process.argv[i + 1]; };
const SKIP = new RegExp(option('skip', '^(DXMP_|Entry$|DX$|DXOnly$)'), 'i');
const flag = n => process.argv.includes(`--${n}`);
const engine = option('browser', 'firefox'), dir = option('dir', '.cache/perf/spot-census');
const quantile = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f1 = v => Number.isFinite(v) ? v.toFixed(1) : '-';

/** One spot's figures from a run's hitch dump: the rows whose time falls in [start, end] (page performance.now() less the log's origin). */
export function spotFigures(run, spot) {
  const d = run.dump, ci = Object.fromEntries(d.columns.map((c, i) => [c, i])), origin = d.meta.originMs;
  const rows = d.rows.filter(r => r[ci.t] >= spot.start - origin && r[ci.t] <= spot.end - origin), drawn = rows.filter(r => r[ci.drawn]);
  const column = k => rows.map(r => r[ci[k]]);
  const mean = k => { const v = column(k); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
  const page = column('animate');
  const phases = {};
  for (const k of d.columns) if (/^(p|gl|w)\./.test(k) && !['w.start', 'w.status', 'w.age', 'w.dt'].includes(k)) phases[k] = Math.round(mean(k) * 100) / 100;
  const top = Object.entries(phases).filter(([k]) => k.startsWith('p.')).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k.slice(2)} ${f1(v)}`);
  return {frames: rows.length, drawn: drawn.length, fps: drawn.length / Math.max(1e-3, (spot.end - spot.start) / 1000),
    page: {p50: quantile(page, .5), p95: quantile(page, .95), max: page.length ? Math.max(...page) : NaN, mean: mean('animate')}, phases, top};
}

/** All the figures of one map's run (the file hitch-run.mjs --places wrote), joined to the spots' labels. A spot is `valid` when the player
 * was walking at its end (not in a conversation, whose camera draws another view) and stood where it was placed: a raw run from before
 * hitch-run recorded the player's state is judged by the camera's position alone. */
export function mapFigures(run, extra = {}) {
  return (run.spots ?? []).map(spot => {
    const f = spotFigures(run, spot), want = spot.location, at = spot.player?.location ?? spot.position ?? [];
    // the placement the sim kept: where the player (else the camera) is at the end of the window against the spot (it falls to the floor, so only x and y)
    const moved = at.length ? Math.hypot(at[0] - want[0], at[1] - want[1]) : NaN;
    const state = spot.player?.state ?? null, cut = Boolean(run.ended) && spot === run.spots.at(-1);
    const target = run.args ? run.args[run.args.indexOf('--map') + 1] : run.status?.map, inMap = !spot.map || String(spot.map).toLowerCase() === String(target).toLowerCase();
    return {map: target ?? null, index: spot.id ?? spot.i, label: spot.label, location: want, yaw: spot.rotation[1], position: spot.position ?? [], moved,
      state, conversation: spot.conversation ?? null, attempts: spot.attempts ?? 1, valid: inMap && !cut && (state === null || state === 'PlayerWalking') && moved < 150, ...f, ...extra};
  });
}

const row = s => `| ${s.map} | ${s.location.map(v => Math.round(v)).join(', ')} | ${s.yaw} | ${f1(s.page.p50)} | ${f1(s.page.p95)} | ${f1(s.page.max)} | ${f1(s.fps)} | ${s.top.join(', ')} | ${f1(s.phases['gl.upload'])} / ${f1(s.phases['gl.uploadMB'])} MB | ${f1(s.phases['gl.drawN'])} |`;
const HEADER = '| Map | Location | Yaw | page p50 | p95 | max | fps | top phases | gl.upload ms / MB | draw calls |\n|---|---|---:|---:|---:|---:|---:|---|---|---:|';

function summary(dirPath, over, limit = 60) {
  const files = readdirSync(dirPath).filter(f => f.startsWith(`${engine}-`) && f.endsWith('.spots.json'));
  const every = files.flatMap(f => JSON.parse(readFileSync(path.join(dirPath, f), 'utf8')).spots), invalid = every.filter(s => !s.valid);
  const all = every.filter(s => s.valid);
  all.sort((a, b) => b.page.p50 - a.page.p50);
  const maps = new Map();
  for (const s of all) (maps.get(s.map) ?? maps.set(s.map, []).get(s.map)).push(s);
  const perMap = [...maps].map(([map, list]) => {
    const p50 = list.map(s => s.page.p50);
    return `| ${map} | ${list.length} | ${f1(quantile(p50, .5))} | ${f1(Math.max(...p50))} | ${list.filter(s => s.page.p50 > over).length} | ${list.sort((a, b) => b.page.p50 - a.page.p50)[0].top[0]} |`;
  }).sort((a, b) => Number(b.split('|')[4]) - Number(a.split('|')[4]));
  // the frame less the simulation's tick: what the page's own work (actors, drawing, uploads, fog, mirrors, HUD) costs there
  const draw = s => s.page.mean - (s.phases['p.tick'] ?? 0);
  const byDraw = [...all].sort((a, b) => draw(b) - draw(a)).slice(0, Math.min(limit, 25));
  return `Slow spots (${engine}, page p50 over ${over} ms: ${all.filter(s => s.page.p50 > over).length} of ${all.length} valid spots on ${maps.size} maps; ${invalid.length} spots left out: the player was in a conversation or not where placed)\n\n${HEADER}\n${all.slice(0, limit).map(row).join('\n')}\n\n`
    + `Draw side (page mean less p.tick, the 25 largest):\n\n| Map | Location | Yaw | frame mean less tick | page p50 | top phases |\n|---|---|---:|---:|---:|---|\n${byDraw.map(s => `| ${s.map} | ${s.location.map(v => Math.round(v)).join(', ')} | ${s.yaw} | ${f1(draw(s))} | ${f1(s.page.p50)} | ${s.top.join(', ')} |`).join('\n')}\n\n`
    + `| Map | spots | median of p50 | worst p50 | spots over ${over} | worst spot's top phase |\n|---|---:|---:|---:|---:|---|\n${perMap.join('\n')}\n`;
}

if (flag('figures')) {
  // the spots of raw hitch-run.mjs --places runs, one line each (A/B at a spot: pass the runs of the arms)
  for (const file of process.argv.slice(2).filter(a => a.endsWith('.json') && !a.startsWith('--'))) {
    const run = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`${file.split('/').pop()}: ${run.browser} ${run.status?.sim}`);
    for (const s of mapFigures(run)) console.log(`  #${s.index} ${s.location.map(v => Math.round(v)).join(',')} yaw ${s.yaw}: p50 ${f1(s.page.p50)} p95 ${f1(s.page.p95)} max ${f1(s.page.max)} fps ${f1(s.fps)} | ${s.top.join(', ')} | upload ${f1(s.phases['gl.upload'])} ms ${f1(s.phases['gl.uploadMB'])} MB | draws ${f1(s.phases['gl.drawN'])}${s.valid ? '' : ` | INVALID ${s.state}`}`);
  }
  process.exit(0);
}
if (flag('rebuild')) {
  // the per-map <browser>-<map>.spots.json again, from the raw runs hitch-run.mjs saved (<map>.json and a continued session's <map>.s2.json...)
  const byMap = new Map();
  for (const f of readdirSync(dir).filter(f => f.startsWith(`${engine}-`) && f.endsWith('.json') && !/\.(spots|places)\.json$/.test(f))) {
    const map = f.slice(engine.length + 1, -5).replace(/\.s\d+$/, '');
    (byMap.get(map) ?? byMap.set(map, []).get(map)).push(f);
  }
  for (const [map, runs] of byMap) {
    const spots = [];
    let sim = null;
    for (const f of runs.sort()) { const run = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); sim = run.status?.sim; if (run.spots?.length) spots.push(...mapFigures(run, {browser: engine})); }
    if (spots.length) writeFileSync(path.join(dir, `${engine}-${map}.spots.json`), JSON.stringify({map, browser: engine, sim, spots}));
  }
}
if (flag('summary') || flag('rebuild')) {
  const text = summary(dir, Number(option('over', 16.7)), Number(option('rows', 60)));
  console.log(text);
  process.exit(0);
}

mkdirSync(dir, {recursive: true});
const points = Number(option('points', 40)), settle = option('settle', '500'), record = option('record', '750'), zUp = Number(option('z', 8));
const requested = option('maps', 'all'), names = requested === 'all' ? (await mapNames()).filter(n => !SKIP.test(n)) : requested.split(',');
const lock = option('lock', '/home/rydgel/projects/deus_ex_web/.work/heavy.lock'), guard = !flag('no-guard') && process.platform === 'linux';
const stallMs = Number(option('timeout-min', 30)) * 60000;

let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {createServer} = await import('vite');
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, host: '127.0.0.1', fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}

/** The session of one map, as a child in its own process group (killed whole after a stall); resolves with its exit code. */
function session(args) {
  const command = guard ? ['flock', lock, 'systemd-run', '--user', '--scope', '-q', '-p', 'MemoryMax=8G', '-p', 'MemorySwapMax=0', process.execPath, ...args]
    : [process.execPath, ...args];
  const child = spawn(command[0], command.slice(1), {stdio: ['ignore', 'pipe', 'inherit'], detached: true});
  let last = Date.now(), lines = 0, waiting = true;
  child.stdout.on('data', chunk => {
    last = Date.now();
    for (const line of String(chunk).split('\n')) {
      if (!line) continue;
      // (the first line after the lock is taken is the session's own: the wait for the lock is not a stall)
      waiting = false;
      if (!/^spot \d+\/\d+$/.test(line) || ++lines % 20 === 0) console.log(`  ${line}`);
    }
  });
  const timer = setInterval(() => {
    if (!waiting && Date.now() - last > stallMs) { console.error(`  stalled for ${stallMs / 60000} min: killing the session's process group ${child.pid}`); try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
  }, 30000);
  return new Promise(resolve => child.on('exit', code => { clearInterval(timer); resolve(code); }));
}

const failed = [];
try {
  for (const map of names) {
    const all = await navPoints(map);
    if (all.length < 4) { console.log(`${map}: ${all.length} navigation points, skipped`); failed.push({map, why: 'no navigation points'}); continue; }
    const sample = farthestPoints(all, points);
    const places = sample.flatMap(p => YAWS.map(yaw => ({label: p.cls, location: [p.location[0], p.location[1], p.location[2] + zUp], rotation: [0, yaw, 0]})));
    const base = path.join(dir, `${engine}-${map}`), started = Date.now();
    console.log(`${map}: ${all.length} points, ${sample.length} sampled, ${places.length} views (${engine})`);
    // One session per map; when the player dies (the session ends on DXOnly: the Airfield's spot 136), a spot's trigger takes the session to
    // another map, or the simulation stops on an unsupported branch (06_HongKong_Storage: FastLineCheck), the spots after it are visited in a
    // further session (<map>.s2.json...) and the spot itself is left out.
    let remaining = places.map((p, id) => ({...p, id})), spots = [], sim = null, ended = null, sessions = 0;
    while (remaining.length && sessions < 5) {
      const out = sessions++ ? `${base}.s${sessions}` : base, placesFile = `${out}.places.json`;
      writeFileSync(placesFile, JSON.stringify(remaining));
      const args = ['scripts/hitch-run.mjs', '--browser', engine, '--map', map, '--places', placesFile, '--place-settle', settle, '--place-record', record,
        '--url', url, '--out', out, ...(flag('no-god') ? [] : ['--god']), ...(option('query', null) ? ['--query', option('query', null)] : [])];
      const code = await session(args);
      if (code || !existsSync(`${out}.json`)) { console.log(`${map}: failed (exit ${code})`); failed.push({map, why: `exit ${code}`}); break; }
      const run = JSON.parse(readFileSync(`${out}.json`, 'utf8'));
      sim = run.status?.sim; ended = run.ended;
      spots.push(...mapFigures(run, {browser: engine}));
      const last = run.spots?.at(-1);
      if ((String(run.status?.map).toLowerCase() === map.toLowerCase() && !run.ended) || !last) { remaining = []; break; }
      console.log(`${map}: the session ended on ${run.status?.map} (${run.ended ?? 'left the map'}) at spot ${last.id ?? last.i} (${last.player?.state}); the rest follow in another session`);
      remaining = remaining.filter(p => p.id > (last.id ?? last.i));
    }
    if (!spots.length) continue;
    writeFileSync(`${base}.spots.json`, JSON.stringify({map, browser: engine, sim, ended, spots}));
    const valid = spots.filter(x => x.valid), worst = [...valid].sort((a, b) => b.page.p50 - a.page.p50)[0];
    console.log(`${map}: ${valid.length}/${spots.length} valid spots in ${Math.round((Date.now() - started) / 1000)} s, sim ${sim}, worst p50 ${f1(worst?.page.p50)} (${worst?.top.join(', ')}), ended ${ended}`);
  }
} finally { await server?.close(); }
writeFileSync(path.join(dir, `${engine}-summary.md`), summary(dir, 16.7));
if (failed.length) console.log(`not measured: ${failed.map(f => `${f.map} (${f.why})`).join(', ')}`);
console.log(`summary: ${path.join(dir, `${engine}-summary.md`)}`);
