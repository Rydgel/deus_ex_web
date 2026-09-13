/**
 * Recovered Extension.dll XWindow::SetPos/Move translation.
 *
 * SetPos forwards its two float arguments to Move.  Move first checks the
 * native horizontal and vertical alignment bytes.  A nonzero alignment byte
 * forces a position update and clears both bytes.  When both are zero, the
 * requested position is compared with the stored float32 position using the
 * x87 C3 result: equal and unordered values are treated as unchanged.  A
 * changed position is stored as raw float32 values and synchronously asks the
 * window hierarchy to reconfigure.  See docs/script-window-position.md.
 */

const freeze = Object.freeze;
const f = Math.fround;

export const WINDOW_POSITION_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.SetPos',
  packageExport: 2068,
  nativeIndex: 1432,
  functionFlags: 0x401,
  serialSize: 34,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10052160,
  execEnd: 0x100521cf,
  execSha256: '217e4fe092cdae7e4a572c76aca9c1deb33fbcda228a2c17bef72b8fabda0ff9',
  setPosBody: 0x100032f0,
  setPosEnd: 0x10003302,
  setPosSha256: 'cd767b44d519592539d7a96bb2623345de488ab4ac9b6e3f8a0416c7c70338e1',
  moveBody: 0x1004ce80,
  moveEnd: 0x1004cf32,
  moveSha256: '95b43187b1f101475811136b3b98969a5fcdb50405f450bd4677e28d533327b6',
});

/** Numeric byte offsets in the native XWindow object. */
export const WINDOW_POSITION_OFFSETS = freeze({
  alignmentX: 0x88,
  alignmentY: 0x89,
  x: 0x8c,
  y: 0x94,
});

export const WINDOW_POSITION_FIELDS = WINDOW_POSITION_OFFSETS;

export const WINDOW_POSITION_NATIVE_ADDRESSES = freeze({
  execSetPos: WINDOW_POSITION_NATIVE.execBody,
  setPos: WINDOW_POSITION_NATIVE.setPosBody,
  move: WINDOW_POSITION_NATIVE.moveBody,
  askParentForReconfigure: 0x1004e060,
});

export const WINDOW_POSITION_NATIVE_CONTRACT = freeze({
  name: 'XWindow::SetPos / XWindow::Move',
  address: WINDOW_POSITION_NATIVE.moveBody,
  arguments: freeze(['XWindow* this', 'float newX', 'float newY']),
  returns: 'void',
  rawStorage: 'read(object, offset, kind, details) / write(object, offset, kind, value, details)',
  alignment: 'read bytes +0x88 and +0x89; either nonzero forces the store and both become zero',
  comparison: 'when both alignment bytes are zero, float32 position comparisons use x87 C3; unordered is equal',
  stores: freeze([
    'write byte +0x88 = 0',
    'write byte +0x89 = 0',
    'write float32 +0x8c = newX',
    'write float32 +0x94 = newY',
    'AskParentForReconfigure(this)',
  ]),
});

export class WindowPositionNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'WindowPositionNativeBoundaryError';
    this.code = `WINDOW_POSITION_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details = {}) => {
  throw new WindowPositionNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`Window.SetPos ${label} suspended`, {kind: 'ASYNC'});
  }
  return value;
}

function objectReference(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    fail('Window.SetPos requires a canonical Window object', {
      kind: 'REFERENCE', value,
    });
  }
  return value;
}

function number(value, label) {
  if (typeof value !== 'number') {
    fail(`Window.SetPos requires numeric ${label}`, {kind: 'VALUE', value});
  }
  return f(value);
}

function byte(value, label, offset) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    fail(`Window.SetPos requires uint8 ${label} at +0x${offset.toString(16)}`, {
      kind: 'VALUE', value, offset,
    });
  }
  return value;
}

function read(object, offset, kind, services, phase) {
  if (typeof services.read !== 'function') {
    fail('Window.SetPos requires raw read service', {kind: 'SERVICE', offset});
  }
  const value = sync(services.read(object, offset, kind, {
    native: WINDOW_POSITION_NATIVE.moveBody,
    phase,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
  if (kind === 'u8') return byte(value, `stored ${phase}`, offset);
  if (kind === 'f32') {
    if (typeof value !== 'number') {
      fail(`Window.SetPos requires numeric stored ${phase}`, {kind: 'VALUE', value, offset});
    }
    return f(value);
  }
  fail(`Window.SetPos does not support raw read kind ${kind}`, {kind: 'VALUE', value: kind, offset});
}

function write(object, offset, kind, value, services, phase) {
  if (typeof services.write !== 'function') {
    fail('Window.SetPos requires raw write service', {kind: 'SERVICE', offset});
  }
  let normalized = value;
  if (kind === 'u8') normalized = byte(value, `write ${phase}`, offset);
  else if (kind === 'f32') {
    if (typeof value !== 'number') {
      fail(`Window.SetPos requires numeric write ${phase}`, {kind: 'VALUE', value, offset});
    }
    normalized = f(value);
  } else {
    fail(`Window.SetPos does not support raw write kind ${kind}`, {kind: 'VALUE', value: kind, offset});
  }
  return sync(services.write(object, offset, kind, normalized, {
    native: WINDOW_POSITION_NATIVE.moveBody,
    phase,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
  }), `write +0x${offset.toString(16)}`);
}

function x87C3Equal(left, right) {
  // FCOMS sets C3 for equality and for unordered comparisons.  Signed zero
  // compares equal, matching JavaScript's === for the non-NaN case.
  return Number.isNaN(left) || Number.isNaN(right) || left === right;
}

/** Execute XWindow::Move(this,newX,newY), called by Window.SetPos. */
export function moveWindowNative(object, newX, newY, services = {}) {
  const window = objectReference(object);
  const x = number(newX, 'newX');
  const y = number(newY, 'newY');
  const O = WINDOW_POSITION_OFFSETS;

  // The native body reads +0x88 and only reads +0x89 when the first byte is
  // zero.  This conditional order is observable by raw-service callers.
  const alignmentX = read(window, O.alignmentX, 'u8', services, 'Move/alignment-x');
  let changed = alignmentX !== 0;
  if (!changed) {
    const alignmentY = read(window, O.alignmentY, 'u8', services, 'Move/alignment-y');
    changed = alignmentY !== 0;
    if (!changed) {
      const oldX = read(window, O.x, 'f32', services, 'Move/x-compare');
      if (!x87C3Equal(x, oldX)) changed = true;
      else {
        const oldY = read(window, O.y, 'f32', services, 'Move/y-compare');
        changed = !x87C3Equal(y, oldY);
      }
    }
  }
  if (!changed) return false;

  // Native writes both alignment bytes before either position component and
  // calls AskParentForReconfigure synchronously after the final store.
  write(window, O.alignmentX, 'u8', 0, services, 'Move/alignment-x-store');
  write(window, O.alignmentY, 'u8', 0, services, 'Move/alignment-y-store');
  write(window, O.x, 'f32', x, services, 'Move/x-store');
  write(window, O.y, 'f32', y, services, 'Move/y-store');
  if (typeof services.askParentForReconfigure !== 'function') {
    fail('Window.SetPos requires AskParentForReconfigure service', {kind: 'SERVICE'});
  }
  sync(services.askParentForReconfigure({
    object: window,
    native: WINDOW_POSITION_NATIVE.moveBody,
    x,
    y,
  }), 'AskParentForReconfigure');
  return true;
}

/** Execute the small exported XWindow::SetPos helper. */
export const setWindowPositionNative = moveWindowNative;
export const setWindowPosNative = moveWindowNative;
export const xWindowSetPosNative = moveWindowNative;
