/**
 * Recovered Extension.dll TextLogWindow.ClearLog translation (native 1571,
 * exec body 0x10048170, method 0x10047810).
 *
 * Exec eats the result byte and calls 0x10047810.  The method
 * runs each record's embedded text FString through Empty(2,0),
 * boundedRemove(0,num), and ~FArray, then num = max = 0 + Realloc(0x14) on
 * the line array, then the rebuild helper (empty text + reconfigure).
 */
import {
  TEXT_WINDOW_DLL,
  clearLogMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_CLEAR_LOG_NATIVE = freeze({
  package: 'Extension',
  function: 'TextLogWindow.ClearLog',
  packageExport: 990,
  nativeIndex: 1571,
  functionFlags: 0x401,
  serialSize: 27,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10048170,
  execEnd: 0x1004817f,
  execSha256: 'dcab7d77788326ab365d1827bec793a58d193047b27699566fb74851d1a708e0',
  methodBody: 0x10047810,
  methodEnd: 0x100478ad,
  methodSha256: '45c4b2e7af613defc33f7237d9d4a06411cde57c9aebcef01c73bf1c6254b8ac',
});

export class TextLogWindowClearLogBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextLogWindowClearLogBoundaryError';
  }
}

const fail = message => {
  throw new TextLogWindowClearLogBoundaryError(message);
};

export function textLogWindowClearLog(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextLogWindow.ClearLog requires a canonical window object');
  const L = textMemory(object, services);
  clearLogMethod(L);
}

export const execTextLogWindowClearLog = textLogWindowClearLog;
