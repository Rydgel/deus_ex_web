/**
 * Shared driver for the UGC text-metrics native validators
 * (GC.GetTextExtent 1280 / GC.GetFontHeight 1281).
 *
 * Same shape as gc-validator-lib.mjs — metadata + body-hash checks, Unicorn
 * oracle, JS replay, mutation gate — but the case model is text-specific:
 *
 *   spec fields    {$font: name}   — real Font export decoded by
 *                  dump-font-image.mjs and laid out by writeFontImage
 *                  {$fontDef: name} — synthetic font (fill + set overrides)
 *   args           {value: bits}   — scalar param dword (f32 bits for floats,
 *                                    int for the bool)
 *                  {out: init}     — out-param pointer presence
 *                  {$text: str}    — FString text (exec), UTF-16 in JS
 *                  {$units: [u16]} — explicit code units (exec FString)
 *                  {$unitsPtr: [u16]} — raw wchar* for method mode
 *
 * The oracle emits f32 results as raw u32 bit patterns; the JS side reports
 * the same bit patterns so 'outs' comparisons stay bit-exact.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {gameDirectory} from './game-directory.mjs';
import {buildGc, dumpState, f32FromBits, GcHeap} from './gc-services.mjs';
import {writeFontImage} from '../src/runtime/script-font-model.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CASES = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/gc-textmetrics-cases.json'), 'utf8'));

const PYTHON = process.env.NATIVE_PROBE_PYTHON
  || path.join(ROOT, '.cache/native-probe-env/bin/python');

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const f32bits = v => { F32[0] = v; return U32[0]; };
const isNanBits = b => (b & 0x7f800000) === 0x7f800000 && (b & 0x7fffff) !== 0;

/** Node-side decode of the real Font exports (same script the oracle uses). */
function loadFonts(root, names) {
  const out = execFileSync('node', [
    path.join(ROOT, 'scripts/dump-font-image.mjs'), root, ...names,
  ], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  const fonts = JSON.parse(out).fonts;
  for (const name of names) {
    const spec = fonts[name];
    const expected = 2 + spec.pageCount * (4 + spec.charsPerPage * 16) + 4;
    assert.equal(spec.serialSize, expected, `${name}: serial layout`);
    for (const page of spec.pages)
      assert.equal(page.chars.length, spec.charsPerPage,
        `${name}: page char count`);
  }
  return fonts;
}

/** Mirror of expand_font_def in the oracle: fill + per-index set overrides. */
function expandFontDef(name, spec) {
  const cpp = spec.charsPerPage;
  const pages = spec.pages.map(page => {
    const chars = page.chars
      ? page.chars.map(rec => [...rec])
      : Array.from({length: cpp}, () => [...page.fill]);
    if (!page.chars)
      for (const [idx, rec] of Object.entries(page.set ?? {}))
        chars[Number(idx)] = [...rec];
    assert.equal(chars.length, cpp, `${name}: page char count`);
    return {header: page.header ?? [0, 0, 0, 0], chars};
  });
  return {name, charsPerPage: cpp, pageCount: spec.pageCount,
          pages, serialSize: 0};
}

/**
 * Compare one JS replay result against the oracle result.
 * execFloat oracle results are raw f32 bits; a NaN pattern only requires
 * Number.isNaN on the JS side (the x87 quiets SNaN payloads that JS cannot
 * carry).  'outs' compares the {name: u32-bits|null} dict verbatim.
 */
function resultMatches(resultKind, got, expected) {
  switch (resultKind) {
    case 'execFloat': {
      const bits = expected >>> 0;
      if (isNanBits(bits)) return Number.isNaN(got);
      return f32bits(got) === bits;
    }
    case 'outs':
      return JSON.stringify(got) === JSON.stringify(expected);
    default:
      return JSON.stringify(got ?? null) === JSON.stringify(expected ?? null);
  }
}

/** First leaf-level difference between two JSON-comparable values. */
function firstDiff(got, expected, path = '') {
  if (Object.is(got, expected)) return null;
  if (typeof got !== 'object' || typeof expected !== 'object' || !got || !expected)
    return {path: path || '$', got, expected};
  for (const key of new Set([...Object.keys(got), ...Object.keys(expected)])) {
    const d = firstDiff(got[key], expected[key], path ? `${path}.${key}` : key);
    if (d) return d;
  }
  return null;
}

async function loadExtension(root) {
  const extensionPath = path.join(root, 'System', 'Extension.u');
  const extensionBytes = new Uint8Array(await readFile(extensionPath));
  const assets = new AssetStore((await readdir(path.join(root, 'System'))).map(name => ({
    path: `System/${name}`,
    read: () => name === 'Extension.u'
      ? extensionBytes : readFile(path.join(root, 'System', name)),
  })));
  return assets.get('Extension');
}

/**
 * @param {object} opts
 *   moduleFile - absolute path of the runtime module under src/runtime
 *   metaExport - name of the frozen metadata export
 *   oracleFile - per-native oracle wrapper script name inside scripts/
 *   section    - gc-textmetrics-cases.json section
 *   resultKind - 'execFloat' | 'outs'
 *   invoke(mod, object, args, services, caseSpec) - call the module entry;
 *      args are the resolved case args (out entries kept as {out}), return
 *      the JS-side result for resultMatches
 *   mutations    - [{file:'module'|'model'|'fontModel', find, replace, note}]
 *   metadataParams - expected ['name:type', ...] param list
 *   dllAssert    - [{offset, hex}] extra Extension.dll byte asserts
 */
export async function runTextMetricsValidator(opts) {
  const root = gameDirectory();
  const extension = await loadExtension(root);
  const moduleUrl = url.pathToFileURL(opts.moduleFile).href;
  const mod = await import(moduleUrl);
  const meta = mod[opts.metaExport];
  assert.ok(meta, `${opts.metaExport} export missing`);

  // ---- metadata + body hashes -------------------------------------------
  const exportIndex = extension.exportsByPath.get(meta.function.toLowerCase());
  assert.equal(exportIndex, meta.packageExport, `${meta.function} export index`);
  const md = readFunctionMetadata(extension, exportIndex);
  assert.equal(md.nativeIndex, meta.nativeIndex);
  assert.equal(md.functionFlags, meta.functionFlags);
  assert.equal(md.entry.serialSize, meta.serialSize);
  if (opts.metadataParams)
    assert.deepEqual(md.parameters.map(p => `${p.name}:${p.type?.name ?? p.type}`),
      opts.metadataParams);

  const dllBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Extension.dll')));
  assert.equal(createHash('sha256').update(dllBytes).digest('hex'), meta.dllSha256);
  for (const check of opts.dllAssert ?? []) {
    const bytes = Buffer.from(dllBytes.subarray(check.offset - meta.imageBase,
      check.offset - meta.imageBase + check.hex.length / 2)).toString('hex');
    assert.equal(bytes, check.hex, `dll bytes at 0x${check.offset.toString(16)}`);
  }
  const bodyHash = (start, end) => createHash('sha256').update(
    dllBytes.subarray(start - meta.imageBase, end - meta.imageBase)).digest('hex');
  if (meta.execBody)
    assert.equal(bodyHash(meta.execBody, meta.execEnd), meta.execSha256, 'exec body changed');
  if (meta.methodBody)
    assert.equal(bodyHash(meta.methodBody, meta.methodEnd), meta.methodSha256, 'method body changed');

  // ---- fonts ---------------------------------------------------------------
  const fonts = loadFonts(root, CASES.fonts ?? []);
  const fontDefs = {};
  for (const [name, spec] of Object.entries(CASES.fontDefs ?? {}))
    fontDefs[name] = expandFontDef(name, spec);

  // ---- oracle ---------------------------------------------------------------
  const oracle = JSON.parse(execFileSync(PYTHON, [
    path.join(ROOT, 'scripts', opts.oracleFile), root,
  ], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}));
  assert.equal(oracle.hashes['Extension.dll'], meta.dllSha256);
  assert.equal(oracle.extensionBase, meta.oracleBase);
  assert.equal(oracle.execBody, meta.execBody, 'exec body address');
  assert.equal(oracle.methodBody ?? null, meta.methodBody ?? null, 'method body address');

  // ---- JS replay -------------------------------------------------------------
  const cases = CASES[opts.section];
  const runCase = (fn, caseSpec) => {
    const heap = new GcHeap();
    const spec = {...caseSpec.spec};
    for (const key of Object.keys(spec)) {
      const v = spec[key];
      if (v && typeof v === 'object') {
        if (v.$font) spec[key] = writeFontImage(heap, fonts[v.$font]);
        else if (v.$fontDef) spec[key] = writeFontImage(heap, fontDefs[v.$fontDef]);
      }
    }
    const {base} = buildGc(heap, spec);
    const object = {base};
    const services = {
      mem: heap,
      objectAddress: o => o.base,
      nodeAddress: i => heap.nodeAddrs[i],
      events: heap.events,
      canon: a => heap.canon(a),
      allocateObject: alloc => heap.allocateObject(alloc),
      constructUObject: address => heap.constructUObject(address),
    };
    heap.events.length = 0;
    const args = (caseSpec.args ?? []).map(a => {
      if (a && typeof a === 'object') {
        if ('node' in a) return heap.nodeAddrs[a.node];
        if ('$text' in a) return a.$text;
        if ('$units' in a || '$unitsPtr' in a)
          return String.fromCharCode(...(a.$units ?? a.$unitsPtr));
        return a;  // {value}/{out} entries stay opaque for invoke
      }
      return a === 'this' ? base : a;
    });
    const raw = opts.invoke(fn, object, args, services, caseSpec, mod);
    return {result: opts.resultKind === 'void' ? null : raw,
            events: heap.events.map(e => ({...e})),
            state: dumpState(heap, base)};
  };

  const report = {native: meta.function, cases: {}, mutations: []};
  for (const [name, caseSpec] of Object.entries(cases)) {
    const expected = oracle.cases[name];
    assert.ok(expected, `oracle missing case ${name}`);
    const got = runCase(mod[opts.entry], caseSpec);
    const okResult = resultMatches(opts.resultKind, got.result, expected.result);
    const okEvents = JSON.stringify(got.events) === JSON.stringify(expected.events);
    const okState = JSON.stringify(got.state) === JSON.stringify(expected.state);
    if (okResult && okEvents && okState) {
      report.cases[name] = 'pass';
      continue;
    }
    const d = firstDiff(got.state, expected.state, 'state')
      ?? firstDiff(got.events, expected.events, 'events')
      ?? {path: 'result', got: got.result, expected: expected.result};
    assert.ok(resultMatches(opts.resultKind, got.result, expected.result),
      `${name}: result ${JSON.stringify(got.result)} != ${JSON.stringify(expected.result)}`);
    assert.deepEqual(got.events, expected.events, `${name}: events`);
    assert.deepEqual(got.state, expected.state, `${name}: state`);
    report.cases[name] = 'pass';
  }

  // ---- mutation gate ---------------------------------------------------------
  const modelFile = path.join(ROOT, 'src/runtime/script-gc-state-model.mjs');
  const fontModelFile = path.join(ROOT, 'src/runtime/script-font-model.mjs');
  const sources = {
    module: readFileSync(opts.moduleFile, 'utf8'),
    model: readFileSync(modelFile, 'utf8'),
    fontModel: readFileSync(fontModelFile, 'utf8'),
  };
  const extras = opts.extraFiles ?? {};
  for (const [key, file] of Object.entries(extras))
    sources[key] = readFileSync(path.resolve(file), 'utf8');
  for (const [i, mutation] of (opts.mutations ?? []).entries()) {
    const target = mutation.file ?? 'module';
    const source = sources[target];
    const hits = source.split(mutation.find).length - 1;
    assert.equal(hits, 1, `mutation ${i} find string occurs ${hits} times`);
    const patched = source.replace(mutation.find, mutation.replace);
    const dir = mkdtempSync(path.join(ROOT, 'src/runtime/.mut-'));
    try {
      writeFileSync(path.join(dir, 'script-gc-state-model.mjs'),
        target === 'model' ? patched : sources.model);
      writeFileSync(path.join(dir, 'script-font-model.mjs'),
        target === 'fontModel' ? patched : sources.fontModel);
      const moduleName = path.basename(opts.moduleFile);
      writeFileSync(path.join(dir, moduleName),
        target === 'module' ? patched : sources.module);
      for (const [key, file] of Object.entries(extras))
        writeFileSync(path.join(dir, path.basename(file)),
          target === key ? patched : sources[key]);
      const mutated = await import(url.pathToFileURL(path.join(dir, moduleName)).href);
      let diverged = false;
      let detail = '';
      for (const [name, caseSpec] of Object.entries(cases)) {
        const expected = oracle.cases[name];
        try {
          const got = runCase(mutated[opts.entry], caseSpec);
          const sameResult = resultMatches(opts.resultKind, got.result, expected.result);
          const sameEvents = JSON.stringify(got.events) === JSON.stringify(expected.events);
          const sameState = JSON.stringify(got.state) === JSON.stringify(expected.state);
          if (!sameResult || !sameEvents || !sameState) {
            diverged = true;
            detail = `${name}: result/events/state diverged`;
            break;
          }
        } catch (error) {
          diverged = true;
          detail = `${name}: threw ${error.message}`;
          break;
        }
      }
      assert.ok(diverged, `mutation ${i} (${mutation.note}) produced identical behavior`);
      report.mutations.push({note: mutation.note, detail});
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  }
  console.log(JSON.stringify(report, null, 1));
}
