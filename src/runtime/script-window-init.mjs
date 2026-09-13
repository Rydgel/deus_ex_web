/**
 * Execute the recovered Extension.dll XWindow::Init body.
 *
 * The native function is a storage and dispatch boundary.  This adapter keeps
 * the original instruction order, but does not guess names for the fields
 * whose reflected/constructor identity is still unresolved.  `read` and
 * `write` therefore receive numeric byte offsets.  XGC construction,
 * AddChild, ChildAdded, DescendantAdded, and SetFonts are explicit host leaves;
 * their native bodies are outside this bounded translation.
 *
 * Evidence: Extension.dll (installed SHA-256 below), body 0x1004bb30 through
 * 0x1004be89, and docs/script-window-init.md.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_INIT_NATIVE = freeze({
  package: 'Extension',
  function: 'XWindow::Init',
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  body: 0x1004bb30,
  end: 0x1004be89,
  stackBytes: 4,
});

export const WINDOW_INIT_NATIVE_ADDRESSES = freeze({
  body: WINDOW_INIT_NATIVE.body,
  end: WINDOW_INIT_NATIVE.end,
  fNameNoneIat: 0x10059124,
  xgcOperatorNew: 0x10002c40,
  xgcConstructor: 0x10026ad0,
  addChild: 0x10050a80,
  childAddedSlot: 0x68,
  descendantAddedSlot: 0x70,
  setFonts: 0x10027640,
});

/** Raw offsets touched by the recovered body.  Names are storage labels only. */
export const WINDOW_INIT_OFFSETS = freeze({
  byte28: 0x28,
  pointer2c: 0x2c,
  dword30: 0x30,
  dword34: 0x34,
  dword38: 0x38,
  byte3c: 0x3c,
  packedColor3d: 0x3d,
  dword44: 0x44,
  dword48: 0x48,
  dword4c: 0x4c,
  dword50: 0x50,
  pointer54: 0x54,
  pointer58: 0x58,
  float5c: 0x5c,
  packedColor60: 0x60,
  float64: 0x64,
  float68: 0x68,
  float6c: 0x6c,
  float70: 0x70,
  dword74: 0x74,
  dword78: 0x78,
  dword7c: 0x7c,
  float80: 0x80,
  float84: 0x84,
  byte88: 0x88,
  byte89: 0x89,
  dword8c: 0x8c,
  dword90: 0x90,
  dword94: 0x94,
  dword98: 0x98,
  float9c: 0x9c,
  floata0: 0xa0,
  dwordb8: 0xb8,
  dwordbc: 0xbc,
  dwordc0: 0xc0,
  dwordc4: 0xc4,
  dwordc8: 0xc8,
  dwordcc: 0xcc,
  dwordd0: 0xd0,
  originD4: 0xd4,
  originD8: 0xd8,
  originDC: 0xdc,
  originE0: 0xe0,
  originE4: 0xe4,
  originE8: 0xe8,
  dwordec: 0xec,
  dwordf0: 0xf0,
  dwordf8: 0xf8,
  dwordfc: 0xfc,
  dword104: 0x104,
  dword108: 0x108,
  dword10c: 0x10c,
  dword110: 0x110,
  dword118: 0x118,
  dword11c: 0x11c,
  dword120: 0x120,
  dword124: 0x124,
  dword128: 0x128,
  pointer130: 0x130,
  pointer134: 0x134,
  parent138: 0x138,
  pointer13c: 0x13c,
  pointer140: 0x140,
  pointer144: 0x144,
  pointer148: 0x148,
});

// Compatibility name for callers that describe these as fields rather than
// offsets.  The values remain raw byte offsets; no script property is implied.
export const WINDOW_INIT_FIELDS = WINDOW_INIT_OFFSETS;

export const WINDOW_INIT_NATIVE_CONTRACT = freeze({
  name: 'XWindow::Init',
  address: WINDOW_INIT_NATIVE.body,
  arguments: freeze(['XWindow* Parent']),
  returns: 'void',
  rawStorage: 'read(target, byteOffset, type, details) / write(target, byteOffset, type, value, details)',
  packedColors: freeze([
    freeze({offset: WINDOW_INIT_OFFSETS.packedColor3d, initializedBytes: freeze([0, 0xff, 0]),
      retainedByte: 'parent argument byte 3'}),
    freeze({offset: WINDOW_INIT_OFFSETS.packedColor60, initializedBytes: freeze([0xff, 0xff, 0xff]),
      retainedByte: 'parent argument byte 3'}),
    freeze({offset: WINDOW_INIT_OFFSETS.packedColor60 + 0xa0, initializedBytes: freeze([0xff, 0xff, 0xff]),
      retainedByte: 'parent argument byte 3'}),
  ]),
  leaves: freeze([
    'FName(NAME_None)',
    'XGC::operator new(size=0xb8, Outer=this, Name, flags=0)',
    'XGC constructor',
    'AddChild(parent,this,1)',
    'parent ChildAdded(this) through vtable +0x68',
    'ancestor DescendantAdded(this) through vtable +0x70',
    'XGC::SetFonts(normalFont,boldFont)',
  ]),
  parentOrder: freeze([
    'AddChild(parent,this,1)',
    'ChildAdded(this)',
    'DescendantAdded(this) for current ancestor',
    'read current ancestor +0x138 after callback',
  ]),
});

export class WindowInitNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', value = undefined, offset = null, operation = null} = {}) {
    super(message);
    this.name = 'WindowInitNativeBoundaryError';
    this.code = `WINDOW_INIT_${kind}`;
    this.value = value;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowInitNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XWindow::Init ${label} service suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'function') {
    fail(`XWindow::Init requires ${name} service`, {kind: 'SERVICE', operation: name});
  }
  return value;
}

function objectReference(value, name, {allowNull = false} = {}) {
  if (allowNull && (value === null || value === 0)) return value;
  if ((typeof value !== 'object' && typeof value !== 'function' &&
      typeof value !== 'number') || value === undefined || value === null) {
    fail(`XWindow::Init requires canonical ${name}`, {kind: 'REFERENCE', value, operation: name});
  }
  return value;
}

function unsigned(value, label, offset) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`XWindow::Init requires uint32 ${label} at +0x${offset.toString(16)}`, {
      kind: 'VALUE', value, offset, operation: label,
    });
  }
  return value >>> 0;
}

function finiteFloat(value, label, offset) {
  if (!Number.isFinite(value)) {
    fail(`XWindow::Init requires finite float ${label} at +0x${offset.toString(16)}`, {
      kind: 'VALUE', value, offset, operation: label,
    });
  }
  return Math.fround(value);
}

function readRaw(target, offset, services, {kind = 'u32', phase = 'Init'} = {}) {
  const reader = required(services.read, 'raw read');
  const value = sync(reader(target, offset, kind, {
    native: WINDOW_INIT_NATIVE.body, phase, offset, kind, width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    fail(`XWindow::Init reached unresolved raw field +0x${offset.toString(16)}`, {
      kind: 'FIELD', value, offset, operation: phase,
    });
  }
  if (kind === 'u8') {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      fail(`XWindow::Init raw byte +0x${offset.toString(16)} is outside uint8`, {
        kind: 'VALUE', value, offset, operation: phase,
      });
    }
    return value;
  }
  if (kind === 'f32') return finiteFloat(value, 'native float', offset);
  if (kind === 'u32' || kind === 'ptr') return kind === 'u32' ? unsigned(value, 'native dword', offset) : value;
  fail(`XWindow::Init does not support raw read kind ${kind}`, {kind: 'VALUE', value: kind, offset});
}

function floatBits(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return new DataView(buffer).getUint32(0, true);
}

function writeRaw(target, offset, value, services, {kind = 'u32', phase = 'Init', source = undefined} = {}) {
  const writer = required(services.write, 'raw write');
  let normalized = value;
  if (kind === 'u8') {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      fail(`XWindow::Init raw byte +0x${offset.toString(16)} is outside uint8`, {
        kind: 'VALUE', value, offset, operation: phase,
      });
    }
  } else if (kind === 'u32') {
    normalized = unsigned(value, 'native dword', offset);
  } else if (kind === 'f32') {
    normalized = finiteFloat(value, 'native float', offset);
  } else if (kind !== 'ptr') {
    fail(`XWindow::Init does not support raw write kind ${kind}`, {kind: 'VALUE', value: kind, offset});
  }
  const details = {
    native: WINDOW_INIT_NATIVE.body,
    phase,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
    rawBits: kind === 'f32' ? floatBits(normalized) :
      kind === 'u32' ? normalized : undefined,
    source,
  };
  return sync(writer(target, offset, kind, normalized, details), `write +0x${offset.toString(16)}`);
}

function callLeaf(services, names, label, details) {
  const nameList = Array.isArray(names) ? names : [names];
  const callback = nameList.map(name => services[name]).find(value => typeof value === 'function');
  if (!callback) fail(`XWindow::Init requires ${nameList[0]} service`, {
    kind: 'SERVICE', operation: label,
  });
  return sync(callback(details), label);
}

function present(pointer) {
  return pointer !== null && pointer !== undefined && pointer !== 0;
}

function pointerWord(parent, explicit, services) {
  if (!present(parent)) return 0;
  const value = explicit ?? (typeof parent === 'number' ? parent : undefined);
  const raw = value === undefined
    ? callLeaf(services, ['pointerWord', 'addressOf'], 'parent pointer word', {
      object: parent, native: WINDOW_INIT_NATIVE.body,
    })
    : value;
  return unsigned(raw, 'parent pointer word', WINDOW_INIT_OFFSETS.pointer2c);
}

function packedColor3d(parentWord) {
  return (((parentWord >>> 24) << 24) | 0x0000ff00) >>> 0;
}

function packedColorAll(parentWord) {
  return (((parentWord >>> 24) << 24) | 0x00ffffff) >>> 0;
}

function makeXgc(window, index, services) {
  const name = callLeaf(services, ['fNameNone', 'nameNone'], 'FName(NAME_None)', {
    enum: 0,
    native: WINDOW_INIT_NATIVE_ADDRESSES.fNameNoneIat,
    index,
  });
  if (name === undefined) {
    fail('XWindow::Init FName(NAME_None) leaf returned no FName value', {
      kind: 'BOUNDARY', operation: 'FName(NAME_None)',
    });
  }
  const graphicsContext = callLeaf(services,
    ['xgcOperatorNew', 'constructXgc'], 'XGC::operator new', {
      size: 0xb8,
      outer: window,
      name,
      flags: 0,
      nativeOperatorNew: WINDOW_INIT_NATIVE_ADDRESSES.xgcOperatorNew,
      nativeConstructor: WINDOW_INIT_NATIVE_ADDRESSES.xgcConstructor,
      index,
    });
  if (graphicsContext === undefined) {
    fail('XWindow::Init XGC allocation leaf returned undefined', {
      kind: 'BOUNDARY', operation: 'XGC::operator new',
    });
  }
  if (!present(graphicsContext)) return 0;
  if (typeof services.xgcOperatorNew === 'function') {
    if (typeof services.xgcConstructor !== 'function' &&
        typeof services.constructXgcObject !== 'function') {
      fail('XWindow::Init requires XGC constructor service after allocation', {
        kind: 'SERVICE', operation: 'XGC constructor',
      });
    }
    callLeaf(services, ['xgcConstructor', 'constructXgcObject'], 'XGC constructor', {
      object: graphicsContext,
      native: WINDOW_INIT_NATIVE_ADDRESSES.xgcConstructor,
      index,
    });
  }
  return graphicsContext;
}

/**
 * Execute the original XWindow::Init(parent) body.
 *
 * `args` is `{window, parent?, parentPointerWord?}`.  `parentPointerWord`
 * preserves the high byte which the x86 body leaves in the three packed-color
 * dwords.  If it is omitted for a non-null object, `services.pointerWord` (or
 * its `addressOf` alias) is required; no alpha byte is invented.
 */
export function initWindowNative({window, parent = null, parentPointerWord, parentWord} = {}, services = {}) {
  objectReference(window, 'window');
  objectReference(parent, 'parent', {allowNull: true});
  const rawParentWord = pointerWord(parent, parentPointerWord ?? parentWord, services);
  const O = WINDOW_INIT_OFFSETS;

  writeRaw(window, O.byte28, 0, services, {kind: 'u8'});
  writeRaw(window, O.pointer2c, rawParentWord, services, {kind: 'u32'});

  const flags30 = readRaw(window, O.dword30, services);
  writeRaw(window, O.dword30, ((flags30 & 0xffffff00) |
    (((flags30 & 0xff) & 0xea) | 2)) >>> 0, services);
  writeRaw(window, O.dword34, 0, services);

  const flags38 = readRaw(window, O.dword38, services);
  writeRaw(window, O.dword38, ((flags38 & ~2) | 1) >>> 0, services);
  writeRaw(window, O.byte3c, 1, services, {kind: 'u8'});
  const flags38After = readRaw(window, O.dword38, services);
  writeRaw(window, O.dword38, (flags38After & ~4) >>> 0, services);

  writeRaw(window, O.packedColor3d, packedColor3d(rawParentWord), services, {
    kind: 'u32', source: 'three initialized bytes plus parent pointer high byte',
  });
  writeRaw(window, O.dword44, 0, services);
  writeRaw(window, O.dword48, 1, services, {kind: 'f32'});
  writeRaw(window, O.dword4c, 0, services);
  writeRaw(window, O.dword50, 0, services);
  writeRaw(window, O.packedColor60, packedColorAll(rawParentWord), services, {
    kind: 'u32', source: 'three initialized bytes plus parent pointer high byte',
  });
  writeRaw(window, O.float64, 1, services, {kind: 'f32'});
  writeRaw(window, O.float68, 1, services, {kind: 'f32'});
  writeRaw(window, O.float6c, 1, services, {kind: 'f32'});
  writeRaw(window, O.float70, 0, services, {kind: 'f32'});

  const flags74 = readRaw(window, O.dword74, services);
  writeRaw(window, O.dword74, (flags74 | 1) >>> 0, services);
  writeRaw(window, O.float5c, 1, services, {kind: 'f32'});
  writeRaw(window, O.dword78, 0, services);
  writeRaw(window, O.dword7c, 0, services);
  writeRaw(window, O.float80, 10, services, {kind: 'f32'});
  writeRaw(window, O.float84, 10, services, {kind: 'f32'});
  writeRaw(window, O.byte88, 0, services, {kind: 'u8'});
  writeRaw(window, O.byte89, 0, services, {kind: 'u8'});
  writeRaw(window, O.dword8c, 0, services);
  writeRaw(window, O.dword90, 0, services);
  writeRaw(window, O.dword94, 0, services);
  writeRaw(window, O.dword98, 0, services);

  const flagsB8 = readRaw(window, O.dwordb8, services);
  writeRaw(window, O.float9c, -1, services, {kind: 'f32'});
  writeRaw(window, O.floata0, -1, services, {kind: 'f32'});
  writeRaw(window, O.dwordb8, ((flagsB8 & ~4) | 0x1b) >>> 0, services);
  writeRaw(window, O.dwordf8, -1, services, {kind: 'f32'});
  writeRaw(window, O.dwordfc, -1, services, {kind: 'f32'});
  writeRaw(window, O.packedColor60 + 0xa0, packedColorAll(rawParentWord), services, {
    kind: 'u32', source: 'three initialized bytes plus parent pointer high byte',
  });

  const flagsCC = readRaw(window, O.dwordcc, services);
  writeRaw(window, O.dwordbc, 0, services);
  writeRaw(window, O.dwordc0, 0, services);
  writeRaw(window, O.dwordc4, 0, services);
  writeRaw(window, O.dwordc8, 0, services);
  writeRaw(window, O.dwordcc, (flagsCC & ~1) >>> 0, services);
  writeRaw(window, O.dwordd0, 0, services);
  writeRaw(window, O.dwordec, 0, services);
  writeRaw(window, O.dwordf0, 0, services);
  writeRaw(window, O.dword104, 0, services);
  writeRaw(window, O.dword108, 0, services);
  writeRaw(window, O.dword10c, 0, services);
  writeRaw(window, O.dword110, 0, services);
  writeRaw(window, O.dword118, 0, services);
  writeRaw(window, O.dword11c, 0xffffffff, services);
  writeRaw(window, O.dword120, 0xffffffff, services);
  writeRaw(window, O.dword124, 0, services);
  writeRaw(window, O.dword128, 0, services);

  const firstGc = makeXgc(window, 0, services);
  writeRaw(window, O.pointer130, firstGc, services, {kind: 'ptr'});
  const secondGc = makeXgc(window, 1, services);
  writeRaw(window, O.pointer134, secondGc, services, {kind: 'ptr'});
  for (const offset of [O.parent138, O.pointer13c, O.pointer140, O.pointer144, O.pointer148]) {
    writeRaw(window, offset, 0, services, {kind: 'ptr'});
  }

  if (present(parent)) {
    callLeaf(services, 'addChild', 'AddChild', {
      parent, child: window, flag: 1, native: WINDOW_INIT_NATIVE_ADDRESSES.addChild,
    });
    callLeaf(services, 'childAdded', 'ChildAdded', {
      parent, child: window, virtualSlot: WINDOW_INIT_NATIVE_ADDRESSES.childAddedSlot,
    });
    let ancestor = parent;
    while (present(ancestor)) {
      callLeaf(services, 'descendantAdded', 'DescendantAdded', {
        parent: ancestor, child: window,
        virtualSlot: WINDOW_INIT_NATIVE_ADDRESSES.descendantAddedSlot,
      });
      ancestor = readRaw(ancestor, O.parent138, services, {kind: 'ptr', phase: 'DescendantAdded'});
    }
  }

  // These reads intentionally happen after the callback walk.  AddChild and
  // callbacks are allowed to publish the +0x138 link used by the native body.
  const originParent = readRaw(window, O.parent138, services, {kind: 'ptr', phase: 'origin'});
  const height = readRaw(window, O.float84, services, {kind: 'f32', phase: 'origin'});
  const width = readRaw(window, O.float80, services, {kind: 'f32', phase: 'origin'});
  let origin;
  if (originParent === null || originParent === 0 || originParent === undefined) {
    origin = [0, 0, 0, 0, width, height];
  } else {
    // Native x87 evaluation loads +0xd8 before the raw +0xd4 word, then
    // places the latter first in the destination six-float block.
    const parentY = readRaw(originParent, O.originD8, services, {
      kind: 'f32', phase: 'parent-origin',
    });
    const parentX = readRaw(originParent, O.originD4, services, {
      kind: 'f32', phase: 'parent-origin',
    });
    origin = [parentX, parentY, 0, 0, width, height];
  }
  for (const [offset, value] of [
    [O.originD4, origin[0]], [O.originD8, origin[1]], [O.originDC, origin[2]],
    [O.originE0, origin[3]], [O.originE4, origin[4]], [O.originE8, origin[5]],
  ]) writeRaw(window, offset, value, services, {kind: 'f32', phase: 'origin'});

  // Font search uses the same +0x138 pointer loaded above.  Every field is
  // reread at the same point as the native instructions; callback mutations
  // therefore affect the walk.
  let fontOwner = originParent;
  while (present(fontOwner)) {
    const normal = readRaw(fontOwner, O.pointer54, services, {kind: 'ptr', phase: 'font-search'});
    if (present(normal)) break;
    const bold = readRaw(fontOwner, O.pointer58, services, {kind: 'ptr', phase: 'font-search'});
    if (present(bold)) break;
    fontOwner = readRaw(fontOwner, O.parent138, services, {kind: 'ptr', phase: 'font-search'});
  }
  if (present(fontOwner)) {
    const normal = readRaw(fontOwner, O.pointer54, services, {kind: 'ptr', phase: 'font-copy'});
    const bold = readRaw(fontOwner, O.pointer58, services, {kind: 'ptr', phase: 'font-copy'});
    writeRaw(window, O.pointer54, normal, services, {kind: 'ptr', phase: 'font-copy'});
    writeRaw(window, O.pointer58, bold, services, {kind: 'ptr', phase: 'font-copy'});
  } else {
    writeRaw(window, O.pointer54, 0, services, {kind: 'ptr', phase: 'font-copy'});
    writeRaw(window, O.pointer58, 0, services, {kind: 'ptr', phase: 'font-copy'});
  }

  const graphicsContext = readRaw(window, O.pointer130, services, {kind: 'ptr', phase: 'SetFonts'});
  if (present(graphicsContext)) {
    const bold = readRaw(window, O.pointer58, services, {kind: 'ptr', phase: 'SetFonts'});
    const normal = readRaw(window, O.pointer54, services, {kind: 'ptr', phase: 'SetFonts'});
    callLeaf(services, 'setFonts', 'XGC::SetFonts', {
      graphicsContext,
      normalFont: normal,
      boldFont: bold,
      native: WINDOW_INIT_NATIVE_ADDRESSES.setFonts,
    });
  }
}

export const initializeWindowNative = initWindowNative;
export const xWindowInitNative = initWindowNative;
