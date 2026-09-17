/**
 * Shared driver for the XTextWindow / XTextLogWindow / XLargeTextWindow
 * native validators.
 *
 * Each per-native validator supplies the module, its frozen metadata, the
 * case-file section name, the exec result kind, and the mutation table.
 * The driver:
 *   1. re-verifies UnrealScript export metadata against Extension.u,
 *   2. hash-checks Extension.dll and every recorded body range,
 *   3. runs the Unicorn oracle (real exec bodies) over the shared case file,
 *   4. replays the identical cases through the JS translation on a synthetic
 *      native heap and deep-compares {result, code, events, state},
 *   5. applies every mutation to a copied module graph, proves the clean run
 *      still passes, and proves the mutated run diverges.
 *
 * `code` is the frame->Code advancement the exec body performs: one opcode
 * byte per marshalled param plus the result-eat byte — the JS side computes
 * it as args.length + 1 (every case arg is exactly one marshal read).
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
import {
  TextWindowHeap, buildWindow, dumpState, dumpFString, resetGlobals,
  textLeafServices, f32Bits,
} from './textwindow-services.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CASES = JSON.parse(readFileSync(path.join(ROOT, 'scripts/textwindow-cases.json'), 'utf8'));

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

const f32box = new DataView(new ArrayBuffer(4));
const bitsToValue = bits => {
  f32box.setUint32(0, bits >>> 0, true);
  return f32box.getFloat32(0, true);
};

/** Build a heap FString cell {data,num,max} — the exec marshal source cell. */
function buildCell(heap, text, maxn) {
  const cell = heap.allocRaw(12);
  if (text == null) {
    heap.write(cell, 'u32', 0);
    heap.write(cell + 4, 'i32', 0);
    heap.write(cell + 8, 'i32', 0);
    return cell;
  }
  const data = heap.allocString(text);
  const num = text.length + 1;
  heap.write(cell, 'u32', data);
  heap.write(cell + 4, 'i32', num);
  heap.write(cell + 8, 'i32', maxn ?? num);
  return cell;
}

/** Marshal a case-file arg spec into module call arguments (exec mode). */
export function marshalArgs(heap, args = []) {
  return args.map(arg => {
    if ('int' in arg) return arg.int | 0;
    if ('float' in arg) return arg.float;
    if ('floatBits' in arg) return bitsToValue(arg.floatBits);
    if ('string' in arg) return buildCell(heap, arg.string, arg.max);
    if ('outString' in arg) return buildCell(heap, arg.outString, arg.outMax);
    if ('outNone' in arg) return 0;
    throw new Error(`unsupported arg ${JSON.stringify(arg)}`);
  });
}

/**
 * @param {object} opts
 *   moduleFile - absolute path of the runtime module under src/runtime
 *   metaExport - name of the frozen metadata export
 *   entry      - exported translation function name
 *   oracleFile - oracle script name inside scripts/
 *   section    - textwindow-cases.json section
 *   resultKind - 'execVoid' | 'execString' | 'execInt' | 'execPart'
 *   invoke(fn, object, args, services, spec, cells) -> raw result (optional)
 *   mutations    - [{file:'module'|'model', find, replace, note}]
 *   metadataParams - expected param list ['name:type', ...]
 */
export async function runTextValidator(opts) {
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
    const heap = new TextWindowHeap();
    const {base} = buildWindow(heap, caseSpec.spec);
    resetGlobals(heap, caseSpec.spec);
    const object = {base};
    const services = {
      mem: heap,
      objectAddress: o => o.base,
      ...textLeafServices(heap, base, caseSpec.spec),
      ...(opts.services ? opts.services(heap, base, caseSpec.spec) : {}),
    };
    heap.events.length = 0;
    heap.blockIds.clear();
    heap.freed.clear();
    heap.seen.clear();
    const args = marshalArgs(heap, caseSpec.args);
    const cells = {};
    const kind = opts.resultKind;
    // Result cells are built before the call exactly like the probe's
    // run_exec: execString pre-fills a result FString from spec.outText,
    // execInt/execPart hand the body a 4-byte cell seeded with 0xdeadbeef,
    // and execPart's dest is the marshalled outString arg (0 for outNone).
    if (kind === 'execString') {
      cells.out = buildCell(heap, caseSpec.spec.outText ?? null, caseSpec.spec.outMax);
    } else if (kind === 'execInt' || kind === 'execPart') {
      cells.out = heap.allocRaw(4);
      heap.write(cells.out, 'u32', 0xdeadbeef);
    }
    if (kind === 'execPart') cells.dest = args[2];
    let raw;
    if (opts.invoke) {
      raw = opts.invoke(fn, object, args, services, caseSpec.spec, heap, cells);
    } else {
      raw = fn(object, ...args, services);
    }
    let result = null;
    if (kind === 'execString') {
      result = dumpFString(heap, cells.out);
    } else if (kind === 'execInt') {
      result = heap.read(cells.out, 'i32');
    } else if (kind === 'execPart') {
      result = {
        value: heap.read(cells.out, 'i32'),
        out: cells.dest ? dumpFString(heap, cells.dest) : null,
      };
    } else if (kind === 'execVoid') {
      result = null;
    } else {
      result = raw;
    }
    // One marshal read per case arg plus the result-eat byte.
    const code = (caseSpec.args ?? []).length + 1;
    return {
      result, code,
      events: heap.events.map(e => ({...e})),
      state: dumpState(heap, base),
    };
  };

  const report = {native: meta.function, cases: {}, mutations: []};
  for (const [name, caseSpec] of Object.entries(cases)) {
    const expected = oracle.cases[name];
    assert.ok(expected, `oracle missing case ${name}`);
    const got = runCase(mod[opts.entry], caseSpec);
    assert.deepEqual(got.result, expected.result, `${name}: result`);
    assert.equal(got.code, expected.code, `${name}: frame->Code advancement`);
    assert.deepEqual(got.events, expected.events, `${name}: events`);
    assert.deepEqual(got.state, expected.state, `${name}: state`);
    report.cases[name] = {status: 'pass'};
  }

  // ---- mutation gate ---------------------------------------------------------
  const modelFile = path.join(ROOT, 'src/runtime/script-text-model.mjs');
  const editModelFile = path.join(ROOT, 'src/runtime/script-edit-model.mjs');
  const listModelFile = path.join(ROOT, 'src/runtime/script-window-list-model.mjs');
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
      writeFileSync(path.join(dir, 'script-text-model.mjs'),
        target === 'model' ? patched : sources.model);
      writeFileSync(path.join(dir, 'script-edit-model.mjs'),
        readFileSync(editModelFile, 'utf8'));
      writeFileSync(path.join(dir, 'script-window-list-model.mjs'),
        readFileSync(listModelFile, 'utf8'));
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
          const sameResult = JSON.stringify(got.result) === JSON.stringify(expected.result);
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
