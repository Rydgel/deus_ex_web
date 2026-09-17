/**
 * Recovered Extension.dll TextWindow.SetMinLines translation (native 1559,
 * exec body 0x100471c0, method 0x100461d0).
 *
 * Exec reads one dword; method 0x100461d0 clamps negative
 * to 0 then clamps to the CURRENT maxLines (a -1 max clamps everything to
 * -1); writes +0x15c + reconfigures iff it differs.
 */
import {
  TEXT_WINDOW_DLL,
  setMinLinesMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_SET_MIN_LINES_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.SetMinLines',
  packageExport: 1059,
  nativeIndex: 1559,
  functionFlags: 0x401,
  serialSize: 31,
  ...TEXT_WINDOW_DLL,
  execBody: 0x100471c0,
  execEnd: 0x10047206,
  execSha256: '98b8b658a6fd478a926678fd280e7a371162e852ddd6dc51961e948f9fd9b072',
  methodBody: 0x100461d0,
  methodEnd: 0x10046233,
  methodSha256: '592c4a1211ff714106d72c1251c47921d114cd4861085dfa9e78f4e0c82e0868',
});

export class TextWindowSetMinLinesBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowSetMinLinesBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowSetMinLinesBoundaryError(message);
};

export function textWindowSetMinLines(object, newMinLines, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.SetMinLines requires a canonical window object');
  if (typeof newMinLines !== 'number' || !Number.isInteger(newMinLines))
    fail('TextWindow.SetMinLines requires an integer newMinLines');
  const L = textMemory(object, services);
  setMinLinesMethod(L, newMinLines);
}

export const execTextWindowSetMinLines = textWindowSetMinLines;
