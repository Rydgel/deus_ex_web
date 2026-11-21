// Cuts the launch trailer from a take of trailer-capture.mjs (its frames, its sound, the audio clock of every step):
//   node video/launch/trailer-cut.mjs [--take take4] [--out trailer-1080p.mp4] [--address rydgel.github.io/deus_ex_web] [--silent] [--only window|card] [--lufs -16]
//        -> .work/marketing/out/trailer-1080p.mp4 (1920x1080, 30 fps, H.264 and AAC) and trailer-shots-made.json (the cut as made, with times)
// The shots are video/launch/trailer-shots.mjs. The picture is the page as a visitor sees it: a 4:3 picture in the middle of a black page
// (docs/boot.md "The screen's shape"). The first shots draw a browser window round that page (headless captures have none): the tab's
// title and icon are the page's own; the address is the public page's, as on the page's own link card (scripts/render-page-card.mjs).
// The frames themselves come from the dev server of this checkout: --address 127.0.0.1:5173 writes that instead. Then the window's
// content fills the frame. The last shot is a card.
// The sound of a shot is the stretch of the recording that belongs to its steps, cross-faded over a few frames at the cuts; where the
// capture's schedule started again inside a shot (a hitch of the page: `resets` in take.json) the sound is laid again from that step.
// Nothing is played while this runs.
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {SHOTS} from './trailer-shots.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const outDir = path.join(repo, '.work/marketing/out'), take = path.join(outDir, 'trailer', option('take', 'take4'));
const work = path.join(outDir, 'trailer', 'cut'), W = 1920, H = 1080;
const silent = argv.includes('--silent'), only = option('only', null);
const made = JSON.parse(readFileSync(path.join(take, 'take.json'), 'utf8')), FPS = made.fps, PW = made.canvas.w;
if (made.canvas.h !== H) throw new Error(`the take's picture is ${made.canvas.w}x${made.canvas.h}: its height is not the frame's`);
const picture = made, sound = !silent && made.sound ? {...made.sound, audioClock: made.audioClock, resets: made.resets ?? []} : null;
const CUT = SHOTS.map(shot => ({...shot}));

const clipFrame = (clip, n) => path.join(take, clip, `f${String(n).padStart(5, '0')}.png`);
let at = 0;
for (const shot of CUT) {
  shot.at = at; at += shot.frames;
  if (shot.clip) {
    const c = picture.clips[shot.clip];
    if (!c) throw new Error(`no clip ${shot.clip} in the take`);
    if (shot.how !== 'still' && shot.from + shot.frames - 1 > c.frames) throw new Error(`${shot.clip}: frames ${shot.from} to ${shot.from + shot.frames - 1} asked, the clip has ${c.frames}`);
    shot.step = c.from + shot.from - 1;                                // the step the shot's first frame was read after
  }
}
const total = at;
console.log(`${CUT.length} shots, ${total} frames, ${(total / FPS).toFixed(2)} s`);

// ------------------------------------------------------------------------------------------------- the drawn shots
const drawn = () => {
  const C = {bg: '#0c1017', text: '#e8e4dc', dim: '#9aa3b2', orange: '#D97757'};
  const SANS = '"Noto Sans", "Liberation Sans", system-ui, sans-serif', MONO = '"JetBrainsMono Nerd Font", "Liberation Mono", monospace';
  let cv, g, cfg;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const inOut = t => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
  const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
  window.setup = async c => {
    cfg = c; cv = document.getElementById('c'); cv.width = c.W; cv.height = c.H; g = cv.getContext('2d');
    await document.fonts.ready;
    cfg.icon = await load(c.icon); if (c.splash) cfg.splashImage = await load(c.splash);
    return true;
  };
  // The browser window. World units are the final frame's pixels: the page (the window's content) is the rectangle 0,0 1920x1080, the
  // window's bars are above it. The camera goes from the whole window to the content alone.
  // (the bars are drawn large, half as big again as a browser's at this size: the first shot has a second to say "a browser")
  const U = 1.5, BAR = {tabs: 46 * U, tools: 54 * U};
  function windowFrame(image, p, splash) {
    const W = cfg.W, H = cfg.H, top = BAR.tabs + BAR.tools;
    const s0 = 0.76, s = s0 + (1 - s0) * p;                            // the content's scale on screen
    const y0 = (H - (H + top) * s0) / 2 + top * s0, cy = y0 * (1 - p); // the content's top on screen: the whole window centred, then the frame's top
    const cx = (W - W * s) / 2;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    const r = g.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, 1200);
    r.addColorStop(0, 'rgba(40,52,72,0.9)'); r.addColorStop(1, 'rgba(12,16,23,0)');
    g.fillStyle = r; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(120,200,255,0.05)'; g.lineWidth = 1; g.beginPath();
    for (let x = 0; x < W; x += 60) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); }
    for (let y = 0; y < H; y += 60) { g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); }
    g.stroke();
    g.setTransform(s, 0, 0, s, cx, cy);                                 // world to screen
    const x = 0, y = -top, w = W, h = H + top, R = 16;
    g.save(); g.shadowColor = 'rgba(0,0,0,0.65)'; g.shadowBlur = 60 * s; g.shadowOffsetY = 18 * s; g.fillStyle = '#161d29'; g.beginPath(); g.roundRect(x, y, w, h, R); g.fill(); g.restore();
    g.save(); g.beginPath(); g.roundRect(x, y, w, h, R); g.clip();
    g.fillStyle = '#10161f'; g.fillRect(x, y, w, BAR.tabs);
    for (let j = 0; j < 3; j++) { g.fillStyle = '#3a4558'; g.beginPath(); g.arc(x + (28 + j * 26) * U, y + BAR.tabs / 2, 7 * U, 0, 7); g.fill(); }
    // the tab: the page's own icon and title
    g.fillStyle = '#1c2533'; g.beginPath(); g.roundRect(x + 112 * U, y + 8 * U, 330 * U, BAR.tabs - 8 * U, [10 * U, 10 * U, 0, 0]); g.fill();
    g.drawImage(cfg.icon, x + 128 * U, y + 16 * U, 22 * U, 22 * U);
    g.font = `${19 * U}px ${SANS}`; g.textBaseline = 'middle'; g.fillStyle = C.text; g.fillText(cfg.title, x + 160 * U, y + 28 * U);
    g.fillStyle = C.dim; g.font = `${18 * U}px ${SANS}`; g.fillText('\u00d7', x + 414 * U, y + 27 * U); g.font = `${24 * U}px ${SANS}`; g.fillText('+', x + 458 * U, y + 27 * U);
    // the toolbar: back, forward, reload, the address
    const ty = y + BAR.tabs;
    g.fillStyle = '#1c2533'; g.fillRect(x, ty, w, BAR.tools);
    g.strokeStyle = C.dim; g.lineWidth = 2.4 * U; g.lineCap = 'round'; g.lineJoin = 'round';
    const my = ty + BAR.tools / 2;
    g.beginPath(); g.moveTo(x + 40 * U, my - 9 * U); g.lineTo(x + 29 * U, my); g.lineTo(x + 40 * U, my + 9 * U); g.moveTo(x + 30 * U, my); g.lineTo(x + 50 * U, my); g.stroke();
    g.globalAlpha = 0.45; g.beginPath(); g.moveTo(x + 76 * U, my - 9 * U); g.lineTo(x + 87 * U, my); g.lineTo(x + 76 * U, my + 9 * U); g.moveTo(x + 86 * U, my); g.lineTo(x + 66 * U, my); g.stroke(); g.globalAlpha = 1;
    g.beginPath(); g.arc(x + 122 * U, my, 9.5 * U, 0.7, 5.7); g.stroke();
    g.fillStyle = '#0c1017'; g.beginPath(); g.roundRect(x + 156 * U, ty + 9 * U, w - (156 + 80) * U, BAR.tools - 18 * U, 18 * U); g.fill();
    g.strokeStyle = C.dim; g.lineWidth = 2 * U; g.beginPath(); g.arc(x + 180 * U, my, 8 * U, 0, 7); g.moveTo(x + 180 * U, my - 1 * U); g.lineTo(x + 180 * U, my + 4 * U); g.stroke(); g.fillStyle = C.dim; g.beginPath(); g.arc(x + 180 * U, my - 4.5 * U, 1.3 * U, 0, 7); g.fill();
    g.font = `${21 * U}px ${SANS}`; g.fillStyle = '#c7ccd6'; g.fillText(cfg.address, x + 202 * U, my + 1);
    for (let j = 0; j < 3; j++) { g.fillStyle = C.dim; g.beginPath(); g.arc(x + w - 40 * U, my + (-8 + j * 8) * U, 2.2 * U, 0, 7); g.fill(); }
    // the page: black, the picture in its middle (the splash at its own size while the files load)
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    if (splash) { const i = cfg.splashImage; g.drawImage(i, Math.round((W - i.width) / 2), Math.round((H - i.height) / 2)); }
    else if (image) g.drawImage(image, (W - cfg.PW) / 2, 0);
    g.restore();
    if (p < 1) { g.strokeStyle = `rgba(90,104,128,${0.9 * (1 - p)})`; g.lineWidth = 1.5; g.beginPath(); g.roundRect(x, y, w, h, R); g.stroke(); }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  window.drawWindow = async (src, p, splash) => { windowFrame(src ? await load(src) : null, p, splash); return cv.toDataURL('image/png').slice(22); };
  // The last card: where the project is, and what it needs.
  window.drawCard = async (k, n, under) => {
    const W = cfg.W, H = cfg.H, t = k / cfg.fps;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    const r = g.createRadialGradient(W / 2, H * 0.46, 60, W / 2, H / 2, 1100);
    r.addColorStop(0, 'rgba(34,46,66,0.9)'); r.addColorStop(1, 'rgba(12,16,23,0)');
    g.fillStyle = r; g.fillRect(0, 0, W, H);
    const line = (str, y, font, color, a) => { g.save(); g.globalAlpha = clamp(a); g.font = font; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = color; g.fillText(str, W / 2, y); g.restore(); };
    const a1 = smooth((t - 0.25) / 0.5), a2 = smooth((t - 0.7) / 0.5);
    g.save(); g.globalAlpha = clamp(a1); g.drawImage(cfg.icon, W / 2 - 40, 350 - 8 * (1 - a1), 80, 80); g.restore();
    line(cfg.card.address, 548 - 8 * (1 - a1), `600 88px ${SANS}`, C.text, a1);
    g.save(); g.globalAlpha = clamp(a1); g.fillStyle = C.orange; g.fillRect(W / 2 - 60, 592, 120, 4); g.restore();
    line(cfg.card.line, 676, `44px ${SANS}`, '#c7ccd6', a2);
    if (under) { const a = 1 - smooth(t / 0.45); if (a > 0) { g.save(); g.globalAlpha = a; g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.drawImage(await load(under), (W - cfg.PW) / 2, 0); g.restore(); } }
    return cv.toDataURL('image/png').slice(22);
  };
};

const dataPng = file => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
rmSync(work, {recursive: true, force: true});
mkdirSync(work, {recursive: true});
const needDrawn = CUT.some(s => s.how === 'window' || s.how === 'card');
let tab = null, browser = null;
if (needDrawn) {
  browser = await chromium.launch({args: ['--mute-audio']});
  tab = await browser.newPage({viewport: {width: W, height: H}, deviceScaleFactor: 1});
  await tab.setContent('<!doctype html><meta charset="utf-8"><style>html, body { margin: 0; background: #0c1017; } canvas { display: block; }</style><canvas id="c"></canvas>');
  await tab.addScriptTag({content: `(${drawn.toString()})()`});
  const splashPng = path.join(work, 'splash.png');
  execFileSync('magick', [path.join(repo, 'Deus Ex GOTY Edition/Help/Logo.bmp'), splashPng]);
  const title = /<title>(.*?)<\/title>/.exec(readFileSync(path.join(repo, 'index.html'), 'utf8'))[1];
  await tab.evaluate(cfg => window.setup(cfg), {W, H, PW, fps: FPS, title, address: option('address', 'rydgel.github.io/deus_ex_web'), splash: dataPng(splashPng),
    icon: `data:image/svg+xml;base64,${readFileSync(path.join(repo, 'src/viewer/favicon.svg')).toString('base64')}`,
    card: {address: 'github.com/Rydgel/deus_ex_web', line: 'Your own copy of the game required. Independent project.'}});
}

// ---------------------------------------------------------------------------------------------- the shots, as clips
const x264 = ['-c:v', 'libx264rgb', '-qp', '0', '-preset', 'ultrafast'];
const ff = args => { const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], {stdio: 'inherit'}); if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`); };
const parts = [];
let windowFrames = 0;
const pushAll = CUT.filter(s => s.how === 'window').reduce((n, s) => n + s.frames, 0);
for (const [index, shot] of CUT.entries()) {
  const file = path.join(work, `shot${String(index).padStart(2, '0')}.mkv`);
  parts.push(file);
  if (only && shot.how !== only) continue;
  if (shot.how === 'full') {
    ff(['-framerate', String(FPS), '-start_number', String(shot.from), '-i', path.join(take, shot.clip, 'f%05d.png'), '-frames:v', String(shot.frames),
      '-vf', `pad=${W}:${H}:${(W - PW) / 2}:0:black`, ...x264, file]);
  } else if (shot.how === 'still') {
    ff(['-loop', '1', '-framerate', String(FPS), '-i', path.join(take, shot.file), '-frames:v', String(shot.frames), '-vf', `pad=${W}:${H}:${(W - PW) / 2}:0:black`, ...x264, file]);
  } else {
    const dir = path.join(work, `shot${String(index).padStart(2, '0')}`);
    mkdirSync(dir, {recursive: true});
    for (let k = 0; k < shot.frames; k++) {
      let png;
      if (shot.how === 'window') {
        // the push-in: `hold` frames of the whole window (drifting a little), then in to the content over the rest of the window shots
        const f = windowFrames++, hold = shot.pushAfter ?? CUT.find(s => s.how === 'window').pushAfter ?? 0;
        const p = f < hold ? 0.035 * (f / Math.max(1, hold)) : null;
        const q = p ?? (() => { const u = (f - hold) / Math.max(1, pushAll - hold - 1); const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; return 0.035 + (1 - 0.035) * e; })();
        png = await tab.evaluate(([src, p, splash]) => window.drawWindow(src, p, splash), [shot.splash ? null : dataPng(clipFrame(shot.clip, shot.from + k)), q, Boolean(shot.splash)]);
      } else png = await tab.evaluate(([k, n, under]) => window.drawCard(k, n, under), [k, shot.frames, shot.under ? dataPng(clipFrame(shot.under.clip, shot.under.frame)) : null]);
      writeFileSync(path.join(dir, `f${String(k + 1).padStart(5, '0')}.png`), Buffer.from(png, 'base64'));
    }
    ff(['-framerate', String(FPS), '-i', path.join(dir, 'f%05d.png'), '-frames:v', String(shot.frames), ...x264, file]);
  }
  console.log(`shot ${index} ${shot.name}: ${shot.frames} frames at ${(shot.at / FPS).toFixed(2)} s`);
}
await browser?.close();
if (only) process.exit(0);
writeFileSync(path.join(work, 'list.txt'), parts.map(p => `file '${p}'`).join('\n') + '\n');

// -------------------------------------------------------------------------------------------------------- the sound
let wav = null;
if (sound) {
  const rate = sound.rate, pcm = readFileSync(path.join(take, 'sound.f32')), src = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  const have = src.length / 2, out = new Float32Array(Math.ceil(total / FPS * rate) * 2);
  const clock = sound.audioClock, sampleOf = step => Math.round(clock[step] * rate) - sound.firstFrame;
  const started = clock.findIndex(t => t > 0.25);                       // the page's first sound (its first click made the context)
  // stretches of the recording: {o: first output sample, s: first source sample, n: samples, soft: true when it only goes on from a reset}
  const stretches = [];
  for (const shot of CUT) {
    const n = Math.round((shot.at + shot.frames) / FPS * rate) - Math.round(shot.at / FPS * rate), o = Math.round(shot.at / FPS * rate);
    if (shot.audio?.join && stretches.length) { const last = stretches.at(-1); last.n += n; if (shot.audio.fadeOut) last.fadeOut = shot.audio.fadeOut; continue; }
    const step = shot.audio?.start ? started : shot.step;
    if (step === undefined || clock[step] < 0) throw new Error(`${shot.name}: no sound at step ${step}`);
    // the shot's steps, cut where the capture's schedule started again: each piece is laid from its own first step
    const cuts = [step, ...sound.resets.filter(r => r > step && r < step + shot.frames && !shot.audio?.start), step + shot.frames];
    for (let i = 0; i + 1 < cuts.length; i++) stretches.push({o: o + Math.round((cuts[i] - step) / FPS * rate), s: sampleOf(cuts[i]), n: Math.round((cuts[i + 1] - cuts[i]) / FPS * rate),
      name: shot.name, soft: i > 0, fadeOut: i + 2 === cuts.length ? shot.audio?.fadeOut ?? 0 : 0});
  }
  for (const gap of sound.gaps ?? []) for (const st of stretches) if (gap[0] < st.s + st.n && gap[0] + gap[1] > st.s) console.warn(`sound: a hole of the recording (${gap[1]} samples) lies in "${st.name}"`);
  for (const [i, st] of stretches.entries()) {
    // a linear cross-fade centred on each cut (80 ms; 12 ms where the sound only goes on from a reset), a short fade at the two ends
    const first = i === 0, last = i === stretches.length - 1, next = stretches[i + 1];
    const xin = first ? 0 : Math.round((st.soft ? 0.012 : 0.08) * rate), xout = last ? 0 : Math.round((next.soft ? 0.012 : 0.08) * rate);
    const lead = xin >> 1, tail = xout >> 1, len = st.n + lead + tail;
    const fin = first ? Math.round(0.02 * rate) : xin, fout = Math.max(last ? Math.round(0.02 * rate) : xout, Math.round(st.fadeOut * rate));
    for (let k = 0; k < len; k++) {
      const so = st.s - lead + k, oo = st.o - lead + k;
      if (so < 0 || so >= have || oo < 0 || oo * 2 + 1 >= out.length) continue;
      const g = Math.min(1, (k + 0.5) / fin, (len - k - 0.5) / fout);
      out[2 * oo] += src[2 * so] * g; out[2 * oo + 1] += src[2 * so + 1] * g;
    }
  }
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const raw = path.join(work, 'sound.f32'); wav = path.join(work, 'sound.wav');
  writeFileSync(raw, Buffer.from(out.buffer));
  ff(['-f', 'f32le', '-ar', String(rate), '-ac', '2', '-i', raw, '-c:a', 'pcm_s24le', wav]);
  console.log(`sound: ${stretches.length} stretches (${stretches.filter(st => st.soft).length} from a reset), peak ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS before levelling`);
}

// ------------------------------------------------------------------------------------------------------- the encode
const target = path.join(outDir, option('out', 'trailer-1080p.mp4'));
let audio = ['-an'];
if (wav) {
  // the level: one gain to -16 LUFS integrated (measured here), then a limiter under -1.5 dBFS for the shots
  const measured = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', 'ebur128=peak=true', '-f', 'null', '-'], {encoding: 'utf8'}).stderr;
  const integrated = Number(/I:\s+(-?[\d.]+) LUFS/.exec(measured.slice(measured.lastIndexOf('Summary')))?.[1]);
  const gain = Number(option('lufs', -16)) - integrated;
  console.log(`sound: ${integrated} LUFS integrated, gain ${gain.toFixed(1)} dB`);
  audio = ['-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.84:attack=2:release=60:level=disabled,aresample=48000`, '-c:a', 'aac', '-b:a', '256k'];
}
ff(['-f', 'concat', '-safe', '0', '-r', String(FPS), '-i', path.join(work, 'list.txt'), ...(wav ? ['-i', wav] : []), '-map', '0:v', ...(wav ? ['-map', '1:a'] : []),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-r', String(FPS), ...audio, '-movflags', '+faststart', '-shortest', target]);
writeFileSync(path.join(outDir, 'trailer-shots-made.json'), JSON.stringify({take: path.relative(repo, take), fps: FPS, frames: total, seconds: total / FPS,
  shots: CUT.map(s => ({name: s.name, how: s.how, clip: s.clip ?? null, from: s.from ?? null, frames: s.frames, at: +(s.at / FPS).toFixed(3), step: s.step ?? null}))}, null, 1));
console.log(`-> ${path.relative(repo, target)}`);
