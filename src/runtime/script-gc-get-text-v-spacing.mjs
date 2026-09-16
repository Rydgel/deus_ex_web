/**
 * Recovered Extension.dll UGC::GetTextVSpacing translation (native 1251,
 * inline getter exec body 0x1002ba70; there is no method body).
 *
 * The exec body does `fld dword [this+0x90]; fstp dword [result]`: the f32
 * field value is returned through the result pointer.  UNVERIFIED: real x87
 * hardware is expected to quiet a signalling NaN payload on the load
 * (0x7f800001 -> 0x7fc00001), but the Unicorn oracle's softfloat returns the
 * pattern unquieted, so the quieting is not proven here.  JS numbers cannot
 * preserve f32 NaN payloads either; the translation returns the decoded
 * number and the validator compares NaN-ness only for NaN oracle results.
 */
import {GC, GC_DLL, gcMemory} from './script-gc-state-model.mjs';

const freeze = Object.freeze;

export const GC_GET_TEXT_V_SPACING_NATIVE = freeze({
  package: 'Extension',
  function: 'GC.GetTextVSpacing',
  packageExport: 2065,
  nativeIndex: 1251,
  functionFlags: 0x401,
  serialSize: 28,
  ...GC_DLL,
  execBody: 0x1002ba70,
  execEnd: 0x1002ba8a,
  execSha256: '321579b8223e986a3e493c6c78fda4d9bfe26d6cddc0b92b4f9d1d0df59101dc',
  methodBody: null,
  methodEnd: null,
  methodSha256: null,
});

export class GcGetTextVSpacingBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcGetTextVSpacingBoundaryError';
    this.code = `GC_GET_TEXT_V_SPACING_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new GcGetTextVSpacingBoundaryError(message, details);
};

export function gcGetTextVSpacing(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('GC.GetTextVSpacing requires a canonical GC object', {kind: 'REFERENCE', value: object});
  const L = gcMemory(object, services);
  return L.read(L.base + GC.textVSpacing, 'f32');
}

export const execGcGetTextVSpacing = gcGetTextVSpacing;
