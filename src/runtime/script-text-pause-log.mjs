/**
 * Recovered Extension.dll TextLogWindow.PauseLog translation (native 1573,
 * exec body 0x10048210 — fully inline).
 *
 * Inline exec: one dword marshal read, the result-eat, then
 * the flag write — logFlags = (logFlags & ~4) | ((arg & 1) << 2) at +0x184.
 * No method body.
 */
import {
  TEXT_WINDOW_DLL,
  pauseLogExec,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_PAUSE_LOG_NATIVE = freeze({
  package: 'Extension',
  function: 'TextLogWindow.PauseLog',
  packageExport: 911,
  nativeIndex: 1573,
  functionFlags: 0x401,
  serialSize: 31,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10048210,
  execEnd: 0x10048265,
  execSha256: '10e3a03d77eeafcea66468faf9bd3725029eed1d4796efb64a939fa96262e334',
});

export class TextLogWindowPauseLogBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextLogWindowPauseLogBoundaryError';
  }
}

const fail = message => {
  throw new TextLogWindowPauseLogBoundaryError(message);
};

export function textLogWindowPauseLog(object, bNewPauseState, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextLogWindow.PauseLog requires a canonical window object');
  if (typeof bNewPauseState !== 'number' || !Number.isInteger(bNewPauseState))
    fail('TextLogWindow.PauseLog requires an integer bNewPauseState');
  const L = textMemory(object, services);
  pauseLogExec(L, bNewPauseState);
}

export const execTextLogWindowPauseLog = textLogWindowPauseLog;
