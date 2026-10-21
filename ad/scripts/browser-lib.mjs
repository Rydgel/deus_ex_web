// Headless capture of the browser runtime (the dev server on 127.0.0.1:5173).
// A virtual clock replaces requestAnimationFrame/performance.now so each
// captured frame advances Play by an exact step regardless of how fast
// headless WebGL renders: footage is smooth even at a few real fps.
import {chromium} from 'playwright';
import { debugUrl } from '../../scripts/page-url.mjs';

export const URL = process.env.DX_VIEWER_URL || 'http://127.0.0.1:5173/';

// Runs in the page before any viewer module. Until enable(), frames flow in
// real time (loading uses timers and rAF); afterwards only step() runs them.
const clockScript = () => {
  const realRaf = window.requestAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  let manual = false, now = 0, queue = [];
  window.__clock = {
    enable() { manual = true; now = Math.max(now, realNow()); },
    // Back to real time (map loading yields through rAF); queued frames resume.
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

// Hides the viewer chrome so #scene fills the window at exactly width x height.
const chromeCss = `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; }`;

// onlyMap: boot straight into one map by hiding the other maps from the dev
// server's game manifest (the viewer opens 00_Training, else the first map).
export async function openViewer({width = 1920, height = 1080, args = [], onlyMap = null} = {}) {
  const browser = await chromium.launch({args: ['--autoplay-policy=no-user-gesture-required', ...args]});
  const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1});
  await context.addInitScript(clockScript);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (onlyMap) await page.route('**/__game__/manifest', async route => {
    const response = await route.fetch();
    const manifest = await response.json();
    const keep = path => !/\.(dx|unr)$/i.test(path) || path.replace(/^.*[\\/]/, '').toLowerCase() === `${onlyMap.toLowerCase()}.dx`;
    manifest.files = manifest.files.filter(keep);
    await route.fulfill({response, json: manifest});
  });
  await page.goto(debugUrl(URL));
  await page.addStyleTag({content: chromeCss});
  await page.waitForFunction(() => window.deusExViewer?.status().ready, null, {timeout: 240000});
  return {browser, context, page, errors};
}

export async function enableClock(page) {
  await page.evaluate(() => window.__clock.enable());
}

// Advances `frames` output frames of 1/fps each, simulated as `sub` equal rAF steps.
export async function step(page, frames = 1, {fps = 30, sub = 2} = {}) {
  for (let i = 0; i < frames; i++) await page.evaluate(([ms, n]) => window.__clock.step(ms, n), [1000 / fps / sub, sub]);
}

export async function shot(page, path, {type = 'png', quality} = {}) {
  const box = await page.locator('#scene').boundingBox();
  return page.screenshot({path, type, quality, clip: {x: box.x, y: box.y, width: Math.round(box.width), height: Math.round(box.height)}});
}

export const status = page => page.evaluate(() => {
  try {
    const s = window.deusExViewer.status();
    return {ready: s.ready, map: s.map, mode: s.mode, paused: s.paused, runtimeError: s.runtimeError?.message ?? null,
      position: s.gameplay?.player?.position ?? null, velocity: s.gameplay?.player?.velocity ?? null,
      grounded: s.gameplay?.player?.grounded ?? null, rotation: s.rotation};
  } catch (error) {
    return {map: document.getElementById('map').value, mode: document.getElementById('mode').value, statusError: error.message};
  }
});

export async function setSelect(page, id, value) {
  await page.evaluate(([id, value]) => {
    const element = document.getElementById(id);
    element.value = value;
    element.dispatchEvent(new Event('change', {bubbles: true}));
  }, [id, value]);
}

export async function setCamera(page, position, rotation) {
  await page.evaluate(([position, rotation]) => {
    document.getElementById('camera-position').value = position.join(', ');
    document.getElementById('camera-rotation').value = rotation.join(', ');
    document.getElementById('camera-form').requestSubmit();
  }, [position, rotation]);
}

export async function loadMap(page, name) {
  await page.evaluate(() => window.__clock.disable());
  await setSelect(page, 'map', name);
  // Poll the DOM, not status(): mid-load, status() can read the previous game's
  // released HUD (NativeHeapError) in the dev build.
  await page.waitForFunction(name => {
    const map = document.getElementById('map'), gate = document.getElementById('gate');
    return map.value === name && !map.disabled && gate.hidden;
  }, name, {timeout: 300000, polling: 1000});
  await page.waitForTimeout(1500);
}

// Turns the Play view by dragging, the same path a user takes (0.0025 rad/px).
export async function turn(page, yawRadians, pitchRadians = 0) {
  const box = await page.locator('#scene').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - Math.round(yawRadians / 0.0025), y - Math.round(pitchRadians / 0.0025), {steps: 4});
  await page.mouse.up();
}
