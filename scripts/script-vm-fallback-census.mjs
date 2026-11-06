// bench-sim --scenario: what the Rust VM hands back to the JavaScript VM, per tick, the slowest tenth of ticks against the rest
// (docs/firefox-60fps-plan.md "What the Rust VM still hands to JavaScript"). Measurement only.
//
//   SCRIPT_VM_STATS=1 SCRIPT_VM_STATS_TIME=1 SCRIPT_VM_STATS_DETAIL=1 SCAN_WARM=300 SCAN_TICKS=1200 \
//     node scripts/bench-sim.mjs --map 15_Area51_Bunker --warm 300 --ticks 1200 --render-feedback \
//     --scenario scripts/script-vm-fallback-census.mjs
//
// The route is the scan route (the player stands and turns through four headings, .work/perf/scan-scenario.mjs). Each tick's
// game.tick is timed and the interpreter's STATS tables (script-vm-rust.mjs: counts, inclusive and self milliseconds by key) are
// differenced around it. The tick's slowest tenth by wall time and the other nine tenths are averaged per tick by key. A key's self
// time leaves out the timed keys nested inside it: a call node's row is the JavaScript glue of the call, the callee's Rust
// statements are the `wasm <function>` rows, its JavaScript statements `js statement ... (callee)` rows. Rows print to stderr at
// exit; PLACE=json puts the player at a spot first, CENSUS_JSON=file also writes them, CENSUS_ROWS=n sets the row count (default 45), CENSUS_SORT=slow|diff (default diff).
import {writeFileSync} from 'node:fs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import {placeProbe} from '../src/viewer/decal-probe.mjs';

const WARM = Number(process.env.SCAN_WARM ?? 60), TICKS = Number(process.env.SCAN_TICKS ?? 300);
export default ({game, runtime}) => {
  const stats = globalThis.__scriptVmStats;
  if (!stats?.self) throw new Error('script-vm-fallback-census needs SCRIPT_VM_STATS=1 SCRIPT_VM_STATS_TIME=1');
  const fixture = createPlayerInputFixture(game);
  const clock = globalThis.__realNow ?? performance.now.bind(performance);
  const ticks = [];
  let start = null, index = 0;
  const take = () => ({counts: new Map(stats.counts), incl: new Map(stats.times), self: new Map(stats.self)});
  const delta = (a, b) => {
    const rows = new Map();
    for (const [key, n] of b.counts) {
      const c = n - (a.counts.get(key) ?? 0), i = (b.incl.get(key) ?? 0) - (a.incl.get(key) ?? 0), s = (b.self.get(key) ?? 0) - (a.self.get(key) ?? 0);
      if (c || i || s) rows.set(key, [c, i, s]);
    }
    return rows;
  };
  const tick = game.tick.bind(game);
  game.tick = seconds => {
    if (index < WARM) { index++; return tick(seconds); }
    const before = take(), t0 = clock();
    try { return tick(seconds); } finally {
      const ms = clock() - t0;
      ticks.push({ms, rows: delta(before, take())});
      index++;
    }
  };
  process.on('exit', () => {
    if (!ticks.length) return;
    const order = ticks.map((t, i) => i).sort((a, b) => ticks[b].ms - ticks[a].ms);
    const nSlow = Math.max(1, Math.round(ticks.length * 0.1)), slow = new Set(order.slice(0, nSlow));
    const total = {slow: new Map(), rest: new Map()};
    let msSlow = 0, msRest = 0;
    ticks.forEach((t, i) => {
      const group = slow.has(i) ? total.slow : total.rest;
      if (slow.has(i)) msSlow += t.ms; else msRest += t.ms;
      for (const [key, [c, incl, self]] of t.rows) {
        const e = group.get(key) ?? [0, 0, 0];
        e[0] += c; e[1] += incl; e[2] += self;
        group.set(key, e);
      }
    });
    const nRest = ticks.length - nSlow;
    const keys = new Set([...total.slow.keys(), ...total.rest.keys()]);
    const rows = [...keys].map(key => {
      const s = total.slow.get(key) ?? [0, 0, 0], r = total.rest.get(key) ?? [0, 0, 0];
      return {key, slowSelf: s[2] / nSlow, restSelf: r[2] / nRest, slowIncl: s[1] / nSlow, restIncl: r[1] / nRest,
        slowCount: s[0] / nSlow, restCount: r[0] / nRest};
    });
    const sortKey = process.env.CENSUS_SORT === 'slow' ? r => r.slowSelf : r => r.slowSelf - r.restSelf;
    rows.sort((a, b) => sortKey(b) - sortKey(a));
    const f = (n, w = 6) => n.toFixed(3).padStart(w);
    const out = [`fallback census: ${ticks.length} ticks, slowest tenth ${nSlow} at ${(msSlow / nSlow).toFixed(2)} ms against ${(msRest / nRest).toFixed(2)} ms (timing overhead included)`,
      'ms a tick: self slow / rest / diff | inclusive slow / rest | calls a tick slow / rest | key'];
    const top = Number(process.env.CENSUS_ROWS) || 45;
    for (const r of rows.slice(0, top)) out.push(`${f(r.slowSelf)} ${f(r.restSelf)} ${f(r.slowSelf - r.restSelf)} | ${f(r.slowIncl)} ${f(r.restIncl)} | ${r.slowCount.toFixed(2).padStart(7)} ${r.restCount.toFixed(2).padStart(7)} | ${r.key.slice(0, 170)}`);
    console.error(out.join('\n'));
    if (process.env.CENSUS_JSON) writeFileSync(process.env.CENSUS_JSON, JSON.stringify({ticks: ticks.length, nSlow, msSlow, msRest, rows}));
  });
  return tick_ => {
    const player = game.player.collisionActor;
    // PLACE='{"location":[x,y,z],"rotation":[0,yaw,0]}': the player is put there before the first tick (hitch-run.mjs --place), so a
    // spot of the slow-spot census can be read without a browser; the scan route then turns from that heading
    if (tick_ === 0 && process.env.PLACE) placeProbe(game, JSON.parse(process.env.PLACE));
    if (tick_ === 0) { fixture.key('KeyW', false); start = runtime.readNamed(player, 'ViewRotation'); }
    if (tick_ >= WARM && (tick_ - WARM) % Math.floor(TICKS / 4) === 0) {
      const k = Math.min(3, Math.floor((tick_ - WARM) / Math.floor(TICKS / 4)));
      runtime.writeNamed(player, 'ViewRotation', [start[0], (start[1] + k * 10923) % 65536, start[2]]);
    }
  };
};
