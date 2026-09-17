/**
 * Recovered Extension.dll TextLogWindow.AddLog translation (native 1570,
 * exec body 0x10048010, method 0x100476a0).
 *
 * Exec marshals NewText into a stack local (deep copy) and
 * linecol as a dword, eats the result byte, calls method 0x100476a0, then
 * tears the local down.  The method grows the +0x178 TArray by one
 * 0x14-byte record, memsets it, stores expire = f32(now_f64 + f32(+0x174
 * timeout)) from the GetTime leaf, assigns the text FString, stores the
 * color, and rebuilds this->text by joining the lines with L"
"
 * (0x10047dc0) before reconfiguring.
 */
import {
  TEXT_WINDOW_DLL,
  addLogExec,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_ADD_LOG_NATIVE = freeze({
  package: 'Extension',
  function: 'TextLogWindow.AddLog',
  packageExport: 993,
  nativeIndex: 1570,
  functionFlags: 0x401,
  serialSize: 34,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10048010,
  execEnd: 0x10048146,
  execSha256: 'c92b13140b0487b850ddb50a017c63c8770768484dca7450da4568422e5df46a',
  methodBody: 0x100476a0,
  methodEnd: 0x100477da,
  methodSha256: 'cf26eb1bea2f6744a3c6f091b0dc1f5d5a2a5f211f59a088fa760a71d22f1079',
});

export class TextLogWindowAddLogBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextLogWindowAddLogBoundaryError';
  }
}

const fail = message => {
  throw new TextLogWindowAddLogBoundaryError(message);
};

export function textLogWindowAddLog(object, newTextCell, linecol, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextLogWindow.AddLog requires a canonical window object');
  if (typeof newTextCell !== 'number' || !Number.isInteger(newTextCell) || newTextCell < 0)
    fail('TextLogWindow.AddLog requires a marshalled FString cell newTextCell');
  if (typeof linecol !== 'number' || !Number.isInteger(linecol))
    fail('TextLogWindow.AddLog requires an integer linecol');
  const L = textMemory(object, services);
  addLogExec(L, newTextCell, linecol);
}

export const execTextLogWindowAddLog = textLogWindowAddLog;
