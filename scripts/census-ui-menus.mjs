/** Which of the original's menu screens, reached from MenuMain on the logo map DX.dx, run when every control and every window area is
 * pressed with the real mouse (docs/native-census.md "The menu sweep"). It is the dynamic complement of the native census: the census
 * says which natives the scripts can call, this finds the ones a click reaches first.
 *
 * The page runs in its default worker mode in headless Chromium. From the boot (DX, then Escape for MenuMain) it walks the screens
 * breadth first. On each screen it reads the window tree (settingsProbe `controls`: class, ancestry, absolute bounds, flags) and
 * performs, with real pointer events at the windows' own bounds:
 *   - a left click, a right click and a double click at the top window's corners and at a point outside it (the client areas),
 *   - a left click at the centre of every visible window of at least 2 x 2 pixels (every button, choice, list, slider, label),
 *   - a drag of 40 pixels from the title bar's centre (the title bar's MouseButtonPressed finds the window under the pointer: the
 *     FindWindow native the user hit first).
 * A click that opens another screen or a message box is an edge of the walk; Escape comes back. A runtime error pauses the game
 * (status().runtimeError): it is recorded with the native it names, the page is rebooted and the route to the screen replayed.
 *
 * Not pressed, because they leave the logo map or the page: the main menu's Training, Intro and Quit buttons, the Yes button of the
 * message boxes MenuMain raises for them, and Start Game (their paths are validate-travel-newgame-play and docs/travel.md).
 *
 *   node scripts/census-ui-menus.mjs [--out .work/native-menu-sweep.json] [--max-screens 60] [--only menuscreenoptions]
 *   node scripts/census-ui-menus.mjs --reuse .work/native-menu-sweep.json    (sort the stops of an earlier run again; no browser)
 *
 * The report: screens (route, windows, gestures, edges, errors), errors, and `stops` grouped by what stopped the game: a native by
 * index, a name-bound native (with the natives the named function calls, from the census), a script function not prepared, an
 * engine exec command not implemented, or other. */
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { handledNatives } from '../src/runtime/native-registry.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP census-ui-menus: no installed game data'); process.exit(0); }
const out = option('out', '.work/native-menu-sweep.json'), maxScreens = Number(option('max-screens', 80)), only = option('only', null);

const registry = handledNatives();

/** Sort the stops by what stopped them and write the report. `--reuse FILE` redoes only this from an earlier report. */
async function finish(report) {
  // A native-0 stop ("Unsupported original door native 0 in menuchoice_class.setinitialclass") names a function, not an index: the
  // census (.work/native-census.json) says which name-bound natives that function calls.
  let census = null;
  try { census = JSON.parse(await readFile('.work/native-census.json', 'utf8')); } catch { /* the census has not been run */ }
  const callsOf = where => !census || !where ? [] : census.natives.filter(row => row.status !== 'handled' && !row.index
    && row.callers.some(caller => caller.key.toLowerCase().endsWith(`.${where}`))).map(row => `${row.package}.${row.class}.${row.function}`);
  const stops = new Map();
  for (const error of report.errors) {
    const text = error.message ?? error.pageError ?? '';
    const kind = error.native ? 'native' : /Unsupported original door native 0 /.test(text) ? 'name-bound native'
      : /Original function is not prepared/.test(text) ? 'script function not prepared'
      : /Exec .*is not implemented/.test(text) ? 'engine exec command' : 'other';
    const detail = kind === 'native' ? String(error.native) : kind === 'name-bound native' ? callsOf(error.in).join(' / ') || text
      : kind === 'script function not prepared' ? text.replace(/^.*not prepared: /, '') : text.replace(/^.*Exec /, 'Exec ');
    const key = `${kind}: ${detail}`;
    if (!stops.has(key)) stops.set(key, {kind, detail, native: error.native ?? null, count: 0, where: []});
    const stop = stops.get(key); stop.count++; stop.where.push(`${error.screen}: ${error.action}`);
  }
  report.stops = [...stops.values()].map(stop => ({ ...stop, registryHandles: stop.native ? registry.byIndex.has(stop.native) : null, where: stop.where.slice(0, 6) }));
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 1) + '\n');
  console.log(`screens ${report.screens.length}, errors ${report.errors.length}; stops: ${report.stops.map(stop => `${stop.kind} ${stop.detail}`).join(' | ')}; written ${out}`);
}
const reuse = option('reuse', null);
if (reuse) { await finish(JSON.parse(await readFile(reuse, 'utf8'))); process.exit(0); }

const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
let page, pageErrors = [];
const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
const probe = step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step);
const newPage = async () => {
  if (page) await page.close().catch(() => {});
  page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
};
/** Boot the logo map and open the main menu. */
async function boot() {
  await newPage();
  await page.goto(`${url}/?antialias=0`);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === 'DX' && !s.runtimeError; }, null, { timeout: 240000 });
  await frames(120);
  await page.keyboard.press('Escape');
  await frames(30);
}
const runtimeError = () => page.evaluate(() => { const s = window.deusExViewer.status(); return s.runtimeError ? { message: s.runtimeError.message, travel: s.runtimeError.travel ?? null } : null; });
const mapName = () => page.evaluate(() => window.deusExViewer.status().map);
const signatureOf = c => !c ? null : `${c.windows[0].class}${c.windows[0].class === 'deusex.menuuimessageboxwindow' ? `[${c.parentClass ?? '?'}#${c.parentMode ?? '?'}]` : c.mode != null ? `#${c.mode}` : ''}`;
const readControls = async () => (await probe({ op: 'controls' })).result;

/** A real pointer gesture at drawing-buffer pixels (settingsProbe `center` coordinates). The default start takes the pointer lock after
 * a click (docs/boot.md "The mouse and fullscreen"): the lock is released first, as the user's Escape in a window does. */
async function pointer(bx, by, { button = 'left', clickCount = 1, drag = null } = {}) {
  if (await page.evaluate(() => Boolean(document.pointerLockElement))) { await page.evaluate(() => document.exitPointerLock()); await frames(3); }
  const buffer = await page.evaluate(() => { const canvas = document.querySelector('#scene'); return { w: canvas.width, h: canvas.height }; });
  const box = await page.locator('#scene').boundingBox();
  const at = (x, y) => [box.x + x * box.width / buffer.w, box.y + y * box.height / buffer.h];
  const [x, y] = at(bx, by);
  await page.mouse.move(x - 12, y - 6); await frames(1);
  await page.mouse.move(x, y); await frames(2);
  for (let k = 0; k < clickCount; k++) {
    await page.mouse.down({ button, clickCount: k + 1 }); await frames(1);
    if (drag) { for (let step = 1; step <= 4; step++) { const [dx, dy] = at(bx + drag[0] * step / 4, by + drag[1] * step / 4); await page.mouse.move(dx, dy); await frames(1); } }
    await page.mouse.up({ button, clickCount: k + 1 }); await frames(k + 1 === clickCount ? 6 : 1);
  }
  await frames(2);
}

const center = w => [w.x + w.w / 2, w.y + w.h / 2];
const KINDS = [['extension.buttonwindow', 'button'], ['extension.listwindow', 'list'], ['extension.editwindow', 'edit'], ['extension.scalewindow', 'scale'],
  ['extension.checkboxwindow', 'checkbox'], ['extension.togglewindow', 'toggle'], ['extension.textwindow', 'text']];
const kindOf = w => /title/.test(w.class) ? 'title' : (KINDS.find(([key]) => w.chain.includes(key))?.[1] ?? 'area');

/** A point of the window a gesture may land on: a title window's own strip first, else its middle, then its corners. */
function pointIn(w, kind, forbiddenAt) {
  const candidates = kind === 'title' ? [[w.x + w.w * 0.8, w.y + 6]] : [];
  candidates.push(center(w), [w.x + 3, w.y + 3], [w.x + w.w - 3, w.y + 3], [w.x + 3, w.y + w.h - 3], [w.x + w.w - 3, w.y + w.h - 3]);
  return candidates.find(([x, y]) => !forbiddenAt(x, y)) ?? null;
}

/** The gestures a screen gets, from its window tree. Each has a label, a place and, when it is a control, the controls index it presses. */
function plan(c) {
  const [top, ...rest] = c.windows;
  const actions = [];
  const buttonIndex = new Map((c.menu.buttons ?? []).map((button, i) => [button.window, button]));
  const actionIndex = new Map((c.menu.actionButtons ?? []).filter(entry => entry.window != null).map(entry => [entry.window, entry]));
  const skipped = [], forbidden = [];
  // The windows a click must not land on (travel and quit; see the header): by the menu's own tables.
  c.windows.forEach((w, i) => {
    const menuButton = buttonIndex.get(i), actionButton = actionIndex.get(i);
    const reason = menuButton && [4, 5, 6].includes(menuButton.action) ? `main menu action ${menuButton.action} (Training, Intro, Quit)`
      : actionButton && actionButton.key === 'START' ? 'Start Game'
      : c.roles.btnYes === i && c.parentClass === 'deusex.menumain' ? 'Yes of a MenuMain message box (train, intro, quit)' : null;
    if (reason) { skipped.push({ label: `${w.class}`, reason }); forbidden.push(w); }
  });
  const forbiddenAt = (x, y) => forbidden.some(w => x >= w.x - 2 && x <= w.x + w.w + 2 && y >= w.y - 2 && y <= w.y + w.h + 2);
  // The window areas: the corners and the middle of the top window, and the screen outside it.
  const area = (label, x, y, gestures) => {
    if (forbiddenAt(x, y)) { skipped.push({ label: `${label}`, reason: 'lands on a window that is not pressed' }); return; }
    for (const gesture of gestures) actions.push({ label: `${label} ${gesture.name}`, x, y, ...gesture.options, kind: 'area' });
  };
  const mouse = [{ name: 'click', options: {} }, { name: 'right-click', options: { button: 'right' } }, { name: 'double-click', options: { clickCount: 2 } }];
  area('top-left corner', top.x + 3, top.y + 3, mouse);
  area('bottom-right corner', top.x + top.w - 3, top.y + top.h - 3, mouse);
  area('middle', ...center(top), mouse);
  area('outside (screen corner)', 4, 4, mouse.slice(0, 1));
  const classCount = new Map();
  c.windows.forEach((w, i) => {
    const nth = classCount.get(w.class) ?? 0; classCount.set(w.class, nth + 1);
    if (i === 0 || !w.visible || w.w < 2 || w.h < 2) return;
    const kind = kindOf(w), label = `${kind} ${w.class.replace(/^(deusex|extension)\./, '')}#${nth}`;
    if (forbidden.includes(w)) return;
    // A window's centre can lie over a window that is not pressed (MenuMain's client window's and title window's do): take the
    // first of its middle and corners that does not.
    const spot = pointIn(w, kind, forbiddenAt);
    if (!spot) { skipped.push({ label, reason: 'every point lands on a window that is not pressed' }); return; }
    actions.push({ label, x: spot[0], y: spot[1], kind, pick: { class: w.class, nth }, forbiddenAt });
    if (kind === 'title') actions.push({ label: `${label} drag`, x: spot[0], y: spot[1], drag: [40, 0], kind, pick: { class: w.class, nth }, forbiddenAt });
  });
  return { actions, skipped };
}

/** Press the control a route step names (class and nth window of that class on the current screen). */
async function pressPick(pick, expectedTop) {
  const c = await readControls();
  let nth = 0, target = null;
  for (const w of c.windows) if (w.class === pick.class) { if (nth++ === pick.nth) { target = w; break; } }
  if (!target) throw new Error(`replay: no ${pick.class}#${pick.nth} on ${signatureOf(c)}`);
  await pointer(...center(target));
  const error = await runtimeError();
  if (error) throw new Error(`replay: ${error.message}`);
  const next = signatureOf(await readControls());
  if (next !== expectedTop) throw new Error(`replay: expected ${expectedTop}, found ${next}`);
}
async function reach(route) {
  for (const step of route) await pressPick(step.pick, step.expectTop);
}
async function rebuild(route) { await boot(); await reach(route); }
/** Back at the screen a route names: Escape up to MenuMain when the game still runs, else a reboot, then the route's clicks. */
async function goTo(route) {
  let main = false;
  if (!(await runtimeError().catch(() => ({ dead: true })))) {
    for (let tries = 0; tries < 7 && !main; tries++) {
      const here = signatureOf(await readControls().catch(() => null));
      if (here === 'deusex.menumain') { main = true; break; }
      await page.keyboard.press('Escape'); await frames(20);
    }
  }
  if (!main) { await boot(); }
  await reach(route);
}

const NATIVE = /native (\d+)/;
const describeError = message => ({ message, native: Number(message.match(NATIVE)?.[1] ?? NaN) || null, in: message.match(/ in ([\w.]+)/)?.[1] ?? null });
const screens = new Map(), queue = [{ route: [], signature: null }], report = { screens: [], errors: [], skipped: [] };
const startedAt = Date.now();
const log = text => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${text}`);

try {
  await boot();
  while (queue.length && screens.size < maxScreens) {
    const node = queue.shift();
    let c;
    try { await goTo(node.route); c = await readControls(); } catch (error) { log(`route lost: ${error.message}`); report.errors.push({ screen: node.signature, action: 'route', ...describeError(error.message), lost: true }); continue; }
    const signature = signatureOf(c);
    if (screens.has(signature)) continue;
    if (only && !signature.includes(only) && node.route.length) { screens.set(signature, true); continue; }
    const { actions, skipped } = plan(c);
    const entry = { signature, route: node.route.map(step => `${step.pick.class}#${step.pick.nth}`), windows: c.windows.length, actions: actions.length, skipped, errors: [], edges: [] };
    screens.set(signature, entry);
    report.screens.push(entry);
    log(`screen ${signature}: ${c.windows.length} windows, ${actions.length} gestures${skipped.length ? `, ${skipped.length} not pressed` : ''}`);
    const failedGroups = new Set();
    for (const action of actions) {
      // Back on this screen (a previous gesture may have left it or stopped the game).
      let now;
      try { now = signatureOf(await readControls()); } catch { now = null; }
      if ((await runtimeError()) || now !== signature) { await goTo(node.route); }
      pageErrors = [];
      const group = action.pick ? `${action.pick.class}#${action.pick.nth}` : `area:${action.label.split(' ').at(-1)}`;
      // A window that stopped the game already is not pressed again (its drag after its click); an area gesture that did is not repeated
      // at the other corners.
      if (failedGroups.has(group)) { entry.repeatedSkipped = (entry.repeatedSkipped ?? 0) + 1; continue; }
      if (action.pick) {
        // Re-resolve the window, as the layout may have moved.
        const fresh = await readControls();
        let nth = 0; const target = fresh.windows.find(w => w.class === action.pick.class && nth++ === action.pick.nth);
        if (target) { const spot = pointIn(target, action.kind, action.forbiddenAt); if (spot) [action.x, action.y] = spot; }
      }
      await pointer(action.x, action.y, { button: action.button, clickCount: action.clickCount, drag: action.drag });
      const error = await runtimeError();
      if (error) {
        const record = { screen: signature, action: action.label, ...describeError(error.message) };
        entry.errors.push(record); report.errors.push(record); failedGroups.add(group);
        log(`  ERROR ${action.label}: ${error.message.slice(0, 150)}`);
        continue;
      }
      if (pageErrors.length) { const record = { screen: signature, action: action.label, pageError: pageErrors[0].slice(0, 200) }; entry.errors.push(record); report.errors.push(record); log(`  PAGE ERROR ${action.label}: ${record.pageError}`); }
      const map = await mapName();
      if (map !== 'DX') { log(`  ${action.label} left the logo map for ${map}`); entry.edges.push({ via: action.label, to: `map ${map}` }); await goTo(node.route); continue; }
      const after = await readControls();
      const next = signatureOf(after);
      if (next !== signature) {
        entry.edges.push({ via: action.label, to: next });
        log(`  ${action.label} -> ${next}`);
        if (action.pick && next && !screens.has(next) && !queue.some(item => item.signature === next))
          queue.push({ route: [...node.route, { pick: action.pick, expectTop: next }], signature: next });
        await page.keyboard.press('Escape'); await frames(20);
        const back = signatureOf(await readControls().catch(() => null));
        if (back !== signature) await goTo(node.route);
      }
    }
    if (!entry.errors.length) log(`  clean`);
  }
} finally {
  await browser.close(); await server.close();
}
await finish(report);
process.exit(0);
