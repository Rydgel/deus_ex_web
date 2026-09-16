/**
 * Recovered Extension.dll UGC::SetVerticalAlignment translation (native
 * 1254, method body 0x100276c0, exec trampoline 0x1002bb60).
 *
 * The method stores the argument low byte (al) at +0x95.  The exec body
 * marshals the byte param through GNatives and applies `and ecx,0xff`
 * before the call, so the translation masks & 0xff.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_SET_VERTICAL_ALIGNMENT_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.SetVerticalAlignment',
  packageExport: 2071,
  nativeIndex: 1254,
  functionFlags: 0x401,
  serialSize: 31,
  ...GC_DLL,
  execBody: 0x1002bb60,
  execEnd: 0x1002bba9,
  execSha256: 'e7dfef3855a87c6a08745dc613ddf85eb68d8c3fd7adcfd013d8a35a248ef060',
  methodBody: 0x100276c0,
  methodEnd: 0x100276cd,
  methodSha256: '5df5d8e888d1ec3dde3bb272fc215bcc1246cc691018451c538cf61eb8906b23',
});

export class GcSetVerticalAlignmentBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcSetVerticalAlignmentBoundaryError';
    this.code = `GC_SET_VERTICAL_ALIGNMENT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcSetVerticalAlignmentBoundaryError(message, details);
};

export function gcSetVerticalAlignment(object, newVAlign, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.SetVerticalAlignment requires a canonical GC object', {kind: 'REFERENCE', value: object});
  if (typeof newVAlign !== 'number' || !Number.isInteger(newVAlign))
    fail('GC.SetVerticalAlignment requires an integer alignment', {kind: 'VALUE', value: newVAlign});
  const L = gcMemory(object, services);
  L.write(L.base + GC.vAlign, 'u8', newVAlign & 0xff);
}

export const execGcSetVerticalAlignment = gcSetVerticalAlignment;
