// Renders the promo: serves the repo read-only on 127.0.0.1, steps
// window.__video.renderFrame(t) in headless Chromium and pipes JPEG frames
// into ffmpeg (H.264 + the synthesized soundtrack when present).
//
//   node ad/scripts/render.mjs                      full render -> ad/out/deus-ex-browser-runtime.mp4
//   node ad/scripts/render.mjs --stills 1,23.5,40    PNG previews -> ad/build/preview/
//   node ad/scripts/render.mjs --from 20 --to 30     partial render (suffix in the file name)
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createReadStream, existsSync, mkdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import { debugUrl } from '../../scripts/page-url.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.obj': 'text/plain', '.css': 'text/css'};
const ALLOWED = ['/ad/', '/node_modules/three/', '/reports/00_Training/world.obj'];
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(repo, url);
  if (!ALLOWED.some(prefix => url.startsWith(prefix)) || !file.startsWith(repo) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, {'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store'});
  createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--force-color-profile=srgb']});
const page = await browser.newPage({viewport: {width: 1920, height: 1080}, deviceScaleFactor: 1});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto(debugUrl(`${base}/ad/src/index.html`));
const info = await page.evaluate(() => window.__video.ready);
console.log('ready', JSON.stringify(info));
const frameAt = async t => {
  await page.evaluate(t => window.__video.renderFrame(t), t);
  return page.screenshot({type: 'jpeg', quality: 95, clip: {x: 0, y: 0, width: 1920, height: 1080}});
};

try {
  if (opt('stills')) {
    const dir = path.join(repo, 'ad/build/preview');
    mkdirSync(dir, {recursive: true});
    for (const t of opt('stills').split(',').map(Number)) {
      await page.evaluate(t => window.__video.renderFrame(t), t);
      await page.screenshot({path: path.join(dir, `t${t.toFixed(2).padStart(6, '0')}.png`), clip: {x: 0, y: 0, width: 1920, height: 1080}});
    }
    console.log('stills written to', dir);
  } else {
    const fps = info.fps, from = Number(opt('from') ?? 0), to = Number(opt('to') ?? info.duration);
    const partial = opt('from') || opt('to');
    mkdirSync(path.join(repo, 'ad/out'), {recursive: true});
    const out = path.join(repo, 'ad/out', partial ? `deus-ex-browser-runtime-${from}-${to}.mp4` : 'deus-ex-browser-runtime.mp4');
    const music = path.join(repo, 'ad/build/music.wav');
    const withAudio = existsSync(music) && !opt('silent');
    const ffArgs = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-'];
    if (withAudio) ffArgs.push('-ss', String(from), '-t', String(to - from), '-i', music);
    ffArgs.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart');
    if (withAudio) ffArgs.push('-c:a', 'aac', '-b:a', '256k', '-shortest');
    ffArgs.push(out);
    const ff = spawn('ffmpeg', ffArgs, {stdio: ['pipe', 'inherit', 'inherit']});
    const done = new Promise((resolve, reject) => ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
    const total = Math.round((to - from) * fps), t0 = Date.now();
    for (let i = 0; i < total; i++) {
      const jpeg = await frameAt(from + i / fps);
      if (!ff.stdin.write(jpeg)) await new Promise(resolve => ff.stdin.once('drain', resolve));
      if (i % 150 === 0) console.log(`frame ${i}/${total} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end();
    await done;
    console.log('wrote', out, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
} finally {
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  await browser.close();
  server.close();
}
