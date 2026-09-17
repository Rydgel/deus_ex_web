/**
 * Recovered Extension.dll TextWindow.AppendText translation (native 1551,
 * exec body 0x10046b80, method 0x10045e60).
 *
 * Exec 0x10046b80 marshals NewText into a stack-local FString, eats the result
 * byte, runs convertPipes, and dispatches vtable +0x120 (method 0x10045e60).
 * With text.num != 0 the method appends at data + (num-1)*2 after
 * num += strlen(arg) — the copy overwrites the old NUL; when num == 0 an
 * empty argument skips the assign entirely.  Both paths reconfigure, and
 * textFlags bit1 scans the ASSIGNED text (not the argument) for |&x.
 */
import {
  TEXT_WINDOW_DLL,
  appendTextExec,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_APPEND_TEXT_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.AppendText',
  packageExport: 1145,
  nativeIndex: 1551,
  functionFlags: 0x401,
  serialSize: 30,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10046b80,
  execEnd: 0x10046ca2,
  execSha256: '15af77095711e7413be90b522f8cf7c27f504c09e8807847c8761a456047cc1d',
  methodBody: 0x10045e60,
  methodEnd: 0x10045f74,
  methodSha256: '075f6ec2309035b4a3323f9b2695e92055e9f71279fc3e912617d4fbeec11bbd',
});

export class TextWindowAppendTextBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowAppendTextBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowAppendTextBoundaryError(message);
};

export function textWindowAppendText(object, newTextCell, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.AppendText requires a canonical window object');
  if (typeof newTextCell !== 'number' || !Number.isInteger(newTextCell) || newTextCell < 0)
    fail('TextWindow.AppendText requires a marshalled FString cell newTextCell');
  const L = textMemory(object, services);
  appendTextExec(L, newTextCell);
}

export const execTextWindowAppendText = textWindowAppendText;
