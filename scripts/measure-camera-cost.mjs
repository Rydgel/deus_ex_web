// What the security computer's camera window costs per frame, in worker mode
// (docs/script-window-viewport.md "Camera pass"): the Island's ComputerSecurity1
// as in validate-terminals-camera-browser.mjs, then framePhases() over `--frames`
// drawn frames with the window open. One run measures the tree it lives in
// (or `--root DIR`, another checkout of this repository); alternate runs of two
// trees to compare them, and `--summarize a.json b.json ...` prints the medians
// of the runs that came back:
//
//   node scripts/measure-camera-cost.mjs [--root DIR] [--frames 240] [--out run.json]
//   node scripts/measure-camera-cost.mjs --summarize A1.json A2.json
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const median = values => { const sorted = values.toSorted((a, b) => a - b); return sorted.length ? sorted[sorted.length >> 1] : null; };
if (process.argv.includes('--summarize')) {
  const runs = process.argv.slice(process.argv.indexOf('--summarize') + 1).map(file => JSON.parse(readFileSync(file, 'utf8')));
  const keys = [...new Set(runs.flatMap(run => Object.keys(run.perFrame)))].sort();
  console.log(`${runs.length} runs`);
  for (const key of keys) console.log(`${key.padEnd(14)} ${median(runs.map(run => run.perFrame[key] ?? 0)).toFixed(3)} ms/frame (median of ${runs.length})`);
  process.exit(0);
}
const root = path.resolve(option('root', fileURLToPath(new URL('..', import.meta.url))));
const frameCount = Number(option('frames', 240));
const {default: base} = await import(path.join(root, 'vite.config.mjs'));
// The tree may itself sit in .work/ or .claude/worktrees/, which the config denies.
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
const server = await createServer({...base, configFile: false, root, logLevel: 'error',
  server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const map = '01_NYC_UNATCOIsland';
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let result;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const settled = async () => { await frames(6); await page.evaluate(() => window.deusExViewer.settled()); };
  const probe = args => page.evaluate(args => window.deusExViewer.terminalProbe(args), args);
  const top = async () => (await page.evaluate(() => window.deusExViewer.windowProbe()))?.top ?? null;
  await frames(30);
  await probe({front: 'ComputerSecurity1'}); await frames(60);
  await probe({front: 'ComputerSecurity1'}); await settled();
  const canvas = await page.evaluate(() => { const r = document.getElementById('scene').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  for (let attempt = 0; attempt < 3 && await top() !== 'deusex.networkterminalsecurity'; attempt++) {
    if (attempt) { await probe({front: 'ComputerSecurity1'}); await settled(); }
    await page.mouse.click(canvas[0] + canvas[2] / 2, canvas[1] + canvas[3] / 2, {button: 'right'});
    for (let i = 0; i < 20 && await top() !== 'deusex.networkterminalsecurity'; i++) await settled();
  }
  await page.keyboard.type('NSF001'); await page.keyboard.press('Tab');
  await page.keyboard.type('smashthestate'); await page.keyboard.press('Enter');
  let state = null;
  for (let i = 0; i < 30; i++) { await settled(); state = await probe({}); if (state.viewports.length && state.page.length) break; }
  if (!state.viewports.length) throw new Error('no camera window');
  await frames(60);
  await page.evaluate(() => window.deusExViewer.framePhases(true));
  await frames(frameCount);
  const phases = await page.evaluate(() => window.deusExViewer.framePhases(true));
  const drawn = phases.draws || phases.frames;
  const perFrame = {};
  for (const [key, value] of Object.entries(phases)) if (typeof value === 'number' && /^(w\.|hud$|actors$|mirrors$|render$|worker$|total$|sprites$|fog$|coronas$|lightUpload$|weapon$|ramp$|tick$)/.test(key)) perFrame[key] = value / drawn;
  result = {root, frames: drawn, plans: state.viewports.length, planMs: state.viewports.map(plan => plan.ms), perFrame, pageErrors: errors};
} finally { await browser.close(); await server.close(); }
console.log(JSON.stringify(result));
if (option('out', null)) writeFileSync(option('out', ''), JSON.stringify(result));
