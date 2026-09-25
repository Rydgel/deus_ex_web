#!/usr/bin/env node
/** DeusExPlayer.GetDeusExVersion (1099) against the hash-checked DeusEx.dll:
 * the body's instruction bytes, the argument push order and the three strings
 * it formats. Evidence: docs/script-font-load.md ("Main menu version text"). */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {DEUSEX_VERSION_NATIVE as V, getDeusExVersion} from '../src/runtime/script-deusex-version.mjs';
import {parsePackage} from '../src/unreal/package.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';

const dll = await readFile(path.join(gameDirectory(), 'System/DeusEx.dll'));
assert.equal(createHash('sha256').update(dll).digest('hex'),
  'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04');
const pe = dll.readUInt32LE(60), opt = pe + 24, base = dll.readUInt32LE(opt + 28);
const sections = Array.from({length: dll.readUInt16LE(pe + 6)}, (_, i) => {
  const s = opt + dll.readUInt16LE(pe + 20) + i * 40;
  return {virtual: dll.readUInt32LE(s + 12), size: Math.max(dll.readUInt32LE(s + 8), dll.readUInt32LE(s + 16)),
    raw: dll.readUInt32LE(s + 20)};
});
const at = va => {
  const rva = va - base, s = sections.find(s => s.virtual <= rva && rva < s.virtual + s.size);
  return s.raw + rva - s.virtual;
};
const hex = (va, n) => dll.subarray(at(va), at(va) + n).toString('hex');
const wide = va => { let out = ''; for (let o = at(va); dll.readUInt16LE(o); o += 2) out += String.fromCharCode(dll.readUInt16LE(o)); return out; };
const ansi = va => { let out = ''; for (let o = at(va); dll[o]; o += 1) out += String.fromCharCode(dll[o]); return out; };
const le = n => Buffer.from(Uint32Array.of(n).buffer).toString('hex');

// 0x10014298: push timestamp; call [appFromAnsi]; mov ecx,[versionPointer];
// add esp,4; push ecx; push eax; push format; push buffer; call [appSprintf];
// ... mov eax, buffer. cdecl: appSprintf(buffer, format, timestamp, version).
const pushes = `68${le(V.timestamp)}ff15a0710210` + `8b0d${le(V.versionPointer)}83c404` + '5150' +
  `68${le(V.format)}68${le(V.buffer)}ff1500710210`;
assert.equal(hex(0x10014298, pushes.length / 2), pushes);
assert.equal(hex(0x100142c4, 5), `b8${le(V.buffer)}`);
assert.equal(ansi(V.timestamp), V.timestampText);
assert.equal(wide(V.format), V.formatText);
assert.equal(dll.readUInt32LE(at(V.versionPointer)), V.version);
assert.equal(wide(V.version), V.versionText);
// Exec 0x100147b0: ++Stack.Code (EX_EndFunctionParms), call the body, then the
// inline FString = TCHAR* assignment (appStrlen+1, FArray::Realloc(2), copy).
assert.equal(hex(V.exec, 16), '558bec518b450856ff400ce8b0faffff');
assert.equal(getDeusExVersion(), 'Mon Mar 19 12:06:14 2001 v1.112fm');

// DeusEx.u declaration: native(1099) final function string GetDeusExVersion().
const pkgBytes = new Uint8Array(await readFile(path.join(gameDirectory(), 'System/DeusEx.u')));
const pkg = parsePackage(pkgBytes);
const index = pkg.exports.findIndex(e => e.path === 'DeusExPlayer.GetDeusExVersion') + 1;
const fn = readFunctionMetadata({pkg, bytes: pkgBytes}, index);
assert.equal(fn.nativeIndex, V.index);
console.log(`validate-deusex-version: native ${V.index} formats "${getDeusExVersion()}" ` +
  'from the retail DeusEx.dll body, strings and push order');
