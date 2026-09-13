/**
 * Execute the recovered Extension.dll XWindow visibility bodies.
 *
 * The storage offsets and call order below are taken from the unchanged
 * Extension.dll.  Focus/grab, tree, event, reconfigure, accelerator, and
 * subclass dispatch remain synchronous host leaves; this adapter does not
 * replace any of those native bodies with guessed browser behavior.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * XWindow::SetVisibility at 0x1004c7d0, and XWindow::SetChildVisibility at
 * 0x1004ee20.  The recovered contract is recorded in
 * docs/script-window-visibility.md.
 */

const freeze = value => Object.freeze(value);

const EXTENSION_HASH =
  '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c';

export const WINDOW_VISIBILITY_NATIVE = freeze({
  package: 'Extension',
  function: 'XWindow::SetVisibility / XWindow::SetChildVisibility',
  dll: 'Extension.dll',
  dllSha256: EXTENSION_HASH,
  imageBase: 0x10000000,
  functions: freeze({
    show: freeze({
      name: 'Window.Show / XWindow::SetVisibility', packageExport: 2123,
      nativeIndex: 1413, execBody: 0x10051960, execEnd: 0x100519a6,
      execSha256: 'aceed4fbcf150767e382f8e8beec32c58ef37aa4fe8734384d5f1610e23dc302',
      body: 0x100031a0, end: 0x100031a8,
      bodySha256: '0e63f55b06f3b5ef0f03f9a4c58fc3c55355ad747cc2f34429de9c8f656349d7',
    }),
    isVisible: freeze({
      name: 'Window.IsVisible / XWindow::IsVisible', packageExport: 2120,
      nativeIndex: 1415, execBody: 0x10051a10, execEnd: 0x10051a89,
      execSha256: '37f6a5029d83e1b9945f54dbe4c5df949c173fea763fb301cab30f0b59159a0a',
      body: 0x100031c0, end: 0x100031f4,
      bodySha256: 'c310b22c098fe74ff5a37a2a5fd2c35a8bbe4f964b1da8863c22d4c4ee81fc5e',
    }),
    setVisibility: freeze({
      name: 'XWindow::SetVisibility',
      body: 0x1004c7d0,
      end: 0x1004c85e,
      stackBytes: 4,
      bodySha256: '48adf991456f7b9c81d972c99018c3035a1804c0cb00683a8e75b24983ddbb10',
    }),
    setChildVisibility: freeze({
      name: 'XWindow::SetChildVisibility',
      body: 0x1004ee20,
      end: 0x1004eef6,
      stackBytes: 4,
      bodySha256: 'a9caaeedc0f2aab1dd6c227c5081698217bba304412249f32b73428616fdfb28',
    }),
  }),
});

export const WINDOW_VISIBILITY_NATIVE_ADDRESSES = freeze({
  setVisibility: 0x1004c7d0,
  setVisibilityEnd: 0x1004c85e,
  setChildVisibility: 0x1004ee20,
  setChildVisibilityEnd: 0x1004eef6,
  currentWindowGlobal: 0x100aeafc,
  global100aeafc: 0x100aeafc,
  childRequestedVisibilityChangeSlot: 0x84,
  checkFocusWindow: 0x10050b80,
  checkGrabbedWindow: 0x10050c90,
  recomputeInitTree: 0x10050d70,
  invokeVisibilityChange: 0x10050e30,
  reconfigureTree: 0x1004e520,
  makeAcceleratorTableDirty: 0x1004c1d0,
  childRequestedVisibilityChange: 0x10003540,
});

/** Numeric byte offsets in the native XWindow object. */
export const WINDOW_VISIBILITY_OFFSETS = freeze({
  vtable: 0x00,
  visibility: 0x30,
  windowFlags: 0x30,
  reconfigureFlags: 0xb8,
  parent: 0x138,
});

export const WINDOW_VISIBILITY_FIELDS = WINDOW_VISIBILITY_OFFSETS;

export const WINDOW_VISIBILITY_BITS = freeze({visibility: 0x01, reconfigure: 0x01});

export const WINDOW_VISIBILITY_GLOBALS = freeze({
  currentWindow: 'global100aeafc',
});

export const WINDOW_VISIBILITY_NATIVE_CONTRACT = freeze({
  name: 'XWindow::SetVisibility / XWindow::SetChildVisibility',
  addresses: freeze({
    setVisibility: WINDOW_VISIBILITY_NATIVE_ADDRESSES.setVisibility,
    setChildVisibility: WINDOW_VISIBILITY_NATIVE_ADDRESSES.setChildVisibility,
  }),
  arguments: freeze(['XWindow* this', 'int newVisibility']),
  returns: 'void',
  rawStorage: 'read(object, offset, kind, details) / write(object, offset, kind, value, details)',
  globalStorage: 'readGlobal(name, kind, details) / writeGlobal(name, kind, value, details), or raw read/write against globalObject',
  visibility: 'bit 0 of +0x30; upper bits are retained',
  effectiveWalk: 'read byte +0x30 then pointer +0x138 for each visible window',
  callbacks: freeze([
    'parent ChildRequestedVisibilityChange(this,newVisibility) through vtable +0x84',
    'CheckFocusWindow(this)',
    'CheckGrabbedWindow(this)',
    'RecomputeInitTree(this,effectiveVisibility)',
    'InvokeVisibilityChange(this,effectiveVisibility)',
    'ReconfigureTree(this,0)',
    'MakeAcceleratorTableDirty(this)',
  ]),
  childOrder: freeze([
    'effective visibility before write',
    'write +0x30 with only bit 0 changed',
    'effective visibility after write',
    'CheckFocusWindow',
    'CheckGrabbedWindow',
    'read +0xb8 then write +0xb8 | 1',
    'RecomputeInitTree',
    'InvokeVisibilityChange',
    'ReconfigureTree(this,0)',
    'MakeAcceleratorTableDirty',
  ]),
});

export class WindowVisibilityNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null, global = null,
  } = {}) {
    super(message);
    this.name = 'WindowVisibilityNativeBoundaryError';
    this.code = `WINDOW_VISIBILITY_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
    this.global = global;
  }
}

const fail = (message, details = {}) => {
  throw new WindowVisibilityNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XWindow visibility ${label} service suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'function') {
    fail(`XWindow visibility requires ${name} service`, {kind: 'SERVICE', operation: name});
  }
  return value;
}

function objectReference(value, name, {allowNull = false} = {}) {
  if (allowNull && (value === null || value === 0)) return value;
  if (value === null || value === undefined || value === 0 ||
      (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number')) {
    fail(`XWindow visibility requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  if (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`XWindow visibility requires uint32 ${name} pointer`, {
      kind: 'VALUE', value, operation: name,
    });
  }
  return value;
}

function present(value) {
  return value !== null && value !== undefined && value !== 0;
}

function pointer(value, label, details = {}) {
  if (!present(value)) return value;
  if (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number') {
    fail(`XWindow visibility requires canonical ${label}`, {
      kind: 'REFERENCE', value, ...details,
    });
  }
  if (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`XWindow visibility requires uint32 ${label}`, {
      kind: 'VALUE', value, ...details,
    });
  }
  return value;
}

function uint(value, label, offset, details = {}) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`XWindow visibility requires uint32 ${label} at +0x${offset.toString(16)}`, {
      kind: 'VALUE', value, offset, operation: label, ...details,
    });
  }
  return value >>> 0;
}

function rawDetails(phase, object, offset, kind) {
  return {
    native: phase.startsWith('SetVisibility/')
      ? WINDOW_VISIBILITY_NATIVE_ADDRESSES.setVisibility
      : WINDOW_VISIBILITY_NATIVE_ADDRESSES.setChildVisibility,
    phase,
    object,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
  };
}

function readRaw(object, offset, kind, services, phase) {
  const reader = required(services.read, 'read');
  const value = sync(reader(object, offset, kind, rawDetails(phase, object, offset, kind)),
    `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    fail(`XWindow visibility reached unresolved raw field +0x${offset.toString(16)}`, {
      kind: 'FIELD', value, object, offset, operation: phase,
    });
  }
  if (kind === 'ptr') return pointer(value, `+0x${offset.toString(16)} pointer`, {
    object, offset, operation: phase,
  });
  if (kind === 'u8') {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      fail(`XWindow visibility raw byte +0x${offset.toString(16)} is outside uint8`, {
        kind: 'VALUE', value, object, offset, operation: phase,
      });
    }
    return value;
  }
  if (kind === 'u32') return uint(value, 'native dword', offset, {object, operation: phase});
  fail(`XWindow visibility does not support raw read kind ${kind}`, {
    kind: 'VALUE', value: kind, object, offset, operation: phase,
  });
}

function writeRaw(object, offset, kind, value, services, phase, source = undefined) {
  const writer = required(services.write, 'write');
  let normalized = value;
  if (kind === 'ptr') {
    normalized = pointer(value, `+0x${offset.toString(16)} pointer`, {
      object, offset, operation: phase,
    });
  } else if (kind === 'u8') {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      fail(`XWindow visibility raw byte +0x${offset.toString(16)} is outside uint8`, {
        kind: 'VALUE', value, object, offset, operation: phase,
      });
    }
  } else if (kind === 'u32') {
    normalized = uint(value, 'native dword', offset, {object, operation: phase});
  } else {
    fail(`XWindow visibility does not support raw write kind ${kind}`, {
      kind: 'VALUE', value: kind, object, offset, operation: phase,
    });
  }
  return sync(writer(object, offset, kind, normalized, {
    ...rawDetails(phase, object, offset, kind),
    source,
  }), `write +0x${offset.toString(16)}`);
}

function validateGlobal(value, phase) {
  if (value === undefined) {
    fail('XWindow::SetVisibility reached unresolved global100aeafc', {
      kind: 'GLOBAL', value, global: WINDOW_VISIBILITY_GLOBALS.currentWindow,
      operation: phase,
    });
  }
  return pointer(value, 'global current-window pointer', {
    global: WINDOW_VISIBILITY_GLOBALS.currentWindow,
    operation: phase,
  });
}

function readGlobal(services, phase) {
  const address = WINDOW_VISIBILITY_NATIVE_ADDRESSES.currentWindowGlobal;
  const name = WINDOW_VISIBILITY_GLOBALS.currentWindow;
  if (typeof services.readGlobal === 'function') {
    return validateGlobal(sync(services.readGlobal(name, 'ptr', {
      native: WINDOW_VISIBILITY_NATIVE_ADDRESSES.setVisibility,
      phase,
      global: name,
      address,
      kind: 'ptr',
      width: 4,
    }), `read global +0x${address.toString(16)}`), phase);
  }
  const target = services.globalObject ?? services.globals ?? services.global;
  if (target === undefined) {
    fail('XWindow::SetVisibility requires readGlobal or globalObject storage', {
      kind: 'SERVICE', global: WINDOW_VISIBILITY_GLOBALS.currentWindow, operation: phase,
    });
  }
  return validateGlobal(readRaw(target, address, 'ptr', services, phase), phase);
}

function writeGlobal(services, value, phase) {
  const address = WINDOW_VISIBILITY_NATIVE_ADDRESSES.currentWindowGlobal;
  const name = WINDOW_VISIBILITY_GLOBALS.currentWindow;
  const normalized = validateGlobal(value, phase);
  if (typeof services.writeGlobal === 'function') {
    return sync(services.writeGlobal(name, 'ptr', normalized, {
      native: WINDOW_VISIBILITY_NATIVE_ADDRESSES.setVisibility,
      phase,
      global: name,
      address,
      kind: 'ptr',
      width: 4,
    }), `write global +0x${address.toString(16)}`);
  }
  const target = services.globalObject ?? services.globals ?? services.global;
  if (target === undefined) {
    fail('XWindow::SetVisibility requires writeGlobal or globalObject storage', {
      kind: 'SERVICE', global: WINDOW_VISIBILITY_GLOBALS.currentWindow, operation: phase,
    });
  }
  return writeRaw(target, address, 'ptr', normalized, services, phase);
}

function callLeaf(services, names, label, details) {
  const candidates = Array.isArray(names) ? names : [names];
  const callback = candidates.map(name => services[name])
    .find(value => typeof value === 'function');
  if (!callback) fail(`XWindow visibility requires ${candidates[0]} service`, {
    kind: 'SERVICE', operation: label,
  });
  return sync(callback(details), label);
}

function visibilityWord(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 0 || value === 1) return value;
  fail('XWindow visibility requires boolean or native 0/1 newVisibility', {
    kind: 'VALUE', value, operation: 'newVisibility',
  });
}

function callbackDetails(object, effective, native) {
  const word = effective ? 1 : 0;
  return {
    object,
    window: object,
    visible: effective,
    newVisibility: effective,
    rawVisibility: word,
    native,
  };
}

function effectiveVisibility(window, services, phase) {
  const seen = new Set();
  let object = window;
  while (present(object)) {
    if (seen.has(object)) {
      fail('XWindow::SetChildVisibility received a cyclic +0x138 parent chain', {
        kind: 'REFERENCE', object, offset: WINDOW_VISIBILITY_OFFSETS.parent,
        operation: phase,
      });
    }
    seen.add(object);
    const flags = readRaw(object, WINDOW_VISIBILITY_OFFSETS.visibility, 'u8', services, phase);
    if ((flags & WINDOW_VISIBILITY_BITS.visibility) === 0) return false;
    object = readRaw(object, WINDOW_VISIBILITY_OFFSETS.parent, 'ptr', services, phase);
  }
  return true;
}

function childVisibilityBody(window, word, services) {
  const O = WINDOW_VISIBILITY_OFFSETS;
  const B = WINDOW_VISIBILITY_BITS;
  const oldFlags = readRaw(window, O.visibility, 'u32', services, 'SetChildVisibility/guard');
  if ((oldFlags & B.visibility) === word) return;

  const before = effectiveVisibility(window, services, 'SetChildVisibility/before');
  const flagsForWrite = readRaw(window, O.visibility, 'u32', services, 'SetChildVisibility/write');
  writeRaw(window, O.visibility, 'u32',
    ((flagsForWrite & ~B.visibility) | (word & B.visibility)) >>> 0,
    services, 'SetChildVisibility/write', 'replace visibility bit');
  const after = effectiveVisibility(window, services, 'SetChildVisibility/after');
  if (before === after) return;

  callLeaf(services, ['checkFocusWindow', 'checkFocus'], 'CheckFocusWindow',
    callbackDetails(window, after, WINDOW_VISIBILITY_NATIVE_ADDRESSES.checkFocusWindow));
  callLeaf(services, ['checkGrabbedWindow', 'checkGrabbed'], 'CheckGrabbedWindow',
    callbackDetails(window, after, WINDOW_VISIBILITY_NATIVE_ADDRESSES.checkGrabbedWindow));

  const reconfigureFlags = readRaw(window, O.reconfigureFlags, 'u32', services,
    'SetChildVisibility/reconfigure');
  writeRaw(window, O.reconfigureFlags, 'u32', (reconfigureFlags | B.reconfigure) >>> 0,
    services, 'SetChildVisibility/reconfigure', 'set reconfigure dirty bit');

  callLeaf(services, ['recomputeInitTree', 'recomputeTree'], 'RecomputeInitTree', {
    ...callbackDetails(window, after, WINDOW_VISIBILITY_NATIVE_ADDRESSES.recomputeInitTree),
    effectiveVisibility: after,
  });
  callLeaf(services, ['invokeVisibilityChange', 'visibilityChanged', 'visibilityChange'],
    'InvokeVisibilityChange', {
      ...callbackDetails(window, after, WINDOW_VISIBILITY_NATIVE_ADDRESSES.invokeVisibilityChange),
      effectiveVisibility: after,
    });
  callLeaf(services, ['reconfigureTree', 'reconfigure'], 'ReconfigureTree', {
    ...callbackDetails(window, false, WINDOW_VISIBILITY_NATIVE_ADDRESSES.reconfigureTree),
    argument: 0,
    rawArgument: 0,
  });
  callLeaf(services, ['makeAcceleratorTableDirty', 'invalidateAccelerators',
    'acceleratorTableDirty'], 'MakeAcceleratorTableDirty', callbackDetails(
      window, after, WINDOW_VISIBILITY_NATIVE_ADDRESSES.makeAcceleratorTableDirty));
}

/** Execute XWindow::SetChildVisibility(this,newVisibility). */
export function setChildVisibilityNative({window, object, newVisibility, visible} = {}, services = {}) {
  const receiver = window ?? object;
  objectReference(receiver, 'window');
  const word = visibilityWord(newVisibility ?? visible);
  childVisibilityBody(receiver, word, services);
}

/** Execute XWindow::SetVisibility(this,newVisibility). */
export function setVisibilityNative({window, object, newVisibility, visible} = {}, services = {}) {
  const receiver = window ?? object;
  objectReference(receiver, 'window');
  const word = visibilityWord(newVisibility ?? visible);
  const flags = readRaw(receiver, WINDOW_VISIBILITY_OFFSETS.visibility, 'u32', services,
    'SetVisibility/guard');
  if ((flags & WINDOW_VISIBILITY_BITS.visibility) === word) return;

  const parent = readRaw(receiver, WINDOW_VISIBILITY_OFFSETS.parent, 'ptr', services,
    'SetVisibility/parent');
  if (!present(parent)) {
    childVisibilityBody(receiver, word, services);
    return;
  }

  const savedWindow = readGlobal(services, 'SetVisibility/global-save');
  writeGlobal(services, parent, 'SetVisibility/global-save');
  try {
    // Native reads +0x138 again after publishing the current-window global.
    const callbackParent = readRaw(receiver, WINDOW_VISIBILITY_OFFSETS.parent, 'ptr', services,
      'SetVisibility/parent-dispatch');
    if (!present(callbackParent)) {
      fail('XWindow::SetVisibility parent link disappeared before virtual +0x84', {
        kind: 'REFERENCE', value: callbackParent, object: receiver,
        offset: WINDOW_VISIBILITY_OFFSETS.parent, operation: 'SetVisibility/parent-dispatch',
      });
    }
    callLeaf(services, ['childRequestedVisibilityChange',
      'parentChildRequestedVisibilityChange', 'parentVisibilityChange'],
      'ChildRequestedVisibilityChange', {
        parent: callbackParent,
        child: receiver,
        object: receiver,
        visible: Boolean(word),
        newVisibility: Boolean(word),
        rawVisibility: word,
        virtualSlot: WINDOW_VISIBILITY_NATIVE_ADDRESSES.childRequestedVisibilityChangeSlot,
        native: WINDOW_VISIBILITY_NATIVE_ADDRESSES.childRequestedVisibilityChange,
      });
  } finally {
    // Restore the saved pointer even if a synchronous host leaf throws.
    writeGlobal(services, savedWindow, 'SetVisibility/global-restore');
  }
}

export const setWindowVisibilityNative = setVisibilityNative;
export const xWindowSetVisibilityNative = setVisibilityNative;
export const setWindowChildVisibilityNative = setChildVisibilityNative;
export const xWindowSetChildVisibilityNative = setChildVisibilityNative;

/**
 * Execute the getter branch used by Window.IsVisible(bRecurse).  The installed
 * body at 0x100031c0 returns this window's bit when recursion is false; with
 * recursion enabled it walks +0x138 until it reaches either a hidden ancestor
 * or the null root link.
 */
export function isWindowVisibleNative(window, recurse = true, services = {}) {
  objectReference(window, 'window');
  const receiver = window;
  if (!recurse) {
    return Boolean(readRaw(receiver, WINDOW_VISIBILITY_OFFSETS.visibility, 'u32', services,
      'IsVisible/local') & WINDOW_VISIBILITY_BITS.visibility);
  }
  const seen = new Set();
  let current = receiver;
  while (present(current)) {
    if (seen.has(current)) {
      fail('XWindow::IsVisible received a cyclic +0x138 parent chain', {
        kind: 'REFERENCE', object: current, offset: WINDOW_VISIBILITY_OFFSETS.parent,
        operation: 'IsVisible/recurse',
      });
    }
    seen.add(current);
    if (!(readRaw(current, WINDOW_VISIBILITY_OFFSETS.visibility, 'u8', services,
      'IsVisible/recurse') & WINDOW_VISIBILITY_BITS.visibility)) return false;
    current = readRaw(current, WINDOW_VISIBILITY_OFFSETS.parent, 'ptr', services,
      'IsVisible/recurse');
  }
  return true;
}

/** execShow's optional bShow defaults to true and calls SetVisibility. */
export function showWindowNative(window, show = true, services = {}) {
  objectReference(window, 'window');
  return setVisibilityNative({object: window, visible: show}, services);
}
