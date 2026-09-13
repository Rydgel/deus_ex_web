/**
 * Translate the three default constructors exported by Extension.dll.
 *
 * The caller owns allocation, object registration, class selection, template
 * copying, and the Core UObject base constructor.  These adapters receive an
 * already allocated object and expose the native stores through numeric byte
 * offsets.  They intentionally do not assign reflected/script property names
 * and XWindow construction does not enter XWindow::Init.
 *
 * Evidence: the hash-checked Extension.dll constructors at 0x10002780
 * (XExtensionObject), 0x10003130 (XWindow), and 0x10026ad0 (XGC), with their
 * InternalConstructor thunks at 0x10002770, 0x10003120, and 0x10002ce0.
 * See docs/script-window-construction.md.
 */

const freeze = value => Object.freeze(value);

const EXTENSION_DLL_SHA256 =
  '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c';

function u32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new TypeError(`Window constructor requires uint32 ${label}`);
  }
  return value >>> 0;
}

function targetObject(value, label) {
  if (typeof value === 'number') {
    const pointer = u32(value, `${label} pointer`);
    if (pointer === 0) throw new TypeError(`Window constructor requires allocated ${label}`);
    return pointer;
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError(`Window constructor requires allocated ${label}`);
  }
  return value;
}

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    throw new Error(`Window constructor ${label} service suspended; native path is synchronous`);
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'function') throw new Error(`Window constructor requires ${name} service`);
  return value;
}

function coreConstructor(services) {
  return required(
    services.coreObjectConstructor ?? services.constructCoreObject ??
      services.constructUObject ?? services.uobjectConstructor,
    'Core UObject constructor',
  );
}

function notify(services, event) {
  if (typeof services.onEvent === 'function') sync(services.onEvent(event), event.op);
}

function callCore(object, record, services) {
  const details = {
    object,
    className: record.nativeClass,
    native: WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.coreObjectConstructorIat,
    constructorIat: WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.coreObjectConstructorIat,
    constructorThunk: WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.coreObjectConstructorThunk,
    constructorBody: WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.coreObjectConstructorBody,
    classConstructor: record.internalConstructor,
  };
  notify(services, {op: 'CoreUObjectConstructor', ...details});
  return sync(coreConstructor(services)(details), 'Core UObject constructor');
}

function readRaw(object, offset, services, {native, phase}) {
  const value = sync(required(services.read, 'raw read')(
    object, offset, 'u32', {native, phase, offset, kind: 'u32', width: 4}),
  `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    throw new Error(`Window constructor reached unresolved raw field +0x${offset.toString(16)}`);
  }
  return u32(value, `raw field +0x${offset.toString(16)}`);
}

function writeRaw(object, offset, kind, value, services, {native, phase, source} = {}) {
  const width = kind === 'u8' ? 1 : kind === 'u32' ? 4 : 0;
  if (!width) throw new Error(`Window constructor does not support raw write kind ${kind}`);
  let normalized;
  if (kind === 'u8') {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new TypeError(`Window constructor requires uint8 at +0x${offset.toString(16)}`);
    }
    normalized = value;
  } else {
    normalized = u32(value, `raw dword +0x${offset.toString(16)}`);
  }
  return sync(required(services.write, 'raw write')(
    object, offset, kind, normalized,
    {native, phase, offset, kind, width, value: normalized, source}),
  `write +0x${offset.toString(16)}`);
}

const EXTENSION_OBJECT = freeze({
  scriptClass: 'ExtensionObject',
  nativeClass: 'XExtensionObject',
  packageExport: 18,
  exportFlags: 0x040f0004,
  serializedClassFlags: 0x112,
  super: 'Core.Object',
  internalConstructor: 0x10002770,
  body: 0x10002780,
  vtable: 0x10059888,
  minimumObjectSize: 0x28,
  nativeObjectSize: 0x28,
  registrationSizeImmediate: 0x100378ec,
});

const WINDOW = freeze({
  scriptClass: 'Window',
  nativeClass: 'XWindow',
  packageExport: 1,
  exportFlags: 0x040f0004,
  serializedClassFlags: 0x112,
  super: 'Extension.ExtensionObject',
  internalConstructor: 0x10003120,
  body: 0x10003130,
  vtable: 0x10059930,
  minimumObjectSize: 0xf0,
  nativeObjectSize: 0x14c,
  registrationSizeImmediate: 0x1004ba80,
  initVtableSlot: 0x54,
  init: 0x1004bb30,
});

const GC = freeze({
  scriptClass: 'GC',
  nativeClass: 'XGC',
  packageExport: 14,
  exportFlags: 0x040f0004,
  serializedClassFlags: 0x112,
  super: 'Extension.ExtensionObject',
  internalConstructor: 0x10002ce0,
  body: 0x10026ad0,
  vtable: 0x100598dc,
  minimumObjectSize: 0xb8,
  nativeObjectSize: 0xb8,
  registrationSizeImmediate: 0x10026770,
  enableTranslucentText: 0x10027610,
});

export const WINDOW_CONSTRUCTION_NATIVE_ADDRESSES = freeze({
  coreObjectConstructorIat: 0x1005907c,
  coreObjectConstructorThunk: 0x101021c6,
  coreObjectConstructorBody: 0x1014f340,
  extensionObjectInternal: EXTENSION_OBJECT.internalConstructor,
  extensionObjectConstructor: EXTENSION_OBJECT.body,
  extensionObjectVtable: EXTENSION_OBJECT.vtable,
  windowInternal: WINDOW.internalConstructor,
  windowConstructor: WINDOW.body,
  windowVtable: WINDOW.vtable,
  windowInitVtableSlotAddress: WINDOW.vtable + WINDOW.initVtableSlot,
  windowInit: WINDOW.init,
  gcInternal: GC.internalConstructor,
  gcConstructor: GC.body,
  gcVtable: GC.vtable,
  gcSetFonts: 0x10027640,
  enableTranslucentText: GC.enableTranslucentText,
  windowInitVtableSlot: WINDOW.initVtableSlot,
});

export const WINDOW_CONSTRUCTION_OFFSETS = freeze({
  nativeVtable: 0,
  windowZeroDwords: freeze([0xd4, 0xd8, 0xdc, 0xe0, 0xe4, 0xe8]),
  gcClipZeroDwords: freeze([0x2c, 0x30, 0x34, 0x38, 0x3c, 0x40]),
  gcCanvas: 0x28,
  gcStyleByte: 0x44,
  gcPackedFlags: 0x48,
  gcPolyFlags: 0x4c,
  gcTextPolyFlags: 0x50,
  gcTileColor: 0x54,
  gcTilePlane: 0x58,
  gcTextColor: 0x68,
  gcTextPlane: 0x6c,
  gcNormalFont: 0x7c,
  gcBoldFont: 0x80,
  gcUnderlineHeight: 0x88,
  gcBaselineOffset: 0x8c,
  gcTextVSpacing: 0x90,
  gcHorizontalAlign: 0x94,
  gcVerticalAlign: 0x95,
  gcWordWrapParse: 0x98,
  gcHorizontalMultiplier: 0x9c,
  gcVerticalMultiplier: 0xa0,
  gcFree: 0xa4,
  gcCount: 0xa8,
  gcStack: 0xac,
  gcFreeStack: 0xb0,
  gcOwner: 0xb4,
});

export const WINDOW_CONSTRUCTION_NATIVE = freeze({
  package: 'Extension',
  dll: 'Extension.dll',
  dllSha256: EXTENSION_DLL_SHA256,
  imageBase: 0x10000000,
  classes: freeze({extensionObject: EXTENSION_OBJECT, window: WINDOW, gc: GC}),
  addresses: WINDOW_CONSTRUCTION_NATIVE_ADDRESSES,
  offsets: WINDOW_CONSTRUCTION_OFFSETS,
});

// Both names are kept because callers describe this evidence as either the
// native construction record or the window-construction record.
export const WINDOW_NATIVE_CONSTRUCTION = WINDOW_CONSTRUCTION_NATIVE;

export const WINDOW_CONSTRUCTION_NATIVE_CONTRACT = freeze({
  name: 'Extension default constructors',
  rawStorage: 'read(target, byteOffset, type, details) / write(target, byteOffset, type, value, details)',
  allocation: 'caller supplied; StaticAllocateObject/Core registry are outside this module',
  baseConstructor: 'caller supplied Core UObject constructor service',
  constructors: freeze([
    'XExtensionObject::XExtensionObject',
    'XWindow::XWindow',
    'XGC::XGC',
  ]),
  xwindowInit: freeze({vtableSlot: 0x54, address: 0x1004bb30, calledByConstructor: false}),
  xgcPreservation: freeze([
    'dword +0x48 low-byte mask preserves its upper three bytes and untouched flag bits',
    'packed dword +0x54 retains the high byte of the this pointer',
    'packed dword +0x68 retains the high byte of the this pointer',
    'dword +0x98 ORs 0x3 and dword +0xa4 clears bit 0 only',
    'unwritten bytes and slots remain caller-owned',
  ]),
});

export const WINDOW_NATIVE_CONSTRUCTION_CONTRACT = WINDOW_CONSTRUCTION_NATIVE_CONTRACT;

function constructExtensionObjectNative(object, services = {}) {
  const target = targetObject(object, 'XExtensionObject');
  callCore(target, EXTENSION_OBJECT, services);
  writeRaw(target, 0, 'u32', EXTENSION_OBJECT.vtable, services, {
    native: EXTENSION_OBJECT.body, phase: 'XExtensionObject::XExtensionObject', source: 'vtable',
  });
  return object;
}

function constructWindowNative(object, services = {}) {
  const target = targetObject(object, 'XWindow');
  callCore(target, WINDOW, services);
  for (const offset of WINDOW_CONSTRUCTION_OFFSETS.windowZeroDwords) {
    writeRaw(target, offset, 'u32', 0, services, {
      native: WINDOW.body, phase: 'XWindow::XWindow', source: 'zero-window-clip',
    });
  }
  writeRaw(target, 0, 'u32', WINDOW.vtable, services, {
    native: WINDOW.body, phase: 'XWindow::XWindow', source: 'vtable',
  });
  return object;
}

function pointerTail(object, services) {
  const explicit = services.nativeAddress ?? services.pointerWord ?? services.address;
  const candidate = explicit ?? (typeof object === 'number' ? object : object.nativeAddress);
  if (candidate === undefined) {
    throw new Error('XGC constructor requires explicit nativeAddress to preserve packed color bytes');
  }
  return u32(candidate, 'XGC nativeAddress') >>> 24;
}

function constructWindowGcNative(object, services = {}) {
  const target = targetObject(object, 'XGC');
  callCore(target, GC, services);

  for (const offset of WINDOW_CONSTRUCTION_OFFSETS.gcClipZeroDwords) {
    writeRaw(target, offset, 'u32', 0, services, {
      native: GC.body, phase: 'XGC::XGC', source: 'zero-gc-clip',
    });
  }

  // The body reads +0x48 before replacing the vtable and then calls
  // EnableTranslucentText(0), which reads the post-mask value again.
  const oldPackedFlags = readRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcPackedFlags, services, {
    native: GC.body, phase: 'XGC::XGC',
  });
  writeRaw(target, 0, 'u32', GC.vtable, services, {
    native: GC.body, phase: 'XGC::XGC', source: 'vtable',
  });
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcCanvas, 'u32', 0, services, {
    native: GC.body, phase: 'XGC::XGC', source: 'canvas',
  });
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcStyleByte, 'u8', 1, services, {
    native: GC.body, phase: 'XGC::XGC', source: 'style',
  });
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcPackedFlags, 'u32',
    ((oldPackedFlags & 0xffffff00) | ((oldPackedFlags & 0xff & 0xe2) | 2)) >>> 0,
  services, {native: GC.body, phase: 'XGC::XGC', source: 'packed-flags'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcPolyFlags, 'u32', 0x900, services, {
    native: GC.body, phase: 'XGC::XGC', source: 'poly-flags',
  });

  notify(services, {
    op: 'EnableTranslucentText', object: target, value: 0,
    native: WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.enableTranslucentText,
  });
  const enabledFlags = readRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcPackedFlags, services, {
    native: GC.enableTranslucentText, phase: 'XGC::EnableTranslucentText',
  });
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcPackedFlags, 'u32', (enabledFlags & ~0x20) >>> 0,
    services, {native: GC.enableTranslucentText, phase: 'XGC::EnableTranslucentText', source: 'text-translucency'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTextPolyFlags, 'u32', 0x802, services, {
    native: GC.enableTranslucentText, phase: 'XGC::EnableTranslucentText', source: 'text-poly-flags',
  });

  const tail = pointerTail(object, services);
  const one = 0x3f800000;
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTileColor, 'u32', ((tail << 24) | 0x00ffffff) >>> 0,
    services, {native: GC.body, phase: 'XGC::XGC', source: 'tile-color'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTilePlane, 'u32', one, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'tile-plane-x'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTilePlane + 4, 'u32', one, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'tile-plane-y'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTilePlane + 8, 'u32', one, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'tile-plane-z'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTextPlane, 'u32', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'text-plane-x'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTilePlane + 0xc, 'u32', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'tile-plane-w'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTextColor, 'u32', ((tail << 24) | 0x0000ff00) >>> 0,
    services, {native: GC.body, phase: 'XGC::XGC', source: 'text-color'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTextPlane + 4, 'u32', one, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'text-plane-y'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTextPlane + 8, 'u32', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'text-plane-z'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcNormalFont, 'u32', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'normal-font'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTextPlane + 0xc, 'u32', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'text-plane-w'});

  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcUnderlineHeight, 'u32', one, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'underline-height'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcTextVSpacing, 'u32', one, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'text-v-spacing'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcBoldFont, 'u32', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'bold-font'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcBaselineOffset, 'u32', 0x40000000, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'baseline-offset'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcHorizontalAlign, 'u8', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'horizontal-align'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcVerticalAlign, 'u8', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'vertical-align'});

  const oldWordWrap = readRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcWordWrapParse, services, {
    native: GC.body, phase: 'XGC::XGC',
  });
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcWordWrapParse, 'u32', (oldWordWrap | 3) >>> 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'word-wrap-parse'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcHorizontalMultiplier, 'u32', 1, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'horizontal-multiplier'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcVerticalMultiplier, 'u32', 1, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'vertical-multiplier'});
  const oldFree = readRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcFree, services, {
    native: GC.body, phase: 'XGC::XGC',
  });
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcFree, 'u32', (oldFree & ~1) >>> 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'free-flag'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcCount, 'u32', 1, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'gc-count'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcStack, 'u32', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'gc-stack'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcFreeStack, 'u32', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'gc-free-stack'});
  writeRaw(target, WINDOW_CONSTRUCTION_OFFSETS.gcOwner, 'u32', 0, services,
    {native: GC.body, phase: 'XGC::XGC', source: 'gc-owner'});
  return object;
}

/** XGC::SetFonts, Extension.dll 0x10027640: two ordered pointer stores. */
export function setWindowGcFontsNative({graphicsContext, normalFont, boldFont}, services = {}) {
  const target = targetObject(graphicsContext, 'graphics context');
  const write = required(services.write, 'raw write');
  for (const [offset, value] of [[0x7c, normalFont], [0x80, boldFont]]) {
    if (value !== null && value !== 0) targetObject(value, 'font');
    sync(write(target, offset, 'ptr', value, {
      native: WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.gcSetFonts,
      phase: 'XGC::SetFonts', offset, kind: 'ptr', width: 4,
    }), `write +0x${offset.toString(16)}`);
  }
}

export {
  constructExtensionObjectNative,
  constructWindowNative,
  constructWindowGcNative,
  constructExtensionObjectNative as constructXExtensionObjectNative,
  constructWindowNative as constructXWindowNative,
  constructWindowGcNative as constructGcNative,
  constructWindowGcNative as constructGCNative,
  constructWindowGcNative as constructXGCNative,
  constructExtensionObjectNative as constructXExtensionObject,
  constructWindowNative as constructXWindow,
  constructWindowGcNative as constructXGC,
};
