/**
 * Shared driver for the interactive-control native validators.
 *
 * Each per-native validator supplies the module, its frozen metadata, the
 * case-file section name, the oracle script, an invoker and the mutation
 * table.  The driver:
 *   1. re-verifies UnrealScript export metadata against Extension.u,
 *   2. hash-checks Extension.dll and every recorded body range,
 *   3. runs the Unicorn oracle over the shared case file,
 *   4. replays the identical cases through the JS translation recording the
 *      canonical access/event stream, and deep-compares
 *      {accesses, events, state, result},
 *   5. applies every mutation to a copied module and proves divergence.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { gameDirectory } from './game-directory.mjs';
import { buildWorld } from './controlwindow-services.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CASES = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/controlwindow-cases.json'), 'utf8'));
const PYTHON = process.env.NATIVE_PROBE_PYTHON ||
  path.join(ROOT, '.cache/native-probe-env/bin/python');

async function loadExtension(root) {
  const extensionBytes = new Uint8Array(
    await readFile(path.join(root, 'System', 'Extension.u')));
  const assets = new AssetStore(
    (await readdir(path.join(root, 'System'))).map(name => ({
      path: `System/${name}`,
      read: () => name === 'Extension.u'
        ? extensionBytes
        : readFile(path.join(root, 'System', name)),
    })));
  return assets.get('Extension');
}

function marshalArg(world, arg) {
  if (arg && typeof arg === 'object') {
    if ('out' in arg) {
      if (!world.objects[arg.out]) world.objects[arg.out] = { name: arg.out };
      return { out: world.objects[arg.out] };
    }
    if ('f32' in arg) return arg.f32;
    if ('f32bits' in arg) {
      const view = new DataView(new ArrayBuffer(4));
      view.setUint32(0, arg.f32bits >>> 0, true);
      return view.getFloat32(0, true);
    }
    if ('skip' in arg) return { skip: true };
    if ('i32' in arg) return arg.i32 | 0;
    if ('u32' in arg) return arg.u32 >>> 0;
    if ('u8' in arg) return arg.u8 & 0xff;
    if ('ptr' in arg) return world.objects[arg.ptr];
    return arg;
  }
  if (typeof arg === 'string') return world.objects[arg];
  return arg;
}

/**
 * @param {object} opts
 *   moduleFile - absolute path of the runtime module under src/runtime
 *   metaExport - name of the frozen metadata export
 *   entry      - exported translation function name
 *   oracleFile - oracle script name inside scripts/
 *   section    - controlwindow-cases.json section
 *   metadataParams - expected param list ['name:type', ...]
 *   invoke(fn, receiver, args, world) - call the module, return the run value
 *   mutations    - [{find, replace, note}]
 *   bodyRanges   - [{body,end,sha256}] extra checked ranges beyond exec/method
 */
export async function runControlValidator(opts) {
  const root = gameDirectory();
  const extension = await loadExtension(root);
  const moduleUrl = url.pathToFileURL(opts.moduleFile).href;
  const mod = await import(moduleUrl);
  const meta = mod[opts.metaExport];
  assert.ok(meta, `${opts.metaExport} export missing`);

  // ---- metadata + body hashes ---------------------------------------------
  const exportIndex = extension.exportsByPath.get(opts.exportPath);
  assert.equal(exportIndex, meta.packageExport, `${meta.function} export index`);
  const md = readFunctionMetadata(extension, exportIndex);
  assert.equal(md.nativeIndex, meta.nativeIndex);
  assert.equal(md.functionFlags, meta.functionFlags);
  assert.equal(md.entry.serialSize, meta.serialSize);
  if (opts.metadataParams)
    assert.deepEqual(md.parameters.map(p => `${p.name}:${p.type?.name ?? p.type}`),
      opts.metadataParams);

  const dllBytes = new Uint8Array(
    await readFile(path.join(root, 'System', 'Extension.dll')));
  assert.equal(createHash('sha256').update(dllBytes).digest('hex'),
    meta.dllSha256);
  const view = new DataView(dllBytes.buffer, dllBytes.byteOffset, dllBytes.byteLength);
  const pe = view.getUint32(0x3c, true);
  const sectionCount = view.getUint16(pe + 6, true);
  const optionalSize = view.getUint16(pe + 20, true);
  const sectionTable = pe + 24 + optionalSize;
  const rvaToFileOffset = rva => {
    for (let index = 0; index < sectionCount; index += 1) {
      const section = sectionTable + index * 40;
      const virtualSize = view.getUint32(section + 8, true);
      const virtualAddress = view.getUint32(section + 12, true);
      const rawSize = view.getUint32(section + 16, true);
      const rawAddress = view.getUint32(section + 20, true);
      if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize))
        return rawAddress + rva - virtualAddress;
    }
    throw new Error(`RVA 0x${rva.toString(16)} outside Extension.dll sections`);
  };
  const bodyHash = (start, end) => createHash('sha256').update(
    dllBytes.slice(rvaToFileOffset(start - meta.imageBase),
      rvaToFileOffset(end - meta.imageBase))).digest('hex');
  if (meta.execBody)
    assert.equal(bodyHash(meta.execBody, meta.execEnd), meta.execSha256,
      'exec body changed');
  if (meta.methodBody)
    assert.equal(bodyHash(meta.methodBody, meta.methodEnd), meta.methodSha256,
      'method body changed');
  for (const extra of opts.bodyRanges ?? [])
    assert.equal(bodyHash(extra.body, extra.end), extra.sha256,
      `body ${extra.body.toString(16)} changed`);

  // ---- oracle --------------------------------------------------------------
  const oracle = JSON.parse(execFileSync(PYTHON, [
    path.join(ROOT, 'scripts', opts.oracleFile), root,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  assert.equal(oracle.hashes['Extension.dll'], meta.dllSha256);
  assert.equal(oracle.extensionBase, 0x12000000);
  assert.equal(oracle.execBody, meta.execBody);
  assert.equal(oracle.execEnd, meta.execEnd);
  if (meta.methodBody) {
    assert.equal(oracle.methodBody, meta.methodBody);
    assert.equal(oracle.methodEnd, meta.methodEnd);
  }

  // ---- JS replay -------------------------------------------------------------
  const cases = CASES[opts.section];
  const runCase = (fn, caseSpec) => {
    const { world, receiver } = buildWorld(caseSpec);
    const args = (caseSpec.args ?? []).map(arg => marshalArg(world, arg));
    const raw = opts.invoke(fn, receiver, args, world, caseSpec);
    const result = raw === undefined ? 0xdeadbeef
      : (raw !== null && typeof raw === 'object' ? world.canon(raw) : raw);
    return {
      accesses: world.trace,
      events: world.events,
      state: world.dumpState(caseSpec.dump ?? {}),
      result,
    };
  };

  const report = { native: meta.function, cases: {}, mutations: [] };
  for (const [name, caseSpec] of Object.entries(cases)) {
    const expected = oracle.cases[name];
    assert.ok(expected, `oracle missing case ${name}`);
    const got = runCase(mod[opts.entry], caseSpec);
    assert.deepEqual(got.accesses, expected.accesses, `${name}: accesses`);
    assert.deepEqual(got.events, expected.events, `${name}: events`);
    assert.deepEqual(got.state, expected.state, `${name}: state`);
    if (opts.checkResult !== false)
      assert.deepEqual(got.result, expected.result, `${name}: result`);
    report.cases[name] = 'pass';
  }

  // ---- mutation gate ---------------------------------------------------------
  const source = readFileSync(opts.moduleFile, 'utf8');
  for (const [i, mutation] of (opts.mutations ?? []).entries()) {
    const hits = source.split(mutation.find).length - 1;
    assert.equal(hits, 1, `mutation ${i} find string occurs ${hits} times`);
    const patched = source.replace(mutation.find, mutation.replace);
    const dir = mkdtempSync(path.join(ROOT, 'src/runtime/.mut-'));
    try {
      const moduleName = path.basename(opts.moduleFile);
      writeFileSync(path.join(dir, moduleName), patched);
      const mutated = await import(
        url.pathToFileURL(path.join(dir, moduleName)).href);
      let diverged = false;
      let detail = '';
      for (const [name, caseSpec] of Object.entries(cases)) {
        const expected = oracle.cases[name];
        try {
          const got = runCase(mutated[opts.entry], caseSpec);
          const same = JSON.stringify(got.accesses) === JSON.stringify(expected.accesses) &&
            JSON.stringify(got.events) === JSON.stringify(expected.events) &&
            JSON.stringify(got.state) === JSON.stringify(expected.state) &&
            (opts.checkResult === false ||
              JSON.stringify(got.result) === JSON.stringify(expected.result));
          if (!same) {
            diverged = true;
            detail = `${name}: accesses/events/state/result diverged`;
            break;
          }
        } catch (error) {
          diverged = true;
          detail = `${name}: threw ${error.message}`;
          break;
        }
      }
      assert.ok(diverged,
        `mutation ${i} (${mutation.note}) produced identical behavior`);
      report.mutations.push({ note: mutation.note, detail });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(report, null, 1));
}
