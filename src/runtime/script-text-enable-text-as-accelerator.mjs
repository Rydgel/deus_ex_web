/**
 * Recovered Extension.dll TextWindow.EnableTextAsAccelerator translation (native 1564,
 * exec body 0x10047370, method 0x100464e0).
 *
 * Exec prefills the local with 1 (the
 * default), reads the bool dword, eats the result byte, calls 0x100464e0.
 * The method guard compares ((textFlags >> 1) & 1) against the RAW dword;
 * the write is textFlags = (flags & ~2) | ((arg & 1) << 1), then enabling
 * scans the current text for |&x while disabling scans NULL (key -> 0).
 */
import {
  TEXT_WINDOW_DLL,
  enableAcceleratorMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_ENABLE_TEXT_AS_ACCELERATOR_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.EnableTextAsAccelerator',
  packageExport: 1088,
  nativeIndex: 1564,
  functionFlags: 0x401,
  serialSize: 31,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10047370,
  execEnd: 0x100473b6,
  execSha256: '76c5b7ece48aa6177df86c058ed77e2743308490d66acf1cacd1dea9983fa065',
  methodBody: 0x100464e0,
  methodEnd: 0x10046560,
  methodSha256: 'f0dbe95b805acd1e4d9300bc0e4e54511cb69ddeee997f51aabef0dc1019c054',
});

export class TextWindowEnableTextAsAcceleratorBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowEnableTextAsAcceleratorBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowEnableTextAsAcceleratorBoundaryError(message);
};

export function textWindowEnableTextAsAccelerator(object, bEnable, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.EnableTextAsAccelerator requires a canonical window object');
  if (typeof bEnable !== 'number' || !Number.isInteger(bEnable))
    fail('TextWindow.EnableTextAsAccelerator requires an integer bEnable');
  const L = textMemory(object, services);
  enableAcceleratorMethod(L, bEnable);
}

export const execTextWindowEnableTextAsAccelerator = textWindowEnableTextAsAccelerator;
