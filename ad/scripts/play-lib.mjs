// Play under a virtual clock, for the promo's footage: its own Vite server, headless Chromium, `?sim=inline` (the simulation
// frame and the draw both run in the page's requestAnimationFrame, so the clock drives both) and `?music=0` (Galaxy's headless
// mirror library: the clips carry no original music; the promo has its own soundtrack). Each output frame advances Play by
// `sub` equal rAF steps whatever the render speed, so footage is smooth at any resolution.
// The scene helpers are the player's own inputs and the viewer's probes, as in record-clip.mjs.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {debugUrl} from '../../scripts/page-url.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Runs before any page module. Until enable(), frames flow in real time (loading yields through rAF); afterwards only step() runs them.
const clockScript = () => {
  const realRaf = window.requestAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  let manual = false, now = 0, queue = [];
  window.__clock = {
    enable() { manual = true; now = Math.max(now, realNow()); },
    disable() {
      manual = false;
      const callbacks = queue; queue = [];
      for (const callback of callbacks) realRaf(callback);
    },
    get manual() { return manual; },
    step(ms, frames = 1) {
      let ran = 0;
      for (let i = 0; i < frames; i++) {
        now += ms;
        const callbacks = queue; queue = [];
        for (const callback of callbacks) { callback(now); ran++; }
      }
      return ran;
    },
  };
  window.requestAnimationFrame = callback => {
    if (!manual) return realRaf(callback);
    queue.push(callback);
    return queue.length;
  };
  performance.now = () => manual ? now : realNow();
};

export async function openPlay({map, width = 1920, height = 1080, query = '', hud = true} = {}) {
  const {default: config} = await import('../../vite.config.mjs');
  const server = await createServer({...config, configFile: false, root, logLevel: 'error', server: {...config.server, port: 0, strictPort: false, watch: null}});
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch({args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio']});
  const page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); } catch { /* storage unavailable */ } });
  await page.addInitScript(clockScript);
  await page.goto(debugUrl(`${url}/?seed=1&sim=inline&music=0${query}`));
  await page.addStyleTag({content: '#show-ui { display: none !important; }'});
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  if (map) {
    await page.evaluate(map => { const menu = document.getElementById('map'); menu.value = map; menu.dispatchEvent(new Event('change')); }, map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.mode === 'play'; }, map, {timeout: 300000});
  }
  const close = async () => { await browser.close(); await server.close(); };
  return {server, browser, page, errors, close, hud};
}

export const read = (page, names, props) => page.evaluate(([names, props]) => window.deusExViewer.liveProbe({read: {names, props}}), [names, props]).then(r => r.read ?? r);
export const exec = (page, ...lines) => page.evaluate(lines => window.deusExViewer.viewProbe({exec: lines}), lines);
export const place = (page, args) => page.evaluate(args => window.deusExViewer.placeProbe(args), args);
export const conversation = page => page.evaluate(() => window.deusExViewer.conversationProbe({}));
export const enableClock = page => page.evaluate(() => window.__clock.enable());
export const disableClock = page => page.evaluate(() => window.__clock.disable());

/** Advance `frames` output frames of 1/fps each, simulated as `sub` equal rAF steps. Returns the callbacks run. */
export async function step(page, frames = 1, {fps = 30, sub = 2} = {}) {
  let ran = 0;
  for (let i = 0; i < frames; i++) ran += await page.evaluate(([ms, n]) => window.__clock.step(ms, n), [1000 / fps / sub, sub]);
  return ran;
}

export const units = rad => Math.round(rad * 32768 / Math.PI);
export const wrap = v => ((v % 65536) + 65536) % 65536;
export const shortest = (from, to) => { let d = wrap(to - from); if (d > 32768) d -= 65536; return d; };
