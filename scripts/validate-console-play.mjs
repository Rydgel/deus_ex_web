/** The typed console in Play's page (docs/console.md): T opens the original console's line, the typed characters show where the original
 * draws them, Enter runs the line through Console.ConsoleCommand and the command chain, and the console's own messages show at the top left.
 *
 * On the original start (DX.dx's logo flight, as the original capture: .work/console/original.sh, outside Git), 960 x 720, ?antialias=0,
 * in the default worker mode (`--sim inline` for the other):
 *  1. a click, T and `xyz`: the console is in Typing with "Say xyz", and the frame's white text (three channels 200 or more) in its bottom-left
 *     corner is the original grab's "(> Say xyz_": 95 pixels, x 2..56, rows 3..11 above the bottom row, the same pixel set (its checksum);
 *  2. ten Backspaces, `asdfgh`, Enter: the console leaves Typing, its newest line is Core.int's "Unrecognized command" (Localize), and the
 *     top-left white text is the original's: 222 pixels, x 4..101, y 3..11, the same set;
 *  3. T, `set DeusEx.JCDentonMale bCheatsEnabled True`, Enter, T, `god`, Enter: bCheatsEnabled and ReducedDamageType 'All';
 *  4. 7 s later (Console.Tick: MsgTime 6 s) no console line is left to draw and the top-left text is gone;
 * with no Play stop and no page error.
 *
 *   node scripts/validate-console-play.mjs [--sim worker|inline] [--shots DIR] */
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';

const NAME = 'validate-console-play';
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const simMode = option('sim', null), shotsDir = option('shots', null);
try { gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }

// The original's text, measured on the Wine grabs (docs/console.md "Checked against the original"): pixel count, box and the sum of
// x * 1000 + y over the set, in frame coordinates (the typed line's y counted up from the bottom row, the message's down from the top).
const ORIGINAL = {
  typing: { count: 95, box: [2, 3, 56, 11], checksum: 2785651 },
  message: { count: 222, box: [4, 3, 101, 11], checksum: 11753528 },
};

const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`, '--mute-audio'] });
const failures = [], check = (ok, message) => { if (!ok) failures.push(message); };
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const target = new URL(`${url}/`);
  target.searchParams.set('antialias', '0');
  if (simMode) target.searchParams.set('sim', simMode);
  await page.goto(target.href);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === 'DX'; }, {}, { timeout: 300000, polling: 100 });
  await page.waitForTimeout(3000);
  await page.mouse.click(480, 360); await page.waitForTimeout(500);
  const consoleState = async () => (await page.evaluate(() => window.deusExViewer.windowProbe()));
  const runtimeError = () => page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
  /** The white text pixels of the canvas in frame coordinates: the bottom-left (`corner` 'bottom') or top-left 160 x 24 region. */
  const white = async (label, corner) => {
    const frame = await page.evaluate(() => { const c = document.getElementById('scene'), r = c.getBoundingClientRect();
      return { width: c.width, height: c.height, left: Math.round(r.x), top: Math.round(r.y) }; });
    const png = await page.screenshot();
    if (shotsDir) await writeFile(path.join(shotsDir, `${label}.png`), png);
    return page.evaluate(async ({ data, frame, corner }) => {
      const image = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      // (the page's screenshot, its pixel (x, y) the canvas's (x - left, y - top): the 4:3 canvas can sit a pixel off the page's origin)
      const dx = -frame.left, dy = -frame.top, pixels = context.getImageData(0, 0, image.width, image.height).data;
      let count = 0, checksum = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const fx = x + dx, fy = y + dy, ry = corner === 'bottom' ? frame.height - fy : fy;
        if (fx < 0 || fx >= 160 || fy < 0 || fy >= frame.height || ry < 0 || ry >= 24) continue;
        const i = (y * image.width + x) * 4;
        if (pixels[i] < 200 || pixels[i + 1] < 200 || pixels[i + 2] < 200) continue;
        count++; checksum += fx * 1000 + ry; x0 = Math.min(x0, fx); y0 = Math.min(y0, ry); x1 = Math.max(x1, fx); y1 = Math.max(y1, ry);
      }
      return { count, checksum, box: count ? [x0, y0, x1, y1] : null };
    }, { data: [...png], frame, corner });
  };
  const compare = (label, found, expected) => {
    check(found.count === expected.count && JSON.stringify(found.box) === JSON.stringify(expected.box)
      && (expected.checksum === null || found.checksum === expected.checksum),
      `${label}: ${found.count} white pixels in ${JSON.stringify(found.box)} (checksum ${found.checksum}), the original's ${expected.count} in ${JSON.stringify(expected.box)}${expected.checksum === null ? '' : ` (${expected.checksum})`}`);
    return found;
  };

  await page.keyboard.press('KeyT'); await page.waitForTimeout(300);
  await page.keyboard.type('xyz', { delay: 40 }); await page.waitForTimeout(400);
  let probe = await consoleState();
  check(probe.console.state === 'Typing' && probe.console.typed === 'Say xyz', `after T and xyz: console ${JSON.stringify(probe.console)}`);
  const typing = compare('the typed line', await white('typing', 'bottom'), ORIGINAL.typing);

  for (let i = 0; i < 10; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('asdfgh', { delay: 30 }); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  probe = await consoleState();
  check(probe.console.state === null && probe.console.lines.at(-1) === 'Unrecognized command' && probe.console.textLines === 1,
    `after asdfgh and Enter: console ${JSON.stringify(probe.console)}`);
  const message = compare('the console message', await white('message', 'top'), ORIGINAL.message);

  for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', 'god']) {
    await page.keyboard.press('KeyT'); await page.waitForTimeout(200);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type(line, { delay: 15 }); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  }
  probe = await consoleState();
  check(probe.cheats.enabled === true && probe.cheats.reducedDamageType === 'All', `after set and god: cheats ${JSON.stringify(probe.cheats)}`);

  await page.waitForTimeout(7000);
  probe = await consoleState();
  const gone = await white('gone', 'top');
  check(probe.console.textLines === 0 && gone.count === 0, `7 s later: TextLines ${probe.console.textLines}, ${gone.count} white pixels at the top left`);
  check((await runtimeError()) === null, `Play stopped: ${await runtimeError()}`);
  check(!errors.length, `page errors: ${errors.join(' | ')}`);
  console.log(`typed line checksum ${typing.checksum}, message checksum ${message.checksum}`);
} finally { await browser.close(); await server.close(); }

if (failures.length) { console.log(`FAIL ${NAME}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS ${NAME}: T opens the console's line, "(> Say xyz_" and "Unrecognized command" are the original's pixels, set and god run, the message ages out`);
