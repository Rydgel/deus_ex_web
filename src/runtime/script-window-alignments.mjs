/**
 * Recovered Extension.dll XWindow::SetWindowAlignments translation.
 *
 * The body compares HAlign/VAlign bytes at +0x88/+0x89, then the four float
 * margins at +0x8c, +0x90, +0x94, +0x98 using x87 C3. A difference stores
 * those six fields in the original order and AskParentForReconfigure.
 * See docs/script-window-alignments.md.
 */

import {WINDOW_POSITION_OFFSETS} from './script-window-position.mjs';

const freeze = Object.freeze;
const f = Math.fround;

export const WINDOW_ALIGNMENTS_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.SetWindowAlignments',
  packageExport: 2054,
  nativeIndex: 1438,
  functionFlags: 0x401,
  serialSize: 46,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10052360,
  execEnd: 0x10052478,
  execSha256: '69ffad6b7b0a987a691606145f0099bd15d5e8bc7b909c2c4a68e9b212c7521d',
  setAlignmentsBody: 0x1004d300,
  setAlignmentsEnd: 0x1004d3d1,
  setAlignmentsSha256: '34d9f6683faa33da2623270a0be8cf98c6a0db84836fcbc86b3167bb5ae42058',
});

export const WINDOW_ALIGNMENTS_OFFSETS = freeze({
  hAlign: WINDOW_POSITION_OFFSETS.alignmentX,
  vAlign: WINDOW_POSITION_OFFSETS.alignmentY,
  hMargin0: WINDOW_POSITION_OFFSETS.x,
  hMargin1: 0x90,
  vMargin0: WINDOW_POSITION_OFFSETS.y,
  vMargin1: 0x98,
});

export const WINDOW_ALIGNMENTS_NATIVE_ADDRESSES = freeze({
  exec: WINDOW_ALIGNMENTS_NATIVE.execBody,
  setWindowAlignments: WINDOW_ALIGNMENTS_NATIVE.setAlignmentsBody,
  askParentForReconfigure: 0x1004e060,
});

export class WindowAlignmentsNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'WindowAlignmentsNativeBoundaryError';
    this.code = `WINDOW_ALIGNMENTS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details = {}) => {
  throw new WindowAlignmentsNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`Window.SetWindowAlignments ${label} suspended`, {kind: 'ASYNC'});
  }
  return value;
}

function objectReference(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    fail('Window.SetWindowAlignments requires a canonical Window object', {
      kind: 'REFERENCE', value,
    });
  }
  return value;
}

function integer(value, label) {
  if (!Number.isInteger(value)) {
    fail(`Window.SetWindowAlignments requires integer ${label}`, {kind: 'VALUE', value});
  }
  return value;
}

function number(value, label) {
  if (typeof value !== 'number') {
    fail(`Window.SetWindowAlignments requires numeric ${label}`, {kind: 'VALUE', value});
  }
  return f(value);
}

function byte(value, label, offset) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    fail(`Window.SetWindowAlignments requires uint8 ${label} at +0x${offset.toString(16)}`, {
      kind: 'VALUE', value, offset,
    });
  }
  return value;
}

function read(object, offset, kind, services, phase) {
  if (typeof services.read !== 'function') {
    fail('Window.SetWindowAlignments requires raw read service', {kind: 'SERVICE', offset});
  }
  const value = sync(services.read(object, offset, kind, {
    native: WINDOW_ALIGNMENTS_NATIVE.setAlignmentsBody,
    phase, offset, kind, width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
  if (kind === 'u8') return byte(value, `stored ${phase}`, offset);
  if (kind === 'f32') {
    if (typeof value !== 'number') {
      fail(`Window.SetWindowAlignments requires numeric stored ${phase}`, {kind: 'VALUE', value, offset});
    }
    return f(value);
  }
  fail(`Window.SetWindowAlignments does not support raw read kind ${kind}`, {kind: 'VALUE', value: kind, offset});
}

function write(object, offset, kind, value, services, phase) {
  if (typeof services.write !== 'function') {
    fail('Window.SetWindowAlignments requires raw write service', {kind: 'SERVICE', offset});
  }
  let normalized = value;
  if (kind === 'u8') normalized = byte(value, `write ${phase}`, offset);
  else if (kind === 'f32') {
    if (typeof value !== 'number') {
      fail(`Window.SetWindowAlignments requires numeric write ${phase}`, {kind: 'VALUE', value, offset});
    }
    normalized = f(value);
  } else {
    fail(`Window.SetWindowAlignments does not support raw write kind ${kind}`, {kind: 'VALUE', value: kind, offset});
  }
  return sync(services.write(object, offset, kind, normalized, {
    native: WINDOW_ALIGNMENTS_NATIVE.setAlignmentsBody,
    phase, offset, kind, width: kind === 'u8' ? 1 : 4,
  }), `write +0x${offset.toString(16)}`);
}

function x87C3Equal(left, right) {
  return Number.isNaN(left) || Number.isNaN(right) || left === right;
}

/** Execute XWindow::SetWindowAlignments(this, HAlign, VAlign, hMargin0, vMargin0, hMargin1, vMargin1). */
export function setWindowAlignmentsNative(
  object, hAlign, vAlign, hMargin0, vMargin0, hMargin1, vMargin1, services = {},
) {
  const window = objectReference(object);
  const requestedH = integer(hAlign, 'HAlign');
  const requestedV = integer(vAlign, 'VAlign');
  const requestedH0 = number(hMargin0, 'hMargin0');
  const requestedV0 = number(vMargin0, 'vMargin0');
  const requestedH1 = number(hMargin1, 'hMargin1');
  const requestedV1 = number(vMargin1, 'vMargin1');
  const O = WINDOW_ALIGNMENTS_OFFSETS;

  // cmp dword requested, zero-extended stored byte. Later float compares use
  // x87 C3 (equal and unordered skip). Each compare is skipped once a
  // difference is known, matching the original branches.
  let changed = (requestedH >>> 0) !== read(window, O.hAlign, 'u8', services, 'HAlign-compare');
  if (!changed) {
    changed = (requestedV >>> 0) !== read(window, O.vAlign, 'u8', services, 'VAlign-compare');
  }
  if (!changed) {
    changed = !x87C3Equal(requestedH0, read(window, O.hMargin0, 'f32', services, 'hMargin0-compare'));
  }
  if (!changed) {
    changed = !x87C3Equal(requestedH1, read(window, O.hMargin1, 'f32', services, 'hMargin1-compare'));
  }
  if (!changed) {
    changed = !x87C3Equal(requestedV0, read(window, O.vMargin0, 'f32', services, 'vMargin0-compare'));
  }
  if (!changed) {
    changed = !x87C3Equal(requestedV1, read(window, O.vMargin1, 'f32', services, 'vMargin1-compare'));
  }
  if (!changed) return false;

  write(window, O.hAlign, 'u8', requestedH & 0xff, services, 'HAlign-store');
  write(window, O.hMargin0, 'f32', requestedH0, services, 'hMargin0-store');
  write(window, O.vAlign, 'u8', requestedV & 0xff, services, 'VAlign-store');
  write(window, O.vMargin0, 'f32', requestedV0, services, 'vMargin0-store');
  write(window, O.hMargin1, 'f32', requestedH1, services, 'hMargin1-store');
  write(window, O.vMargin1, 'f32', requestedV1, services, 'vMargin1-store');
  if (typeof services.askParentForReconfigure !== 'function') {
    fail('Window.SetWindowAlignments requires AskParentForReconfigure service', {kind: 'SERVICE'});
  }
  sync(services.askParentForReconfigure({
    object: window,
    native: WINDOW_ALIGNMENTS_NATIVE_ADDRESSES.askParentForReconfigure,
    hAlign: requestedH & 0xff,
    vAlign: requestedV & 0xff,
    hMargin0: requestedH0,
    vMargin0: requestedV0,
    hMargin1: requestedH1,
    vMargin1: requestedV1,
  }), 'AskParentForReconfigure');
  return true;
}

export const xWindowSetWindowAlignmentsNative = setWindowAlignmentsNative;
