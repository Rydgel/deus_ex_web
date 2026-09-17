/**
 * Recovered Extension.dll XTextWindow::SetText translation (native 1550,
 * exec body 0x10046a30, method body 0x10045d50 — vtable slot +0x11c).
 *
 * The exec marshals NewText through GNatives into a stack-local FString
 * (deep copy, one Realloc), eats the result byte, runs convertPipes on the
 * local's text, dispatches the +0x11c virtual, then tears the local down
 * through the allocator (num = max = 0, Realloc(2), Remove(0,0,2), free).
 *
 * The method compares the CURRENT text against the argument with
 * appStricmp (case-INSENSITIVE): an equal string returns early with no
 * writes and no reconfigure.  A data pointer identical to the argument
 * skips the assign but still reconfigures.  textFlags bit1 routes the
 * original argument through SetAcceleratorText (the |&x scan), and
 * AskParentForReconfigure always runs on the write path.
 */
import {
  TEXT_WINDOW_DLL,
  setTextExec,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_SET_TEXT_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.SetText',
  packageExport: 1146,
  nativeIndex: 1550,
  functionFlags: 0x401,
  serialSize: 30,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10046a30,
  execEnd: 0x10046b52,
  execSha256: '3c1f02b64713f96f82539033b58ca16a7125974d12964ad16cb8c065c156da64',
  methodBody: 0x10045d50,
  methodEnd: 0x10045e2a,
  methodSha256: 'a84bc56acde8c1e4848a77d3cde089eac8dd0aa624ac77121f15e7a41f2fca4d',
});

export class TextWindowSetTextBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowSetTextBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowSetTextBoundaryError(message);
};

export function textWindowSetText(object, newTextCell, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('TextWindow.SetText requires a canonical window object');
  }
  if (typeof newTextCell !== 'number' || !Number.isInteger(newTextCell) || newTextCell < 0) {
    fail('TextWindow.SetText requires a marshalled FString cell');
  }
  setTextExec(textMemory(object, services), newTextCell >>> 0);
}

export const execTextWindowSetText = textWindowSetText;
