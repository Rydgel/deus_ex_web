/**
 * Recovered Extension.dll XWindow::ChangeStyle translation.
 *
 * The exec thunk calls 0x10050310, which GetRootWindow's the receiver and
 * walks from that root. Each visited window dispatches vtable +0xe4
 * (StyleChanged ProcessScript), then GetTopChild(this, 0) / GetLowerSibling
 * with flag 0 so +0x140 and +0x144 are used without a visible-bit filter.
 * See docs/script-window-change-style.md.
 */

import {WINDOW_INIT_OFFSETS} from './script-window-init.mjs';
import {WINDOW_PARENT_OFFSETS} from './script-window-parent.mjs';
import {WINDOW_SENSITIVITY_OFFSETS} from './script-window-sensitivity.mjs';

const freeze = Object.freeze;

export const WINDOW_CHANGE_STYLE_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.ChangeStyle',
  packageExport: 1831,
  nativeIndex: 1493,
  functionFlags: 0x401,
  serialSize: 27,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x100542d0,
  execEnd: 0x100542df,
  execSha256: '2030aef5c1ef9ee5d0857b670f457f36b3a397357be0277750474d8da2a80431',
  changeStyleBody: 0x10050310,
  changeStyleEnd: 0x10050359,
  changeStyleSha256: 'fcd2c68b75ccf04bea5562a554c234c3a16111b62bdfd69d7fa4d9c659acaa6f',
  walkBody: 0x100510c0,
  walkEnd: 0x10051154,
  walkSha256: '403b092c779aa2b683f5db86fadde2fc7fad5a5f486bcbbcec4517946c7658a4',
});

export const WINDOW_CHANGE_STYLE_OFFSETS = freeze({
  windowType: WINDOW_INIT_OFFSETS.byte28,
  parent: WINDOW_PARENT_OFFSETS.parent,
  topChild: WINDOW_SENSITIVITY_OFFSETS.topChild,
  lowerSibling: WINDOW_SENSITIVITY_OFFSETS.lowerSibling,
});

export const WINDOW_CHANGE_STYLE_NATIVE_ADDRESSES = freeze({
  exec: WINDOW_CHANGE_STYLE_NATIVE.execBody,
  changeStyle: WINDOW_CHANGE_STYLE_NATIVE.changeStyleBody,
  walk: WINDOW_CHANGE_STYLE_NATIVE.walkBody,
  getRootWindow: 0x1004c5a0,
  getTopChild: 0x1004c6b0,
  getLowerSibling: 0x1004c650,
  styleChangedThunk: 0x10003d10,
  styleChangedFName: 0x1009b3c0,
  virtualStyleChanged: 0xe4,
});

export class WindowChangeStyleNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'WindowChangeStyleNativeBoundaryError';
    this.code = `WINDOW_CHANGE_STYLE_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details = {}) => {
  throw new WindowChangeStyleNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`Window.ChangeStyle ${label} suspended`, {kind: 'ASYNC'});
  }
  return value;
}

function required(services, name) {
  if (typeof services?.[name] !== 'function') {
    fail(`Window.ChangeStyle requires ${name} service`, {kind: 'SERVICE'});
  }
  return services[name];
}

function present(value) {
  return value !== null && value !== undefined && value !== 0;
}

function objectReference(value, label, {allowNull = false} = {}) {
  if (allowNull && !present(value)) return value ?? null;
  if (!value || (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number')) {
    fail(`Window.ChangeStyle requires canonical ${label}`, {kind: 'REFERENCE', value});
  }
  return value;
}

function byte(value, label, offset) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    fail(`Window.ChangeStyle requires uint8 ${label} at +0x${offset.toString(16)}`, {
      kind: 'VALUE', value, offset,
    });
  }
  return value;
}

function pointer(value, label) {
  if (!present(value)) return value ?? null;
  return objectReference(value, label);
}

function read(object, offset, kind, services, phase) {
  const value = sync(required(services, 'read')(object, offset, kind, {
    native: WINDOW_CHANGE_STYLE_NATIVE.changeStyleBody, phase, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    fail(`Window.ChangeStyle reached unresolved +0x${offset.toString(16)}`, {
      kind: 'FIELD', offset, value,
    });
  }
  if (kind === 'u8') return byte(value, phase, offset);
  if (kind === 'ptr') return pointer(value, phase);
  fail(`Window.ChangeStyle does not support raw read kind ${kind}`, {kind: 'VALUE', value: kind, offset});
}

function getRootWindow(window, services) {
  const O = WINDOW_CHANGE_STYLE_OFFSETS;
  let current = window;
  for (;;) {
    const parent = read(current, O.parent, 'ptr', services, 'GetRootWindow/parent');
    if (!present(parent)) break;
    current = parent;
  }
  const type = read(current, O.windowType, 'u8', services, 'GetRootWindow/type');
  return type >= 3 ? current : null;
}

function walkStyleChanged(window, services) {
  const O = WINDOW_CHANGE_STYLE_OFFSETS;
  const slot = WINDOW_CHANGE_STYLE_NATIVE_ADDRESSES.virtualStyleChanged;
  sync(required(services, 'dispatchVirtual')({
    object: window, slot, argument: null,
    native: WINDOW_CHANGE_STYLE_NATIVE.walkBody,
  }), `virtual +0x${slot.toString(16)}`);
  let child = read(window, O.topChild, 'ptr', services, 'ChangeStyle/top-child');
  while (present(child)) {
    walkStyleChanged(child, services);
    child = read(child, O.lowerSibling, 'ptr', services, 'ChangeStyle/lower-sibling');
  }
}

/** Execute XWindow::ChangeStyle(this). Void. */
export function changeStyleWindowNative(object, services = {}) {
  const window = objectReference(object, 'Window');
  const root = getRootWindow(window, services);
  if (!present(root)) return;
  walkStyleChanged(root, services);
}

export const xWindowChangeStyleNative = changeStyleWindowNative;
