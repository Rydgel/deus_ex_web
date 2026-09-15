/**
 * Recovered Extension.dll XWindow::SetWidth translation.
 *
 * SetWidth clamps a negative or unordered requested width to positive zero,
 * compares it with the stored float32 at Window+0x9c via x87 C3, and stores
 * then AskParentForReconfigure only when that comparison differs. Height at
 * +0xa0 is not read or written. See docs/script-window-width.md.
 */

import {WINDOW_SIZE_OFFSETS} from './script-window-size.mjs';

const freeze = Object.freeze;
const f = Math.fround;

export const WINDOW_WIDTH_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.SetWidth',
  packageExport: 2079,
  nativeIndex: 1433,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x100521f0,
  execEnd: 0x10052236,
  execSha256: '4650ef6bd533afcb4f857733bcdddcf97971a05c98e1f02d5ae6b911ea2b8016',
  setWidthBody: 0x1004d040,
  setWidthEnd: 0x1004d0b0,
  setWidthSha256: 'bc52c125754017b25bd7dcf13360720374a3540d335d0e2fb530859162ebb90a',
});

/** Same recovered width slot as Window.SetSize / XWindow::Resize. */
export const WINDOW_WIDTH_OFFSETS = freeze({width: WINDOW_SIZE_OFFSETS.width});

export const WINDOW_WIDTH_NATIVE_ADDRESSES = freeze({
  exec: WINDOW_WIDTH_NATIVE.execBody,
  setWidth: WINDOW_WIDTH_NATIVE.setWidthBody,
  askParentForReconfigure: 0x1004e060,
});

export class WindowWidthNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'WindowWidthNativeBoundaryError';
    this.code = `WINDOW_WIDTH_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => { throw new WindowWidthNativeBoundaryError(message, details); };

function sync(value, label) {
  if (value && typeof value.then === 'function') fail(`Window.SetWidth ${label} suspended`, {kind: 'ASYNC'});
  return value;
}

function number(value, label) {
  if (typeof value !== 'number') fail(`Window.SetWidth requires numeric ${label}`, {kind: 'VALUE', value});
  return f(value);
}

function requested(value) {
  const result = f(value);
  // fcom requested,0 followed by test C0: negative and unordered clamp. A
  // supplied -0 has neither condition and retains its sign bit.
  return Number.isNaN(result) || result < 0 ? 0 : result;
}

function x87C3Equal(left, right) {
  // fcom's C3 is also set for unordered values. Signed zero compares equal.
  return Number.isNaN(left) || Number.isNaN(right) || left === right;
}

function read(object, offset, services, phase) {
  if (typeof services.read !== 'function') fail('Window.SetWidth requires raw read service', {kind: 'SERVICE', offset});
  const value = sync(services.read(object, offset, 'f32', {
    native: WINDOW_WIDTH_NATIVE.setWidthBody, phase, offset, kind: 'f32', width: 4,
  }), `read +0x${offset.toString(16)}`);
  return number(value, `stored ${phase}`);
}

function write(object, offset, value, services, phase) {
  if (typeof services.write !== 'function') fail('Window.SetWidth requires raw write service', {kind: 'SERVICE', offset});
  return sync(services.write(object, offset, 'f32', value, {
    native: WINDOW_WIDTH_NATIVE.setWidthBody, phase, offset, kind: 'f32', width: 4,
  }), `write +0x${offset.toString(16)}`);
}

export function setWindowWidthNative(object, newWidth, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('Window.SetWidth requires a canonical Window object', {kind: 'REFERENCE', value: object});
  const width = requested(number(newWidth, 'newWidth'));
  const oldWidth = read(object, WINDOW_WIDTH_OFFSETS.width, services, 'width-compare');
  if (x87C3Equal(width, oldWidth)) return false;
  write(object, WINDOW_WIDTH_OFFSETS.width, width, services, 'width-store');
  if (typeof services.askParentForReconfigure !== 'function')
    fail('Window.SetWidth requires AskParentForReconfigure service', {kind: 'SERVICE'});
  sync(services.askParentForReconfigure({
    object, native: WINDOW_WIDTH_NATIVE_ADDRESSES.askParentForReconfigure, width,
  }), 'AskParentForReconfigure');
  return true;
}

export const xWindowSetWidthNative = setWindowWidthNative;
