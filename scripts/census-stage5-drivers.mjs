/** The drivers of scripts/census-stage5.mjs: one session per map (Play's createGame, the sim-session frame, the player-input fixture) and one driver per scenario.
 * A driver returns {ok, effect}: `ok` is the effect the original defines, `effect` the numbers behind it. It throws Undriven(reason) when it cannot start. */
import {spawn, execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Level time, not wall time: the scheduler and every timer follow the frames below (the alterations census's deterministic clock).
let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', {value: () => simulatedMs, configurable: true});

export class Undriven extends Error {}
const PI = Math.PI;
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Scenarios that run an existing Play validator unchanged (the Stage 3 and 4 practice): the validator passing is the scenario playing. */
const DELEGATES = {
  'crowbar-crate': 'validate-crowbar-crate.mjs', 'ladder': 'validate-training-ladder.mjs', 'instructor-take': 'validate-instructor-conversation.mjs',
  'meet-paul': 'validate-island-conversation.mjs', 'overheard-barks': 'validate-island-bark.mjs',
};

async function delegate(file) {
  const proc = spawn(process.execPath, ['--max-old-space-size=6144', path.join(root, 'scripts', file)], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', peak = 0;
  proc.stdout.on('data', d => { out += d; }); proc.stderr.on('data', d => { out += d; });
  const watch = setInterval(() => {
    try { const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(proc.pid)], {encoding: 'utf8'})) / 1024; peak = Math.max(peak, rss); if (rss > 6144) proc.kill('SIGKILL'); } catch { /* gone */ }
  }, 500);
  const timer = setTimeout(() => proc.kill('SIGKILL'), 20 * 60 * 1000);
  const code = await new Promise(resolve => proc.on('exit', resolve));
  clearInterval(watch); clearTimeout(timer);
  const lines = out.trim().split('\n');
  if (code === 0) return {status: 'plays', effect: {delegate: file, peakMiB: Math.round(peak), last: lines.at(-1).slice(0, 160)}};
  return {status: 'pause', message: `${file}: ${(lines.filter(l => /error|assert|not|unsupported/i.test(l)).at(0) ?? lines.at(-1)).slice(0, 200)}`};
}

export async function runScenarios(map, ids) {
  const results = {};
  const {gameDirectory} = await import('./game-directory.mjs');
  const gameRoot = gameDirectory();
  const {AssetStore} = await import('../src/unreal/assets.mjs');
  const files = [];
  for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const name of await readdir(`${gameRoot}/${directory}`)) files.push({path: `${directory}/${name}`, read: () => readFile(`${gameRoot}/${directory}/${name}`)});
  const assets = new AssetStore(files);
  const {DRIVERS, openSession} = await import('./census-stage5-session.mjs');
  await import('./census-stage5-island.mjs');
  let session = null;
  for (const id of ids) {
    if (DELEGATES[id]) { results[id] = await delegate(DELEGATES[id]); console.log(`${id} ${results[id].status}`); continue; }
    if (id === 'phase1-route') {
      const {runTrainingProbes} = await import('./training-probe-lib.mjs');
      const run = await runTrainingProbes({groups: ['route'], continueMode: false});
      const probe = run.probes.find(p => p.group === 'route');
      results[id] = !probe || probe.error || run.bootError ? {status: 'pause', message: String(probe?.error ?? run.bootError ?? 'no route probe')}
        : {status: 'plays', effect: {route: probe.label, ms: probe.ms}};
      console.log(`${id} ${results[id].status}`); continue;
    }
    const driver = DRIVERS[id];
    if (!driver) { results[id] = {status: 'undriven', message: 'no driver'}; continue; }
    session ??= await openSession(map, assets);
    const outcome = results[id] = await session.run(id, driver);
    console.log(`${id} ${outcome.status}${outcome.message ? ` ${outcome.message.slice(0, 120)}` : ''}`);
    if (outcome.status === 'pause' || outcome.status === 'driver-error') session = null;
  }
  return results;
}

export {Undriven as UndrivenError, near, PI, simulatedMsAdvance};
function simulatedMsAdvance(ms) { simulatedMs += ms; }
