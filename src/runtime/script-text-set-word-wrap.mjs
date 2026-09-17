/**
 * Recovered Extension.dll XTextWindow::SetWordWrap translation (native 1555,
 * method body 0x10045fb0, exec trampoline 0x10046f90).
 *
 * The exec reads one dword (the bool marshals as a dword), eats the result
 * byte, and calls the method.  The method's guard compares the isolated
 * flag bit ((textFlags & 1)) against the RAW dword argument — a marshalled
 * bool only ever produces 0/1, but the binary quirk stands: arg values 2/3
 * still enter the write path and reconfigure.  The write is
 * textFlags ^= (textFlags ^ arg) & 1, then AskParentForReconfigure.
 */
import {
  TEXT_WINDOW_DLL,
  setWordWrapMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_SET_WORD_WRAP_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.SetWordWrap',
  packageExport: 1118,
  nativeIndex: 1555,
  functionFlags: 0x401,
  serialSize: 31,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10046f90,
  execEnd: 0x10046fd6,
  execSha256: '78d65347178b5b78b056bf8b17677b289a44bc0d797e83018a0665ce3177e2c0',
  methodBody: 0x10045fb0,
  methodEnd: 0x10046011,
  methodSha256: '0fb19fd90b9c4753799f35c4bd0c3104ea093231420cc808b07af61555363399',
});

export class TextWindowSetWordWrapBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowSetWordWrapBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowSetWordWrapBoundaryError(message);
};

export function textWindowSetWordWrap(object, bNewWordWrap, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('TextWindow.SetWordWrap requires a canonical window object');
  }
  if (typeof bNewWordWrap !== 'number' || !Number.isInteger(bNewWordWrap)) {
    fail('TextWindow.SetWordWrap requires an integer flag');
  }
  setWordWrapMethod(textMemory(object, services), bNewWordWrap);
}

export const execTextWindowSetWordWrap = textWindowSetWordWrap;
