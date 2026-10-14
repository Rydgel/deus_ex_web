/** Opt-in frame-hitch recorder (?hitchlog=1; docs/hitch-log.md). It records,
 * per display frame, the frame interval, the page's phase times, the
 * simulation worker's frame record and step times, the time spent in WebGL
 * calls that can block (shader compile and link, uploads, syncs, draws), and
 * per second the heaps, wasm memories, renderer resource counts, new shader
 * programs, long tasks and long animation frames. Ctrl+Shift+H (or
 * `deusExHitch.download()`) saves a compact JSON.
 *
 * Without the URL switch this module does nothing but export `hitchEnabled =
 * false`: no WebGL wrapper, no observer, no per-frame call (main.mjs guards
 * every hook with `hitch?.`). It is imported first so that the WebGL and
 * WebAssembly wrappers precede the first context and the first memory.
 * Measurement only; it changes no simulation state. */
import { watchWasm, wasmBytes, wasmCount } from './hitch-wasm.mjs';

const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('hitchlog');
export const hitchEnabled = param !== null && param !== '0' && param !== 'off';

// ---- WebGL wrappers --------------------------------------------------------
const SLOW_GL_MS = 2, MAX_EVENTS = 4000;
const GL_GROUPS = {
  compile: ['compileShader', 'linkProgram', 'getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'getShaderInfoLog',
    'validateProgram', 'createProgram', 'createShader', 'shaderSource', 'attachShader', 'deleteProgram', 'deleteShader'],
  program: ['useProgram', 'getUniformLocation', 'getAttribLocation', 'getUniformBlockIndex', 'getActiveUniform', 'getActiveAttrib'],
  upload: ['texImage2D', 'texImage3D', 'texSubImage2D', 'texSubImage3D', 'compressedTexImage2D', 'compressedTexSubImage2D', 'texStorage2D',
    'texStorage3D', 'bufferData', 'bufferSubData', 'copyTexSubImage2D', 'copyTexImage2D', 'copyTexSubImage3D', 'generateMipmap', 'copyBufferSubData'],
  sync: ['readPixels', 'finish', 'flush', 'clientWaitSync', 'getSyncParameter', 'fenceSync', 'getParameter', 'getError', 'getQueryParameter',
    'checkFramebufferStatus', 'getBufferSubData'],
  draw: ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear', 'clearBufferfv',
    'clearBufferuiv', 'clearBufferiv', 'clearBufferfi', 'blitFramebuffer', 'invalidateFramebuffer'],
};
const GL_COUNTED = ['createTexture', 'createBuffer', 'createFramebuffer', 'createRenderbuffer', 'createVertexArray', 'createQuery', 'createSampler',
  'deleteTexture', 'deleteBuffer', 'deleteFramebuffer', 'deleteRenderbuffer', 'deleteVertexArray', 'deleteQuery', 'deleteSampler'];
// What the GL wrappers have seen since the recorder last drained them.
const gl = { ms: { compile: 0, program: 0, upload: 0, sync: 0, draw: 0 }, n: { compile: 0, program: 0, upload: 0, sync: 0, draw: 0 },
  uploadBytes: 0, counted: Object.fromEntries(GL_COUNTED.map(name => [name, 0])), slow: [] };
const bytesOf = args => {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (a && typeof a === 'object') {
      if (typeof a.byteLength === 'number') return a.byteLength;
      if (typeof a.width === 'number' && typeof a.height === 'number') return a.width * a.height * 4;
    } else if (i === 1 && typeof a === 'number' && args.length === 3) return a; // bufferData(target, size, usage)
  }
  return 0;
};
function installGlWatch() {
  const proto = globalThis.WebGL2RenderingContext?.prototype;
  if (!proto) return;
  for (const [group, names] of Object.entries(GL_GROUPS)) {
    for (const name of names) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      const counts = group === 'upload';
      proto[name] = function () {
        const t0 = performance.now();
        const result = original.apply(this, arguments);
        const ms = performance.now() - t0;
        gl.ms[group] += ms; gl.n[group]++;
        if (counts) gl.uploadBytes += bytesOf(arguments);
        if (ms >= SLOW_GL_MS && gl.slow.length < MAX_EVENTS) gl.slow.push({ t: t0, fn: name, ms });
        return result;
      };
    }
  }
  for (const name of GL_COUNTED) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    proto[name] = function () { gl.counted[name]++; return original.apply(this, arguments); };
  }
}
if (hitchEnabled) { watchWasm(); installGlWatch(); }

// ---- the recorder ------------------------------------------------------------
const PAGE_KEYS = ['tick', 'lighting', 'sprites', 'actors', 'lightAnimation', 'textures', 'lightUpload', 'fog', 'mirrors', 'render', 'coronas',
  'weapon', 'hud', 'ramp', 'audio'];
const WORKER_KEYS = ['tick', 'lighting', 'sprites', 'actors', 'mirrors', 'coronas', 'weapon', 'hud', 'audio'];
const COLUMNS = ['t', 'dt', 'drawn', 'animate', ...PAGE_KEYS.map(k => `p.${k}`), 'gpu',
  'gl.compile', 'gl.program', 'gl.upload', 'gl.sync', 'gl.draw', 'gl.uploadMB', 'gl.uploadN', 'gl.drawN',
  'w.start', 'w.dur', 'w.posts', 'w.dt', 'w.lat', 'w.age', 'w.status', 'w.wasmMB', ...WORKER_KEYS.map(k => `w.${k}`), 'outstanding', 'waiting'];
const NCOL = COLUMNS.length, MAX_ROWS = 96000, MAX_SECONDS = 7200;
const COLUMN_INDEX = Object.fromEntries(COLUMNS.map((name, i) => [name, i])), ci = name => COLUMN_INDEX[name];
const I_W_DUR = ci('w.dur');
const I_W_POSTS = ci('w.posts');
const I_W_LAT = ci('w.lat');
const I_OUTSTANDING = ci('outstanding');
const I_WAITING = ci('waiting');
const I_GL_COMPILE = ci('gl.compile');
const I_GL_UPLOAD = ci('gl.upload');
const I_GL_SYNC = ci('gl.sync');
const I_GL_DRAW = ci('gl.draw');
const I_GL_UPLOADMB = ci('gl.uploadMB');
const round = v => Math.round(v * 100) / 100;

export function createHitchLog() {
  const rows = new Float32Array(MAX_ROWS * NCOL);
  let count = 0, ctx = null, origin = 0, lastTime = 0, lastDrawn = null;
  const previous = new Float64Array(PAGE_KEYS.length + 3);
  let pending = null;
  const seconds = [], events = [];
  const meta = { started: new Date().toISOString(), columns: COLUMNS, pageKeys: PAGE_KEYS, workerKeys: WORKER_KEYS };
  const seenPrograms = new Set(), programKeys = [];
  let secondStart = 0, secondFrames = 0, secondDrawn = 0, secondDtMax = 0, secondTasks = 0, secondLoaf = 0;
  // Per-second maxima and sums, so the whole session's table can say what a slow second was doing.
  const sec = { animMax: 0, wMax: 0, wPostsMax: 0, wLatMax: 0, outMax: 0, waitMax: 0, compile: 0, upload: 0, sync: 0, draw: 0, uploadMB: 0, phaseMax: 0, phaseKey: '' };
  const secondCreated = {};
  let hitches = 0, overlay = null, lastMap = null, workerWasm = 0, workerMems = 0, lastProgramsLength = -1;
  const push = event => { if (events.length < MAX_EVENTS * 3) events.push(event); };

  function attach(context) {
    ctx = context; origin = performance.now(); meta.originMs = origin;
    const renderer = ctx.renderer, glc = renderer.getContext();
    try {
      const info = glc.getExtension('WEBGL_debug_renderer_info');
      Object.assign(meta, { glVersion: glc.getParameter(glc.VERSION), glRenderer: info ? glc.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
        glVendor: info ? glc.getParameter(info.UNMASKED_VENDOR_WEBGL) : null });
    } catch { /* optional */ }
    Object.assign(meta, { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null,
      screen: [screen.width, screen.height], devicePixelRatio, crossOriginIsolated, url: location.search, hasMemoryApi: Boolean(performance.memory),
      pixelRatio: renderer.getPixelRatio(), canvas: [renderer.domElement.width, renderer.domElement.height], threeRevision: ctx.threeRevision ?? null });
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) { secondTasks++; push({ t: round(e.startTime - origin), kind: 'longtask', ms: round(e.duration) }); }
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* not supported */ }
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          secondLoaf++;
          const scripts = (e.scripts ?? []).slice().sort((a, b) => b.duration - a.duration).slice(0, 3)
            .map(s => ({ fn: s.sourceFunctionName || s.invoker || '', url: String(s.sourceURL ?? '').split('/').pop().split('?')[0], ms: round(s.duration),
              forced: round(s.forcedStyleAndLayoutDuration ?? 0), type: s.invokerType ?? '' }));
          push({ t: round(e.startTime - origin), kind: 'loaf', ms: round(e.duration), blocking: round(e.blockingDuration ?? 0),
            renderStart: e.renderStart ? round(e.renderStart - e.startTime) : null, styleStart: e.styleAndLayoutStart ? round(e.styleAndLayoutStart - e.startTime) : null, scripts });
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch { /* not supported */ }
    for (const name of ['visibilitychange', 'focus', 'blur', 'resize', 'pointerlockchange'])
      window.addEventListener(name, () => push({ t: round(performance.now() - origin), kind: name, visible: document.visibilityState, focus: document.hasFocus() }), true);
    window.addEventListener('keydown', event => {
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyH') { event.stopImmediatePropagation(); event.preventDefault(); if (!event.repeat) download(); }
    }, true);
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:11px/1.3 monospace;color:#9fe;background:rgba(0,0,0,.55);padding:3px 6px;border-radius:3px;pointer-events:none;white-space:pre';
    document.body.appendChild(overlay);
    window.deusExHitch = { download, dump, status: () => ({ frames: count, seconds: seconds.length, events: events.length, hitches }), events: () => events, seconds: () => seconds };
  }

  function frameStart() { /* the frame's own timestamp arrives with frameEnd; wrappers need no reset */ }

  /** The snapshot the page is about to draw: the worker's frame record and
   * step times, and the client's queue depths. */
  function snapshot(snap) {
    const client = ctx?.client();
    pending = { hitch: snap.hitch ?? null, timings: snap.timings ?? null, outstanding: client?.outstanding ?? 0, waiting: client?.waiting ?? 0 };
    if (snap.hitch) { workerWasm = snap.hitch.wasm; workerMems = snap.hitch.mems; }
  }

  function frameEnd(time) {
    const phases = ctx.framePhases;
    const drawn = pending ? 1 : 0;
    const base = (count % MAX_ROWS) * NCOL;
    let c = base;
    const dt = lastTime ? time - lastTime : 0;
    lastTime = time;
    rows[c++] = time - origin; rows[c++] = dt; rows[c++] = drawn;
    // Phase deltas: framePhases only grows (a reset by another reader restarts the baseline).
    let k = 0;
    const delta = value => { const prev = previous[k]; previous[k++] = value; return value >= prev ? value - prev : value; };
    rows[c++] = delta(phases.total);
    for (const key of PAGE_KEYS) rows[c++] = delta(phases[key] ?? 0);
    rows[c++] = delta(phases.gpu ?? 0);
    rows[c++] = gl.ms.compile; rows[c++] = gl.ms.program; rows[c++] = gl.ms.upload; rows[c++] = gl.ms.sync; rows[c++] = gl.ms.draw;
    rows[c++] = gl.uploadBytes / 1048576; rows[c++] = gl.n.upload; rows[c++] = gl.n.draw;
    for (const key in gl.ms) { gl.ms[key] = 0; gl.n[key] = 0; }
    gl.uploadBytes = 0;
    for (const name in gl.counted) { if (gl.counted[name]) { secondCreated[name] = (secondCreated[name] ?? 0) + gl.counted[name]; gl.counted[name] = 0; } }
    if (gl.slow.length) { for (const e of gl.slow) push({ t: round(e.t - origin), kind: 'slowGL', fn: e.fn, ms: round(e.ms) }); gl.slow.length = 0; }
    const h = pending?.hitch;
    if (h) {
      const start = h.start - performance.timeOrigin;
      rows[c++] = start - origin; rows[c++] = h.end - h.start; rows[c++] = h.posts; rows[c++] = h.dt * 1000; rows[c++] = start - h.sent; rows[c++] = start - h.firstSent;
      rows[c++] = h.status ? 1 : 0; rows[c++] = h.wasm / 1048576;
    } else for (let i = 0; i < 8; i++) rows[c++] = -1;
    for (const key of WORKER_KEYS) rows[c++] = pending?.timings?.[key] ?? -1;
    rows[c++] = pending?.outstanding ?? -1; rows[c++] = pending?.waiting ?? -1;
    {
      const animate = rows[base + 3];
      if (animate > sec.animMax) sec.animMax = animate;
      const wDur = rows[base + I_W_DUR];
      if (wDur > sec.wMax) sec.wMax = wDur;
      if (rows[base + I_W_POSTS] > sec.wPostsMax) sec.wPostsMax = rows[base + I_W_POSTS];
      if (rows[base + I_W_LAT] > sec.wLatMax) sec.wLatMax = rows[base + I_W_LAT];
      if (rows[base + I_OUTSTANDING] > sec.outMax) sec.outMax = rows[base + I_OUTSTANDING];
      if (rows[base + I_WAITING] > sec.waitMax) sec.waitMax = rows[base + I_WAITING];
      sec.compile += rows[base + I_GL_COMPILE]; sec.upload += rows[base + I_GL_UPLOAD]; sec.sync += rows[base + I_GL_SYNC];
      sec.draw += rows[base + I_GL_DRAW]; sec.uploadMB += rows[base + I_GL_UPLOADMB];
      for (let i = 0; i < PAGE_KEYS.length; i++) { const v = rows[base + 4 + i]; if (v > sec.phaseMax) { sec.phaseMax = v; sec.phaseKey = PAGE_KEYS[i]; } }
    }
    pending = null;
    count++;

    // New shader programs (three keeps one per cache key; a growing id means a compile).
    const programs = ctx.renderer.info.programs;
    if (programs && programs.length !== lastProgramsLength) {
      lastProgramsLength = programs.length;
      for (const program of programs) if (!seenPrograms.has(program.id)) {
        seenPrograms.add(program.id);
        const entry = { t: round(time - origin), kind: 'program', id: program.id, name: program.name ?? '', key: (key => key.length > 260 ? `${key.slice(0, 80)} ... ${key.slice(-170)}` : key)(String(program.cacheKey ?? '')) };
        push(entry); programKeys.push(entry);
      }
    }
    // Per-second table.
    secondFrames++; if (drawn) secondDrawn++;
    if (dt > secondDtMax) secondDtMax = dt;
    if (dt > 100 && drawn) hitches++;
    if (!secondStart) secondStart = time;
    if (time - secondStart >= 1000) {
      const mem = performance.memory, info = ctx.renderer.info, status = ctx.status();
      const music = ctx.music();
      if (status.map !== lastMap) { push({ t: round(time - origin), kind: 'map', map: status.map }); lastMap = status.map; }
      if (seconds.length < MAX_SECONDS) seconds.push({ t: round(time - origin), frames: secondFrames, drawn: secondDrawn, dtMax: round(secondDtMax),
        animMax: round(sec.animMax), wMax: round(sec.wMax), wPostsMax: sec.wPostsMax, wLatMax: round(sec.wLatMax), outMax: sec.outMax, waitMax: sec.waitMax,
        glCompileMs: round(sec.compile), glUploadMs: round(sec.upload), glSyncMs: round(sec.sync), glDrawMs: round(sec.draw), glUploadMB: round(sec.uploadMB),
        phaseMax: round(sec.phaseMax), phaseKey: sec.phaseKey,
        heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null, heapTotalMB: mem ? Math.round(mem.totalJSHeapSize / 1048576) : null,
        heapLimitMB: mem ? Math.round(mem.jsHeapSizeLimit / 1048576) : null,
        wasmPageMB: Math.round(wasmBytes() / 1048576), wasmPageMems: wasmCount(), wasmWorkerMB: Math.round(workerWasm / 1048576), wasmWorkerMems: workerMems,
        geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? null, calls: info.render.calls,
        triangles: info.render.triangles, created: { ...secondCreated }, longTasks: secondTasks, loaf: secondLoaf,
        focus: document.hasFocus(), visible: document.visibilityState, map: status.map, paused: status.paused, error: status.error, position: status.position,
        underruns: music?.underruns ?? null, audioFill: music?.fill ?? null });
      for (const key in secondCreated) delete secondCreated[key];
      Object.assign(sec, { animMax: 0, wMax: 0, wPostsMax: 0, wLatMax: 0, outMax: 0, waitMax: 0, compile: 0, upload: 0, sync: 0, draw: 0, uploadMB: 0, phaseMax: 0, phaseKey: '' });
      secondStart = time; secondFrames = 0; secondDrawn = 0; secondDtMax = 0; secondTasks = 0; secondLoaf = 0;
      if (overlay) overlay.textContent = `hitchlog ${Math.round((time - origin) / 1000)} s, ${hitches} gaps > 100 ms\nCtrl+Shift+H saves the log`;
    }
  }

  function rowAt(i) { // i-th recorded frame (0 = oldest kept)
    const first = Math.max(0, count - MAX_ROWS);
    const at = ((first + i) % MAX_ROWS) * NCOL, row = new Array(NCOL);
    for (let c = 0; c < NCOL; c++) row[c] = rows[at + c];
    return row;
  }

  /** The log as plain data: per-second table, events, a summary and the
   * per-frame rows around every hitch (all rows with `full`). */
  function dump({ full = false } = {}) {
    const kept = Math.min(count, MAX_ROWS), iT = 0, iDt = 1, iDrawn = 2;
    const all = [];
    for (let i = 0; i < kept; i++) all.push(rowAt(i));
    // Draw-to-draw gaps: what the player sees.
    const gaps = [];
    let lastDraw = null;
    for (const r of all) { if (r[iDrawn]) { if (lastDraw !== null) gaps.push(r[iT] - lastDraw); lastDraw = r[iT]; } }
    const sorted = gaps.slice().sort((a, b) => a - b), q = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
    const median = q(0.5), limit = Math.max(60, 2.5 * median);
    // Ranges around hitches and around slow seconds.
    const ranges = [];
    lastDraw = null;
    for (const r of all) if (r[iDrawn]) {
      if (lastDraw !== null && r[iT] - lastDraw > limit) ranges.push({ from: lastDraw - 1500, to: r[iT] + 1500, gap: r[iT] - lastDraw });
      lastDraw = r[iT];
    }
    const secDrawn = seconds.map(s => s.drawn).sort((a, b) => a - b), secMedian = secDrawn.length ? secDrawn[secDrawn.length >> 1] : 0;
    for (const s of seconds) if (secMedian && s.drawn < 0.6 * secMedian) ranges.push({ from: s.t - 1000, to: s.t + 1500, gap: 0 });
    ranges.sort((a, b) => b.gap - a.gap);
    const merged = [];
    for (const range of ranges.slice(0, 80)) merged.push(range);
    const last = all.length ? all[all.length - 1][iT] : 0;
    merged.push({ from: last - 15000, to: last + 1 });
    const include = new Set();
    if (full) for (let i = 0; i < all.length; i++) include.add(i);
    else for (const range of merged) for (let i = 0; i < all.length && include.size < 14000; i++) if (all[i][iT] >= range.from && all[i][iT] <= range.to) include.add(i);
    const picked = [...include].sort((a, b) => a - b).map(i => all[i].map(round));
    const summary = { frames: count, drawn: all.reduce((n, r) => n + r[iDrawn], 0), drawGapMs: { p50: round(median), p95: round(q(0.95)), p99: round(q(0.99)), max: round(sorted.at(-1) ?? 0) },
      gapsOver: Object.fromEntries([33, 50, 100, 200, 500, 1000].map(x => [x, gaps.filter(g => g > x).length])), seconds: seconds.length,
      programsCreated: programKeys.length };
    return { meta: { ...meta, saved: new Date().toISOString(), elapsedS: round((performance.now() - origin) / 1000) }, summary, columns: COLUMNS, seconds, events,
      programs: programKeys, hitchLimitMs: round(limit), rows: picked };
  }

  function download(options) {
    const data = dump(options);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `deusex-hitchlog-${(ctx.status().map ?? 'nomap')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 20000);
  }

  return { attach, frameStart, snapshot, frameEnd, dump, download };
}
