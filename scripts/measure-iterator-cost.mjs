// What the render iterators' per-frame items cost per frame, in worker mode: 09_NYC_Dockyard
// facing the floor mirror its BeamTriggers' beams stand near (validate-iterator-frames-play.mjs'
// first view: a mirror child frame, 78 iterator items), then framePhases() over `--frames` drawn
// frames. One run measures the tree it lives in (or `--root DIR`, another checkout); alternate
// two trees and compare with `measure-camera-cost.mjs --summarize a.json b.json`:
//
//   node scripts/measure-iterator-cost.mjs [--root DIR] [--frames 300] [--out run.json]
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const root = path.resolve(option('root', fileURLToPath(new URL('..', import.meta.url))));
const frameCount = Number(option('frames', 300));
const {default: base} = await import(path.join(root, 'vite.config.mjs'));
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
const server = await createServer({...base, configFile: false, root, logLevel: 'error',
  server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, ''), map = '09_NYC_Dockyard';
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let result;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(debugUrl(`${url}/`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  await page.waitForTimeout(3000);
  await page.evaluate(view => window.deusExViewer.placeProbe(view), {location: [1304, 3212, 72], rotation: [62981, 32768, 0]});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(90);
  await page.evaluate(() => window.deusExViewer.framePhases(true));
  await frames(frameCount);
  const phases = await page.evaluate(() => window.deusExViewer.framePhases(true));
  const drawn = phases.draws || phases.frames, perFrame = {};
  for (const [key, value] of Object.entries(phases)) if (typeof value === 'number' && /^(w\.|hud$|actors$|mirrors$|render$|worker$|total$|sprites$|fog$|tick$)/.test(key)) perFrame[key] = value / drawn;
  result = {root, frames: drawn, perFrame, pageErrors: errors, runtimeError: await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null)};
} finally { await browser.close(); await server.close(); }
console.log(JSON.stringify(result));
if (option('out', null)) writeFileSync(option('out', ''), JSON.stringify(result));
