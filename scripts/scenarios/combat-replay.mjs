/** A bench-sim scenario (--scenario): places-replay.mjs (the slow-spot census' placements replayed in Node) plus a per-spot report, to see
 * whether the replayed NPC state is the heavy one the census met in a browser (docs/firefox-60fps-plan.md "Combat tick").
 *
 *   PLACES=.cache/perf/spot-census/firefox-02_NYC_Underground.places.json PER=77 TO=105 \
 *     node scripts/bench-sim.mjs --map 02_NYC_Underground --warm 8048 --ticks 300 --idle --render-feedback \
 *       --scenario scripts/scenarios/combat-replay.mjs
 *
 * Takes places-replay's environment. REPORT=1 prints, at exit, one line per spot: the mean wall time of the ticks of its last
 * half (the census' views were measured after a 0.5 s settle), and the scripted pawns by state (state name: count), with the number
 * that have an Enemy. CENSUS=file.spots.json adds the census' p.tick of the same spot for comparison. Host measurement only. */
import {readFileSync} from 'node:fs';
import places from './places-replay.mjs';

export default async function ({game, runtime, assets}) {
  const step = await places({game, runtime, assets});
  const per = Number(process.env.PER ?? 77), first = Number(process.env.START_TICK ?? 30), from = Number(process.env.FROM ?? 0);
  const census = process.env.CENSUS ? JSON.parse(readFileSync(process.env.CENSUS, 'utf8')).spots : null;
  const clock = () => globalThis.__realNow?.() ?? performance.now();
  const rows = new Map();
  let spot = -1, ticks = [];
  const flush = () => {
    if (spot < 0) return;
    const half = ticks.slice(ticks.length >> 1);
    rows.set(spot, {ms: half.reduce((a, b) => a + b, 0) / Math.max(1, half.length), n: ticks.length, states: states()});
    ticks = [];
  };
  const states = () => {
    const counts = new Map();
    let enemies = 0;
    for (const actor of runtime.levelFor(game.player.collisionActor).actors) {
      if (!actor) continue;
      let instance;
      try { instance = runtime.instance(actor); } catch { continue; }
      let pawn = false;
      for (let c = instance.cls; c; c = c.base) if (c.record.key === 'deusex.scriptedpawn') pawn = true;
      if (!pawn) continue;
      const state = instance.state?.stateNode?.record.name ?? 'None';
      counts.set(state, (counts.get(state) ?? 0) + 1);
      try { if (runtime.readNamed(actor, 'Enemy')) enemies++; } catch { /* not readable */ }
    }
    return {counts: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])), enemies};
  };
  const tick = game.tick.bind(game);
  game.tick = (...args) => {
    const start = clock();
    try { return tick(...args); } finally { ticks.push(clock() - start); }
  };
  if (process.env.REPORT) process.on('exit', () => {
    flush();
    for (const [k, row] of rows) {
      const c = census?.[k];
      console.error(`SPOT ${String(k).padStart(3)} node ${row.ms.toFixed(2)} ms${c ? ` census p.tick ${c.phases['p.tick']} (${c.location.map(Math.round)} yaw ${c.yaw})` : ''} enemies ${row.states.enemies} ${JSON.stringify(row.states.counts)}`);
    }
  });
  return index => {
    if (index >= first && (index - first) % per === 0) { flush(); spot = from + (index - first) / per; }
    step(index);
  };
}
