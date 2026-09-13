/**
 * Recovered XComputerWindow construction, Init, and terminal-buffer natives.
 *
 * This module deliberately leaves the engine-owned object graph and FArray
 * storage behind synchronous services.  The native bodies are nevertheless
 * kept in instruction order: raw fields are addressed by their original byte
 * offsets and the event records contain the exact stores made by Extension.dll.
 * The service boundary is useful in Play mode too, where the browser owns the
 * actual child-window and text presentation objects.
 *
 * Evidence: installed Extension.u exports 1758, 1822, 1828, 1835, 1837,
 * 1843, 1847, 1857, 1860, and 1897; Extension.dll SHA-256 below; and the
 * direct bodies at 0x1000d4d0, 0x1000d530, 0x1000d8f0, 0x1000d970,
 * 0x1000dab0, 0x1000daf0, 0x1000db10, 0x1000dbc0, 0x1000dcb0,
 * 0x1000ddb0, and 0x10031320.  See docs/script-window-computer.md.
 */

const freeze = Object.freeze;
const EXTENSION_DLL_SHA256 =
  '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c';

const functionEvidence = (packageExport, nativeIndex, serialSize, scriptSize,
  body, end, bodySha256) => freeze({
  packageExport, nativeIndex, functionFlags: 0x401, serialSize, scriptSize,
  body, end, bodySha256,
});

export const COMPUTER_WINDOW_NATIVE_ADDRESSES = freeze({
  imageBase: 0x10000000,
  internalConstructor: 0x100191e0,
  constructor: 0x1000d4d0,
  constructorEnd: 0x1000d52c,
  init: 0x1000d530,
  initEnd: 0x1000d698,
  setTextSize: 0x1000d8f0,
  setTextFont: 0x1000d970,
  setCursorColor: 0x1000dab0,
  showTextCursor: 0x1000daf0,
  setTextTiming: 0x1000db10,
  enableWordWrap: 0x1000dbc0,
  clearScreen: 0x1000dcb0,
  print: 0x1000ddb0,
  setFadeSpeed: 0x10031320,
  resize: 0x1004cf70,
  baseInit: 0x1004bb30,
  getRootWindow: 0x1004c5a0,
  getPlayerPawn: 0x1004c5c0,
  createNewWindow: 0x1004df70,
  setWindowAlignments: 0x1004d300,
  setTextMargins: 0x10046070,
  setInsertionPointBlinkRate: 0x1001d960,
  setSelectability: 0x1004c390,
  appStricmpIat: 0x100590c8,
  addZeroedIat: 0x100590d4,
  reallocIat: 0x1005909c,
  appStrcpyIat: 0x100590d8,
  gmallocIat: 0x10059060,
  textWindowClass: 0x100ae5b8,
  inputWindowClass: 0x1009ae18,
  xWindowVtable: 0x10059930,
  xComputerWindowVtable: 0x1005b2c8,
  temporaryVtable: 0x10059888,
});

export const COMPUTER_WINDOW_NATIVE = freeze({
  package: 'Extension',
  class: 'ComputerWindow',
  nativeClass: 'XComputerWindow',
  classPackageExport: 1758,
  dll: 'Extension.dll',
  dllSha256: EXTENSION_DLL_SHA256,
  imageBase: 0x10000000,
  internalConstructor: freeze({
    body: COMPUTER_WINDOW_NATIVE_ADDRESSES.internalConstructor,
    end: 0x1001923a,
    bodySha256: '1fbe0a567b43f6d5cedba2fd3ff36c30d14220ca46ffaf29821c559fedc578ba',
  }),
  constructor: freeze({
    body: COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor,
    end: COMPUTER_WINDOW_NATIVE_ADDRESSES.constructorEnd,
    bodySha256: 'e56a2f0af28bef14ac45a297447363f2cfa5f2719286a013c3129c5c6dd1d6e4',
  }),
  init: freeze({
    body: COMPUTER_WINDOW_NATIVE_ADDRESSES.init,
    end: COMPUTER_WINDOW_NATIVE_ADDRESSES.initEnd,
    bodySha256: '69504b81695dba70b2fb94647ba272259fb7adc2d5fde8bff503c39fe144e030',
  }),
  setTextSize: functionEvidence(1822, 1971, 34, 10, 0x1000d8f0, 0x1000d94c,
    'b24371066746cea6c16c4777be83caceb05d8cf60101e53c7edb6308d6b8ae0d'),
  setTextFont: functionEvidence(1828, 1973, 40, 20, 0x1000d970, 0x1000da24,
    '70e15220a6c44846f7a3f71a68e0e0af032270613b2e5551ac85fb90aa7e58e5'),
  setTextTiming: functionEvidence(1835, 1975, 31, 5, 0x1000db10, 0x1000db1d,
    'b11f0f64d244dcc0eda8b3021115291e67a4209e8f4c11b93cfb36e6fe2a6daf'),
  setFadeSpeed: functionEvidence(1837, 1976, 31, 5, 0x10031320, 0x1003132d,
    'ffb28d94b1433089f39ea23d85dc3391c38fc9545997a0b81f6cb1dea0385d30'),
  setCursorColor: functionEvidence(1843, 1978, 31, 5, 0x1000dab0, 0x1000dabd,
    'decdf36c73911376e8c547fc804276491f0af30fe07b2b509cf37669a92c404e'),
  showTextCursor: functionEvidence(1847, 1980, 31, 5, 0x1000daf0, 0x1000db0d,
    'db125a0281022a7219607de0bcd85238c4a4f042eee1aecb198c1a8aa5399ccc'),
  clearScreen: functionEvidence(1857, 1985, 27, 5, 0x1000dcb0, 0x1000dce8,
    'c9f72ab16705c6fcb34d9ac8a5f2f75a042ea97fedcad7f086f40d6bbb89643a'),
  print: functionEvidence(1860, 1987, 34, 10, 0x1000ddb0, 0x1000debd,
    'daae75fca4b05b57b0246fb024a8dee6ccfa3721f55710eafde1e9f44de5693d'),
  enableWordWrap: functionEvidence(1897, 2001, 30, 5, 0x1000dbc0, 0x1000dbde,
    '08f709316ae5d6fb80265189b1e47b1f680719b37c3034a91d9b6b6a142f264a'),
});

export const COMPUTER_WINDOW_OFFSETS = freeze({
  eventTimeInterval: 0x14c,
  timeNextEvent: 0x150,
  timeLastEvent: 0x154,
  timeCurrent: 0x158,
  fadeSpeed: 0x15c,
  throttle: 0x160,
  fadeOutTimer: 0x164,
  fadeOutStart: 0x168,
  textCols: 0x16c,
  textRows: 0x170,
  textFont: 0x174,
  fontWidth: 0x178,
  fontHeight: 0x17c,
  fontColor: 0x180,
  textSound: 0x184,
  typingSound: 0x188,
  computerSoundVolume: 0x18c,
  flags: 0x190,
  backgroundTextures: 0x194,
  cursorTexture: 0x1ac,
  cursorColor: 0x1b0,
  cursorWidth: 0x1b4,
  cursorHeight: 0x1b8,
  cursorBlinkSpeed: 0x1bc,
  cursorFlags: 0x1c0,
  cursorNextEvent: 0x1c4,
  unknown1c8: 0x1c8,
  textWindow: 0x1cc,
  player: 0x1d0,
  displayBuffer: 0x1d4,
  queuedBuffer: 0x1e0,
  queuedBufferStart: 0x1ec,
  textX: 0x1f0,
  textY: 0x1f4,
  inputKey: 0x1f8,
  inputMask: 0x204,
  inputWindow: 0x210,
  inputFlags: 0x214,
});

export const COMPUTER_WINDOW_FIELDS = COMPUTER_WINDOW_OFFSETS;

export const COMPUTER_WINDOW_BITS = freeze({
  wordWrap: 0x01,
  cursorVisible: 0x01,
  showCursor: 0x02,
  waitingForKey: 0x01,
  ignoreGamePaused: 0x20,
});

export const COMPUTER_WINDOW_NATIVE_CONTRACT = freeze({
  name: 'XComputerWindow construction, Init, and terminal buffer natives',
  class: 'ComputerWindow',
  constructors: freeze([
    'InternalConstructor: Core UObject constructor, temporary XWindow vtable, XClipRect zero, six dynamic-array dwords zero, final XComputerWindow vtable',
    'XComputerWindow(parent): XWindow constructor, six dynamic-array dwords zero, bFirstTick|bWordWrap, bCursorVisible|bShowCursor, final vtable',
  ]),
  init: freeze([
    'call XWindow::Init(parent)',
    'GetRootWindow then GetPlayerPawn; store Player +0x1d0',
    'read Player viewport name and compare with NAME_None/empty string; set inputFlags bit 0x20 when nonempty',
    'Create TextWindow with class global 0x100ae5b8 and bShow=1; store +0x1cc',
    'when textFont and TextWindow are non-null, Resize this ComputerWindow to cols*fontWidth by rows*fontHeight',
    'SetWindowAlignments(TextWindow, 3, 3, 0, 0, 0, 0)',
    'Create input window with class global 0x1009ae18 and bShow=0; store +0x210',
    'SetTextMargins(input,0,0), SetInsertionPointBlinkRate(input,2*cursorBlinkSpeed,0), SetSelectability(this,1)',
  ]),
  methods: freeze([
    'SetTextSize writes cols/rows before the font/TextWindow guards, then resizes this ComputerWindow',
    'SetTextFont writes font/width/height, appends queued event type 1 with timeNextEvent and Color, copies timeCurrent to timeLastEvent, then conditionally resizes this ComputerWindow',
    'SetTextTiming and SetFadeSpeed copy one float dword',
    'SetCursorColor copies one Color dword',
    'ShowTextCursor changes cursorFlags bit 1 only',
    'EnableWordWrap changes flags bit 0 only',
    'ClearScreen clears inputFlags bit 0, empties displayBuffer with element size 0x20, then clears TextX/TextY',
    'Print clears inputFlags bit 0 and appends one queued event per UTF-16 code unit; caret (0x5e) events have type 4, others type 0; bNewLine is unused by the body',
  ]),
  rawStorage: 'read(object, byteOffset, kind, details) / write(object, byteOffset, kind, value, details)',
  farrayLeaves: freeze([
    'addZeroed({object,arrayOffset,elementSize:0x20,count:1}) -> element index',
    'writeQueuedEvent({object,arrayOffset,index,event})',
    'arrayRealloc({object,arrayOffset,elementSize:0x20})',
  ]),
  initLeaves: freeze([
    'initWindow', 'getRootWindow', 'getPlayerPawn', 'readPlayerViewportName',
    'createNewWindow', 'resize', 'setWindowAlignments', 'setTextMargins',
    'setInsertionPointBlinkRate', 'setSelectability',
  ]),
  limitations: freeze([
    'The native Print temporary FString allocator/copy/free sequence is represented by the resolved JavaScript string and explicit queued-event leaf; allocator ownership is not guessed.',
    'The Player viewport FString graph is an explicit host leaf because it belongs to the Engine/DeusEx object graph outside this Extension.dll body.',
  ]),
});

export const COMPUTER_WINDOW_NATIVE_CONTRACTS = COMPUTER_WINDOW_NATIVE_CONTRACT;

export class ComputerWindowNativeBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', operation = null, offset = null, value} = {}) {
    super(message);
    this.name = 'ComputerWindowNativeBoundaryError';
    this.code = `COMPUTER_WINDOW_${kind}`;
    this.operation = operation;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details = {}) => { throw new ComputerWindowNativeBoundaryError(message, details); };
const sync = (value, label) => {
  if (value && typeof value.then === 'function') fail(`${label} service suspended`, {kind: 'ASYNC', operation: label});
  return value;
};
const service = (services, names, label) => {
  const candidates = Array.isArray(names) ? names : [names];
  const callback = candidates.map(name => services?.[name]).find(value => typeof value === 'function');
  if (!callback) fail(`ComputerWindow requires ${candidates[0]} service`, {kind: 'SERVICE', operation: label});
  return callback;
};
const present = value => value !== null && value !== undefined && value !== 0;

function objectReference(value, label, {nullable = false} = {}) {
  if (nullable && (value === null || value === undefined || value === 0)) return value;
  if (value === null || value === undefined || value === 0 ||
      (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number')) {
    fail(`ComputerWindow requires canonical ${label}`, {kind: 'REFERENCE', operation: label, value});
  }
  if (typeof value === 'number' && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`ComputerWindow requires uint32 ${label} pointer`, {kind: 'VALUE', operation: label, value});
  }
  return value;
}

function int32(value, label) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    fail(`ComputerWindow requires int32 ${label}`, {kind: 'VALUE', operation: label, value});
  }
  return value | 0;
}

function uint32(value, label, offset = null) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`ComputerWindow requires uint32 ${label}`, {kind: 'VALUE', operation: label, offset, value});
  }
  return value >>> 0;
}

function scalar(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`ComputerWindow requires finite float ${label}`, {kind: 'VALUE', operation: label, value});
  }
  return Math.fround(value);
}

function rawRead(object, offset, kind, services, phase, native) {
  const value = sync(service(services, 'read', phase)(object, offset, kind, {
    native, phase, offset, kind, width: kind === 'u8' ? 1 : 4,
  }), `${phase} read +0x${offset.toString(16)}`);
  if (value === undefined) fail(`ComputerWindow reached unresolved raw field +0x${offset.toString(16)}`, {
    kind: 'FIELD', operation: phase, offset,
  });
  if (kind === 'u8') {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) fail('ComputerWindow raw byte is outside uint8', {
      kind: 'VALUE', operation: phase, offset, value,
    });
    return value;
  }
  if (kind === 'i32') return int32(value, `raw +0x${offset.toString(16)}`);
  if (kind === 'f32') return scalar(value, `raw +0x${offset.toString(16)}`);
  if (kind === 'ptr') return value;
  return uint32(value, `raw +0x${offset.toString(16)}`, offset);
}

function rawWrite(object, offset, kind, value, services, phase, native) {
  let normalized = value;
  if (kind === 'u8') {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) fail('ComputerWindow raw byte is outside uint8', {
      kind: 'VALUE', operation: phase, offset, value,
    });
  } else if (kind === 'i32') normalized = int32(value, `raw +0x${offset.toString(16)}`);
  else if (kind === 'f32') normalized = scalar(value, `raw +0x${offset.toString(16)}`);
  else if (kind === 'u32') normalized = uint32(value, `raw +0x${offset.toString(16)}`, offset);
  else if (kind !== 'ptr') fail(`ComputerWindow does not support raw write kind ${kind}`, {
    kind: 'VALUE', operation: phase, offset, value: kind,
  });
  return sync(service(services, 'write', phase)(object, offset, kind, normalized, {
    native, phase, offset, kind, width: kind === 'u8' ? 1 : 4, value: normalized,
  }), `${phase} write +0x${offset.toString(16)}`);
}

function call(services, names, label, details) {
  return sync(service(services, names, label)(details), label);
}

function colorWord(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) return value >>> 0;
  if (!value || typeof value !== 'object') fail('ComputerWindow Color requires a packed dword or Color object', {
    kind: 'VALUE', operation: 'Color', value,
  });
  const channels = ['r', 'g', 'b', 'a'].map(channel => {
    const item = value[`core.object.color.${channel}`] ?? value[channel];
    if (!Number.isInteger(item) || item < 0 || item > 0xff) fail(`ComputerWindow Color.${channel} is outside uint8`, {
      kind: 'VALUE', operation: `Color.${channel}`, value: item,
    });
    return item;
  });
  return (channels[0] | channels[1] << 8 | channels[2] << 16 | channels[3] << 24) >>> 0;
}

function boolWord(value, label) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 0 || value === 1) return value;
  fail(`ComputerWindow requires boolean ${label}`, {kind: 'VALUE', operation: label, value});
}

function resizeForText(object, services, phase) {
  const O = COMPUTER_WINDOW_OFFSETS;
  const rows = rawRead(object, O.textRows, 'i32', services, phase, COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextSize);
  const height = rawRead(object, O.fontHeight, 'i32', services, phase, COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextSize);
  const cols = rawRead(object, O.textCols, 'i32', services, phase, COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextSize);
  const width = rawRead(object, O.fontWidth, 'i32', services, phase, COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextSize);
  // The original uses signed x86 IMUL followed by FILD, then float stores to
  // the Resize stack. Math.imul preserves the same 32-bit product.
  call(services, ['resize', 'resizeWindow'], 'XComputerWindow::Resize', {
    object,
    window: object,
    width: Math.fround(Math.imul(cols, width)),
    height: Math.fround(Math.imul(rows, height)),
    native: COMPUTER_WINDOW_NATIVE_ADDRESSES.resize,
    caller: phase,
  });
}

function addQueuedEvent(object, event, services, phase) {
  const details = {
    object, window: object, array: 'queuedBuffer', arrayOffset: COMPUTER_WINDOW_OFFSETS.queuedBuffer,
    elementSize: 0x20, count: 1, event, native: COMPUTER_WINDOW_NATIVE_ADDRESSES[phase], caller: phase,
  };
  const append = ['appendQueuedEvent', 'queueEvent'].map(name => services?.[name])
    .find(value => typeof value === 'function');
  if (append) return sync(append(details), `${phase} queued event`);
  const index = call(services, ['addZeroed', 'arrayAddZeroed', 'queuedBufferAddZeroed'],
    `${phase} FArray::AddZeroed`, details);
  if (!Number.isInteger(index) || index < 0) fail(`${phase} AddZeroed returned an invalid index`, {
    kind: 'BOUNDARY', operation: phase, value: index,
  });
  call(services, ['writeQueuedEvent', 'writeArrayEvent'], `${phase} queued event store`, {
    ...details, index,
  });
  return index;
}

function constructBaseWindow(object, parent, services) {
  const explicit = ['constructWindow', 'constructXWindow'].map(name => services?.[name])
    .find(value => typeof value === 'function');
  if (explicit) return call(services, ['constructWindow', 'constructXWindow'], 'XWindow constructor', {
    object, window: object, parent, native: COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor,
  });
  call(services, ['coreObjectConstructor', 'constructCoreObject', 'constructUObject'],
    'Core UObject constructor', {
      object, className: 'XComputerWindow', native: 0x1005907c,
      constructorBody: COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor,
    });
  for (const offset of [0xd4, 0xd8, 0xdc, 0xe0, 0xe4, 0xe8]) {
    rawWrite(object, offset, 'u32', 0, services, 'XWindow::XWindow', COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor);
  }
  rawWrite(object, 0, 'u32', COMPUTER_WINDOW_NATIVE_ADDRESSES.xWindowVtable,
    services, 'XWindow::XWindow', COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor);
}

/** Execute XComputerWindow's direct constructor body. */
export function constructComputerWindowNative(object, services = {}) {
  const target = objectReference(object, 'XComputerWindow');
  const parent = services.parent ?? null;
  constructBaseWindow(target, parent, services);
  const O = COMPUTER_WINDOW_OFFSETS;
  for (const offset of [0x1d4, 0x1d8, 0x1dc, 0x1e0, 0x1e4, 0x1e8]) {
    rawWrite(target, offset, 'u32', 0, services, 'XComputerWindow::XComputerWindow',
      COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor);
  }
  const flags = rawRead(target, O.flags, 'u32', services, 'XComputerWindow::XComputerWindow',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor);
  const cursor = rawRead(target, O.cursorFlags, 'u32', services, 'XComputerWindow::XComputerWindow',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor);
  rawWrite(target, O.flags, 'u32', (flags | 0x11) >>> 0, services, 'XComputerWindow::XComputerWindow',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor);
  rawWrite(target, 0, 'u32', COMPUTER_WINDOW_NATIVE_ADDRESSES.xComputerWindowVtable,
    services, 'XComputerWindow::XComputerWindow', COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor);
  rawWrite(target, O.cursorFlags, 'u32', cursor | 3, services, 'XComputerWindow::XComputerWindow',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.constructor);
  return object;
}

/** Execute XComputerWindow's InternalConstructor thunk/body storage. */
export function constructComputerWindowInternalNative(object, services = {}) {
  const target = objectReference(object, 'XComputerWindow');
  call(services, ['coreObjectConstructor', 'constructCoreObject', 'constructUObject'],
    'Core UObject constructor', {
      object: target, className: 'XComputerWindow', native: 0x1005907c,
      constructorBody: COMPUTER_WINDOW_NATIVE_ADDRESSES.internalConstructor,
    });
  rawWrite(target, 0, 'u32', COMPUTER_WINDOW_NATIVE_ADDRESSES.temporaryVtable,
    services, 'XComputerWindow::InternalConstructor', COMPUTER_WINDOW_NATIVE_ADDRESSES.internalConstructor);
  for (const offset of [0xd4, 0xd8, 0xdc, 0xe0, 0xe4, 0xe8]) {
    rawWrite(target, offset, 'u32', 0, services, 'XComputerWindow::InternalConstructor',
      COMPUTER_WINDOW_NATIVE_ADDRESSES.internalConstructor);
  }
  for (const offset of [0x1d4, 0x1d8, 0x1dc, 0x1e0, 0x1e4, 0x1e8]) {
    rawWrite(target, offset, 'u32', 0, services, 'XComputerWindow::InternalConstructor',
      COMPUTER_WINDOW_NATIVE_ADDRESSES.internalConstructor);
  }
  rawWrite(target, 0, 'u32', COMPUTER_WINDOW_NATIVE_ADDRESSES.xComputerWindowVtable,
    services, 'XComputerWindow::InternalConstructor', COMPUTER_WINDOW_NATIVE_ADDRESSES.internalConstructor);
  return object;
}

/** Execute the reached XComputerWindow::Init body. */
export function initComputerWindowNative(object, parent = null, services = {}) {
  const target = objectReference(object, 'XComputerWindow');
  objectReference(parent, 'parent', {nullable: true});
  call(services, ['initWindow', 'baseInit'], 'XWindow::Init', {
    object: target, window: target, parent, native: COMPUTER_WINDOW_NATIVE_ADDRESSES.baseInit,
  });
  const root = call(services, ['getRootWindow', 'rootWindow'], 'XWindow::GetRootWindow', {
    object: target, window: target, native: COMPUTER_WINDOW_NATIVE_ADDRESSES.getRootWindow,
  });
  const O = COMPUTER_WINDOW_OFFSETS;
  if (present(root)) {
    const player = call(services, ['getPlayerPawn', 'playerPawn'], 'XWindow::GetPlayerPawn', {
      object: root, root, native: COMPUTER_WINDOW_NATIVE_ADDRESSES.getPlayerPawn,
    });
    rawWrite(target, O.player, 'ptr', player ?? 0, services, 'XComputerWindow::Init',
      COMPUTER_WINDOW_NATIVE_ADDRESSES.init);
  }
  const player = rawRead(target, O.player, 'ptr', services, 'XComputerWindow::Init',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.init);
  if (present(player)) {
    const viewportName = call(services, ['readPlayerViewportName', 'playerViewportName'],
      'Player viewport name', {player, native: COMPUTER_WINDOW_NATIVE_ADDRESSES.init});
    let comparison;
    if (typeof services.appStricmp === 'function' || typeof services.compareStrings === 'function') {
      comparison = call(services, ['appStricmp', 'compareStrings'], 'appStricmp', {
        left: viewportName, right: '', player, native: COMPUTER_WINDOW_NATIVE_ADDRESSES.appStricmpIat,
      });
      if (!Number.isInteger(comparison)) fail('appStricmp returned a non-integer result', {
        kind: 'VALUE', operation: 'appStricmp', value: comparison,
      });
    } else if (typeof viewportName === 'string') {
      // The right operand is the empty NAME_None FString.  The comparison is
      // therefore zero exactly for an empty source, independent of folding.
      comparison = viewportName.length === 0 ? 0 : 1;
    } else {
      fail('XComputerWindow::Init requires appStricmp or a resolved viewport name string', {
        kind: 'SERVICE', operation: 'appStricmp', value: viewportName,
      });
    }
    if (comparison !== 0) {
      const flags = rawRead(target, O.inputFlags, 'u32', services, 'XComputerWindow::Init',
        COMPUTER_WINDOW_NATIVE_ADDRESSES.init);
      rawWrite(target, O.inputFlags, 'u32', flags | COMPUTER_WINDOW_BITS.ignoreGamePaused,
        services, 'XComputerWindow::Init', COMPUTER_WINDOW_NATIVE_ADDRESSES.init);
    }
  }

  const textWindow = call(services, ['createNewWindow', 'createWindow'], 'TextWindow CreateNewWindow', {
    classObject: COMPUTER_WINDOW_NATIVE_ADDRESSES.textWindowClass,
    classPointer: COMPUTER_WINDOW_NATIVE_ADDRESSES.textWindowClass,
    parent: target, bShow: true, show: true, native: COMPUTER_WINDOW_NATIVE_ADDRESSES.createNewWindow,
  });
  rawWrite(target, O.textWindow, 'ptr', textWindow ?? 0, services, 'XComputerWindow::Init',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.init);
  const font = rawRead(target, O.textFont, 'ptr', services, 'XComputerWindow::Init',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.init);
  if (present(font) && present(textWindow)) resizeForText(target, services, 'XComputerWindow::Init');
  if (!present(textWindow)) fail('XComputerWindow::Init TextWindow CreateNewWindow returned null', {
    kind: 'BOUNDARY', operation: 'TextWindow CreateNewWindow', value: textWindow,
  });
  call(services, ['setWindowAlignments', 'setAlignments'], 'TextWindow SetWindowAlignments', {
    object: textWindow, window: textWindow, alignments: [3, 3, 0, 0, 0, 0],
    horizontal: 3, vertical: 3, left: 0, right: 0, top: 0, bottom: 0,
    native: COMPUTER_WINDOW_NATIVE_ADDRESSES.setWindowAlignments,
  });
  const inputWindow = call(services, ['createNewWindow', 'createWindow'], 'InputWindow CreateNewWindow', {
    classObject: COMPUTER_WINDOW_NATIVE_ADDRESSES.inputWindowClass,
    classPointer: COMPUTER_WINDOW_NATIVE_ADDRESSES.inputWindowClass,
    parent: target, bShow: false, show: false, native: COMPUTER_WINDOW_NATIVE_ADDRESSES.createNewWindow,
  });
  rawWrite(target, O.inputWindow, 'ptr', inputWindow ?? 0, services, 'XComputerWindow::Init',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.init);
  if (!present(inputWindow)) fail('XComputerWindow::Init input CreateNewWindow returned null', {
    kind: 'BOUNDARY', operation: 'InputWindow CreateNewWindow', value: inputWindow,
  });
  call(services, ['setTextMargins', 'inputSetTextMargins'], 'InputWindow SetTextMargins', {
    object: inputWindow, window: inputWindow, horizontal: 0, vertical: 0,
    native: COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextMargins,
  });
  const blink = rawRead(target, O.cursorBlinkSpeed, 'f32', services, 'XComputerWindow::Init',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.init);
  call(services, ['setInsertionPointBlinkRate', 'inputSetInsertionPointBlinkRate'],
    'InputWindow SetInsertionPointBlinkRate', {
      object: inputWindow, window: inputWindow, rate: Math.fround(blink + blink), value: Math.fround(blink + blink),
      flags: 0, native: COMPUTER_WINDOW_NATIVE_ADDRESSES.setInsertionPointBlinkRate,
    });
  call(services, ['setSelectability', 'selectability'], 'XComputerWindow SetSelectability', {
    object: target, window: target, selectable: true, value: 1,
    native: COMPUTER_WINDOW_NATIVE_ADDRESSES.setSelectability,
  });
  return object;
}

/** XComputerWindow::SetTextSize. */
export function setComputerTextSizeNative(object, newCols, newRows, services = {}) {
  const target = objectReference(object, 'XComputerWindow');
  const cols = int32(newCols, 'newCols'), rows = int32(newRows, 'newRows'), O = COMPUTER_WINDOW_OFFSETS;
  const font = rawRead(target, O.textFont, 'ptr', services, 'XComputerWindow::SetTextSize',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextSize);
  rawWrite(target, O.textCols, 'i32', cols, services, 'XComputerWindow::SetTextSize',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextSize);
  rawWrite(target, O.textRows, 'i32', rows, services, 'XComputerWindow::SetTextSize',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextSize);
  const textWindow = present(font) ? rawRead(target, O.textWindow, 'ptr', services, 'XComputerWindow::SetTextSize',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextSize) : 0;
  if (present(font) && present(textWindow)) resizeForText(target, services, 'XComputerWindow::SetTextSize');
  return object;
}

/** XComputerWindow::SetTextFont, including its type-1 queued event. */
export function setComputerTextFontNative(object, newFont, newFontWidth, newFontHeight,
  newFontColor, services = {}) {
  const target = objectReference(object, 'XComputerWindow');
  const font = objectReference(newFont, 'font', {nullable: true});
  const width = int32(newFontWidth, 'newFontWidth'), height = int32(newFontHeight, 'newFontHeight');
  const color = colorWord(newFontColor), O = COMPUTER_WINDOW_OFFSETS;
  rawWrite(target, O.fontWidth, 'i32', width, services, 'XComputerWindow::SetTextFont',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextFont);
  rawWrite(target, O.textFont, 'ptr', font ?? 0, services, 'XComputerWindow::SetTextFont',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextFont);
  rawWrite(target, O.fontHeight, 'i32', height, services, 'XComputerWindow::SetTextFont',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextFont);
  const next = rawRead(target, O.timeNextEvent, 'f32', services, 'XComputerWindow::SetTextFont',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextFont);
  addQueuedEvent(target, {
    type: 1, time: next, color, colorWord: color,
    fields: {type: 1, time: next, color, colorWord: color},
  }, services, 'setTextFont');
  const current = rawRead(target, O.timeCurrent, 'f32', services, 'XComputerWindow::SetTextFont',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextFont);
  rawWrite(target, O.timeLastEvent, 'f32', current, services, 'XComputerWindow::SetTextFont',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextFont);
  if (present(font) && present(rawRead(target, O.textWindow, 'ptr', services, 'XComputerWindow::SetTextFont',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextFont))) resizeForText(target, services, 'XComputerWindow::SetTextFont');
  return object;
}

/** XComputerWindow::SetTextTiming. */
export function setComputerTextTimingNative(object, newTiming, services = {}) {
  const target = objectReference(object, 'XComputerWindow');
  rawWrite(target, COMPUTER_WINDOW_OFFSETS.eventTimeInterval, 'f32', scalar(newTiming, 'newTiming'), services,
    'XComputerWindow::SetTextTiming', COMPUTER_WINDOW_NATIVE_ADDRESSES.setTextTiming);
  return object;
}

/** XComputerWindow::SetFadeSpeed. */
export function setComputerFadeSpeedNative(object, fadeSpeed, services = {}) {
  const target = objectReference(object, 'XComputerWindow');
  rawWrite(target, COMPUTER_WINDOW_OFFSETS.fadeSpeed, 'f32', scalar(fadeSpeed, 'fadeSpeed'), services,
    'XComputerWindow::SetFadeSpeed', COMPUTER_WINDOW_NATIVE_ADDRESSES.setFadeSpeed);
  return object;
}

/** XComputerWindow::SetCursorColor. */
export function setComputerCursorColorNative(object, newCursorColor, services = {}) {
  const target = objectReference(object, 'XComputerWindow');
  rawWrite(target, COMPUTER_WINDOW_OFFSETS.cursorColor, 'u32', colorWord(newCursorColor), services,
    'XComputerWindow::SetCursorColor', COMPUTER_WINDOW_NATIVE_ADDRESSES.setCursorColor);
  return object;
}

/** XComputerWindow::ShowTextCursor changes cursorFlags bit 1. */
export function showComputerTextCursorNative(object, show, services = {}) {
  const target = objectReference(object, 'XComputerWindow'), O = COMPUTER_WINDOW_OFFSETS;
  const value = boolWord(show, 'bShow'), old = rawRead(target, O.cursorFlags, 'u32', services,
    'XComputerWindow::ShowTextCursor', COMPUTER_WINDOW_NATIVE_ADDRESSES.showTextCursor);
  rawWrite(target, O.cursorFlags, 'u32', ((old & ~2) | (value << 1)) >>> 0, services,
    'XComputerWindow::ShowTextCursor', COMPUTER_WINDOW_NATIVE_ADDRESSES.showTextCursor);
  return object;
}

/** XComputerWindow::EnableWordWrap changes flags bit 0. */
export function enableComputerWordWrapNative(object, enabled, services = {}) {
  const target = objectReference(object, 'XComputerWindow'), O = COMPUTER_WINDOW_OFFSETS;
  const value = boolWord(enabled, 'bNewWordWrap'), old = rawRead(target, O.flags, 'u32', services,
    'XComputerWindow::EnableWordWrap', COMPUTER_WINDOW_NATIVE_ADDRESSES.enableWordWrap);
  rawWrite(target, O.flags, 'u32', ((old & ~1) | value) >>> 0, services,
    'XComputerWindow::EnableWordWrap', COMPUTER_WINDOW_NATIVE_ADDRESSES.enableWordWrap);
  return object;
}

/** XComputerWindow::ClearScreen. */
export function clearComputerScreenNative(object, services = {}) {
  const target = objectReference(object, 'XComputerWindow'), O = COMPUTER_WINDOW_OFFSETS;
  const flags = rawRead(target, O.inputFlags, 'u32', services, 'XComputerWindow::ClearScreen',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.clearScreen);
  rawWrite(target, O.inputFlags, 'u32', (flags & ~COMPUTER_WINDOW_BITS.waitingForKey) >>> 0, services,
    'XComputerWindow::ClearScreen', COMPUTER_WINDOW_NATIVE_ADDRESSES.clearScreen);
  call(services, ['arrayRealloc', 'reallocateArray', 'displayBufferRealloc'], 'displayBuffer FArray::Realloc', {
    object: target, window: target, array: 'displayBuffer', arrayOffset: O.displayBuffer,
    elementSize: 0x20, num: 0, max: 0, native: COMPUTER_WINDOW_NATIVE_ADDRESSES.reallocIat,
  });
  rawWrite(target, O.textX, 'u32', 0, services, 'XComputerWindow::ClearScreen',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.clearScreen);
  rawWrite(target, O.textY, 'u32', 0, services, 'XComputerWindow::ClearScreen',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.clearScreen);
  return object;
}

/** XComputerWindow::Print. bNewLine is accepted for signature fidelity but unused by the body. */
export function printComputerTextNative(object, printText, bNewLine = false, services = {}) {
  const target = objectReference(object, 'XComputerWindow');
  if (typeof printText !== 'string') fail('ComputerWindow.Print requires an initialized string', {
    kind: 'VALUE', operation: 'printText', value: printText,
  });
  // The native body never reads bNewLine. Keep the parameter in the exported
  // API so a caller cannot accidentally shift the service argument.
  void bNewLine;
  const O = COMPUTER_WINDOW_OFFSETS;
  const flags = rawRead(target, O.inputFlags, 'u32', services, 'XComputerWindow::Print',
    COMPUTER_WINDOW_NATIVE_ADDRESSES.print);
  rawWrite(target, O.inputFlags, 'u32', (flags & ~COMPUTER_WINDOW_BITS.waitingForKey) >>> 0, services,
    'XComputerWindow::Print', COMPUTER_WINDOW_NATIVE_ADDRESSES.print);
  for (let index = 0; index < printText.length; index += 1) {
    const character = printText.charCodeAt(index);
    const next = rawRead(target, O.timeNextEvent, 'f32', services, 'XComputerWindow::Print',
      COMPUTER_WINDOW_NATIVE_ADDRESSES.print);
    const event = {
      type: character === 0x5e ? 4 : 0,
      time: next,
      charCode: character,
      character,
      param0: 0xffffffff,
      param1: 0xffffffff,
      flags: 0,
      fields: {
        type: character === 0x5e ? 4 : 0, time: next, charCode: character,
        param0: 0xffffffff, param1: 0xffffffff, flags: 0,
      },
    };
    addQueuedEvent(target, event, services, 'print');
    const current = rawRead(target, O.timeCurrent, 'f32', services, 'XComputerWindow::Print',
      COMPUTER_WINDOW_NATIVE_ADDRESSES.print);
    rawWrite(target, O.timeLastEvent, 'f32', current, services, 'XComputerWindow::Print',
      COMPUTER_WINDOW_NATIVE_ADDRESSES.print);
    const interval = rawRead(target, O.eventTimeInterval, 'f32', services, 'XComputerWindow::Print',
      COMPUTER_WINDOW_NATIVE_ADDRESSES.print);
    rawWrite(target, O.timeNextEvent, 'f32', Math.fround(next + interval), services,
      'XComputerWindow::Print', COMPUTER_WINDOW_NATIVE_ADDRESSES.print);
  }
  return object;
}

// Short aliases mirror the names used by the neighboring window modules.
export const initializeComputerWindowNative = initComputerWindowNative;
export const setTextSizeComputerWindowNative = setComputerTextSizeNative;
export const setTextFontComputerWindowNative = setComputerTextFontNative;
export const setTextTimingComputerWindowNative = setComputerTextTimingNative;
export const setFadeSpeedComputerWindowNative = setComputerFadeSpeedNative;
export const setCursorColorComputerWindowNative = setComputerCursorColorNative;
export const showTextCursorComputerWindowNative = showComputerTextCursorNative;
export const clearScreenComputerWindowNative = clearComputerScreenNative;
export const printComputerWindowNative = printComputerTextNative;
export const enableWordWrapComputerWindowNative = enableComputerWordWrapNative;
