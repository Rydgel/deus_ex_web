/** Stage 6, rows 6.4.NN.1 in one batch (docs/stage-6-chains.md "Running"): the original's capture of every mission chain under Wine, one after another (the probe
 * takes the Wine lock), each followed by Play's run against it (scripts/validate-stage6-chain.mjs). A mission whose capture is newer than its chain file and its
 * start save is not captured again, so a batch that stops (the Linux host drops off the network for minutes) resumes where it was.
 *
 *   node scripts/chain-capture-all.mjs [--missions 02,03] [--force] [--compare-only]
 *
 * Each mission's output goes to .work/chains/logs/capture-m<NN>.log and validate-m<NN>.log; the summary (also .work/chains/logs/capture-all.txt) lists each
 * mission's capture and comparison. Over ssh the game needs the session's display: DISPLAY, WAYLAND_DISPLAY and XDG_RUNTIME_DIR default to the desktop's. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { loadChain, captureDirectory, slotDirectory } from './chain-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const missions = option('missions', null)?.split(',')
  ?? readdirSync(`${ROOT}scripts/chains`).map(name => /^mission(\d\d)\.mjs$/.exec(name)?.[1]).filter(Boolean).filter(id => id !== '00' && id !== '01').sort();
const force = process.argv.includes('--force'), compareOnly = process.argv.includes('--compare-only');
const logs = `${ROOT}.work/chains/logs/`;
mkdirSync(logs, { recursive: true });
const env = { ...process.env };
if (process.platform === 'linux') {
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
  env.DISPLAY ??= ':0'; env.WAYLAND_DISPLAY ??= 'wayland-1'; env.XDG_RUNTIME_DIR ??= `/run/user/${uid}`;
}
const mtime = path => { try { return statSync(path).mtimeMs; } catch { return 0; } };
const newest = dir => { try { return Math.max(0, ...readdirSync(dir).map(name => mtime(`${dir}/${name}`))); } catch { return 0; } };
const run = (args, log, minutes) => {
  const fd = openSync(log, 'w');
  try { return spawnSync(process.execPath, ['--max-old-space-size=12288', ...args], { cwd: ROOT, env, stdio: ['ignore', fd, fd], timeout: minutes * 60000 }).status; }
  finally { closeSync(fd); }
};

const summary = [];
for (const mission of missions) {
  const chain = await loadChain(mission);
  const start = chain.steps.find(step => step.op === 'start');
  const result = `${captureDirectory(mission)}result.json`;
  const inputs = Math.max(mtime(`${ROOT}scripts/chains/mission${mission}.mjs`), start?.kind === 'slot' ? newest(slotDirectory(start)) : 0);
  let captured = 'current';
  if (!compareOnly && (force || mtime(result) < inputs)) {
    const status = run(['scripts/chain-original.mjs', '--mission', mission], `${logs}capture-m${mission}.log`, 120);
    captured = status === 0 && mtime(result) >= inputs ? 'captured' : `capture failed (${status})`;
  }
  const compared = existsSync(result) ? (run(['scripts/validate-stage6-chain.mjs', '--mission', mission], `${logs}validate-m${mission}.log`, 60) === 0 ? 'PASS' : 'FAIL') : 'no capture';
  summary.push(`m${mission}: ${captured}, ${compared}`);
  console.log(summary.at(-1));
  writeFileSync(`${logs}capture-all.txt`, `${summary.join('\n')}\n`);
}
