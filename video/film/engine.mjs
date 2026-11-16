// The game engine as a camera for the film: this project's viewer in headless, muted Chromium, served by Vite in-process,
// driven through the viewer's own probes (as scripts/visual-acceptance.mjs and scripts/validate-mesh-path-frames.mjs do).
// With `clock`, the page runs on a stepped clock (Playwright's page.clock, the simulation inline, the page held until
// released): every step() is one 1/60 s frame whatever the machine does, so a sequence is the same each time and film
// time is exact. Frames are read from the canvas itself (its drawing buffer is kept for that).
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TURN = 65536 / 360, EYE = 40;             // rotator units to a degree; the ghost player's eye above its Location

/** Pitch and yaw (degrees) that look from one Unreal point to another. */
export function lookAt(from, to) {
  const [dx, dy, dz] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  return {yaw: Math.atan2(dy, dx) * 180 / Math.PI, pitch: Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI};
}

export async function openEngine({size: [W, H], clock = false}) {
  const {default: base} = await import(path.join(repo, 'vite.config.mjs'));
  const server = await createServer({...base, configFile: false, root: repo, logLevel: 'error', server: {...base.server, port: 0, strictPort: false, watch: null}});
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch({args: ['--use-angle=gl', '--mute-audio']});
  const page = await browser.newPage({viewport: {width: W, height: H}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch(), text = await response.text(), from = 'antialias: true })';
    if (!text.includes(from)) throw new Error('the renderer options in main.mjs no longer read as expected');
    await route.fulfill({response, body: text.replace(from, 'antialias: true, preserveDrawingBuffer: true })')});
  });
  if (clock) await page.clock.install({time: new Date('2026-01-01T00:00:00Z')});
  await page.goto(`${url}/?debug=1&seed=1&music=0${clock ? '&hold=1&sim=inline' : ''}`);
  const ready = map => page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && (!m || s.map === m); }, map, {timeout: 300000});
  let stepped = 0;
  const engine = {
    page, errors, size: [W, H],
    call: (name, args) => page.evaluate(([n, a]) => window.deusExViewer[n](a), [name, args]),
    probe: args => engine.call('viewProbe', args),
    /** n frames of 1/60 s (on the stepped clock: 17, 17, 16 ms). */
    async step(n = 1) {
      if (!clock) return page.evaluate(async k => { for (let i = 0; i < k; i++) await new Promise(r => requestAnimationFrame(r)); }, n);
      for (let i = 0; i < n; i++) await page.clock.runFor(stepped++ % 3 === 2 ? 16 : 17);
    },
    async load(map) {
      await ready(null);
      if (await page.evaluate(() => window.deusExViewer.status().map) !== map) { await page.locator('#map').selectOption(map); await ready(map); }
      // only the game's picture, at the film's size
      await page.addStyleTag({content: `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; } #viewport { position: fixed !important; inset: 0 !important; width: ${W}px; height: ${H}px; }
#scene { position: fixed !important; left: 0 !important; top: 0 !important; margin: 0 !important; border: 0 !important; transform: none !important; width: ${W}px !important; height: ${H}px !important; }`});
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      if (clock) {
        await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
        await page.evaluate(() => window.deusExViewer.release());
      }
      await engine.step(30);
      const start = await engine.probe({ghost: true});               // fly, no collision, no HUD: the player is only a camera
      // ... and its blob shadow must not lie about: a frozen level leaves it where the player last stood (seen on the dock, 2026-11-11)
      const shadows = ((await engine.call('liveProbe', {actors: 'deusex.shadow'})).actors ?? []).map(row => row.name);
      const owners = shadows.length ? await engine.read(shadows, ['Owner']) : {};
      const mine = shadows.filter(name => /^JCDenton/i.test(String(owners[name]?.Owner ?? '')));
      if (mine.length) await engine.call('liveProbe', {write: Object.fromEntries(mine.map(name => [name, {bHidden: true}]))});
      engine.hidden = mine;
      await engine.step(4);
      const buffer = await page.evaluate(() => { const c = document.getElementById('scene'); return [c.width, c.height]; });
      if (buffer[0] !== W || buffer[1] !== H) throw new Error(`the scene canvas is ${buffer.join('x')}, not ${W}x${H}`);
      return start;
    },
    /** The camera at an Unreal point, looking along pitch and yaw in degrees. */
    camera: (position, {pitch, yaw}) => engine.probe({location: [position[0], position[1], position[2] - EYE], rotation: [Math.round(pitch * TURN), Math.round(yaw * TURN), 0]}),
    /** Summons a pawn where the player is placed; -> its name (its shadow actor comes with it). */
    async summon(cls, near, yaw) {
      await engine.probe({location: [near[0] - 72 * Math.cos(yaw * Math.PI / 180), near[1] - 72 * Math.sin(yaw * Math.PI / 180), near[2]], rotation: [0, Math.round(yaw * TURN), 0]});
      await engine.step(12);
      const made = await engine.call('inputProbe', {op: 'summon', cls});
      await engine.step(24);                                           // it drops to the floor
      return made.actors[0];
    },
    put: (name, location, yaw) => engine.call('liveProbe', {write: {[name]: {Location: location, Rotation: [0, Math.round(yaw * TURN) & 65535, 0]}}}),
    pose: (name, sequence, frame) => engine.call('placeProbe', {set: {actor: name, fields: {AnimSequence: sequence, AnimFrame: frame, AnimRate: 0}}}),
    read: async (names, props) => (await engine.call('liveProbe', {read: {names, props}})).read,
    async grab(file) {
      writeFileSync(file, Buffer.from(await page.evaluate(() => document.getElementById('scene').toDataURL('image/png').slice(22)), 'base64'));
    },
    status: () => page.evaluate(() => { const s = window.deusExViewer.status(); return {position: s.position, rotation: s.rotation}; }),
    async close() { await browser.close(); await server.close(); },
  };
  return engine;
}
