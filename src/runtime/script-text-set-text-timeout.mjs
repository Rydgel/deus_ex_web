/**
 * Recovered Extension.dll TextLogWindow.SetTextTimeout translation (native 1572,
 * exec body 0x100481a0, method 0x100478e0).
 *
 * Exec reads one f32 dword; method 0x100478e0 is a raw
 * store of the marshalled bits at +0x174 — no clamp, no reconfigure.
 */
import {
  TEXT_WINDOW_DLL,
  f32Bits,
  setTextTimeoutMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_SET_TEXT_TIMEOUT_NATIVE = freeze({
  package: 'Extension',
  function: 'TextLogWindow.SetTextTimeout',
  packageExport: 976,
  nativeIndex: 1572,
  functionFlags: 0x401,
  serialSize: 31,
  ...TEXT_WINDOW_DLL,
  execBody: 0x100481a0,
  execEnd: 0x100481e6,
  execSha256: 'b5f19a7386bc87c8b9ea0d6c75a8d9220d1c2eb0e982b1396cfaf3670f5f70f3',
  methodBody: 0x100478e0,
  methodEnd: 0x100478ed,
  methodSha256: '40b1203f9df61ffc9170179fdf613958d66c41725cd06a1326e41146f8e288aa',
});

export class TextLogWindowSetTextTimeoutBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextLogWindowSetTextTimeoutBoundaryError';
  }
}

const fail = message => {
  throw new TextLogWindowSetTextTimeoutBoundaryError(message);
};

export function textLogWindowSetTextTimeout(object, newTimeout, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextLogWindow.SetTextTimeout requires a canonical window object');
  if (typeof newTimeout !== 'number')
    fail('TextLogWindow.SetTextTimeout requires a float newTimeout');
  const L = textMemory(object, services);
  setTextTimeoutMethod(L, f32Bits(newTimeout));
}

export const execTextLogWindowSetTextTimeout = textLogWindowSetTextTimeout;
