/**
 * Recovered Extension.dll TextWindow.SetTextAlignments translation (native 1556,
 * exec body 0x10047000, method 0x10046050).
 *
 * The exec reads two dwords, masks each &0xff (the
 * byte param marshal), eats the result byte, calls method 0x10046050 which
 * makes the two unconditional byte stores at +0x14c/+0x14d — no
 * reconfigure.
 */
import {
  TEXT_WINDOW_DLL,
  setTextAlignmentsMethod,
  textMemory,
} from './script-text-model.mjs';

const freeze = Object.freeze;

export const TEXT_SET_TEXT_ALIGNMENTS_NATIVE = freeze({
  package: 'Extension',
  function: 'TextWindow.SetTextAlignments',
  packageExport: 1125,
  nativeIndex: 1556,
  functionFlags: 0x401,
  serialSize: 34,
  ...TEXT_WINDOW_DLL,
  execBody: 0x10047000,
  execEnd: 0x10047075,
  execSha256: '368e31dc383ea33d54616cd3a0a8e675651408880f46a7dae611b44bb807480b',
  methodBody: 0x10046050,
  methodEnd: 0x10046067,
  methodSha256: 'c90f05e91d2fa5a45dbe4e0ebc70888d109670ff89245345c6b6d2d3c3d29a71',
});

export class TextWindowSetTextAlignmentsBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextWindowSetTextAlignmentsBoundaryError';
  }
}

const fail = message => {
  throw new TextWindowSetTextAlignmentsBoundaryError(message);
};

export function textWindowSetTextAlignments(object, newHAlign, newVAlign, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('TextWindow.SetTextAlignments requires a canonical window object');
  if (typeof newHAlign !== 'number' || !Number.isInteger(newHAlign))
    fail('TextWindow.SetTextAlignments requires an integer newHAlign');
  if (typeof newVAlign !== 'number' || !Number.isInteger(newVAlign))
    fail('TextWindow.SetTextAlignments requires an integer newVAlign');
  const L = textMemory(object, services);
  setTextAlignmentsMethod(L, newHAlign & 0xff, newVAlign & 0xff);
}

export const execTextWindowSetTextAlignments = textWindowSetTextAlignments;
