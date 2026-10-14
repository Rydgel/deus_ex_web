#!/usr/bin/env node
// Compare the original's AIPickRandomDestination worker calls (tools/dx-live-win.c `call` breakpoints at the pick worker 0x103c7fc0,
// ULevel::MoveActor 0x103990e0 and FarMoveActor 0x10398ba0: <trace>.calls.jsonl) with Play's nav trace (live-acceptance.mjs play
// --nav-trace A,B --nav-ticks 1:N -> nav-play-<tag>.json), pick by pick (a pawn's nth pick), call by call.
//
//   node scripts/live-pick-compare.mjs --map 02_NYC_Warehouse --tag z1 [--pawn Doberman0] [--verbose]
//
// Per pick: the tick, the pawn, the arguments, the destination of each side, and the first differing call (delta, location after,
// hit time/normal of a MoveActor; destination of a FarMoveActor). Machine output stays under .work/live-acceptance/.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : (argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[i + 1]); };
const map = option('map', null), tag = option('tag', null), only = option('pawn', null), verbose = argv.includes('--verbose');
if (!map || !tag) { console.error('usage: live-pick-compare.mjs --map <map> --tag <tag> [--pawn P] [--verbose]'); process.exit(2); }
const dir = path.join(root, '.work/live-acceptance', map);
const f32 = x => Math.fround(x);
const bits = new DataView(new ArrayBuffer(4));
// Play's JSON keeps no sign of zero, so -0 and +0 are one value here
const word = x => { bits.setFloat32(0, x + 0); return bits.getUint32(0); };
const same = (a, b) => a.length === b.length && a.every((x, i) => word(x) === word(b[i]));
const fmt = v => v && `(${[...v].map(x => +x.toFixed(4)).join(', ')})`;

// the original: group each pick worker call with the calls it encloses
const orig = fs.readFileSync(path.join(dir, `original-trace-${tag}.jsonl.calls.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
const origPicks = [];
let cur = null;
for (const r of orig) {
  if (r.fn === 'aiPickWorker') {
    if (r.ev === 'enter') { cur = {tick: r.u, pawn: r.ecxName, floats: r.floats.slice(0, 8), args: r.args, calls: [], pending: []}; origPicks.push(cur); }
    else if (cur) { cur.found = parseInt(r.eax, 16) & 1; cur.dest = r.deref[0].floats; cur = null; }
  } else if (cur && (r.fn === 'moveActor' || r.fn === 'farMoveActor')) {
    if (r.ev === 'enter') {
      const c = r.fn === 'moveActor'
        ? {fn: 'move', before: r.deref[0].floats, delta: r.floats.slice(1, 4), flags: r.args.slice(8, 12).join(','), seq: r.seq}
        : {fn: 'farmove', before: r.deref[0].floats, dest: r.floats.slice(1, 4), flags: r.args.slice(4, 6).join(','), seq: r.seq};
      cur.calls.push(c); cur.pending.push(c);
    } else {
      const c = cur.pending.pop();
      if (!c) continue;
      c.after = r.deref[0].floats; c.eax = parseInt(r.eax, 16);
      // FCheckResult words: Next, Actor, Location x3, Normal x3, Primitive, Time, Item
      if (r.fn === 'moveActor') { const w = r.deref[1].words, fl = r.deref[1].floats; c.hit = {time: fl[9], normal: fl.slice(5, 8), actor: w[1], item: w[10], name: r.argName}; }
    }
  }
}
// Play: the same grouping from nav-play
const play = JSON.parse(fs.readFileSync(path.join(dir, `nav-play-${tag}.json`), 'utf8')).events;
const playPicks = [];
cur = null;
for (const e of play) {
  if (e.fn === 'aiPick' && e.ev === 'enter') { cur = {tick: e.u, pawn: e.pawn, args: e.target, location: e.location, calls: []}; playPicks.push(cur); }
  else if (e.fn === 'aiPick' && e.ev === 'ret' && cur) { cur.found = e.result ? 1 : 0; cur.dest = e.dest; cur = null; }
  else if (cur && e.ev === 'call' && e.fn === 'move') cur.calls.push({fn: 'move', delta: e.delta, after: e.after, hit: e.ret && typeof e.ret === 'object' ? e.ret : null});
  else if (cur && e.ev === 'call' && e.fn === 'farmove') cur.calls.push({fn: 'farmove', dest: e.dest, after: e.after, flags: `${e.test},${e.noCheck}`});
}

const byPawn = (picks) => { const m = new Map(); for (const p of picks) { if (!m.has(p.pawn)) m.set(p.pawn, []); m.get(p.pawn).push(p); } return m; };
const O = byPawn(origPicks), P = byPawn(playPicks);
let nDiff = 0, nEqual = 0, nMissing = 0;
const report = [];
for (const [pawn, list] of O) {
  if (only && only !== true && pawn !== only) continue;
  const mine = P.get(pawn) ?? [];
  list.forEach((o, n) => {
    const p = mine[n];
    if (!p) { nMissing++; console.log(`${pawn} pick ${n + 1} (original tick ${o.tick}): no Play pick traced`); return; }
    const row = {pawn, n: n + 1, tickOrig: o.tick, tickPlay: p.tick, args: o.floats.map(x => +x.toFixed(4)), calls: [o.calls.length, p.calls.length]};
    let first = null;
    const len = Math.max(o.calls.length, p.calls.length);
    for (let i = 0; i < len && !first; i++) {
      const a = o.calls[i], b = p.calls[i];
      if (!a || !b) { first = {i, why: !a ? 'original has fewer calls' : 'Play has fewer calls', orig: a, play: b}; break; }
      if (a.fn !== b.fn) { first = {i, why: `call kind ${a.fn} against ${b.fn}`, orig: a, play: b}; break; }
      if (a.fn === 'move') {
        if (!same(a.delta, b.delta.map(f32))) first = {i, why: 'delta', orig: a.delta, play: b.delta};
        else if (!same(a.after, b.after.map(f32))) first = {i, why: 'location after the move', orig: a.after, play: b.after, delta: a.delta, before: a.before, hitOrig: a.hit, hitPlay: b.hit};
        else if (b.hit && a.hit && (word(f32(a.hit.time)) !== word(f32(b.hit.time)) || !same(a.hit.normal, b.hit.normal.map(f32)) || (a.hit.name && b.hit.actor !== undefined && (a.hit.name === 'None' ? null : a.hit.name) !== b.hit.actor))) first = {i, why: 'hit', orig: a.hit, play: b.hit};
      } else if (!same(a.dest, b.dest.map(f32))) first = {i, why: 'FarMoveActor destination', orig: a.dest, play: b.dest};
      else if (!same(a.after, b.after.map(f32))) first = {i, why: 'location after FarMoveActor', orig: a.after, play: b.after};
    }
    const destEqual = o.dest && p.dest && same(o.dest, p.dest.map(f32));
    row.found = [o.found, p.found]; row.dest = [o.dest, p.dest];
    if (!first && destEqual) { nEqual++; if (verbose) console.log(`${pawn} #${n + 1} tick ${o.tick}: equal (${o.calls.length} calls) dest ${fmt(o.dest)}`); }
    else {
      nDiff++;
      console.log(`${pawn} #${n + 1} tick ${o.tick}/${p.tick} args ${JSON.stringify(row.args)} found ${o.found}/${p.found}`);
      console.log(`   dest original ${fmt(o.dest)}  Play ${fmt(p.dest)}`);
      if (first) {
        console.log(`   first differing call #${first.i} of ${row.calls.join('/')}: ${first.why}`);
        const show = v => (v === undefined ? 'none' : typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : fmt(v));
        console.log(`      original ${show(first.orig)}${first.before ? '  from ' + fmt(first.before) : ''}${first.delta ? '  delta ' + fmt(first.delta) : ''}`);
        console.log(`      Play     ${show(first.play)}`);
        if (first.hitOrig || first.hitPlay) console.log(`      hit original ${JSON.stringify(first.hitOrig)}  Play ${JSON.stringify(first.hitPlay)}`);
      } else console.log('   all calls equal; the destination differs');
      row.first = first;
    }
    report.push(row);
  });
}
console.log(`${map} ${tag}: ${nEqual} picks equal, ${nDiff} differ, ${nMissing} not traced in Play (${origPicks.length} original picks, ${playPicks.length} Play picks)`);
fs.writeFileSync(path.join(dir, `pick-compare-${tag}.json`), JSON.stringify(report));
