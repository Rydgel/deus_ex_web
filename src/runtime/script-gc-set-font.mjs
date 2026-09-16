/**
 * Recovered Extension.dll UGC::SetFont translation (native 1242, exec
 * trampoline 0x1002b6c0, shared method body 0x10027640).
 *
 * The exec body marshals the single object param through GNatives, then
 * pushes the evaluated dword TWICE and calls the shared two-font method
 * body: both +0x7c (normalFont) and +0x80 (boldFont) receive the pointer.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_FONT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetFont',
  packageExport: 2047,
  nativeIndex: 1242,
  functionFlags: 0x401,
  serialSize: 30,
  ...GC_DLL,
  execBody: 0x1002b6c0,
  execEnd: 0x1002b707,
  execSha256: '24a76786a2be0a99fc2cca118a9d81a5d327681fe7020be18d18bd2deb7b52ae',
  methodBody: 0x10027640,
  methodEnd: 0x10027654,
  methodSha256: '7ce05c25dd00d30022780c045313059e9faf9037610d53bcb431c3eade92c2de',
});

export class GcSetFontBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetFontBoundaryError';
    this.code = `GC_SET_FONT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetFontBoundaryError(message, details);
};

export function gcSetFont(object, newFont, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetFont requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newFont !== 'number' || !Number.isInteger(newFont))
    fail('GC.SetFont requires an integer font pointer', {kind: 'VALUE', value: newFont});
  const L = gcMemory(object, services);
  L.write(L.base + GC.normalFont, 'u32', newFont >>> 0);
  L.write(L.base + GC.boldFont, 'u32', newFont >>> 0);
}

export const execGcSetFont = gcSetFont;
