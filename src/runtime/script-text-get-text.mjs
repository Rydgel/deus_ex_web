/**
 * Recovered Extension.dll TextWindow.GetText translation (native 1552,
 * exec body 0x10046cd0 — fully inline).
 *
 * The exec body is the whole native — no marshal reads, one
 * frame->Code result-eat.  Result != &this->text guards the self-copy;
 * otherwise Result->num = Result->max = text.num, FArray::Realloc(2), and a
 * rep-movsd/movsb copy of num*2 bytes from text.data (or the shared L""
 * when num is 0).
 */
import {
  TEXT_WINDOW_DLL,
  getTextExec,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_GET_TEXT_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.GetText',
  packageExport: 1142,
  nativeIndex: 1552,
  functionFlags: 0x401,
  serialSize: 27,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10046cd0,
  execEnd: 0x10046d48,
  execSha256: '6cfb8b5161ae1e1ac142f017db79e19d13b02ce6cd1fb13f275790a9731636cc',
});

export class TextWindowGetTextBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowGetTextBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowGetTextBoundaryError(message);
};

export function textWindowGetText(object, out, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.GetText requires a canonical window object');
  if (typeof out !== 'number' || !Number.isInteger(out) || out <= 0)
    fail('TextWindow.GetText requires a result cell out');
  const L = textMemory(object, services);
  getTextExec(L, out);
}

export const execTextWindowGetText = textWindowGetText;
