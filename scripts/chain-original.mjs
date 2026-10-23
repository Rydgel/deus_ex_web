/** The original-side driver of the Stage 6 chain harness (docs/stage-6-chains.md): runs a chain (scripts/chains/mission*.mjs) in the original DeusEx.exe under Wine
 * through dxinput's keys and console lines, the same steps chain-play.mjs runs in Play, and writes what the original left (the flags, the travel text each map
 * change exported, the intermediate snapshots) to .work/chains/m<mission>/ (outside Git: the texts carry the game's data).
 *
 * The Wine lock, the launch, the quit and the Save folder's restore are scripts/travel-probe.sh's: this driver starts it in `follow` mode (a file of steps it
 * would read) and sends the steps itself through scripts/travel-step.sh and the dump tools (tools/dump-*.c), reading the game's state between them to know when
 * a step took effect (a conversation's event, a map change, a flag). One DeusEx.exe at a time, machine-wide: the probe waits for the lock.
 *
 *   node scripts/chain-original.mjs --mission 00 [--until <snap label>] [--keep]
 *
 * Needs the worktree's ad/build and ad/tools/dxinput.exe (built once in the main checkout, ignored by Git). */
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { placeLines, flagsOfDump, loadChain, captureDirectory } from './chain-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const env = { ...process.env, WINEPREFIX: process.env.WINEPREFIX ?? `${process.env.HOME}/.wine-deusex`, DX_WINE: process.env.DX_WINE ?? '/usr/bin/wine', DX_DESKTOP: process.env.DX_DESKTOP ?? '1400x860' };
env.DX_GAME = process.env.DX_GAME ?? `${env.WINEPREFIX}/drive_c/Deus Ex GOTY Edition`;
const clean = text => String(text).split('\n').filter(line => !/MESA|pci id/.test(line)).join('\n').replace(/\r/g, '');
const tool = (name, ...args) => {
  try { return clean(execFileSync(env.DX_WINE, [`ad/build/${name}.exe`, ...args], { env, cwd: ROOT, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 27 })); }
  catch (error) { return ''; }
};
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };

export async function runChainInOriginal(chain, { log = console.log, until = null, tag = `chain-m${chain.mission}`, outDir = captureDirectory(chain.mission) } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const followFile = `${outDir}follow.txt`;
  writeFileSync(followFile, '');
  const probeOut = `${ROOT}/.work/travel/${tag}`;
  rmSync(probeOut, { recursive: true, force: true });
  const probeEnv = { ...env, DX_SAVE_BACKUP: `${ROOT}/.work/save-backup-${tag}`, ...(chain.userSet ? { DX_USER_SET: chain.userSet } : {}) };
  const probeLog = `${outDir}probe.log`;
  const probe = spawn('scripts/travel-probe.sh', [tag, `follow:${followFile}`], { cwd: ROOT, env: probeEnv, stdio: ['ignore', openLog(probeLog), openLog(probeLog)] });
  let probeExited = false;
  probe.on('exit', () => { probeExited = true; });
  const quit = async () => {
    if (!probeExited) { appendFileSync(followFile, 'quit\n'); for (let i = 0; i < 60 && !probeExited; i++) await sleep(1000); }
    if (!probeExited) probe.kill('SIGTERM');   // the probe this driver started (its trap quits the game)
  };
  process.on('SIGINT', () => { quit().then(() => process.exit(130)); });

  const result = { mission: chain.mission, snaps: {}, legs: [], steps: [], conversations: [], raw: {} };
  const note = text => { result.steps.push(text); log(text); };
  const step = (verb, ...args) => execFileSync('scripts/travel-step.sh', [probeOut, verb, ...args], { env, cwd: ROOT, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });

  /** The controlled player: the JCDentonMale whose Player (viewport) is set, with its level object. */
  const controlled = () => {
    for (const line of tool('dump-actor-win', 'JCDentonMale', 'Player:0x5d4:u32', 'XLevel:0xac:u32').split('\n')) {
      const m = /^JCDentonMale (JCDentonMale\d+) Player=0x([0-9a-f]+) XLevel=0x([0-9a-f]+)/.exec(line);
      if (m && parseInt(m[2], 16)) return { name: m[1], level: parseInt(m[3], 16) };
    }
    return null;
  };
  /** The level object a player stands in: its URL.Map and the TravelInfo text it kept. */
  const levelOf = pointer => {
    const dump = tool('dump-travel-win');
    for (const block of dump.split(/^(?=Level )/m)) {
      const header = /^Level \S+ slot \d+ at 0x([0-9a-f]+)/.exec(block);
      if (!header || parseInt(header[1], 16) !== pointer) continue;
      const map = /^ {2}URL\.Map: (.*)$/m.exec(block)?.[1] ?? null;
      const start = block.split('\n').findIndex(line => /^ {2}\[\d+\] value:$/.test(line));
      let text = null;
      if (start >= 0) { const lines = block.split('\n').slice(start + 1); const end = lines.findIndex(line => /^ {2}\[\d+\] end$/.test(line)); text = lines.slice(0, end < 0 ? undefined : end).join('\r\n'); }
      return { map, text, dump: block };
    }
    return null;
  };
  const flagsNow = () => { const p = controlled(); if (!p) return null; const raw = tool('dump-flags-win', p.name); return { raw, ...flagsOfDump(raw) }; };
  const where = () => { const p = controlled(); return p ? { ...p, ...(levelOf(p.level) ?? {}) } : null; };
  const hasFlag = (flags, name) => flags.flags.some(f => f.toLowerCase().startsWith(`${name.toLowerCase()}|`));
  const locationOf = () => {
    const p = controlled(); if (!p) return null;
    const line = tool('dump-actor-win', p.name, 'Location:0x114:f3', 'Physics:0x30:u8').split('\n').find(row => row.startsWith(`JCDentonMale ${p.name} `));
    const m = line && /Location=\(([^,]+),([^,]+),([^)]+)\) Physics=(\d+)/.exec(line);
    return m ? { at: [Number(m[1]), Number(m[2]), Number(m[3])], physics: Number(m[4]) } : null;
  };
  const type = async (line, settle = 700) => { step('cmd', line); await sleep(settle); };
  const press = async name => { step('key', name); };
  let current = null;   // { name, level, map }
  const refresh = () => { const w = where(); if (w) current = w; return w; };
  const waitArrival = async (previous, seconds = 150) => {
    for (let i = 0; i < seconds / 2; i++) {
      const p = controlled();
      if (p && p.level !== previous.level) {
        await sleep(3000);
        const w = where();
        if (w?.map) return w;
      }
      await sleep(1000);
    }
    throw new Error(`no arrival after ${seconds}s (the level is still ${previous.map})`);
  };

  const ops = {
    async start(s) {
      for (let i = 0; i < 90 && !(controlled()); i++) await sleep(2000);
      const first = where();
      if (!first?.map) throw new Error('the game did not come up (or tools/dump-travel-win.c is not built into ad/build: i686-w64-mingw32-gcc -O2 -o ad/build/dump-travel-win.exe tools/dump-travel-win.c -lpsapi)');
      current = first;
      if (s.kind === 'menu-training') {
        step('click', '640 360'); await sleep(800);
        step('click', '641 340');
        const arrived = await waitArrival(first);
        result.legs.push({ label: 'start', from: first.map, to: arrived.map, text: arrived.text });
        current = arrived;
        note(`start menu-training: in ${arrived.map}`);
      } else throw new Error(`start ${s.kind} (not written yet)`);
    },
    async wait(s) {
      if (s.seconds !== undefined) { await sleep(s.seconds * 1000); note(`wait ${s.seconds}s`); return; }
      const limit = (s.timeout ?? 120) / 2;
      for (let i = 0; i < limit; i++) {
        const f = flagsNow();
        if (f && ((s.flag && hasFlag(f, s.flag)) || (s.notFlag && !hasFlag(f, s.notFlag)))) { note(`wait ${JSON.stringify(s)}`); return; }
        await sleep(2000);
      }
      throw new Error(`wait ${JSON.stringify(s)}: timed out`);
    },
    async line(s) { await type(s.text); note(`line ${s.text}`); },
    async place(s) {
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines(s)]) await type(line, 500);
        if (s.drop) { note(`place ${s.at.join(',')} (${s.harness ? 'harness' : 'player'}): dropped`); return; }
        await sleep((s.settle ?? 1) * 1000 + 800);
        const here = locationOf();
        if (here && Math.hypot(here.at[0] - s.at[0], here.at[1] - s.at[1]) < 25) { note(`place ${s.at.join(',')} (${s.harness ? 'harness' : 'player'}): the player is at ${here.at.map(v => Math.round(v * 10) / 10)}`); return; }
        note(`place attempt ${attempt + 1}: the player is at ${JSON.stringify(here)}`);
      }
      throw new Error(`place ${s.at}: the player never arrived`);
    },
    async frob() { await type('ParseRightClick', 900); await sleep(600); note('frob'); },
    async click() { await press('ENTER'); note('click'); },
    async belt(s) { await type(`ActivateBelt ${s.n}`, 900); await sleep(1000); note(`belt ${s.n}`); },
    async key(s) { for (const name of s.names) { await press(name); } note(`key ${s.names.join(' ')}`); },
    async walk(s) { step('hold', s.key ?? 'UP', String(Math.round(s.seconds * 1000))); note(`walk ${s.key ?? 'UP'} ${s.seconds}s`); },
    async conv(s) { throw new Error('conv: not written yet'); },
    async travel(s) {
      const arrived = await waitArrival(current);
      if (s.to && arrived.map.toLowerCase().replace(/\.dx$/, '') !== s.to.toLowerCase().replace(/\.dx$/, '')) note(`travel: arrived in ${arrived.map} (the chain says ${s.to})`);
      result.legs.push({ label: s.label ?? `to-${s.to}`, from: current.map, to: arrived.map, text: arrived.text });
      note(`leg ${s.label}: ${current.map} -> ${arrived.map}, ${arrived.text?.length ?? 0} bytes`);
      current = arrived;
      await sleep((s.settle ?? 2) * 1000);
    },
    async snap(s) {
      const f = flagsNow();
      if (!f) throw new Error('snap: no controlled player');
      const w = where();
      result.snaps[s.label] = { map: w?.map, flags: f.flags, defaultExpiration: f.defaultExpiration };
      writeFileSync(`${outDir}${s.label}.flags.txt`, f.raw);
      if (w?.text) writeFileSync(`${outDir}${s.label}.travel.txt`, w.text);
      step('snap', s.label);
      note(`snap ${s.label}: ${w?.map}, ${f.flags.length} flags`);
    },
  };

  try {
    for (const s of chain.steps) {
      if (!ops[s.op]) throw new Error(`unknown op ${s.op}`);
      try { await ops[s.op](s); } catch (error) { error.message = `step ${result.steps.length + 1} (${JSON.stringify(s)}): ${error.message}`; throw error; }
      if (until && s.op === 'snap' && s.label === until) break;
    }
    // the exit's own snapshot is the last leg's arrival text (already in result.legs)
    delete result.raw;
    writeFileSync(`${outDir}result.json`, JSON.stringify(result, null, 1));
    return result;
  } finally {
    await quit();
  }
}

function openLog(path) { return openSync(path, 'a'); }

if (import.meta.url === `file://${process.argv[1]}`) {
  const chain = await loadChain(option('mission', '00'));
  const result = await runChainInOriginal(chain, { until: option('until', null) });
  console.log(`done: ${result.legs.length} legs, ${Object.keys(result.snaps).length} snaps`);
  process.exit(0);
}
