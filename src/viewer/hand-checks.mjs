/** Opt-in recorder for Stage 7's checks by hand (?checks=1; docs/stage-7-hand-checks.md). The person doing the checks only acts (hides
 * the tab, sleeps the machine, presses Escape, zooms, picks a folder, answers the persistence prompt); this records what each row needs
 * to see and the panel's Copy report button gives one text to paste back.
 *
 * What it records, all through what the page already exposes or the browser's own events:
 *   - the browser's events: visibilitychange, freeze and resume (Chromium's page lifecycle), pagehide and pageshow, focus and blur,
 *     resize, pointerlockchange and pointerlockerror, fullscreenchange and fullscreenerror, a change of the device pixel ratio (a
 *     resolution query, as main.mjs watchPixelRatio), mediaDevices devicechange, the game folder input's change, and the keys the rows
 *     name (Escape, F11, Alt+Enter, W), with their repeat flag and the pointer lock and fullscreen at the time;
 *   - once a second (setInterval, which a hidden page may slow): the page's read probes, `deusExViewer.status()` (the map, mode, pause,
 *     runtime error, drawn frame count, the view's position, the audio context, the music worklet's quanta and underruns, the saves'
 *     source, folder and persistence) and, while the page is visible, `deusExViewer.viewProbe({})` for the level's TimeSeconds;
 *   - the wall clock beside the page clock, so that a stop of the whole page (system sleep) shows as a gap in the one-second ticks.
 *
 * Measurement only: passive listeners that call nothing of the page's and prevent nothing, read probes (viewProbe is a read on the
 * simulation side), and a one-line panel fixed in a corner, outside the canvas. The log is kept in sessionStorage so that a reload (the
 * 7.8.2 check) does not lose it. Without the URL switch this module does nothing but export `checksEnabled = false`. */

const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('checks');
export const checksEnabled = param !== null && param !== '0' && param !== 'off';

const STORE = 'deusex-hand-checks', MAX_EVENTS = 5000, MAX_SAMPLES = 7200, SLEEP_GAP_S = 3;

// The recorder must never stop the page: a failure here is logged and the page goes on without it
if (checksEnabled) { try { startRecorder(); } catch (error) { console.error('hand-checks recorder:', error); } }

function startRecorder() {
  let panel = null, count = null, persistedNow = 'not read';
  const panelUpdate = () => { if (count) count.textContent = `${log.events.length} events`; };
  const started = Date.now();
  const log = load() ?? { started: new Date(started).toISOString(), loads: [], events: [], samples: [] };
  log.loads.push({ at: new Date(started).toISOString(), url: location.href, userAgent: navigator.userAgent });
  // t: seconds since the first load of this tab's log (the wall clock, which goes on through a sleep); perf: the page clock of this load
  const origin = Date.parse(log.started);
  const now = () => ({ t: round((Date.now() - origin) / 1000), perf: round(performance.now() / 1000), load: log.loads.length });
  const state = () => ({ hidden: document.hidden, locked: Boolean(document.pointerLockElement), fullscreen: Boolean(document.fullscreenElement) });
  const event = (kind, detail = {}) => {
    log.events.push({ ...now(), kind, ...state(), ...detail });
    if (log.events.length > MAX_EVENTS) log.events.splice(0, log.events.length - MAX_EVENTS);
    panelUpdate();
  };
  event('load', { dpr: devicePixelRatio, window: [innerWidth, innerHeight], screen: [screen.width, screen.height] });

  // ---- the browser's events
  document.addEventListener('visibilitychange', () => { event(document.hidden ? 'hidden' : 'visible'); sample(true); }, true);
  document.addEventListener('freeze', () => event('freeze'), true);
  document.addEventListener('resume', () => event('resume'), true);
  addEventListener('pagehide', e => event('pagehide', { persisted: e.persisted }), true);
  addEventListener('pageshow', e => event('pageshow', { persisted: e.persisted }), true);
  addEventListener('focus', e => { if (e.target === window) event('focus'); }, true);   // the window's, not an element's
  addEventListener('blur', e => { if (e.target === window) event('blur'); }, true);
  addEventListener('resize', () => event('resize', { window: [innerWidth, innerHeight], dpr: devicePixelRatio, canvas: canvasSize() }));
  document.addEventListener('pointerlockchange', () => event(document.pointerLockElement ? 'pointer-locked' : 'pointer-released'), true);
  document.addEventListener('pointerlockerror', () => event('pointer-lock-error'), true);
  document.addEventListener('fullscreenchange', () => event(document.fullscreenElement ? 'fullscreen-entered' : 'fullscreen-left',
    { window: [innerWidth, innerHeight], canvas: canvasSize() }), true);
  document.addEventListener('fullscreenerror', () => event('fullscreen-error'), true);
  (function watchRatio() {
    const was = devicePixelRatio;
    matchMedia(`(resolution: ${was}dppx)`).addEventListener('change', () => {
      event('pixel-ratio', { from: was, to: devicePixelRatio, window: [innerWidth, innerHeight] });
      // the page resizes its canvas on the same query (main.mjs watchPixelRatio): read the result once it has
      setTimeout(() => event('pixel-ratio-canvas', { dpr: devicePixelRatio, canvas: canvasSize() }), 500);
      watchRatio();
    }, { once: true });
  })();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => event('audio-device-change'));
  document.addEventListener('change', e => {
    const input = e.target;
    if (input?.type !== 'file') return;
    const files = input.files ? [...input.files] : [];
    event('folder-picked', { input: input.id || null, files: files.length, top: files[0]?.webkitRelativePath?.split('/')[0] ?? null });
  }, true);
  const KEYS = new Set(['Escape', 'F11', 'Enter', 'KeyW']);
  for (const type of ['keydown', 'keyup']) addEventListener(type, e => {
    if (!KEYS.has(e.code) || (e.code === 'Enter' && !e.altKey)) return;
    if (type === 'keydown' && e.repeat && e.code !== 'Escape') return;          // Escape's repeats are what 7.6.2's held press is about
    event(type, { code: e.code, repeat: e.repeat, alt: e.altKey });
  }, { capture: true, passive: true });
  addEventListener('error', e => { if (e instanceof ErrorEvent) event('page-error', { message: String(e.message).slice(0, 300) }); }, true);   // not a resource's load failure
  addEventListener('unhandledrejection', e => event('page-rejection', { message: String(e.reason?.message ?? e.reason).slice(0, 300) }), true);

  // ---- once a second: the page's read probes, and the wall clock's gaps
  let lastTick = Date.now(), lastPerf = performance.now(), last = null, probing = false;
  async function sample(force = false) {
    const wall = Date.now(), perf = performance.now();
    const gap = (wall - lastTick) / 1000, perfGap = (perf - lastPerf) / 1000;
    lastTick = wall; lastPerf = perf;
    if (!force && gap > SLEEP_GAP_S && !document.hidden) event('stopped', { wallGap: round(gap), pageClockGap: round(perfGap) });
    const viewer = window.deusExViewer;
    let s = null;
    try { s = viewer?.status?.() ?? null; } catch (error) { s = { probeError: String(error?.message ?? error) }; }
    const row = { ...now(), hidden: document.hidden };
    if (s) {
      const worklet = s.music?.output?.worklet ?? null;
      Object.assign(row, {
        map: s.map ?? null, mode: s.mode ?? null, paused: Boolean(s.paused), error: s.runtimeError?.message ?? (s.runtimeError ? String(s.runtimeError) : null),
        frame: s.frame ?? null, position: Array.isArray(s.position) ? s.position.map(Math.round) : null,
        context: s.music?.context ?? s.audio?.contextState ?? null, quanta: worklet?.quanta ?? null, underruns: worklet?.underruns ?? null,
        fault: worklet?.fault ?? null, saves: s.saves ? { source: s.saves.source ?? null, folder: s.saves.folder?.name ?? s.saves.folder ?? null,
          persisted: s.saves.persisted ?? null, message: s.saves.message ?? null, error: s.saves.error ?? s.saves.saveError ?? null } : null,
        graphicsLost: s.graphics?.lost ?? null, probeError: s.probeError ?? null,
      });
    }
    // the level's clock, read on the simulation side; not while hidden (a hidden page's worker does not tick, and a read then says nothing)
    if (!document.hidden && !probing && viewer?.viewProbe && s?.map) {
      probing = true;
      try { const v = await Promise.race([viewer.viewProbe({}), new Promise(r => setTimeout(() => r(null), 800))]);
        if (v) { row.timeSeconds = v.timeSeconds ?? null; row.timeDilation = v.timeDilation ?? null; } } catch { /* not in Play yet */ }
      probing = false;
    }
    log.samples.push(row);
    if (log.samples.length > MAX_SAMPLES) log.samples.splice(0, log.samples.length - MAX_SAMPLES);
    // changes worth an event of their own
    if (last) {
      for (const [key, kind] of [['context', 'audio-context'], ['map', 'map'], ['mode', 'mode'], ['paused', 'paused'], ['error', 'runtime-error'],
        ['graphicsLost', 'graphics-lost']]) if (row[key] !== undefined && row[key] !== last[key]) event(kind, { from: last[key] ?? null, to: row[key] ?? null });
      const a = JSON.stringify(last.saves ?? null), b = JSON.stringify(row.saves ?? null);
      if (a !== b) event('saves', { from: last.saves ?? null, to: row.saves ?? null });
      if (row.underruns !== null && last.underruns !== null && row.underruns > last.underruns) event('audio-underrun', { underruns: row.underruns });
    }
    last = row;
    save();
  }
  setInterval(() => sample(false), 1000);

  // ---- the report
  function report() {
    const lines = [];
    const env = log.loads[0];
    lines.push('# Stage 7 checks by hand: recorder report', '',
      `- recorded from ${log.started}, ${round((Date.now() - origin) / 1000)} s, ${log.loads.length} page load(s), ${log.events.length} events, ${log.samples.length} samples`,
      `- browser: ${env.userAgent}`, `- platform: ${navigator.platform}, screen ${screen.width}x${screen.height}, now: dpr ${devicePixelRatio}, window ${innerWidth}x${innerHeight}`,
      `- persisted storage (navigator.storage.persisted at the report): ${persistedNow}`, '');
    lines.push(...summaries(), '', '## Events', '', 't (s) | load | event | hidden locked fullscreen | detail', '--- | --- | --- | --- | ---');
    for (const e of log.events) {
      const { t, perf, load, kind, hidden, locked, fullscreen, ...rest } = e;
      lines.push(`${t} | ${load} | ${kind} | ${flag(hidden)}${flag(locked)}${flag(fullscreen)} | ${JSON.stringify(rest)}`);
    }
    return lines.join('\n');
  }
  const readPersisted = () => navigator.storage?.persisted?.().then(v => { persistedNow = v; }, () => { persistedNow = 'error'; });
  readPersisted();

  // Per row, the facts the checks look for (no verdicts: they are read against docs/stage-7-hand-checks.md)
  function summaries() {
    const out = [], ev = log.events, sm = log.samples;
    const at = t => sm.filter(s => s.t <= t).at(-1) ?? null, after = t => sm.find(s => s.t >= t) ?? null;
    const timed = (t0, t1) => sm.filter(s => s.t >= t0 && s.t <= t1 && s.timeSeconds != null);
    // hidden intervals (7.5.1, 7.6.1, 7.6.4)
    out.push('## Hidden page (7.5.1, 7.6.1, 7.6.4)', '');
    let any = false;
    for (let i = 0; i < ev.length; i++) {
      if (ev[i].kind !== 'hidden') continue;
      const show = ev.slice(i + 1).find(e => e.kind === 'visible' && e.load === ev[i].load);
      if (!show) { out.push(`- hidden at ${ev[i].t} s, not shown again in this load`); any = true; continue; }
      any = true;
      const before = timed(ev[i].t - 5, ev[i].t).at(-1), back = timed(show.t + 1, show.t + 8);
      const firstBack = back[0], laterBack = back.at(-1);
      const b = at(ev[i].t), a = after(show.t + 0.01), a2 = sm.find(s => s.t >= show.t + 2) ?? null;
      const advanced = before && firstBack ? round((firstBack.timeSeconds - before.timeSeconds) / (firstBack.timeDilation || 1)) : null;
      const walked = a && a2 && a.position && a2.position ? round(Math.hypot(...a2.position.map((v, k) => v - a.position[k]))) : null;
      const wHeld = ev.slice(0, i + 1).filter(e => e.code === 'KeyW').at(-1)?.kind === 'keydown';
      out.push(`- hidden ${ev[i].t} to ${show.t} s (${round(show.t - ev[i].t)} s): level time ${before?.timeSeconds ?? '?'} before, ${firstBack?.timeSeconds ?? '?'} at the first read after (${firstBack ? round(firstBack.t - show.t) : '?'} s after showing), advanced ${advanced ?? '?'} s of game time over ${firstBack && before ? round(firstBack.t - before.t) : '?'} s of wall time, of which ${firstBack && before ? round(firstBack.t - before.t - (show.t - ev[i].t)) : '?'} s visible (no catch-up: the advance is about the visible time); ` +
        `frames ${b?.frame ?? '?'} -> ${a?.frame ?? '?'} -> ${a2?.frame ?? '?'} (2 s later); music context ${b?.context ?? '?'} -> ${a?.context ?? '?'}, quanta ${b?.quanta ?? '?'} -> ${a?.quanta ?? '?'} -> ${a2?.quanta ?? '?'}; ` +
        `W ${wHeld ? 'held when hidden' : 'not held'}, the view moved ${walked ?? '?'} units in the 2 s after showing` +
        (laterBack && firstBack && laterBack !== firstBack ? `; game time then ran ${round((laterBack.timeSeconds - firstBack.timeSeconds) / (laterBack.timeDilation || 1))} s in ${round(laterBack.t - firstBack.t)} s` : ''));
    }
    if (!any) out.push('- none');
    // stops of the whole page: system sleep (7.6.4)
    out.push('', '## Page stopped while visible: system sleep (7.6.4)', '');
    const stops = ev.filter(e => e.kind === 'stopped');
    if (!stops.length) out.push('- none');
    for (const e of stops) {
      const before = timed(e.t - e.wallGap - 5, e.t - e.wallGap + 0.5).at(-1), back = timed(e.t + 1, e.t + 8)[0];
      out.push(`- at ${e.t} s: the one-second tick was ${e.wallGap} s late (page clock ${e.pageClockGap} s): level time ${before?.timeSeconds ?? '?'} -> ${back?.timeSeconds ?? '?'}` +
        ` (advanced ${before && back ? round((back.timeSeconds - before.timeSeconds) / (back.timeDilation || 1)) : '?'} s); music context after: ${after(e.t)?.context ?? '?'}`);
    }
    // audio (7.5.1)
    out.push('', '## Audio (7.5.1)', '');
    const audio = ev.filter(e => ['audio-context', 'audio-device-change', 'audio-underrun'].includes(e.kind));
    if (!audio.length) out.push('- no change of the audio context, device or underruns');
    for (const e of audio) out.push(`- ${e.t} s: ${e.kind} ${JSON.stringify({ from: e.from, to: e.to, underruns: e.underruns })}`);
    const lastSample = sm.at(-1);
    out.push(`- now: context ${lastSample?.context ?? '?'}, quanta ${lastSample?.quanta ?? '?'}, underruns ${lastSample?.underruns ?? '?'}, fault ${lastSample?.fault ?? '?'}`);
    // Escape and the pointer (7.6.1, 7.6.2)
    out.push('', '## Escape, the pointer and fullscreen (7.6.1, 7.6.2)', '');
    const keyed = ev.filter(e => ['keydown', 'keyup', 'pointer-locked', 'pointer-released', 'pointer-lock-error', 'fullscreen-entered', 'fullscreen-left',
      'fullscreen-error', 'mode', 'paused', 'blur', 'focus'].includes(e.kind));
    const escapes = ev.filter(e => e.kind === 'keydown' && e.code === 'Escape');
    out.push(`- Escape keydowns the page received: ${escapes.length} (${escapes.filter(e => e.locked).length} while the pointer was locked, ${escapes.filter(e => e.fullscreen).length} in fullscreen, ${escapes.filter(e => e.repeat).length} repeats)`);
    out.push(`- pointer locks ${ev.filter(e => e.kind === 'pointer-locked').length}, releases ${ev.filter(e => e.kind === 'pointer-released').length}, errors ${ev.filter(e => e.kind === 'pointer-lock-error').length}; fullscreen entered ${ev.filter(e => e.kind === 'fullscreen-entered').length}, left ${ev.filter(e => e.kind === 'fullscreen-left').length}`);
    out.push('- in order:', ...keyed.slice(-80).map(e => `  - ${e.t} s ${e.kind}${e.code ? ` ${e.code}${e.alt ? '+Alt' : ''}${e.repeat ? ' (repeat)' : ''}` : ''}${e.to !== undefined ? ` -> ${JSON.stringify(e.to)}` : ''}${e.canvas ? ` canvas ${JSON.stringify(e.canvas)}` : ''} [locked ${e.locked}, fullscreen ${e.fullscreen}]`));
    // pixel ratio and size (7.6.3)
    out.push('', '## Zoom, another screen, resizes (7.6.3)', '');
    const sized = ev.filter(e => ['pixel-ratio', 'pixel-ratio-canvas', 'resize'].includes(e.kind));
    if (!sized.length) out.push('- none');
    for (const e of sized.slice(-40)) out.push(`- ${e.t} s ${e.kind}: ${JSON.stringify({ from: e.from, to: e.to, dpr: e.dpr, window: e.window, canvas: e.canvas })}`);
    // folder and storage (7.8.1, 7.8.2, 7.8.3)
    out.push('', '## Folder and storage (7.8.1, 7.8.2, 7.8.3)', '');
    const store = ev.filter(e => ['folder-picked', 'saves', 'load', 'pagehide', 'pageshow'].includes(e.kind));
    for (const e of store) out.push(`- ${e.t} s (load ${e.load}) ${e.kind}: ${JSON.stringify(e.kind === 'saves' ? { from: e.from, to: e.to } : { files: e.files, top: e.top, input: e.input, persisted: e.persisted })}`);
    out.push(`- navigator.storage.persisted() at the report: ${persistedNow}; the page's own answer: ${JSON.stringify(lastSample?.saves ?? null)}`);
    // errors
    const errors = ev.filter(e => ['runtime-error', 'page-error', 'page-rejection', 'graphics-lost'].includes(e.kind));
    out.push('', '## Errors', '', ...(errors.length ? errors.map(e => `- ${e.t} s ${e.kind}: ${JSON.stringify(e.message ?? e.to)}`) : ['- none']));
    return out;
  }

  // ---- the panel: one line in the bottom left corner, over the page's margin
  function mountPanel() {
    panel = document.createElement('div');
    panel.id = 'hand-checks';
    panel.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483647;font:11px/1.4 system-ui,sans-serif;color:#fff;' +
      'background:rgba(0,0,0,.72);border:1px solid rgba(255,255,255,.25);border-radius:4px;padding:3px 6px;display:flex;gap:6px;align-items:center';
    const title = document.createElement('span'); title.textContent = 'Checks recorder';
    count = document.createElement('span'); count.style.opacity = '.75';
    const copy = document.createElement('button'), file = document.createElement('button'), clear = document.createElement('button');
    for (const [b, text] of [[copy, 'Copy report'], [file, 'Save'], [clear, 'Clear']]) {
      b.type = 'button'; b.textContent = text;
      b.style.cssText = 'font:inherit;padding:0 6px;color:#fff;background:#333;border:1px solid #777;border-radius:3px;cursor:pointer';
    }
    copy.onclick = async () => {
      await readPersisted();
      const text = report();
      try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; } catch { download(text); copy.textContent = 'Saved (no clipboard)'; }
      setTimeout(() => { copy.textContent = 'Copy report'; }, 2000);
    };
    file.onclick = async () => { await readPersisted(); download(report()); };
    clear.onclick = () => { if (confirm('Clear the recorded checks?')) { log.events.length = 0; log.samples.length = 0; log.loads.splice(0, log.loads.length - 1); save(); panelUpdate(); } };
    panel.append(title, count, copy, file, clear);
    document.body.append(panel);
    panelUpdate();
  }
  if (document.body) mountPanel(); else addEventListener('DOMContentLoaded', mountPanel, { once: true });

  function download(text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    a.download = `stage7-hand-checks-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function save() { try { sessionStorage.setItem(STORE, JSON.stringify(log)); } catch { /* full or blocked: the log stays in memory */ } }
  window.deusExChecks = { report, log: () => structuredClone(log), sample: () => sample(true) };
}

function load() { try { const text = sessionStorage.getItem(STORE); return text ? JSON.parse(text) : null; } catch { return null; } }
function canvasSize() {
  const c = document.getElementById('scene');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { backing: [c.width, c.height], css: [round(r.width), round(r.height)], dpr: devicePixelRatio };
}
function round(v) { return Math.round(v * 100) / 100; }
function flag(v) { return v ? '1' : '0'; }
