#!/usr/bin/env node
/** The public page's link preview image, docs/readme/card.jpg (1280×640): what X, Discord, Slack and GitHub show for a
 * shared link (docs/development.md "The public page"). Drawn here, not captured: the project's title and one sentence on the
 * left, and on the right a README screenshot of the browser version inside a browser window, with the page's address.
 *
 *   node scripts/render-page-card.mjs [--address rydgel.github.io/deus_ex_web] [--shot docs/readme/island.jpg] [--out docs/readme/card.jpg]
 *
 * The screenshot is one the repository already publishes (docs/readme/, README "Legal"); no game file is read. */
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const address = arg('address', 'rydgel.github.io/deus_ex_web');
const shot = arg('shot', 'docs/readme/island.jpg');
const out = arg('out', 'docs/readme/card.jpg');
const picture = `data:image/jpeg;base64,${(await readFile(shot)).toString('base64')}`;

// The gate's own colours (src/viewer/style.css): the dark page, the gold rule and eyebrow, the two greys of its text.
const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:640px;overflow:hidden;background:linear-gradient(180deg,#03060b 0%,#081524 60%,#0d2236 100%);font-family:"Liberation Sans",Arial,Helvetica,sans-serif}
  .text{position:absolute;left:64px;top:112px;width:452px;border-left:3px solid #c3a166;padding-left:30px}
  .eyebrow{font:15px "JetBrains Mono","DejaVu Sans Mono",monospace;letter-spacing:3px;color:#c8a56c;margin:2px 0 22px}
  h1{font-size:60px;line-height:1.08;font-weight:500;color:#eef4f9;margin:0 0 26px;letter-spacing:-.5px}
  p{font-size:24px;line-height:1.42;color:#aebfcc;margin:0}
  .note{position:absolute;left:97px;top:548px;font-size:16px;color:#6c8294}
  .window{position:absolute;left:590px;top:62px;width:626px;border:1px solid #2b4257;border-radius:11px;overflow:hidden;background:#101c27;box-shadow:0 24px 60px #000a}
  .bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#16232f}
  .dot{width:11px;height:11px;border-radius:50%;background:#34495c}
  .url{margin-left:10px;flex:1;height:22px;line-height:22px;border-radius:11px;background:#0b151e;color:#9db2c3;font:13px "JetBrains Mono","DejaVu Sans Mono",monospace;padding:0 14px}
  .window img{display:block;width:626px;height:469.5px}
</style>
<div class="text">
  <div class="eyebrow">OPEN SOURCE · RUST · WEBASSEMBLY</div>
  <h1>Deus Ex (2000), in a browser tab</h1>
  <p>The original game on a reimplemented engine, checked bit for bit against the original.</p>
</div>
<div class="note">Bring your own copy of the game · An independent project</div>
<div class="window"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">${address}</span></div><img src="${picture}" alt=""></div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map(image => image.decode())]));
  const bytes = await page.screenshot({ type: 'jpeg', quality: 88 });
  await writeFile(out, bytes);
  console.log(`${out}: 1280x640, ${bytes.length} bytes`);
} finally { await browser.close(); }
