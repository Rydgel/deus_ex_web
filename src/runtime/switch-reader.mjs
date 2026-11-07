/**
 * The reader of a page switch (`?name=` / DEUS_EX_NAME) or environment variable (Node: NAME), as a function.
 *
 * The readers were `() => (typeof process !== 'undefined' && process.env?.NAME) || globalThis.DEUS_EX_NAME || 'default'`, called
 * from the hot paths (a far move, a cleanup scan of one actor, a spawn's bindings): in Firefox `typeof process` of an undeclared
 * global and a read of an absent property of the global each cost 150 to 200 ns, 400 ns for the pair (a microbenchmark in
 * Firefox 155, docs/firefox-60fps-plan.md "Dockyard spawns and js_eval"; V8 does both in about 10 ns), and 0.57 ms of a Dockyard
 * frame went to them.
 *
 * A browser realm has no `process`, and its switches are set once, before the runtime loads (main.mjs for the page, sim-worker.mjs
 * for the simulation worker, from the page's list): the first call reads the global and keeps the answer. Node keeps the full read
 * at every call, because validators and tests set the environment between runs of one process; SWITCH_CACHE=on in Node's
 * environment makes it cache too, so that the digest runs exercise the browser's path.
 *
 * SWITCH_CACHE / `?switchCache=js` (DEUS_EX_SWITCH_CACHE) keeps the full read at every call in a browser as well, the reference of
 * this file; `verify` keeps the first answer and checks it against a full read at each call.
 */
const NODE = typeof process !== 'undefined';
const CACHE_IN_NODE = NODE && ['on', 'verify'].includes(process.env?.SWITCH_CACHE ?? '');
let setting;
/** 'on' (default), 'js' or 'verify'; decided at the first cached read, after the page's switches are set. */
const cacheSetting = () => setting ??= (NODE && process.env?.SWITCH_CACHE) || globalThis.DEUS_EX_SWITCH_CACHE || 'on';

/** The reader of environment variable `env` / page global `name` with `fallback`. */
export function switchReader(env, name, fallback) {
  // (the expression the readers had, whole: a browser's first read and the `js` mode pay for `typeof process` as before)
  const full = () => (typeof process !== 'undefined' && process.env?.[env]) || globalThis[name] || fallback;
  if (NODE && !CACHE_IN_NODE) return full;
  let value, checking = false;
  return () => {
    if (value !== undefined) {
      if (checking) {
        const now = full();
        if (now !== value) throw new Error(`SWITCH_CACHE=verify: ${name} was ${value} at the first read and is ${now} now`);
      }
      return value;
    }
    const first = full(), setting = cacheSetting();
    if (setting !== 'js') { value = first; checking = setting === 'verify'; }
    return first;
  };
}
