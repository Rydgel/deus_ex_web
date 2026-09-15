/**
 * Recovered Extension.dll XWindow::SetFocusWindow translation.
 *
 * The body walks GetRootWindow, replaces NewFocusWindow with a selectable
 * ancestor (bit 0x04 of +0x30), compares RootWindow+0x5c8, and on a change
 * dispatches the original focus leaves. Clip/tween helpers that use fstp stay
 * host leaves. See docs/script-window-focus.md.
 */

import {WINDOW_INIT_OFFSETS} from './script-window-init.mjs';
import {WINDOW_PARENT_OFFSETS} from './script-window-parent.mjs';
import {WINDOW_VISIBILITY_OFFSETS} from './script-window-visibility.mjs';

const freeze = Object.freeze;

export const WINDOW_FOCUS_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.SetFocusWindow',
  packageExport: 2058,
  nativeIndex: 1440,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10052690,
  execEnd: 0x100526dc,
  execSha256: '70008779896dbdea30d24b35df993ae6b76ae9511aab511b33a8f1c8e89c49e8',
  setFocusBody: 0x1004f0e0,
  setFocusEnd: 0x1004f241,
  setFocusSha256: '2aedd833f3c45b0cb10f1661d8fcc6ba1c9a6aa51cd98f5f071da283a6e54e32',
});

export const WINDOW_FOCUS_OFFSETS = freeze({
  windowType: WINDOW_INIT_OFFSETS.byte28,
  flags: WINDOW_VISIBILITY_OFFSETS.visibility,
  float80: WINDOW_INIT_OFFSETS.float80,
  float84: WINDOW_INIT_OFFSETS.float84,
  dword104: WINDOW_INIT_OFFSETS.dword104,
  dword108: WINDOW_INIT_OFFSETS.dword108,
  parent: WINDOW_PARENT_OFFSETS.parent,
  type2Focus: 0x178,
  rootFocus: 0x5c8,
});

export const WINDOW_FOCUS_BITS = freeze({selectable: 0x04});

export const WINDOW_FOCUS_NATIVE_ADDRESSES = freeze({
  exec: WINDOW_FOCUS_NATIVE.execBody,
  setFocusWindow: WINDOW_FOCUS_NATIVE.setFocusBody,
  getRootWindow: 0x1004c5a0,
  checkFocusable: 0x1004c460,
  type2Ancestor: 0x1004c580,
  focusGeometry: 0x1004e230,
  focusTween: 0x1004ffb0,
  virtualEntered: 0xa8,
  virtualLost: 0xac,
  virtualEnteredAncestor: 0xb0,
  virtualLostAncestor: 0xb4,
});

export class WindowFocusNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'WindowFocusNativeBoundaryError';
    this.code = `WINDOW_FOCUS_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details = {}) => {
  throw new WindowFocusNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`Window.SetFocusWindow ${label} suspended`, {kind: 'ASYNC'});
  }
  return value;
}

function required(services, name) {
  if (typeof services?.[name] !== 'function') {
    fail(`Window.SetFocusWindow requires ${name} service`, {kind: 'SERVICE'});
  }
  return services[name];
}

function present(value) {
  return value !== null && value !== undefined && value !== 0;
}

function objectReference(value, label, {allowNull = false} = {}) {
  if (allowNull && !present(value)) return value ?? null;
  if (!value || (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number')) {
    fail(`Window.SetFocusWindow requires canonical ${label}`, {kind: 'REFERENCE', value});
  }
  return value;
}

function byte(value, label, offset) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    fail(`Window.SetFocusWindow requires uint8 ${label} at +0x${offset.toString(16)}`, {
      kind: 'VALUE', value, offset,
    });
  }
  return value;
}

function dword(value, label, offset) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`Window.SetFocusWindow requires uint32 ${label} at +0x${offset.toString(16)}`, {
      kind: 'VALUE', value, offset,
    });
  }
  return value >>> 0;
}

function pointer(value, label) {
  if (!present(value)) return value ?? null;
  return objectReference(value, label);
}

function read(object, offset, kind, services, phase) {
  const value = sync(required(services, 'read')(object, offset, kind, {
    native: WINDOW_FOCUS_NATIVE.setFocusBody, phase, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    fail(`Window.SetFocusWindow reached unresolved +0x${offset.toString(16)}`, {
      kind: 'FIELD', offset, value,
    });
  }
  if (kind === 'u8') return byte(value, phase, offset);
  if (kind === 'u32') return dword(value, phase, offset);
  if (kind === 'ptr') return pointer(value, phase);
  fail(`Window.SetFocusWindow does not support raw read kind ${kind}`, {kind: 'VALUE', value: kind, offset});
}

function write(object, offset, kind, value, services, phase) {
  let normalized = value;
  if (kind === 'ptr') normalized = pointer(value, phase);
  else if (kind === 'u32') normalized = dword(value, phase, offset);
  else fail(`Window.SetFocusWindow does not support raw write kind ${kind}`, {kind: 'VALUE', value: kind, offset});
  return sync(required(services, 'write')(object, offset, kind, normalized, {
    native: WINDOW_FOCUS_NATIVE.setFocusBody, phase, offset, kind, width: 4,
  }), `write +0x${offset.toString(16)}`);
}

function getRootWindow(window, services) {
  const O = WINDOW_FOCUS_OFFSETS;
  let current = window;
  for (;;) {
    const parent = read(current, O.parent, 'ptr', services, 'GetRootWindow/parent');
    if (!present(parent)) break;
    current = parent;
  }
  const type = read(current, O.windowType, 'u8', services, 'GetRootWindow/type');
  return type >= 3 ? current : null;
}

function selectableAncestor(start, services) {
  const O = WINDOW_FOCUS_OFFSETS;
  let current = start;
  while (present(current)) {
    const flags = read(current, O.flags, 'u8', services, 'SetFocusWindow/selectable');
    if (flags & WINDOW_FOCUS_BITS.selectable) return current;
    current = read(current, O.parent, 'ptr', services, 'SetFocusWindow/selectable-parent');
  }
  return start;
}

function type2Ancestor(start, services) {
  const O = WINDOW_FOCUS_OFFSETS;
  let current = start;
  if (!present(current)) return null;
  while (present(current)) {
    const type = read(current, O.windowType, 'u8', services, 'SetFocusWindow/type2');
    if (type >= 2) return current;
    current = read(current, O.parent, 'ptr', services, 'SetFocusWindow/type2-parent');
    if (!present(current)) return null;
  }
  return null;
}

function dispatchVirtual(services, slot, object, argument) {
  sync(required(services, 'dispatchVirtual')({
    object, slot, argument: argument ?? null,
    native: WINDOW_FOCUS_NATIVE.setFocusBody,
  }), `virtual +0x${slot.toString(16)}`);
}

/** Execute XWindow::SetFocusWindow(this, NewFocusWindow). Returns 0 or 1. */
export function setFocusWindowNative(object, newFocusWindow, services = {}) {
  const window = objectReference(object, 'Window');
  const requested = objectReference(newFocusWindow, 'NewFocusWindow', {allowNull: true});
  const O = WINDOW_FOCUS_OFFSETS;
  const A = WINDOW_FOCUS_NATIVE_ADDRESSES;

  const root = getRootWindow(window, services);
  let focus = present(requested) ? selectableAncestor(requested, services) : requested;

  if (!present(root)) return 0;
  const current = read(root, O.rootFocus, 'ptr', services, 'SetFocusWindow/root-focus');
  if (current === focus) return 1;

  if (present(focus)) {
    const accepted = sync(required(services, 'checkFocusable')({
      object: focus, flag: 1, native: A.checkFocusable,
    }), 'checkFocusable');
    if (!accepted) return 0;
    const owner = type2Ancestor(focus, services);
    if (present(owner)) {
      write(owner, O.type2Focus, 'ptr', focus, services, 'SetFocusWindow/type2-focus');
    }
  }

  const oldFocus = read(root, O.rootFocus, 'ptr', services, 'SetFocusWindow/root-focus-old');
  write(root, O.rootFocus, 'ptr', present(focus) ? focus : null, services, 'SetFocusWindow/root-focus-store');

  if (present(oldFocus)) {
    dispatchVirtual(services, A.virtualLost, oldFocus);
    const tweenField = read(oldFocus, O.dword108, 'u32', services, 'SetFocusWindow/old-tween');
    sync(required(services, 'focusTween')({
      object: oldFocus, argument: tweenField, lo: 0xbf800000, hi: 0x3f800000,
      native: A.focusTween,
    }), 'focusTween old');
    let ancestor = oldFocus;
    while (present(ancestor)) {
      dispatchVirtual(services, A.virtualLostAncestor, ancestor, oldFocus);
      ancestor = read(ancestor, O.parent, 'ptr', services, 'SetFocusWindow/old-ancestor');
    }
  }

  const stored = read(root, O.rootFocus, 'ptr', services, 'SetFocusWindow/root-focus-reload');
  if (present(stored)) {
    const height = read(stored, O.float84, 'u32', services, 'SetFocusWindow/geometry-84');
    const width = read(stored, O.float80, 'u32', services, 'SetFocusWindow/geometry-80');
    sync(required(services, 'focusGeometry')({
      object: stored, arg0: 0, arg1: 0, arg2: width, arg3: height, native: A.focusGeometry,
    }), 'focusGeometry');
    const tweenField = read(stored, O.dword104, 'u32', services, 'SetFocusWindow/new-tween');
    sync(required(services, 'focusTween')({
      object: stored, argument: tweenField, lo: 0xbf800000, hi: 0x3f800000,
      native: A.focusTween,
    }), 'focusTween new');
    dispatchVirtual(services, A.virtualEntered, stored);
    let ancestor = stored;
    while (present(ancestor)) {
      dispatchVirtual(services, A.virtualEnteredAncestor, ancestor, stored);
      ancestor = read(ancestor, O.parent, 'ptr', services, 'SetFocusWindow/new-ancestor');
    }
  }
  return 1;
}

export const xWindowSetFocusWindowNative = setFocusWindowNative;
