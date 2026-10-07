/** The card's still image: the scene facing front, spin stopped, a fixed electricity seed. */
import {chromium} from '@playwright/test';
import {serve} from './serve.mjs';

const SEED = 12; // an arc running up out of the frame

export async function renderPoster(file) {
  const server = await serve(0);
  const browser = await chromium.launch({args: process.platform === 'darwin' ? ['--use-angle=metal'] : []});
  try {
    const page = await browser.newPage({viewport: {width: 600, height: 600}, deviceScaleFactor: 2});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?still&yaw=0&seed=${SEED}`, {waitUntil: 'networkidle'});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (errors.length) throw new Error(`Poster page failed: ${errors.join('; ')}`);
    await page.screenshot({path: file});
  } finally {
    await browser.close();
    server.close();
  }
}
