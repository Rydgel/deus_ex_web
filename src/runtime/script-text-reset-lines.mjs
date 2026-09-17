/**
 * Recovered Extension.dll TextWindow.ResetLines translation (native 1561,
 * exec body 0x100472a0, method 0x10046310).
 *
 * Exec performs the bare result-eat and calls 0x10046310.
 * The method writes -1/-1 and reconfigures only when at least one of
 * minLines/maxLines is non-negative — both-negative is already reset.
 */
import {
  TEXT_WINDOW_DLL,
  resetLinesMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_RESET_LINES_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.ResetLines',
  packageExport: 1104,
  nativeIndex: 1561,
  functionFlags: 0x401,
  serialSize: 26,
  ...TEXT_WINDOW_DLL,
  execBody: 0x100472a0,
  execEnd: 0x100472af,
  execSha256: '330e3b14e17ee2e6cd98a60503efe8516b7af496eadd47a53c54bbbbd82d73ca',
  methodBody: 0x10046310,
  methodEnd: 0x10046371,
  methodSha256: '7ec0de63147283d7723f290fb3e2a63cf9ba753da3e8813b80197eb29139acb1',
});

export class TextWindowResetLinesBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowResetLinesBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowResetLinesBoundaryError(message);
};

export function textWindowResetLines(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.ResetLines requires a canonical window object');
  const L = textMemory(object, services);
  resetLinesMethod(L);
}

export const execTextWindowResetLines = textWindowResetLines;
