/** A card's still image: a page of a built embed, screenshotted at 1200×1200. */
import {chromium} from '@playwright/test';
import {serve} from './serve.mjs';

/** `root` is the built site; `query` selects the frame (the logo scene's default:
 * facing front, spin stopped, an electricity seed whose arc runs up out of frame). */
export async function renderPoster(file, {root, query = '?still&yaw=0&seed=12'} = {}) {
  const server = await serve(0, root);
  const browser = await chromium.launch({args: process.platform === 'darwin' ? ['--use-angle=metal'] : []});
  try {
    const page = await browser.newPage({viewport: {width: 600, height: 600}, deviceScaleFactor: 2});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/${query}`, {waitUntil: 'networkidle'});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (errors.length) throw new Error(`Poster page failed: ${errors.join('; ')}`);
    await page.screenshot({path: file});
  } finally {
    await browser.close();
    server.close();
  }
}
