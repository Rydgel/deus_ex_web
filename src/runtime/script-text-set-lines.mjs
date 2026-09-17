/**
 * Recovered Extension.dll TextWindow.SetLines translation (native 1558,
 * exec body 0x10047130, method 0x10046120).
 *
 * Exec reads two dwords; method 0x10046120 clamps each negative
 * to 0, then clamps min to max, and writes +0x15c/+0x160 + reconfigures iff
 * either differs.
 */
import {
  TEXT_WINDOW_DLL,
  setLinesMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_SET_LINES_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.SetLines',
  packageExport: 1120,
  nativeIndex: 1558,
  functionFlags: 0x401,
  serialSize: 34,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10047130,
  execEnd: 0x1004719f,
  execSha256: '83cd3f2128563ea0279bda055cdb5bf1092edd9f3a8b314c1372be5b8e82877c',
  methodBody: 0x10046120,
  methodEnd: 0x10046194,
  methodSha256: '2d71762fdf815526e6188a0e4a02699f8d3e9c8bf74f159dea482574959d9bbf',
});

export class TextWindowSetLinesBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowSetLinesBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowSetLinesBoundaryError(message);
};

export function textWindowSetLines(object, newMinLines, newMaxLines, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.SetLines requires a canonical window object');
  if (typeof newMinLines !== 'number' || !Number.isInteger(newMinLines))
    fail('TextWindow.SetLines requires an integer newMinLines');
  if (typeof newMaxLines !== 'number' || !Number.isInteger(newMaxLines))
    fail('TextWindow.SetLines requires an integer newMaxLines');
  const L = textMemory(object, services);
  setLinesMethod(L, newMinLines, newMaxLines);
}

export const execTextWindowSetLines = textWindowSetLines;
