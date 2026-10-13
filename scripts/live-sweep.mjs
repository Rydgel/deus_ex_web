// A live sweep over many maps (docs/visual-acceptance.md "Sweep"): each map's start pose, no placement, the original traced for N ticks
// (one at a time through scripts/live-original.sh, under the Wine lock) and Play replayed on that trace with every measured host input
// (delta, rand state, viewport size, strobe, generator state, population match), then compared per actor and field.
//
//   node scripts/live-sweep.mjs run --maps a,b,c [--ticks 1200] [--max-seconds 300] [--seed 1] [--tag sweep] [--out .work/live-acceptance/sweep.json] [--force]
//        [--allow-missing generators]   # go on when the only actors Play's load lacks are generators (chosen by chance at each load); they are not watched
//   node scripts/live-sweep.mjs report [--out ...]      # the table, the ranked groups and the skipped maps, as markdown on stdout
//
// Pipeline: Play's population probe of map k+1 and Play's replay of map k run in Chromium while the original runs map k+1 (one Wine
// game, one headless browser at a time). A map whose original does not load, never matches Play's population, crashes or yields too
// few ticks is skipped with the reason; one whose Play replay fails is recorded with the error (a finding, not a skip). `--max-seconds`
// cuts a slow map's ticks (the tracer's `max-seconds`) instead of stalling the sweep. Results accumulate in the JSON (a finished map is
// not repeated without --force).
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(`--${name}`);
const verb = process.argv[2];
const outPath = path.resolve(root, option('out', '.work/live-acceptance/sweep.json'));
const tag = option('tag', 'sweep'), ticks = Number(option('ticks', 1200)), maxSeconds = Number(option('max-seconds', 300)), seed = option('seed', '1');
const mapDir = map => path.join(root, '.work/live-acceptance', map);
const load = () => existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {version: 1, ticks, maps: {}};
const save = data => { mkdirSync(path.dirname(outPath), {recursive: true}); writeFileSync(outPath, JSON.stringify(data, null, 1)); };
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

// A child process to completion, its output appended to a log file; `timeoutMs` stops it (TERM, then the sweep gives up on it).
function run(command, args, {logFile, timeoutMs = 0, env = process.env} = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let out = '', timer = null, timedOut = false;
    const take = d => { out += d; if (out.length > 4e6) out = out.slice(-2e6); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      if (logFile) writeFileSync(logFile, `$ ${command} ${args.join(' ')}\n${out}\nexit ${code}${timedOut ? ' (timed out)' : ''}\n`);
      resolve({code, out, timedOut});
    });
  });
}
class Lock { // an async mutex: Play's browser work, one job at a time
  constructor() { this.tail = Promise.resolve(); }
  with(job) { const next = this.tail.then(job, job); this.tail = next.catch(() => {}); return next; }
}
const playLock = new Lock();
const node = (args, opts) => run('node', args, opts);

async function population(map) {
  return playLock.with(() => node(['scripts/live-acceptance.mjs', 'population', '--map', map, '--seed', seed], {logFile: path.join(mapDir(map), 'sweep-population.log'), timeoutMs: 20 * 60e3}));
}

async function original(map) {
  mkdirSync(mapDir(map), {recursive: true});
  const logFile = path.join(mapDir(map), 'sweep-original.log');
  const result = await run('bash', ['scripts/live-original.sh', map, '--ticks', String(ticks), '--delta', '0.0166666675', '--monitor', '20', '--max-seconds', String(maxSeconds), '--tag', tag, ...(option('allow-missing', null) ? ['--allow-missing', option('allow-missing')] : [])],
    {logFile, timeoutMs: 90 * 60e3});
  return result;
}

async function replayAndCompare(map) {
  const dir = mapDir(map);
  const play = await playLock.with(() => node(['scripts/live-acceptance.mjs', 'play', '--map', map, '--seed', seed, '--tag', tag], {logFile: path.join(dir, 'sweep-play.log'), timeoutMs: 40 * 60e3}));
  if (play.code !== 0) return {error: (play.out.split('\n').filter(l => /rror|Error|stopped|no actor/.test(l)).slice(-3).join(' | ') || `play exit ${play.code}`).slice(0, 400), timedOut: play.timedOut};
  const cmp = await node(['scripts/live-acceptance.mjs', 'compare', '--map', map, '--tag', tag], {logFile: path.join(dir, 'sweep-compare.log')});
  if (cmp.code !== 0) return {error: `compare exit ${cmp.code}: ${cmp.out.slice(-200)}`};
  return {ok: true};
}

// The original's State at a tick, for grouping (the trace rows are large: one pass, keeping the ticks asked for).
async function stateAt(tracePath, wanted) { // wanted: Map(tick -> Set(actor))
  const found = new Map();
  if (!wanted.size) return found;
  const rl = createInterface({input: createReadStream(tracePath), crlfDelay: Infinity});
  let n = 0;
  for await (const line of rl) {
    n++;
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const tick = row.unfrozen;
    if (!tick || !wanted.has(tick)) continue;
    for (const name of wanted.get(tick)) { const a = row.actors?.[name]; if (a) found.set(`${tick}:${name}`, {state: String(a.State ?? '').split('|')[0], order: a.Order ?? null, anim: a.Anim ?? null, phys: a.Phys ?? null}); }
  }
  return found;
}

async function summarise(map) {
  const dir = mapDir(map);
  const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
  const watch = JSON.parse(readFileSync(path.join(dir, 'watch.json'), 'utf8'));
  const tracePath = path.join(dir, `original-trace-${tag}.jsonl`);
  const labelsOrder = ['Loc', 'Rot', 'Vel', 'Acc', 'Phys', 'State', 'Anim', 'Frame', 'Rate', 'Tween', 'Dest', 'MoveT', 'MoveTgt', 'Order'];
  const entries = Object.entries(report.actors);
  const diverging = [];
  const wanted = new Map();
  for (const [name, entry] of entries) {
    if (entry.firstDifference === null) continue;
    const fields = Object.entries(entry.fields).map(([label, f]) => ({label, tick: f.tick, original: f.original, play: f.play, count: f.count}))
      .sort((a, b) => a.tick - b.tick || ((labelsOrder.indexOf(a.label) + 99) % 99) - ((labelsOrder.indexOf(b.label) + 99) % 99));
    diverging.push({actor: name, class: name === '@player' ? 'Player' : watch.classes?.[name] ?? (watch.generators?.includes(name) ? 'PawnGenerator' : '?'),
      firstTick: entry.firstDifference, field: fields[0].label, original: fields[0].original, play: fields[0].play, fields: fields.slice(0, 6)});
    if (!wanted.has(entry.firstDifference)) wanted.set(entry.firstDifference, new Set());
    wanted.get(entry.firstDifference).add(name);
  }
  const states = existsSync(tracePath) ? await stateAt(tracePath, wanted) : new Map();
  for (const d of diverging) Object.assign(d, states.get(`${d.firstTick}:${d.actor}`) ?? {});
  diverging.sort((a, b) => a.firstTick - b.firstTick);
  return {notInPlay: watch.notInPlay ?? [], watched: entries.length, equal: entries.filter(([, e]) => e.firstDifference === null).length, ticks: report.ticks, diverging,
    rngFirstDifference: report.rng?.firstTickWithDifferentDrawCount ? report.rng.firstTickWithDifferentDrawCount.tick : null,
    clockEqual: !report.clock?.firstDifference, strobe: report.strobe ?? null};
}

async function runSweep() {
  const maps = (option('maps', '') || '').split(',').filter(Boolean);
  if (!maps.length) { console.error('usage: live-sweep.mjs run --maps a,b,c'); process.exit(2); }
  const data = load();
  data.ticks = ticks; data.maxSeconds = maxSeconds;
  const todo = maps.filter(m => flag('force') || data.maps[m]?.status !== 'ok' && data.maps[m]?.status !== 'skipped');
  log(`${todo.length} maps to run (${maps.length - todo.length} already done): ${todo.join(' ')}`);
  let nextPopulation = todo.length ? population(todo[0]) : Promise.resolve();
  let replayChain = Promise.resolve();
  for (let i = 0; i < todo.length; i++) {
    const map = todo[i];
    await nextPopulation;
    nextPopulation = i + 1 < todo.length ? population(todo[i + 1]) : Promise.resolve();
    log(`${map}: original (${ticks} ticks, at most ${maxSeconds} s)`);
    // The original of this map, then (overlapped with the next map's original) its replay and comparison.
    const entry = data.maps[map] = {map};
    const dir = mapDir(map), trace = path.join(dir, `original-trace-${tag}.jsonl`);
    mkdirSync(dir, {recursive: true});
    const t0 = Date.now();
    const orig = await original(map);
    const rows = existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean).length : 0;
    entry.originalSeconds = Math.round((Date.now() - t0) / 1000); entry.originalRows = rows;
    const crash = `${trace}.crash.txt`;
    let skip = null;
    if (existsSync(crash)) skip = `the original crashed: ${readFileSync(crash, 'utf8').split('\n').slice(0, 3).join(' ').slice(0, 200)}`;
    else if (orig.timedOut) skip = 'the original run did not finish in 90 minutes (the lock wait included)';
    else if (orig.code === 3) skip = "the original's load never matched Play's population in 4 loads";
    else if (orig.code !== 0 || rows < 60) skip = `the original run failed (exit ${orig.code}, ${rows} trace rows): ${orig.out.split('\n').filter(l => /rror|cannot|not running|failed/i.test(l)).slice(-2).join(' | ').slice(0, 250)}`;
    if (skip) { entry.status = 'skipped'; entry.reason = skip; save(data); log(`${map}: SKIPPED, ${skip}`); if (orig.timedOut) { await new Promise(r => setTimeout(r, 30000)); try { execFileSync('pgrep', ['-x', 'DeusEx.exe']); log('stopping: a DeusEx.exe is still running'); process.exit(4); } catch { /* none: go on */ } } continue; }
    log(`${map}: original done in ${entry.originalSeconds} s, ${rows} rows; replay queued`);
    save(data);
    replayChain = replayChain.then(async () => {
      log(`${map}: replay`);
      const cmp = await replayAndCompare(map);
      if (cmp.error) { entry.status = 'play-error'; entry.reason = cmp.error; log(`${map}: PLAY ERROR ${cmp.error}`); }
      else { Object.assign(entry, await summarise(map), {status: 'ok'}); log(`${map}: ${entry.equal}/${entry.watched} equal over ${entry.ticks} ticks, ${entry.diverging.length} diverging`); }
      save(data);
    });
  }
  await replayChain;
  log('sweep finished');
}

// --- the report ----------------------------------------------------------------------------------------------------------------------
function groups(list, key) {
  const by = new Map();
  for (const item of list) { const k = key(item); if (!by.has(k)) by.set(k, []); by.get(k).push(item); }
  return [...by.entries()].map(([k, items]) => ({key: k, actors: items.length, maps: new Set(items.map(i => i.map)).size, items}))
    .sort((a, b) => b.maps - a.maps || b.actors - a.actors);
}
function report() {
  const data = load();
  const maps = Object.values(data.maps), ok = maps.filter(m => m.status === 'ok');
  const out = [];
  out.push('| map | watched | equal | ticks | absent in Play | diverging (first tick, class: field) |', '| --- | ---: | ---: | ---: | --- | --- |');
  for (const m of maps.sort((a, b) => a.map.localeCompare(b.map))) {
    if (m.status !== 'ok') { out.push(`| ${m.map} | | | | | **${m.status}**: ${String(m.reason ?? '').replace(/\|/g, '/')} |`); continue; }
    const list = m.diverging.slice(0, 3).map(d => `${d.actor} ${d.firstTick} ${d.class}: ${d.field}`).join('; ');
    const absent = (m.notInPlay ?? []).length ? m.notInPlay.slice(0, 3).join(' ') + (m.notInPlay.length > 3 ? ` +${m.notInPlay.length - 3}` : '') : '';
    out.push(`| ${m.map} | ${m.watched} | ${m.equal} | ${m.ticks} | ${absent} | ${m.diverging.length ? `${m.diverging.length}: ${list}${m.diverging.length > 3 ? '; ...' : ''}` : 'none'} |`);
  }
  const all = ok.flatMap(m => m.diverging.map(d => ({...d, map: m.map})));
  const total = ok.reduce((n, m) => n + m.watched, 0), equal = ok.reduce((n, m) => n + m.equal, 0);
  out.push('', `${ok.length} maps compared, ${equal} of ${total} watched actors equal over their ticks, ${all.length} diverging.`, '');
  const show = (title, list, key, describe) => {
    out.push(`**${title}**`, '', '| group | actors | maps | earliest example |', '| --- | ---: | ---: | --- |');
    for (const g of groups(list, key).slice(0, 12)) {
      const e = g.items.slice().sort((a, b) => a.firstTick - b.firstTick)[0];
      out.push(`| ${g.key} | ${g.actors} | ${g.maps} | ${describe(e)} |`);
    }
    out.push('');
  };
  const ex = e => `${e.map} ${e.actor} tick ${e.firstTick}: ${e.field} ${fmt(e.original)} vs ${fmt(e.play)}`;
  show('By first differing field', all, d => d.field, ex);
  show('By class', all, d => d.class, ex);
  show('By state of the actor at its first differing tick (the original)', all, d => d.state || '?', ex);
  show('By class and field', all, d => `${d.class}: ${d.field}`, ex);
  show('By state and field', all, d => `${d.state || '?'}: ${d.field}`, ex);
  console.log(out.join('\n'));
  const ranked = {byField: groups(all, d => d.field), byClass: groups(all, d => d.class), byState: groups(all, d => d.state || '?'), byClassField: groups(all, d => `${d.class}: ${d.field}`), byStateField: groups(all, d => `${d.state || '?'}: ${d.field}`)};
  // --json <file>: the per-map results and the automatic groups (a compact copy of the sweep, for the docs)
  const jsonOut = option('json', null);
  if (jsonOut) {
    const trim = d => ({actor: d.actor, class: d.class, firstTick: d.firstTick, field: d.field, original: d.original, play: d.play, state: d.state ?? null, order: d.order ?? null});
    writeFileSync(path.resolve(root, jsonOut), JSON.stringify({ticks: data.ticks, maxSeconds: data.maxSeconds,
      maps: Object.fromEntries(Object.values(data.maps).sort((a, b) => a.map.localeCompare(b.map)).map(m => [m.map, m.status === 'ok'
        ? {status: m.status, watched: m.watched, equal: m.equal, ticks: m.ticks, notInPlay: m.notInPlay ?? [], originalSeconds: m.originalSeconds, rngFirstDifference: m.rngFirstDifference, diverging: m.diverging.map(trim)}
        : {status: m.status, reason: m.reason}])),
      groups: Object.fromEntries(Object.entries(ranked).map(([k, v]) => [k, v.map(g => ({key: g.key, actors: g.actors, maps: g.maps}))]))}, null, 1) + '\n');
  }
  const slim = list => list.map(g => ({key: g.key, actors: g.actors, maps: g.maps, examples: g.items.slice().sort((a, b) => a.firstTick - b.firstTick).slice(0, 3).map(i => ({map: i.map, actor: i.actor, tick: i.firstTick, field: i.field, original: i.original, play: i.play}))}));
  writeFileSync(outPath.replace(/\.json$/, '-ranked.json'), JSON.stringify(Object.fromEntries(Object.entries(ranked).map(([k, v]) => [k, slim(v)])), null, 1));
}
const fmt = v => Array.isArray(v) ? `(${v.map(fmt).join(', ')})` : typeof v === 'number' ? String(+v.toPrecision(7)) : String(v);

if (verb === 'run') await runSweep();
else if (verb === 'report') report();
else console.log('usage: live-sweep.mjs run --maps a,b | report');
