// A page init script for the Firefox wasm gap study (docs/firefox-60fps-plan.md "Firefox wasm gap"): times every export of every
// instance the page creates, inclusive, like scripts/wasm-gap-hook.mjs does in Node. hitch-run.mjs --init-script this --eval 'window.__gapStats()'.
// Firefox's clock steps by 20 us with privacy.reduceTimerPrecision off (--ff-prefs), so only totals over many calls mean anything.
// window.__gapReset() clears the totals (after the warm-up). Measurement only.
(() => {
  const stats = new Map();
  const now = performance.now.bind(performance);
  const wrap = instance => {
    const exports = {};
    for (const [name, value] of Object.entries(instance.exports)) {
      if (typeof value !== 'function') { exports[name] = value; continue; }
      let entry = stats.get(name);
      if (!entry) stats.set(name, entry = {calls: 0, ms: 0});
      exports[name] = (...args) => {
        const t = now();
        try { return value(...args); } finally { entry.calls++; entry.ms += now() - t; }
      };
    }
    return new Proxy(instance, {get: (target, key) => key === 'exports' ? Object.freeze(exports) : Reflect.get(target, key, target)});
  };
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async function (source, imports) {
    const result = await instantiate.call(this, source, imports);
    // (only the script core: it has decal_attach)
    const probe = result instanceof WebAssembly.Instance ? result : result.instance;
    if (typeof probe.exports.decal_attach !== 'function') return result;
    if (result instanceof WebAssembly.Instance) return wrap(result);
    return {...result, instance: wrap(result.instance)};
  };
  // The totals count from 6 s after the map's HUD first reads 100 health (the run's start, as hitch-run waits for it), or from __gapReset().
  const poll = setInterval(() => {
    try {
      if (window.deusExViewer?.status().gameplay?.hud?.health?.head?.displayedHealth !== 100) return;
      clearInterval(poll); setTimeout(() => window.__gapReset(), Number(window.__gapAfterMs ?? 6000));
    } catch { /* not ready */ }
  }, 250);
  window.__gapStats = () => [...stats].map(([name, v]) => ({name, calls: v.calls, ms: +v.ms.toFixed(3)})).filter(r => r.calls).sort((a, b) => b.ms - a.ms);
  window.__gapReset = () => { for (const v of stats.values()) { v.calls = 0; v.ms = 0; } };
})();
