/** Focused original-evidence validator for ToggleWindow.GetToggle. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import {
  WINDOW_TOGGLE_GET_BITS,
  WINDOW_TOGGLE_GET_FIELDS,
  WINDOW_TOGGLE_GET_NATIVE,
  WindowToggleGetNativeBoundaryError,
  getToggleNative,
} from '../src/runtime/script-window-toggle-get.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const system = path.join(root, 'System');
const extensionBytes = new Uint8Array(await readFile(path.join(system, 'Extension.u')));
const assets = new AssetStore((await readdir(system)).map(name => ({
  path: `System/${name}`,
  read: () => name === 'Extension.u'
    ? extensionBytes
    : readFile(path.join(system, name)),
})));
const extension = await assets.get('Extension');
const functionIndex = extension.exportsByPath.get('togglewindow.gettoggle');
assert.equal(functionIndex, WINDOW_TOGGLE_GET_NATIVE.packageExport);
const metadata = readFunctionMetadata(extension, functionIndex);
assert.equal(metadata.nativeIndex, WINDOW_TOGGLE_GET_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags, WINDOW_TOGGLE_GET_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize, WINDOW_TOGGLE_GET_NATIVE.serialSize);
assert.deepEqual(metadata.parameters.map(parameter => parameter.name), ['ReturnValue']);

const extensionDll = new Uint8Array(await readFile(path.join(system, 'Extension.dll')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(extensionDll), WINDOW_TOGGLE_GET_NATIVE.dllSha256);
const view = new DataView(extensionDll.buffer, extensionDll.byteOffset, extensionDll.byteLength);
const pe = view.getUint32(0x3c, true);
const sectionCount = view.getUint16(pe + 6, true);
const optionalSize = view.getUint16(pe + 20, true);
const sectionTable = pe + 24 + optionalSize;
function rvaToFileOffset(rva) {
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionTable + index * 40;
    const virtualSize = view.getUint32(section + 8, true);
    const virtualAddress = view.getUint32(section + 12, true);
    const rawSize = view.getUint32(section + 16, true);
    const rawAddress = view.getUint32(section + 20, true);
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
      return rawAddress + rva - virtualAddress;
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} is outside Extension.dll sections`);
}
function bodyHash(start, end) {
  const begin = rvaToFileOffset(start - WINDOW_TOGGLE_GET_NATIVE.imageBase);
  const finish = rvaToFileOffset(end - WINDOW_TOGGLE_GET_NATIVE.imageBase);
  return sha256(extensionDll.slice(begin, finish));
}
assert.equal(bodyHash(WINDOW_TOGGLE_GET_NATIVE.execBody, WINDOW_TOGGLE_GET_NATIVE.execEnd),
  WINDOW_TOGGLE_GET_NATIVE.execSha256, 'exec bytes');
assert.equal(bodyHash(WINDOW_TOGGLE_GET_NATIVE.body, WINDOW_TOGGLE_GET_NATIVE.end),
  WINDOW_TOGGLE_GET_NATIVE.bodySha256, 'method bytes');

const python = process.env.NATIVE_PROBE_PYTHON ||
  path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-toggle-get-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
assert.equal(native.hashes['Extension.dll'], WINDOW_TOGGLE_GET_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.equal(native.addresses.body, 0x12049a50);
assert.equal(native.addresses.end, 0x12049a5a);
assert.equal(native.addresses.execBody, 0x12049d80);
assert.equal(native.addresses.execEnd, 0x12049d95);

const F = WINDOW_TOGGLE_GET_FIELDS;
const flagsByCase = {
  clear: 0,
  set: 1,
  clearWithOtherBits: 0xfffffffe,
  setWithOtherBits: 0xffffffff,
};

function world(flags) {
  const window = { name: 'window' };
  window[F.toggleFlags] = flags >>> 0;
  const trace = [];
  const services = {
    read: (object, offset, kind, details) => {
      let value = object[offset];
      if (value === undefined) value = 0;
      if (kind === 'u32') value >>>= 0;
      trace.push({ op: 'read', object: object.name, offset, kind, size: 4, value });
      return value;
    },
  };
  return { window, trace, services };
}

for (const name of Object.keys(native.cases)) {
  const original = native.cases[name];
  const value = world(flagsByCase[name]);
  const result = getToggleNative(value.window, value.services);
  assert.deepEqual(value.trace, original.accesses, `${name} raw access trace`);
  assert.equal(result === true ? 1 : result === false ? 0 : result, original.result,
    `${name} result bit`);
  assert.equal(value.window[F.toggleFlags] >>> 0, original.final, `${name} field unchanged`);
}

// Local boundary checks the oracle cases do not distinguish.
{
  const value = world(1);
  assert.equal(getToggleNative(value.window, value.services), true);
  value.services.read = () => Promise.resolve(0);
  assert.throws(() => getToggleNative(value.window, value.services),
    error => error instanceof WindowToggleGetNativeBoundaryError &&
      error.code === 'WINDOW_TOGGLE_GET_ASYNC',
    'a suspended raw read must stay an explicit boundary');
  value.services.read = () => undefined;
  assert.throws(() => getToggleNative(value.window, value.services),
    error => error instanceof WindowToggleGetNativeBoundaryError &&
      error.code === 'WINDOW_TOGGLE_GET_FIELD',
    'an unresolved +0x174 read must stay an explicit boundary');
  assert.throws(() => getToggleNative(null, value.services),
    error => error instanceof WindowToggleGetNativeBoundaryError &&
      error.code === 'WINDOW_TOGGLE_GET_REFERENCE',
    'a null receiver must stay an explicit boundary');
  const masked = world(0x80000000);
  assert.equal(getToggleNative(masked.window, masked.services), false,
    'a set high bit without bit 0 returns false');
  assert.ok((WINDOW_TOGGLE_GET_BITS.toggled & ~1) === 0, 'the toggled bit is exactly bit 0');
}

console.log('Window.GetToggle matches the hash-checked unchanged body: +0x174 dword read, ' +
  'bit-0 mask result, unchanged field, and explicit boundary errors.');
