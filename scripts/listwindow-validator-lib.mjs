/**
 * Shared driver for the XListWindow native validators.
 *
 * Each per-native validator supplies the module, its frozen metadata, the
 * case-file section name, the result kind the method body produces, an arg
 * marshaler, and the mutation table.  The driver:
 *   1. re-verifies UnrealScript export metadata against Extension.u,
 *   2. hash-checks Extension.dll and every recorded body range,
 *   3. runs the Unicorn oracle over the shared case file,
 *   4. replays the identical cases through the JS translation on a synthetic
 *      native heap and deep-compares {result, events, state},
 *   5. applies every mutation to a copied module graph, proves the clean run
 *      still passes, and proves the mutated run diverges.
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
import {buildWindow, dumpState, ListWindowHeap} from './listwindow-services.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CASES = JSON.parse(readFileSync(path.join(ROOT, 'scripts/listwindow-cases.json'), 'utf8'));

const PYTHON = process.env.NATIVE_PROBE_PYTHON || path.join(ROOT, '.cache/native-probe-env/bin/python');

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

/** Marshal a case-file arg spec into module call arguments. */
export function marshalArgs(heap, base, args = []) {
  const rdata = heap.read(base + 0x170, 'u32');
  return args.map(arg => {
    if ('int' in arg) return arg.int | 0;
    if ('float' in arg) return arg.float;
    if ('string' in arg) return arg.string;
    if ('row' in arg) return heap.read(rdata + 4 * arg.row, 'u32');
    throw new Error(`unsupported arg ${JSON.stringify(arg)}`);
  });
}

function canonResult(kind, heap, value) {
  if (kind === 'ptr') return {ptr: heap.canon(value)};
  if (kind === 'fieldstr')
    return {ptr: heap.canon(value), text: value ? heap.readString(value) : null};
  if (kind === 'int') return {value: value | 0};
  return value;
}

/**
 * @param {object} opts
 *   moduleFile - absolute path of the runtime module under src/runtime
 *   metaExport - name of the frozen metadata export
 *   entry      - exported translation function name
 *   oracleFile - oracle script name inside scripts/
 *   section    - listwindow-cases.json section
 *   resultKind - 'int' | 'ptr' | 'fieldstr' | 'execInt'
 *   invoke(fn, heap, base, args, spec) - call the module, return raw result
 *   services(heap, base, spec) - optional extra leaf services
 *   mutations    - [{file:'module'|'model', find, replace, note}]
 *   metadataParams - expected param list ['name:type', ...]
 */
export async function runListValidator(opts) {
  const root = gameDirectory();
  const extension = await loadExtension(root);
  const moduleUrl = url.pathToFileURL(opts.moduleFile).href;
  const mod = await import(moduleUrl);
  const meta = mod[opts.metaExport];
  assert.ok(meta, `${opts.metaExport} export missing`);

  // ---- metadata + body hashes ---------------------------------------------
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
  const bodyHash = (start, end) => createHash('sha256').update(
    dllBytes.subarray(start - meta.imageBase, end - meta.imageBase)).digest('hex');
  if (meta.execBody)
    assert.equal(bodyHash(meta.execBody, meta.execEnd), meta.execSha256, 'exec body changed');
  if (meta.methodBody)
    assert.equal(bodyHash(meta.methodBody, meta.methodEnd), meta.methodSha256, 'method body changed');

  // ---- oracle --------------------------------------------------------------
  const oracle = JSON.parse(execFileSync(PYTHON, [
    path.join(ROOT, 'scripts', opts.oracleFile), root,
  ], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
  assert.equal(oracle.hashes['Extension.dll'], meta.dllSha256);
  assert.equal(oracle.extensionBase, meta.oracleBase);

  // ---- JS replay -------------------------------------------------------------
  const cases = CASES[opts.section];
  const runCase = (fn, caseSpec) => {
    const heap = new ListWindowHeap();
    const {base} = buildWindow(heap, caseSpec.spec);
    const object = {base};
    const services = {
      mem: heap,
      objectAddress: o => o.base,
      ...(opts.services ? opts.services(heap, base, caseSpec.spec) : {}),
    };
    heap.events.length = 0;
    heap.blockIds.clear();
    heap.freed.clear();
    heap.seen.clear();
    const args = marshalArgs(heap, base, caseSpec.args);
    const raw = opts.invoke ? opts.invoke(fn, object, args, services, caseSpec.spec)
      : fn(object, ...args, services);
    const result = canonResult(opts.resultKind, heap, raw);
    return {result, events: heap.events.map(e => ({...e})), state: dumpState(heap, base)};
  };

  const report = {native: meta.function, cases: {}, mutations: []};
  for (const [name, caseSpec] of Object.entries(cases)) {
    const expected = oracle.cases[name];
    assert.ok(expected, `oracle missing case ${name}`);
    const got = runCase(mod[opts.entry], caseSpec);
    if (opts.resultKind === 'execInt') {
      assert.equal(got.result, expected.result, `${name}: result value`);
      assert.equal(expected.ret, expected.result, `${name}: exec ret`);
    } else {
      assert.deepEqual(got.result, expected.result, `${name}: result`);
    }
    assert.deepEqual(got.events, expected.events, `${name}: events`);
    assert.deepEqual(got.state, expected.state, `${name}: state`);
    report.cases[name] = 'pass';
  }

  // ---- mutation gate ---------------------------------------------------------
  const modelFile = path.join(ROOT, 'src/runtime/script-window-list-model.mjs');
  const sources = {
    module: readFileSync(opts.moduleFile, 'utf8'),
    model: readFileSync(modelFile, 'utf8'),
  };
  for (const [i, mutation] of (opts.mutations ?? []).entries()) {
    const target = mutation.file ?? 'module';
    const source = sources[target];
    const hits = source.split(mutation.find).length - 1;
    assert.equal(hits, 1, `mutation ${i} find string occurs ${hits} times`);
    const patched = source.replace(mutation.find, mutation.replace);
    const dir = mkdtempSync(path.join(ROOT, 'src/runtime/.mut-'));
    try {
      writeFileSync(path.join(dir, 'script-window-list-model.mjs'),
        target === 'model' ? patched : sources.model);
      const moduleName = path.basename(opts.moduleFile);
      writeFileSync(path.join(dir, moduleName),
        target === 'module' ? patched : sources.module);
      const mutated = await import(url.pathToFileURL(path.join(dir, moduleName)).href);
      let diverged = false;
      let detail = '';
      for (const [name, caseSpec] of Object.entries(cases)) {
        const expected = oracle.cases[name];
        try {
          const got = runCase(mutated[opts.entry], caseSpec);
          const sameResult = opts.resultKind === 'execInt'
            ? got.result === expected.result
            : JSON.stringify(got.result) === JSON.stringify(expected.result);
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
