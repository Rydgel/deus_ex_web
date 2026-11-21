// The game as the launch trailer films it: the page as a visitor gets it (the default start, docs/boot.md: splash, logo map, the
// original's menus, a 4:3 picture), in headless, muted Chromium, served by Vite in-process, on a stepped clock as video/film/engine.mjs
// has it (Playwright's page.clock, the simulation inline), driven by the player's own inputs (keys, mouse buttons, the menus' cursor)
// and, for placements and the view, the viewer's probes, as ad/scripts/capture-play.mjs does.
//
// Picture and sound come from one run, 30 frames a second. A step is one frame of the page: the clock goes on by 33, 33 or 34 ms and
// the page's animation frame runs once with that dt. The steps are paced to the wall clock (30 a second), because the page's sound is
// made in real time: what its audio graph sends to its destination is recorded as PCM by a recorder worklet (the browser is muted:
// nothing is played on the machine), and the audio clock is noted at every step, so a stretch of steps is a stretch of samples. With a
// clip open, the canvas is read after each step without waiting for it (frameGrabber below).
// Why 30 and why one run, measured 2026-11-16 on this host (Radeon 780M; the page's work is on the CPU):
//   - a step of Liberty Island costs the page about 17 ms, and 5 ms more with a frame read: over the 16.7 ms a 60 Hz run has;
//   - two runs, one read slowly for the picture and one paced for the sound, agree tick for tick through the menus, the dock and
//     MeetPaul, but not in the fight, where the pawns' barks wait for a speech decode that takes a different number of steps at each
//     pace. One run cannot disagree with itself.
// Nothing else follows the wall clock: a map load is waited for with the simulation frozen (deusExViewer.freeze) and the step phase
// starts again after it, so the level's first tick and every dt after it are the same in every run; `marks` (a line every second of a
// level: its time, the player's place, the conversation's event) is written to compare runs (dry: no sound, no picture, not paced).
// The page is not changed and nothing is intercepted in the browser: the dev server gets one plugin of this script's own (the frames'
// endpoint, the save folder it lists, and the canvas kept readable, as film/engine.mjs keeps it).
import {appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const units = rad => Math.round(rad * 32768 / Math.PI);
export const wrap = v => ((v % 65536) + 65536) % 65536;
export const shortest = (from, to) => { let d = wrap(to - from); if (d > 32768) d -= 65536; return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs before any page module (sound run): everything connected to an AudioContext's destination is also connected to a recorder
// worklet of that context, which posts its input in blocks with the frame they start at.
const audioTap = () => {
  const connect = AudioNode.prototype.connect, taps = new Map();
  window.__taps = taps; window.__pcm = [];
  const code = `registerProcessor('launch-recorder', class extends AudioWorkletProcessor {
    constructor() { super(); this.left = new Float32Array(128 * 64); this.right = new Float32Array(128 * 64); this.n = 0; this.first = 0; }
    process(inputs) {
      const input = inputs[0], l = input[0], r = input[1] ?? input[0];
      if (this.n === 0) this.first = currentFrame;
      if (l) { this.left.set(l, this.n); this.right.set(r, this.n); } else { this.left.fill(0, this.n, this.n + 128); this.right.fill(0, this.n, this.n + 128); }
      this.n += 128;
      if (this.n === this.left.length) { this.port.postMessage({first: this.first, left: this.left.slice(), right: this.right.slice()}); this.n = 0; }
      return true;
    }
  });`;
  const tapOf = context => {
    let tap = taps.get(context);
    if (tap) return tap;
    tap = {bus: context.createGain(), ready: false, rate: context.sampleRate, context};
    taps.set(context, tap);
    context.audioWorklet.addModule(URL.createObjectURL(new Blob([code], {type: 'application/javascript'}))).then(() => {
      const node = new AudioWorkletNode(context, 'launch-recorder', {numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2]});
      node.port.onmessage = ({data}) => window.__pcm.push(data);
      connect.call(tap.bus, node); connect.call(node, context.destination);            // (its output is silence; it only has to be pulled)
      tap.ready = true;
    });
    return tap;
  };
  AudioNode.prototype.connect = function (target, ...rest) {
    const result = connect.call(this, target, ...rest);
    if (target instanceof AudioDestinationNode) connect.call(this, tapOf(this.context).bus);
    return result;
  };
  // the audio clock of every animation frame (the stepped clock runs one a step): [context time, or -1 before there is a context]
  window.__audioClock = () => { const tap = [...taps.values()][0]; return tap ? tap.context.currentTime : -1; };
};

// Runs before any page module, after the stepped clock is installed: the page's animation frames. Playwright's clock fires them on a
// 16 ms grid of its own time (62.5 a second), so a 17 ms step holds one frame or two, depending on where the clock stood when it was
// paused: two runs then feed their inputs to different ticks. From begin() on the frames are run here instead, once a step, after the
// clock has advanced by the step: every frame's dt is its step (17, 17, 16 ms).
const frameQueue = () => {
  const clockRaf = window.requestAnimationFrame.bind(window), clockCancel = window.cancelAnimationFrame.bind(window);
  let manual = false, queue = [], id = 1 << 20;
  window.requestAnimationFrame = callback => { if (!manual) return clockRaf(callback); queue.push([++id, callback]); return id; };
  window.cancelAnimationFrame = handle => { queue = queue.filter(([h]) => h !== handle); clockCancel(handle); };
  window.__frames = {
    manual() { manual = true; },
    /** The frame of this step: every callback asked for since the last one, with the clock's time. */
    run() { const now = performance.now(), callbacks = queue; queue = []; for (const [, callback] of callbacks) callback(now); return callbacks.length; },
  };
};

// Runs before any page module (picture): window.__grab(file) reads the canvas as it is now (readPixels, in the task that drew it) and
// copies the pixels to a worker, which writes them as a PNG (its own writer: RGB, the Sub filter, zlib through CompressionStream) and
// keeps the bytes. window.__grabFlush() has the workers post what they keep to the capture's endpoint: stage.mjs calls it when a clip
// ends, and waits. What was tried first, 2026-11-16:
//   - canvas.toDataURL: 33 ms on the page for a frame of the Island;
//   - createImageBitmap and a worker's OffscreenCanvas, or readPixels into a buffer on the GPU fetched a step later, each with the PNG
//     posted as soon as it was made: the stepping stalls 300 to 800 ms every ten frames or so. Not the page's collector (--trace-gc
//     shows no pause over 12 ms), not the read, the copy or the compression (each tried alone: no stall): the posts themselves, while
//     the automation's session watches the page's requests;
//   - convertToBlob in the worker: headless Chromium keeps every Blob in a store of some 500 MB until the worker's collector frees it,
//     which it does not do in time: from the 286th frame on every post failed with net::ERR_BLOB_OUT_OF_MEMORY.
// The pixels are the drawing buffer's own (premultiplied, over the page's black: what the page shows).
const frameGrabber = () => {
  const code = `
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = (bytes, from, to) => { let c = 0xffffffff; for (let i = from; i < to; i++) c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  async function png(rgba, w, h) {
    const row = 1 + 3 * w, raw = new Uint8Array(h * row);
    for (let y = 0, o = 0; y < h; y++) {
      raw[o++] = 1;                                                  // filter type Sub: each byte less the byte one pixel to its left
      let pr = 0, pg = 0, pb = 0;
      for (let x = 0, i = (h - 1 - y) * w * 4; x < w; x++, i += 4) { const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]; raw[o++] = r - pr; raw[o++] = g - pg; raw[o++] = b - pb; pr = r; pg = g; pb = b; }   // (readPixels gives the bottom row first)
    }
    const packed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const out = new Uint8Array(8 + 25 + 12 + packed.length + 12), view = new DataView(out.buffer);
    out.set([137, 80, 78, 71, 13, 10, 26, 10]);
    let at = 8;
    const chunk = (type, data) => { view.setUint32(at, data.length); out.set([...type].map(c => c.charCodeAt(0)), at + 4); out.set(data, at + 8); view.setUint32(at + 8 + data.length, crc(out, at + 4, at + 8 + data.length)); at += 12 + data.length; };
    const head = new Uint8Array(13), hv = new DataView(head.buffer); hv.setUint32(0, w); hv.setUint32(4, h); head[8] = 8; head[9] = 2;
    chunk('IHDR', head); chunk('IDAT', packed); chunk('IEND', new Uint8Array(0));
    return out;
  }
  let kept = [], busy = Promise.resolve();
  self.onmessage = ({data}) => { busy = busy.then(async () => {
    if (data.flush) {
      const failed = [], list = kept; kept = [];
      for (const {file, bytes} of list) {
        try { const response = await fetch(ORIGIN + '__launch_grab__?file=' + encodeURIComponent(file), {method: 'POST', body: bytes}); if (!response.ok) failed.push({file, error: 'HTTP ' + response.status}); }
        catch (error) { failed.push({file, error: String(error)}); }
      }
      self.postMessage({flushed: list.length, failed});
    } else {
      try { kept.push({file: data.file, bytes: await png(data.pixels, data.w, data.h)}); self.postMessage({encoded: true}); }
      catch (error) { self.postMessage({encoded: false, failed: [{file: data.file, error: String(error)}]}); }
    }
  }); };`;
  const source = URL.createObjectURL(new Blob([`const ORIGIN = ${JSON.stringify(location.origin + '/')};` + code], {type: 'application/javascript'}));
  const workers = Array.from({length: 10}, () => new Worker(source));
  // pending: frames read and not yet written by the endpoint; encoding: of those, the ones not yet a PNG
  const state = window.__grabState = {pending: 0, encoding: 0, failed: [], sent: 0, written: 0};
  let flushing = null;
  for (const worker of workers) worker.onmessage = ({data}) => {
    if (data.failed?.length) state.failed.push(...data.failed);
    if ('encoded' in data) { state.encoding--; if (!data.encoded) state.pending--; return; }
    state.pending -= data.flushed; state.written += data.flushed - data.failed.length;
    if (flushing && --flushing.left === 0) { flushing.done(); flushing = null; }
  };
  /** Every kept frame posted; resolves when the endpoint has them all. */
  window.__grabFlush = () => new Promise(done => { flushing = {left: workers.length, done}; for (const worker of workers) worker.postMessage({flush: true}); });
  let gl = null, pixels = null;
  window.__grab = file => {
    const canvas = document.getElementById('scene');
    gl ??= canvas.getContext('webgl2');
    const w = canvas.width, h = canvas.height, read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    // one array of the page's for every frame (3 ms to fill here), copied to the worker by the message
    if (pixels?.length !== w * h * 4) pixels = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    workers[state.sent++ % workers.length].postMessage({pixels, w, h, file});
    state.pending++; state.encoding++;
  };
};

/** Opens the page. `saves`: a folder whose `Save<N>` folders the page lists as the installation's own (the dev server's read-only
 * listing, answered from that folder instead: the installation is not touched). `fps`: steps a second. `dry`: no sound, no picture, no pacing. */
export async function openStage({size: [W, H] = [1920, 1080], fps = 30, sound = true, dry = false, saves = null, query = '', out, scout = 0, marks = null, log = console.log} = {}) {
  if (dry) sound = false;
  const pictures = !dry, saveNames = /^(Save-?\d+|QuickSave)$/i;
  const {default: base} = await import(path.join(repo, 'vite.config.mjs'));
  const capture = {name: 'launch-capture', enforce: 'pre',
    // the canvas keeps its picture, to be read (as film/engine.mjs asks of it)
    transform(code, id) {
      if (!/\/src\/viewer\/main\.mjs(?:\?|$)/.test(id)) return null;
      const from = 'antialias: true })';
      if (!code.includes(from)) throw new Error('the renderer options in main.mjs no longer read as expected');
      return {code: code.replace(from, 'antialias: true, preserveDrawingBuffer: true })'), map: null};
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const at = new URL(req.url ?? '/', 'http://x');
        // the frames: POST /__launch_grab__?file=<path under `out`> writes the body there
        if (at.pathname === '/__launch_grab__') {
          const file = path.resolve(out ?? '.', at.searchParams.get('file') ?? '');
          if (req.method !== 'POST' || !out || !file.startsWith(out + path.sep) || !file.endsWith('.png')) { res.statusCode = 400; return res.end('no'); }
          const chunks = [];
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', () => { writeFileSync(file, Buffer.concat(chunks)); res.statusCode = 200; res.end('ok'); });
          return;
        }
        // the save folder the page lists (vite.config.mjs's own two routes, read from `saves`)
        if (saves && req.method === 'GET' && at.pathname === '/__game__/saves') {
          const found = [];
          for (const dir of await readdir(saves, {withFileTypes: true})) {
            if (!dir.isDirectory() || !saveNames.test(dir.name)) continue;
            for (const file of await readdir(path.join(saves, dir.name), {withFileTypes: true})) if (file.isFile()) {
              const info = await stat(path.join(saves, dir.name, file.name));
              found.push({dir: dir.name, name: file.name, size: info.size, modified: Math.floor(info.mtimeMs)});
            }
          }
          res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({files: found}));
        }
        if (saves && req.method === 'GET' && at.pathname.startsWith('/__game__/save/')) {
          const [dir, name, ...rest] = at.pathname.slice('/__game__/save/'.length).split('/').map(decodeURIComponent);
          res.setHeader('Cache-Control', 'no-store');
          if (rest.length || !saveNames.test(dir ?? '') || !name || /[\\/]|^\.\.?$/.test(name)) { res.statusCode = 404; return res.end('Save file not found'); }
          try { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(await readFile(path.join(saves, dir, name))); }
          catch { res.statusCode = 404; return res.end('Save file not found'); }
        }
        next();
      });
    }};
  const server = await createServer({...base, plugins: [capture, ...(base.plugins ?? [])], configFile: false, root: repo, logLevel: 'error', server: {...base.server, port: 0, strictPort: false, watch: null}});
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');
  // Chromium's full headless build: it grants the pointer lock, as a browser window does (docs/boot.md "The mouse and fullscreen").
  // A profile of its own, new for each run and removed after it. LAUNCH_GPU=nvidia draws on the discrete GPU (PRIME offload); not the
  // default: flat out an Island step is 13.2 ms on it against 15.2 ms on the integrated one, but paced it is the slower (the card idles
  // between frames).
  const nvidia = '/usr/share/glvnd/egl_vendor.d/10_nvidia.json';
  const env = existsSync(nvidia) && process.env.LAUNCH_GPU === 'nvidia' ? {...process.env, __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __EGL_VENDOR_LIBRARY_FILENAMES: nvidia} : process.env;
  mkdirSync(path.join(repo, '.work/marketing/out/trailer'), {recursive: true});
  const profile = mkdtempSync(path.join(repo, '.work/marketing/out/trailer', 'profile-'));
  const browser = await chromium.launchPersistentContext(profile, {channel: 'chromium', headless: true, env, viewport: {width: W, height: H}, deviceScaleFactor: 1,
    args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required', ...(process.env.LAUNCH_ARGS?.split(' ') ?? [])]});
  const page = browser.pages()[0] ?? await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (sound) await page.addInitScript(audioTap);
  if (pictures) await page.addInitScript(frameGrabber);
  await page.clock.install({time: new Date('2026-01-01T00:00:00Z')});
  await page.addInitScript(frameQueue);
  // seed: the shared random stream; credit=0: without the page's own credit card over the flight (not the original's); saves=off unless a folder is given
  await page.goto(`${url}/?seed=1&hold=1&sim=inline&credit=0${saves ? '' : '&saves=off'}${query}`);

  if (out) { mkdirSync(out, {recursive: true}); if (scout) { rmSync(path.join(out, 'scout'), {recursive: true, force: true}); mkdirSync(path.join(out, 'scout'), {recursive: true}); } }
  // (dry: the picture run without its reads, to compare two runs' marks quickly)
  const marksFile = out ? path.join(out, marks ?? 'marks.jsonl') : null;
  if (marksFile) rmSync(marksFile, {force: true});
  let stepped = 0, phase = 0, t0 = null, clip = null, pcmWritten = 0, worst = 0, late = 0;
  // a step: 1000 / fps ms on average in whole milliseconds (30: 33, 33, 34; 60: 17, 17, 16), and as much of the wall clock
  const PERIOD = 1000 / fps, stepMs = () => { const a = Math.round(phase * PERIOD), b = Math.round((phase + 1) * PERIOD); phase++; return b - a; };
  /** A script's count of sixtieths of a second (its unit for waits, glides and turns) as steps. */
  const steps = n => Math.max(1, Math.round(n * fps / 60));
  const pcmFile = out && sound ? path.join(out, 'sound.f32') : null;
  if (pcmFile) rmSync(pcmFile, {force: true});
  const clips = {};                                                   // name -> {from, to (steps), frames}
  const audioClock = [];                                              // per step, the audio context's time
  const resets = [], pcmGaps = [];                                    // steps at which the schedule started again; holes in the recording [sample, samples]

  /** The clock on by `ms`, then the frame of that time (one, whatever the clock's own frame grid says). */
  const tick = async ms => { await page.clock.runFor(ms); return page.evaluate(() => window.__frames.run()); };
  /** The same with the simulation frozen for that frame (a finished load un-freezes the page: asked again before every frame of a wait). */
  const pump = async ms => { await page.clock.runFor(ms); return page.evaluate(() => { window.deusExViewer.freeze(true); return window.__frames.run(); }); };
  let sinceArrival = 0;
  const stage = {
    page, errors, size: [W, H], fps, sound, clips, audioClock, resets,
    get steps() { return stepped; },
    call: (name, args) => page.evaluate(([n, a]) => window.deusExViewer[n](a), [name, args]),
    status: () => page.evaluate(() => { const s = window.deusExViewer?.status(); return s ? {ready: s.ready, map: s.map, mode: s.mode, paused: s.paused, error: s.runtimeError?.message ?? null, audio: s.audio?.contextState} : null; }),
    read: async (names, props) => (await stage.call('liveProbe', {read: {names, props}})).read,
    place: args => stage.call('placeProbe', args),
    exec: (...lines) => stage.call('viewProbe', {exec: lines}),
    menu: step => stage.call('settingsProbe', step),
    conversation: () => stage.call('conversationProbe', {}),

    /** One frame, on the wall clock unless the run is dry. With a clip open, the canvas is read after it. */
    async step(n = 1) {
      for (let i = 0; i < n; i++) {
        if (!dry) {
          const now = performance.now();
          if (t0 === null) t0 = now - stepped * PERIOD;
          const due = t0 + stepped * PERIOD;
          if (due > now) { if (due - now > 2) await sleep(due - now - 1.5); while (performance.now() < due) await new Promise(r => setImmediate(r)); }
          // behind: the next steps run back to back until the schedule is met again; far behind (a load, a hitch of the page), the
          // schedule starts again here, and the step is noted: the cut lays the sound of what follows from this step, not from before it
          else if (now - due > 6) { late++; worst = Math.max(worst, now - due); if (now - due > 80) { t0 = now - stepped * PERIOD; resets.push(stepped); } }
        }
        const file = clip && pictures ? path.join(clip.name, `f${String(clip.frames + 1).padStart(5, '0')}.png`) : null;
        await page.clock.runFor(stepMs());
        const heard = await page.evaluate(file => { window.__frames.run(); if (file) window.__grab(file); return window.__audioClock ? window.__audioClock() : -1; }, file);
        stepped++; sinceArrival++;
        audioClock.push(heard);
        if (clip) clip.frames++;
        // (scout: a small picture every `scout` steps, to look over a whole run)
        if (scout && stepped % scout === 0) writeFileSync(path.join(out, 'scout', `s${String(stepped).padStart(6, '0')}.jpg`), Buffer.from(await page.evaluate(() => {
          const c = document.createElement('canvas'); c.width = 480; c.height = 360; c.getContext('2d').drawImage(document.getElementById('scene'), 0, 0, 480, 360); return c.toDataURL('image/jpeg', 0.8).slice(23); }), 'base64'));
      }
    },
    /** `n` sixtieths of a second (the scripts' unit), with a line of marks every second of the level. */
    async frames(n, each) {
      for (let i = 0, count = steps(n); i < count; i++) {
        await stage.step();
        if (each) await each(i);
        if (marksFile && sinceArrival % fps === 0) await stage.mark();
      }
    },
    async mark(note) {
      const row = await page.evaluate(async () => {
        const v = window.deusExViewer, s = v.status();
        const live = s.ready ? await v.liveProbe({read: {names: ['@player', 'LevelInfo0'], props: ['Location', 'ViewRotation', 'Health', 'TimeSeconds']}}).catch(() => null) : null;
        const con = s.ready ? await v.conversationProbe({}).catch(() => null) : null;
        return {map: s.map, ready: s.ready, time: live?.read?.LevelInfo0?.TimeSeconds ?? null, at: live?.read?.['@player']?.Location ?? null, view: live?.read?.['@player']?.ViewRotation ?? null,
          health: live?.read?.['@player']?.Health ?? null, con: con?.conPlay ? [con.conPlay.con, con.conPlay.event ?? con.conPlay.currentEvent ?? null] : null};
      });
      appendFileSync(marksFile, JSON.stringify({step: stepped, level: sinceArrival, ...(note ? {note} : {}), ...row}) + '\n');
      return row;
    },
    /** Steps until `predicate` holds (asked after every step), for `max` sixtieths at most: the steps taken, or -1. */
    until: async (predicate, max) => {
      for (let i = 0, count = steps(max); i < count; i++) {
        await stage.step();
        if (marksFile && sinceArrival % fps === 0) await stage.mark();
        if (await predicate()) return i + 1;
      }
      return -1;
    },
    async grab(file) {
      writeFileSync(file, Buffer.from(await page.evaluate(() => document.getElementById('scene').toDataURL('image/png').slice(22)), 'base64'));
    },
    /** The steps from here on are the clip `name` (picture: out/<name>/f00001.png ...; both runs: its first and last step). */
    async start(name) {
      await stage.stop();
      const dir = path.join(out, name);
      if (pictures) { rmSync(dir, {recursive: true, force: true}); mkdirSync(dir, {recursive: true}); }
      clip = {name, dir, from: stepped, frames: 0};
    },
    /** The clip ends: its frames, kept by the workers until now, go to the endpoint, and this waits for them (the wall clock runs on
     * meanwhile and the page does not step: its sound plays on, the game stands still). */
    async stop() {
      if (!clip) return;
      clips[clip.name] = {from: clip.from, to: stepped, frames: clip.frames};
      log(`${clip.name}: ${clip.frames} frames (steps ${clip.from} to ${stepped})`);
      clip = null;
      if (pictures) { await page.evaluate(() => window.__grabFlush()); t0 = null; }
    },

    /** The first map, loaded and held: the clock is paused here and the frame loop released, so the first step is the level's first tick. */
    async begin() {
      await page.waitForFunction(() => window.deusExViewer?.status()?.ready, null, {timeout: 300000});
      await page.addStyleTag({content: '#toast, #play-hint { display: none !important; }'});
      // the frames to the queue first: the one frame the clock still owes runs within 16 ms (the loop is held: it only asks again, into the queue)
      await page.evaluate(() => window.__frames.manual());
      await sleep(120);
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      await page.evaluate(() => window.deusExViewer.release());
      const canvas = await page.evaluate(() => { const c = document.getElementById('scene'), b = c.getBoundingClientRect(); return {w: c.width, h: c.height, box: [b.x, b.y, b.width, b.height]}; });
      stage.canvas = canvas;
      return canvas;
    },
    /** A map load (a travel, a loaded game), waited for with the simulation frozen: the new level's first tick is the first step after this,
     * with a dt of 1/60 s and the step phase at its start, in both runs. `started`: steps to give the travel to begin (they are the old level's). */
    async arrive(map, {timeout = 300000, shot = null} = {}) {
      // the travel begins inside a frame; until then the old level ticks, the same number of times in both runs
      let began = false;
      for (let i = 0; i < 600 && !began; i++) { await stage.step(); began = !(await stage.status()).ready; }
      if (!began) throw new Error(`no map load began (waiting for ${map})`);
      await page.evaluate(() => window.deusExViewer.freeze(true));
      const start = Date.now();
      let pumped = 0;
      for (;;) {
        const s = await stage.status();
        if (s.error) throw new Error(`runtime error while loading ${map}: ${s.error}`);
        if (s.ready && (!map || s.map === map)) break;
        if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${map} (at ${s.map})`);
        await pump(17);                                                // the load's own timers and frames; no tick runs
        await sleep(4);
        if (shot && pictures && [3, 8, 16, 30].includes(++pumped)) await stage.grab(shot);    // the loading frame the page shows meanwhile (the last of these reads)
      }
      for (let i = 0; i < 6; i++) { await pump(17); await sleep(4); }
      phase = 0; t0 = null; sinceArrival = 0;
      await page.evaluate(() => window.deusExViewer.freeze(false));
      if (marksFile) appendFileSync(marksFile, JSON.stringify({step: stepped, note: `arrived ${map}`}) + '\n');
    },

    // ---- inputs
    /** The centre of a control of the top window, in page pixels (settingsProbe `center`: drawing-buffer pixels). */
    async control(spec) {
      const {result} = await stage.menu({op: 'center', ...spec});
      if (!result) throw new Error(`no control ${JSON.stringify(spec)} in the top window`);
      const {w, h, box} = stage.canvas;
      return {x: box[0] + result.x * box[2] / w, y: box[1] + result.y * box[3] / h, w: result.w, h: result.h};
    },
    /** The menus' cursor to a point over `n` steps, eased, then a click. The pointer is the page's own (released first, as the page releases it:
     * under the lock the cursor follows relative motion), so the cursor the game draws is where the mouse is. */
    async glide(to, n = 24) {
      if (await page.evaluate(() => Boolean(document.pointerLockElement))) {
        await page.evaluate(() => window.deusExViewer.releasePointer());
        // the browser gives the pointer back in its own time (not the stepped clock's): waited for here, with no step, so both runs go on alike
        for (let i = 0; i < 400 && await page.evaluate(() => Boolean(document.pointerLockElement)); i++) await sleep(5);
        await stage.frames(2);
      }
      const from = stage.mouse ?? {x: stage.canvas.box[0] + stage.canvas.box[2] / 2, y: stage.canvas.box[1] + stage.canvas.box[3] / 2};
      for (let k = 1, count = steps(n); k <= count; k++) {
        const t = k / count, e = t * t * (3 - 2 * t);
        await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
        await stage.step();
      }
      stage.mouse = {x: to.x, y: to.y};
    },
    async click({hold = 4, after = 8, button = 'left'} = {}) {
      await page.mouse.down({button}); await stage.frames(hold); await page.mouse.up({button}); await stage.frames(after);
    },
    async clickControl(spec, {glide = 24, settle = 6, ...rest} = {}) {
      await stage.glide(await stage.control(spec), glide);
      await stage.frames(settle);
      await stage.click(rest);
    },
    async key(key, {hold = 3, after = 6} = {}) { await page.keyboard.down(key); await stage.frames(hold); await page.keyboard.up(key); await stage.frames(after); },
    /** The view to `rotation` over `n` steps, eased, written once a step (the player's own ViewRotation, as a mouse would turn it). */
    async turnTo(rotation, n = 36) {
      const start = (await stage.read(['@player'], ['ViewRotation']))['@player'].ViewRotation;
      for (let k = 1, count = steps(n); k <= count; k++) {
        const t = k / count, e = t * t * (3 - 2 * t);
        await stage.place({rotation: [wrap(start[0] + shortest(start[0], rotation[0]) * e), wrap(start[1] + shortest(start[1], rotation[1]) * e), 0]});
        await stage.step();
        if (marksFile && sinceArrival % fps === 0) await stage.mark();
      }
    },
    async aimAt(actor, n = 20, lift = 0) {
      const r = await stage.read(['@player', actor], ['Location', 'EyeHeight']);
      if (!r[actor]?.Location) return false;
      const eye = r['@player'].Location.map((v, i) => v + (i === 2 ? r['@player'].EyeHeight : 0));
      const d = r[actor].Location.map((v, i) => v - eye[i] + (i === 2 ? lift : 0));
      await stage.turnTo([wrap(units(Math.atan2(d[2], Math.hypot(d[0], d[1])))), wrap(units(Math.atan2(d[1], d[0]))), 0], n);
      return true;
    },

    /** Sound run: the samples recorded so far, appended to sound.f32 (interleaved stereo float32) with their place on the audio clock. */
    async drain() {
      if (!sound) return;
      const got = await page.evaluate(() => {
        const blocks = window.__pcm.splice(0), rate = [...window.__taps.values()][0]?.rate ?? 0;
        return {rate, blocks: blocks.map(b => { const out = new Float32Array(b.left.length * 2); for (let i = 0; i < b.left.length; i++) { out[2 * i] = b.left[i]; out[2 * i + 1] = b.right[i]; }
          let text = ''; const bytes = new Uint8Array(out.buffer); for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return {first: b.first, n: b.left.length, data: btoa(text)}; })};
      });
      for (const block of got.blocks) {
        if (stage.pcmFirst === undefined) stage.pcmFirst = block.first;
        const expected = stage.pcmFirst + pcmWritten;
        if (block.first !== expected) { pcmGaps.push([pcmWritten, block.first - expected]); if (block.first > expected) { const pad = Buffer.alloc((block.first - expected) * 8); appendFileSync(pcmFile, pad); pcmWritten += block.first - expected; } }
        appendFileSync(pcmFile, Buffer.from(block.data, 'base64')); pcmWritten += block.n;
      }
      stage.rate = got.rate || stage.rate;
    },
    /** The copies still being encoded or written. */
    grabs: () => (pictures ? page.evaluate(() => ({...window.__grabState, failed: window.__grabState.failed.slice(0, 5)})) : {pending: 0, encoding: 0, failed: [], sent: 0, written: 0}),
    async close() {
      await stage.stop();
      if (pictures) {
        const g = await stage.grabs();
        log(`pictures: ${g.sent} frames read, ${g.written} written, ${g.pending} not written, ${g.failed.length} failed${g.failed.length ? ' ' + JSON.stringify(g.failed) : ''}`);
        stage.grabbed = g;
      }
      if (sound) { await sleep(400); await stage.drain(); }
      if (out && !dry) {
        writeFileSync(path.join(out, 'take.json'), JSON.stringify({canvas: stage.canvas, fps, clips, steps: stepped, pictures: stage.grabbed ?? null,
          sound: sound ? {rate: stage.rate, firstFrame: stage.pcmFirst ?? null, frames: pcmWritten, gaps: pcmGaps} : null, lateSteps: late, worstLateMs: Math.round(worst), resets, audioClock}));
        if (sound) log(`sound: ${(pcmWritten / (stage.rate || 44100)).toFixed(1)} s at ${stage.rate} Hz, ${pcmGaps.length} gaps ${JSON.stringify(pcmGaps)}`);
        log(`${late} of ${stepped} steps over 6 ms late (worst ${Math.round(worst)} ms)`);
      }
      if (errors.length) log('page errors:', errors.slice(0, 5));
      await browser.close(); await server.close();
      rmSync(profile, {recursive: true, force: true});
    },
  };
  return stage;
}
