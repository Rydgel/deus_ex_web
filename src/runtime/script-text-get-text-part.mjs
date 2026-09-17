/**
 * Recovered Extension.dll TextWindow.GetTextPart translation (native 1554,
 * exec body 0x10046dc0 — fully inline).
 *
 * Inline exec: marshals startPos and Count as dwords and
 * OutText through the out-string reader (GPropAddr = the lvalue; a 0
 * GPropAddr falls back to the marshal local), eats the result byte, then
 * Core FString::Mid (0x101086e0) computes s = min_u(start, len),
 * e = min_u(max_u(start+count, s), len) into a stack temp, the temp copies
 * into the destination via the shared assign (num = max = mid.num,
 * Realloc(2), raw copy), the temp tears down (Empty(2,0) + dtor), *out =
 * dest.num ? num-1 : 0, and the marshal local tears down.
 */
import {
  TEXT_WINDOW_DLL,
  getTextPartExec,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_GET_TEXT_PART_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.GetTextPart',
  packageExport: 1135,
  nativeIndex: 1554,
  functionFlags: 0x401,
  serialSize: 36,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10046dc0,
  execEnd: 0x10046f6d,
  execSha256: '27527784b91014e74c29a684b7555c7f9129649dd753ef277bbea623deed7176',
});

export class TextWindowGetTextPartBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowGetTextPartBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowGetTextPartBoundaryError(message);
};

export function textWindowGetTextPart(object, startPos, count, dest, out, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.GetTextPart requires a canonical window object');
  if (typeof startPos !== 'number' || !Number.isInteger(startPos))
    fail('TextWindow.GetTextPart requires an integer startPos');
  if (typeof count !== 'number' || !Number.isInteger(count))
    fail('TextWindow.GetTextPart requires an integer count');
  if (typeof dest !== 'number' || !Number.isInteger(dest) || dest < 0)
    fail('TextWindow.GetTextPart requires an out-string cell dest');
  if (typeof out !== 'number' || !Number.isInteger(out) || out <= 0)
    fail('TextWindow.GetTextPart requires a result cell out');
  const L = textMemory(object, services);
  getTextPartExec(L, startPos, count, dest, out);
}

export const execTextWindowGetTextPart = textWindowGetTextPart;
