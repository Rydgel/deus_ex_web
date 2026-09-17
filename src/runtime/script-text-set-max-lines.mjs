/**
 * Recovered Extension.dll TextWindow.SetMaxLines translation (native 1560,
 * exec body 0x10047230, method 0x10046270).
 *
 * Exec reads one dword; method 0x10046270 clamps negative
 * to 0 then clamps UP to the CURRENT minLines (a -1 min clamps to -1);
 * writes +0x160 + reconfigures iff it differs.
 */
import {
  TEXT_WINDOW_DLL,
  setMaxLinesMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_SET_MAX_LINES_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.SetMaxLines',
  packageExport: 1064,
  nativeIndex: 1560,
  functionFlags: 0x401,
  serialSize: 30,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10047230,
  execEnd: 0x10047276,
  execSha256: 'cbd9732e63b0edbef7a4595bd3b662a9184ff144723b44cb02ebbd95e17c59b2',
  methodBody: 0x10046270,
  methodEnd: 0x100462d3,
  methodSha256: 'f15ae8a1baca3d47774c47b443610f9154b4c0502f4308bd843a4b48a3ecdffb',
});

export class TextWindowSetMaxLinesBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowSetMaxLinesBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowSetMaxLinesBoundaryError(message);
};

export function textWindowSetMaxLines(object, newMaxLines, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.SetMaxLines requires a canonical window object');
  if (typeof newMaxLines !== 'number' || !Number.isInteger(newMaxLines))
    fail('TextWindow.SetMaxLines requires an integer newMaxLines');
  const L = textMemory(object, services);
  setMaxLinesMethod(L, newMaxLines);
}

export const execTextWindowSetMaxLines = textWindowSetMaxLines;
