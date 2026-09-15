/**
 * Recovered Extension.dll XWindow::Lower translation.
 *
 * Lower is the inverse of Raise: a child with a parent and a lower sibling
 * (+0x144) is reinserted with AddChild(parent, this, 0), then
 * AskParentForReconfigure and CheckFocusWindow. See docs/script-window-lower.md.
 */

import {WINDOW_ORDER_OFFSETS} from './script-window-order.mjs';
import {WINDOW_SENSITIVITY_OFFSETS} from './script-window-sensitivity.mjs';

const freeze = Object.freeze;

export const WINDOW_LOWER_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.Lower',
  packageExport: 2125,
  nativeIndex: 1412,
  functionFlags: 0x401,
  serialSize: 27,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10051930,
  execEnd: 0x1005193f,
  execSha256: '12261e055cbe8bc8fb70faa6f264f567a6e4a6cee9c953c5ad012b883bb9a053',
  body: 0x1004c2f0,
  end: 0x1004c355,
  bodySha256: '0c2669009b4d8c22c071ce6f73b835fb910608a350e8f7ac0f252dbf5e678362',
});

export const WINDOW_LOWER_OFFSETS = freeze({
  parent: WINDOW_ORDER_OFFSETS.parent,
  prevSibling: WINDOW_SENSITIVITY_OFFSETS.lowerSibling,
});

export const WINDOW_LOWER_NATIVE_ADDRESSES = freeze({
  exec: WINDOW_LOWER_NATIVE.execBody,
  lower: WINDOW_LOWER_NATIVE.body,
  addChild: 0x10050a80,
  askParentForReconfigure: 0x1004e060,
  checkFocusWindow: 0x10050b80,
});

export class WindowLowerNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'WindowLowerNativeBoundaryError';
    this.code = `WINDOW_LOWER_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details = {}) => {
  throw new WindowLowerNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') fail(`Window.Lower ${label} suspended`, {kind: 'ASYNC'});
  return value;
}

function service(services, name) {
  if (typeof services?.[name] !== 'function') fail(`Window.Lower requires ${name} service`, {kind: 'SERVICE'});
  return services[name];
}

function canonical(value, label, {nullable = false} = {}) {
  if (nullable && (value === null || value === 0)) return value;
  if (!value || (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number'))
    fail(`Window.Lower requires canonical ${label}`, {kind: 'REFERENCE', value});
  return value;
}

function present(value) {
  return value !== null && value !== undefined && value !== 0;
}

/** Execute XWindow::Lower. AddChild owns the exact sibling relink operation. */
export function lowerWindowNative(object, services = {}) {
  const window = canonical(object, 'Window');
  const read = service(services, 'read');
  const parent = canonical(sync(read(window, WINDOW_LOWER_OFFSETS.parent, 'ptr', {
    native: WINDOW_LOWER_NATIVE.body, phase: 'Lower/parent',
  }), 'Lower parent read'), 'parent', {nullable: true});
  if (!present(parent)) return false;
  const prev = canonical(sync(read(window, WINDOW_LOWER_OFFSETS.prevSibling, 'ptr', {
    native: WINDOW_LOWER_NATIVE.body, phase: 'Lower/prev-sibling',
  }), 'Lower sibling read'), 'previous sibling', {nullable: true});
  if (!present(prev)) return false;
  sync(service(services, 'addChild')({
    parent, child: window, flag: 0, native: WINDOW_LOWER_NATIVE_ADDRESSES.addChild,
  }), 'Lower AddChild');
  sync(service(services, 'askParentForReconfigure')({
    object: window, native: WINDOW_LOWER_NATIVE_ADDRESSES.askParentForReconfigure,
  }), 'Lower AskParentForReconfigure');
  sync(service(services, 'checkFocusWindow')({
    object: window, native: WINDOW_LOWER_NATIVE_ADDRESSES.checkFocusWindow,
  }), 'Lower CheckFocusWindow');
  return true;
}

export const xWindowLowerNative = lowerWindowNative;
