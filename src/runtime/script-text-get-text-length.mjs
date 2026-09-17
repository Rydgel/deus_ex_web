/**
 * Recovered Extension.dll TextWindow.GetTextLength translation (native 1553,
 * exec body 0x10046d70 — fully inline).
 *
 * Inline exec: one result-eat, then
 * *out = text.num ? text.num - 1 : 0 — two return paths share the write.
 */
import {
  TEXT_WINDOW_DLL,
  getTextLengthExec,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_GET_TEXT_LENGTH_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.GetTextLength',
  packageExport: 1131,
  nativeIndex: 1553,
  functionFlags: 0x401,
  serialSize: 27,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10046d70,
  execEnd: 0x10046d9a,
  execSha256: '691cffbf2ffe4d36d5901cd06188671283a5b97d733c70fc448653ba1b8c2115',
});

export class TextWindowGetTextLengthBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowGetTextLengthBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowGetTextLengthBoundaryError(message);
};

export function textWindowGetTextLength(object, out, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.GetTextLength requires a canonical window object');
  if (typeof out !== 'number' || !Number.isInteger(out) || out <= 0)
    fail('TextWindow.GetTextLength requires a result cell out');
  const L = textMemory(object, services);
  getTextLengthExec(L, out);
}

export const execTextWindowGetTextLength = textWindowGetTextLength;
