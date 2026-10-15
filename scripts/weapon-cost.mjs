#!/usr/bin/env node
/**
 * What the pawns' third-person weapons cost a drawn frame in Play's default worker mode
 * (docs/weapon-attachment.md "Cost"). Host measurement only. Pairs of runs of the same view, interleaved
 * (default, `?weapons=off`, then the other way round), each a fresh page: the frame phases of
 * deusExViewer.framePhases() (the worker's `w.*` steps and the page's own) as means over the measured frames,
 * the draw interval, and how many weapon bindings were drawn. The report gives the median over the pairs of each
 * run's mean, and the difference of the medians (the weapons' share).
 *
 *   node scripts/weapon-cost.mjs --url http://127.0.0.1:5173 --map 01_NYC_UNATCOIsland
 *     --place '{"location":[x,y,z],"rotation":[pitch,yaw,0]}' [--pairs 5] [--frames 240] [--settle 4000]
 *     [--ghost] [--query meshBackend=cpu] (extra page switches for both sides) [--on weaponGpu=1] [--off weapons=off]
 *     [--angle gl|metal] [--size 1440x960] [--executable /usr/bin/chromium] [--tag name]
 *
 * `--on` and `--off` are the query strings of the two sides (default: none and `weapons=off`), so the same tool
 * compares two weapon paths. The view stays still (no walk): the pawns move and animate, the player does not.
 */
import {chromium} from '@playwright/test';
import {mkdir, writeFile} from 'node:fs/promises';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const url = option('url', 'http://127.0.0.1:5173'), map = option('map', '01_NYC_UNATCOIsland'), pairs = Number(option('pairs', 5));
const frames = Number(option('frames', 240)), settle = Number(option('settle', 4000)), tag = option('tag', 'weapon-cost');
const [width, height] = option('size', '1440x960').split('x').map(Number);
const angle = option('angle', process.platform === 'darwin' ? 'metal' : 'gl');
const place = option('place', null), ghost = process.argv.includes('--ghost');
const sides = {on: option('on', ''), off: option('off', 'weapons=off')};
const median = values => { const sorted = values.toSorted((a, b) => a - b), n = sorted.length; return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2; };

async function measure(browser, query) {
  const page = await browser.newPage({viewport: {width, height}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const target = new URL(url);
    for (const [key, value] of new URLSearchParams(option('query', ''))) target.searchParams.set(key, value);
    for (const [key, value] of new URLSearchParams(query)) target.searchParams.set(key, value);
    await page.goto(target.href);
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 180000});
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 180000});
    await page.waitForFunction(() => window.deusExViewer?.status()?.gameplay?.hud?.health?.head?.displayedHealth === 100, {}, {timeout: 180000});
    await page.locator('#scene').click({position: {x: 600, y: 350}});
    // --ghost: the player floats there (the `ghost` cheat, as the view finder placed it); otherwise he stands where he lands
    if (place && ghost) await page.evaluate(args => window.deusExViewer.viewProbe({ghost: true, playersOnly: false, ...JSON.parse(args)}), place);
    else if (place) await page.evaluate(args => window.deusExViewer.placeProbe(JSON.parse(args)), place);
    await page.waitForTimeout(settle);
    await page.evaluate(() => window.deusExViewer.framePhases(true));
    await page.evaluate(() => window.deusExViewer.lodProbe({list: 'weaponStats', reset: true}));
    const intervals = await page.evaluate(async frames => {
      const samples = [];
      let last = performance.now();
      for (let i = 0; i < frames; i++) {
        const now = await new Promise(requestAnimationFrame);
        samples.push(now - last); last = now;
        if (window.deusExViewer.framePhases(false).runtimeError) break;
      }
      return samples;
    }, frames);
    const totals = await page.evaluate(() => window.deusExViewer.framePhases(true));
    const stats = await page.evaluate(() => window.deusExViewer.lodProbe({list: 'weaponStats'}));
    const states = await page.evaluate(() => window.deusExViewer.lodProbe({list: 'weapons'}));
    const drawn = states.filter(s => s.binding !== null && s.why === null);   // drawn by the last update (`last` keeps the last drawn state)
    const draws = Math.max(1, totals.draws || 1);
    const phases = Object.fromEntries(Object.entries(totals).filter(([key, value]) => typeof value === 'number' && key !== 'frames')
      .map(([key, value]) => [key, value / draws]));
    // the weapon layer's own time on the simulation side (actor-weapon-sim.mjs stats), per worker frame it ran in
    phases['weapons.sim'] = stats.updates ? stats.ms / stats.updates : 0;
    return {query, draws: totals.draws, runtimeError: totals.runtimeError, errors, intervalMedian: median(intervals),
      intervalMean: intervals.reduce((a, b) => a + b, 0) / intervals.length, phases,
      weapons: {armed: states.filter(s => s.weapon).length, drawn: drawn.length, pawns: drawn.map(s => `${s.pawn}/${s.weapon}`)}};
  } finally { await page.close(); }
}

const browser = await chromium.launch({args: [`--use-angle=${angle}`], executablePath: option('executable', undefined)});
const runs = {on: [], off: []};
try {
  for (let pair = 0; pair < pairs; pair++) {
    // alternate which side goes first so a drifting machine does not favour one
    for (const side of pair % 2 ? ['off', 'on'] : ['on', 'off']) {
      const run = await measure(browser, sides[side]);
      runs[side].push(run);
      console.error(`pair ${pair + 1} ${side}: draws ${run.draws}, interval ${run.intervalMedian.toFixed(1)} ms, w.actors ${(run.phases['w.actors'] ?? 0).toFixed(2)}, actors ${(run.phases.actors ?? 0).toFixed(2)}, weapons drawn ${run.weapons.drawn}${run.runtimeError ? `, runtime error ${run.runtimeError}` : ''}`);
    }
  }
} finally { await browser.close(); }

const keys = [...new Set(Object.values(runs).flat().flatMap(run => Object.keys(run.phases)))].filter(key => !/^(draws|gpu|mirrorCalls|skyCalls|mainCalls|hudCalls)/.test(key));
const summary = Object.fromEntries(keys.map(key => {
  const on = median(runs.on.map(run => run.phases[key] ?? 0)), off = median(runs.off.map(run => run.phases[key] ?? 0));
  return [key, {on: +on.toFixed(3), off: +off.toFixed(3), diff: +(on - off).toFixed(3)}];
}).filter(([, row]) => Math.abs(row.on) >= 0.02 || Math.abs(row.off) >= 0.02));
const report = {tag, url, map, place: place ? JSON.parse(place) : null, sides, pairs, frames, size: `${width}x${height}`, angle,
  weaponsDrawn: {on: runs.on.map(run => run.weapons.drawn), off: runs.off.map(run => run.weapons.drawn), pawns: runs.on[0]?.weapons.pawns},
  interval: {on: +median(runs.on.map(run => run.intervalMedian)).toFixed(2), off: +median(runs.off.map(run => run.intervalMedian)).toFixed(2)},
  phasesPerDrawnFrameMs: summary, runs};
await mkdir('.work/weapon/cost', {recursive: true});
await writeFile(`.work/weapon/cost/${tag}.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify({...report, runs: undefined}, null, 1));
if (Object.values(runs).flat().some(run => run.runtimeError || run.errors.length)) process.exitCode = 1;
