// Replays the snapshot cases of scripts/wasm-gap-hook.mjs against a script-vm.wasm in Node (V8), in Firefox or in Chromium and times
// each export on its recorded inputs (docs/firefox-60fps-plan.md "Firefox wasm gap"). Measurement only.
//
//   node scripts/wasm-gap-replay.mjs --dir .work/gap/snap-dockyard [--cases decal_attach,lc_scan] [--engine node|firefox|chromium]
//     [--wasm src/runtime/script-vm.wasm] [--seconds 4] [--prefs '{"javascript.options.wasm_lazy_tiering":false}'] [--out FILE.json]
//     [--v8-flags '--no-liftoff'] [--cold MIB] (a read through MIB of other memory before each call)
//     [--profile FILE] (Firefox: a Gecko profile at shutdown; Node: run with --cpu-prof)
//   --dir may be given several times (comma separated): every case of each directory (a case is NAME.json + NAME.mem).
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {join, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCase, verify, timeCase} from './wasm-gap-core.mjs';

const argv = process.argv.slice(2);
const option = (n, f) => { const i = argv.indexOf(`--${n}`); return i < 0 ? f : argv[i + 1]; };
const root = fileURLToPath(new URL('..', import.meta.url));
const engine = option('engine', 'node'), seconds = Number(option('seconds', 4));
const wasmPath = option('wasm', join(root, 'src/runtime/script-vm.wasm'));
const dirs = option('dir', '.work/gap/snap-dockyard').split(',');
const only = option('cases', null)?.split(','), cold = Number(option('cold', 0));
const prefs = JSON.parse(option('prefs', '{}'));
const cases = [];
for (const dir of dirs) for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const name = basename(f, '.json');
  if (JSON.parse(readFileSync(join(dir, f), 'utf8')).nested) { console.error(`${name}: skipped (an import called into the module again, or grew its memory)`); continue; }
  if (only && !only.includes(name)) continue;
  cases.push({dir, name});
}

let results;
if (engine === 'node') {
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  results = [];
  for (const {dir, name} of cases) {
    const meta = JSON.parse(readFileSync(join(dir, `${name}.json`)));
    const c = await openCase(module, meta, new Uint8Array(readFileSync(join(dir, `${name}.mem`))));
    try { const v = verify(c); results.push({dir, name, verify: v, ...timeCase(c, seconds, undefined, cold)}); } catch (e) { console.error(`${name}: ${e.message.slice(0, 120)}`); }
  }
} else {
  const {chromium, firefox} = await import('@playwright/test');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (body, type) => { res.writeHead(200, {'content-type': type, 'cache-control': 'no-store'}); res.end(body); };
    if (url.pathname === '/core.mjs') return send(readFileSync(join(root, 'scripts/wasm-gap-core.mjs')), 'text/javascript');
    if (url.pathname === '/wasm') return send(readFileSync(wasmPath), 'application/wasm');
    if (url.pathname === '/run.html') return send('<!doctype html><meta charset=utf-8><body>', 'text/html');
    const m = /^\/case\/(\d+)\.(json|mem)$/.exec(url.pathname);
    if (m) { const {dir, name} = cases[Number(m[1])]; return send(readFileSync(join(dir, `${name}.${m[2]}`)), m[2] === 'json' ? 'application/json' : 'application/octet-stream'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profOut = option('profile', null);
  const browser = engine === 'firefox'
    ? await firefox.launch({headless: true, firefoxUserPrefs: {'privacy.reduceTimerPrecision': false, 'javascript.options.asyncstack': false, ...prefs},
      env: profOut ? {...process.env, MOZ_PROFILER_STARTUP: '1', MOZ_PROFILER_STARTUP_FEATURES: 'js,threads', MOZ_PROFILER_STARTUP_FILTERS: 'GeckoMain', MOZ_PROFILER_STARTUP_INTERVAL: '0.2',
        MOZ_PROFILER_STARTUP_ENTRIES: '40000000', MOZ_PROFILER_SHUTDOWN: profOut} : process.env})
    : await chromium.launch({headless: true, args: option('v8-flags', null) ? [`--js-flags=${option('v8-flags', '')}`] : []});
  console.error(`${engine} ${browser.version()}`);
  const page = await browser.newPage();
  await page.goto(`${base}/run.html`);
  results = await page.evaluate(async ({base, n, seconds, cold}) => {
    const core = await import(`${base}/core.mjs`);
    const module = await WebAssembly.compile(await (await fetch(`${base}/wasm`)).arrayBuffer());
    const out = [];
    for (let i = 0; i < n; i++) {
      const meta = await (await fetch(`${base}/case/${i}.json`)).json();
      const bytes = new Uint8Array(await (await fetch(`${base}/case/${i}.mem`)).arrayBuffer());
      const c = await core.openCase(module, meta, bytes);
      try { const v = core.verify(c); out.push({index: i, verify: v, ...core.timeCase(c, seconds, undefined, cold)}); } catch (e) { console.error(`case ${i}: ${e.message.slice(0, 120)}`); }
    }
    return out;
  }, {base, n: cases.length, seconds, cold});
  results.forEach(r => Object.assign(r, cases[r.index]));
  await browser.close();
  server.close();
}
const line = r => `${r.name.padEnd(18)} calls ${String(r.calls).padStart(8)} median ${String(r.medianUs).padStart(9)} mean ${String(r.meanUs).padStart(9)} us  min ${String(r.minUs).padStart(9)}  p90 ${String(r.p90Us).padStart(9)}  first ${r.firstUs.slice(0, 4).join(',')}  ${r.verify.afterEqual && r.verify.restoredEqual ? 'replay exact' : 'REPLAY DIFFERS ' + JSON.stringify(r.verify)}  dirty ${r.verify.dirtyBytes}`;
console.log(results.map(line).join('\n'));
if (option('out', null)) writeFileSync(option('out', null), JSON.stringify({engine, wasm: wasmPath, prefs, results}, null, 1));
