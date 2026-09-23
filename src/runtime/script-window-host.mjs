/**
 * Play window host: the Extension window manager of one DeusExPlayer.
 *
 * Replaces the InfoLink-only shell allocation with the original tree:
 * APlayerPawnExt::ConstructRootWindow (StaticLoadClass("ini:Engine.Engine.Root")
 * -> StaticConstructObject -> XRootWindow::Init(pawn) -> InitWindow ->
 * SetVisibility(1)) and every window the installed DeusExRootWindow /
 * DeusExHUD bytecode creates through Window.NewChild. Windows are admitted by
 * their native Extension class family (the first native window class in the
 * class chain), never by script class name; a family whose constructor/Init
 * has not been recovered is an explicit boundary error.
 *
 * Storage: one byte-addressed heap (script-native-heap.mjs) holds every
 * window, GC, canvas, texture and font image, so window natives, GC natives
 * and UFont natives share the address space the original bodies assume.
 * Script fields declared by native window classes are bound to their native
 * offsets (script-window-native-layout.mjs), so `bTickEnabled = True`, reads
 * of `width`, etc. reach the same bytes as the natives.
 *
 * Evidence and remaining boundaries: docs/script-window-host.md.
 */
import {createNativeHeap} from './script-native-heap.mjs';
import {nativeWindowLayout, NATIVE_WINDOW_CLASS_SIZES} from './script-window-native-layout.mjs';
import * as T from './script-window-tree-natives.mjs';
import * as F from './script-window-families.mjs';
import {constructWindowNative, constructWindowGcNative, setWindowGcFontsNative} from './script-window-construction.mjs';
import {initWindowNative} from './script-window-init.mjs';
import {addWindowChildNative, removeWindowChildNative} from './script-window-hierarchy.mjs';
import {initTextWindowNative, WINDOW_TEXT_OFFSETS} from './script-window-text.mjs';
import {constructTileWindow, initTileWindow} from './script-window-tile.mjs';
import {constructComputerWindowNative, initComputerWindowNative} from './script-window-computer.mjs';
import {askParentForReconfigureNative, WINDOW_RECONFIGURE_GLOBALS} from './script-window-reconfigure.mjs';
import {configureChildNative, WINDOW_CONFIGURE_CHILD_GLOBALS} from './script-window-configure-child.mjs';
import {boundsUpdateNative} from './script-window-bounds-update.mjs';
import {setVisibilityNative, setChildVisibilityNative} from './script-window-visibility.mjs';
import {updatePolyFlagsFromFlags, gcMemory, GC} from './script-gc-state-model.mjs';
import {decodeFontExport, writeFontImage, UFONT, FONT_PAGE} from './script-font-model.mjs';
import {readObject} from '../unreal/objects.mjs';
import {readTexture} from '../unreal/textures.mjs';
import {refValue} from './script-vm.mjs';

const f = Math.fround;
const lower = value => String(value).toLowerCase();
const NATIVE_WINDOW_KEYS = new Set(Object.keys(NATIVE_WINDOW_CLASS_SIZES));

/** Native class families admitted by the host, keyed by Extension class key. */
const FAMILIES = Object.freeze({
  'extension.window': {vtable: F.VTABLES.window},
  'extension.textwindow': {vtable: F.VTABLES.textwindow},
  'extension.buttonwindow': {vtable: F.VTABLES.buttonwindow},
  'extension.togglewindow': {vtable: F.VTABLES.togglewindow},
  'extension.tilewindow': {vtable: F.VTABLES.tilewindow},
  'extension.tabgroupwindow': {vtable: F.VTABLES.tabgroupwindow},
  'extension.radioboxwindow': {vtable: F.VTABLES.radioboxwindow},
  'extension.textlogwindow': {vtable: F.VTABLES.textlogwindow},
  'extension.modalwindow': {vtable: F.VTABLES.modalwindow},
  'extension.rootwindow': {vtable: F.VTABLES.rootwindow},
  'extension.computerwindow': {vtable: F.VTABLES.computerwindow},
  'extension.editwindow': {vtable: 0x1005b50c},
});

export class WindowHostBoundaryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WindowHostBoundaryError';
    this.code = 'WINDOW_HOST_BOUNDARY';
    Object.assign(this, details);
  }
}
const boundary = (message, details) => { throw new WindowHostBoundaryError(message, details); };

/** Find the native Extension window class of a linked runtime class. */
export function nativeWindowFamily(cls) {
  for (let node = cls; node; node = node.base) if (NATIVE_WINDOW_KEYS.has(node.record.key)) return node.record.key;
  return null;
}

/** Classes whose every function/state the HUD tree may reach. */
const HUD_CLASS_PATHS = Object.freeze([
  ['Extension', ['window', 'textwindow', 'buttonwindow', 'togglewindow', 'tilewindow', 'tabgroupwindow',
    'radioboxwindow', 'textlogwindow', 'modalwindow', 'rootwindow', 'computerwindow', 'gc', 'extensionobject']],
  ['DeusEx', ['deusexrootwindow', 'deusexhud', 'hudbasewindow', 'hudsharedborderwindow', 'hudammodisplay',
    'hudhitdisplay', 'crosshair', 'hudobjectbelt', 'hudobjectslot', 'hudactiveitemsdisplay',
    'hudactiveitemsborderbase', 'hudactiveaugsborder', 'hudactiveitemsborder', 'hudactiveitembase',
    'hudactiveaug', 'hudactiveitem', 'damagehuddisplay', 'hudcompassdisplay', 'hudmultiskills',
    'hudinformationdisplay', 'hudlogdisplay', 'frobdisplaywindow', 'augmentationdisplaywindow',
    'hudmissionstarttextdisplay', 'hudbarkdisplay', 'hudreceiveddisplay', 'actordisplaywindow',
    'deusexscopeview', 'progressbarwindow', 'hudinfolinkdisplay', 'hudconwindowfirst', 'staticwindow',
    'colorthememanager', 'colortheme']],
]);

export async function createWindowHost({runtime, assets, player, gameConfig = null}) {
  if (!runtime?.attach || !assets?.get) throw new TypeError('Window host requires ScriptRuntime and AssetStore');
  const packages = new Map();
  for (const name of ['Core', 'Engine', 'Extension', 'DeusEx', 'DeusExUI', 'ConSys']) packages.set(name, await assets.get(name));
  const extension = packages.get('Extension'), deusEx = packages.get('DeusEx');
  const loadClass = (asset, path) => {
    const index = asset.exportsByPath.get(lower(path));
    if (!index) throw new Error(`Window host is missing original class ${asset.name}.${path}`);
    return runtime.loadClass(asset, index);
  };
  // Link the classes and prepare every function/state of the HUD call graph.
  const classes = new Map();
  for (const [pkg, paths] of HUD_CLASS_PATHS) {
    const asset = packages.get(pkg);
    for (const path of paths) {
      const cls = await loadClass(asset, path);
      classes.set(cls.record.key, cls);
    }
    const prefixes = paths.map(path => `${path}.`);
    for (const [path, index] of asset.exportsByPath) {
      if (!prefixes.some(prefix => path.startsWith(prefix))) continue;
      const kind = asset.pkg.exports[index - 1].className;
      if (kind === 'Function') await runtime.prepareFunction(asset, index);
      else if (kind === 'State') await runtime.prepareState(asset, index);
    }
  }
  // Every ColorTheme subclass reachable through the theme manager.
  for (const [path, index] of deusEx.exportsByPath) {
    if (!path.startsWith('colortheme') || path.includes('.')) continue;
    if (deusEx.pkg.exports[index - 1].className !== 'Class') continue;
    classes.set(`deusex.${path}`, await runtime.loadClass(deusEx, index));
  }
  const gcClass = classes.get('extension.gc');

  // ------------------------------------------------------------------
  // Native heap with resource images for textures and fonts.
  // ------------------------------------------------------------------
  const resourceImages = new Map();      // heap address -> {kind, ref, ...}
  const textureInfo = new Map();          // texture ref -> {address, width, height}
  const heap = createNativeHeap({external: (value, api) => materialize(value, api)});
  const vtableFor = new Map();
  const textureVtable = (() => { const vt = heap.allocRaw(0x80); heap.mem.write(vt + 0x54, 'u32', 1); heap.mem.write(vt + 0x58, 'u32', 2); return vt; })();
  function textureImage(asset, index, ref) {
    const decoded = readTexture(asset, index);
    const mip = decoded.mips[0];
    const address = heap.allocRaw(0x60);
    heap.mem.write(address, 'u32', textureVtable);
    heap.mem.write(address + 0x34, 'i32', mip.width);
    heap.mem.write(address + 0x38, 'i32', mip.height);
    resourceImages.set(address, {kind: 'texture', ref, asset, index, width: mip.width, height: mip.height});
    textureInfo.set(ref, {address, width: mip.width, height: mip.height});
    return address;
  }
  function fontImage(ref) {
    const asset = ref.asset, entry = asset.pkg.exports[ref.index - 1];
    const decoded = decodeFontExport(asset.bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize), ref.key);
    const font = writeFontImage(heap.mem, decoded), table = heap.mem.read(font + UFONT.pages, 'u32');
    const reader = readObject(asset.pkg, asset.bytes, ref.index).reader;
    if (reader.compact() !== decoded.pageCount) throw new Error('Original font page count mismatch');
    for (let page = 0; page < decoded.pageCount; page++) {
      const textureIndex = reader.compact(), count = reader.compact();
      reader.take(count * 16);
      const pageRef = {key: `${ref.key}.page${page}`, asset, index: textureIndex, kind: 'Texture'};
      const pointer = textureImage(asset, textureIndex, pageRef);
      heap.mem.write(table + page * FONT_PAGE.size, 'u32', pointer);
    }
    resourceImages.set(font, {kind: 'font', ref});
    return font;
  }
  function materialize(value) {
    if (value && typeof value === 'object' && value.asset && Number.isInteger(value.index)) {
      if (value.kind === 'Font') return fontImage(value);
      if (typeof value.kind === 'string' && value.kind.endsWith('Texture')) return textureImage(value.asset, value.index, value);
    }
    return undefined;
  }

  // ------------------------------------------------------------------
  // World services used by the translated bodies.
  // ------------------------------------------------------------------
  const globals = new Map([
    ...Object.values(WINDOW_RECONFIGURE_GLOBALS).map(name => [name, 0]),
    ...Object.values(WINDOW_CONFIGURE_CHILD_GLOBALS).map(name => [name, 0]),
    ['preferredSizeDepth', 0], ['granularityDepth', 0], ['rootWindowList', null], ['global100aeafc', null],
  ]);
  const boundaryLog = [];
  const W = {
    heap,
    u8: (o, off) => heap.read(o, off, 'u8'), u16: (o, off) => heap.read(o, off, 'u16'),
    u32: (o, off) => heap.read(o, off, 'u32'), i32: (o, off) => heap.read(o, off, 'i32'),
    f32: (o, off) => heap.read(o, off, 'f32'), ptr: (o, off) => heap.read(o, off, 'ptr'),
    setU8: (o, off, v) => heap.write(o, off, 'u8', v & 0xff), setU32: (o, off, v) => heap.write(o, off, 'u32', v >>> 0),
    setI32: (o, off, v) => heap.write(o, off, 'i32', v | 0), setF32: (o, off, v) => heap.write(o, off, 'f32', f(v)),
    setPtr: (o, off, v) => heap.write(o, off, 'ptr', v),
    addressOf: value => heap.addressOf(value),
    global: name => { if (!globals.has(name)) boundary(`Window host global ${name} is not modelled`); return globals.get(name); },
    setGlobal: (name, value) => globals.set(name, value),
    boundary: message => boundary(message),
    uobjectConstructor: () => {},
    addToRoot: () => {},
    isA: (win, key) => { for (let c = runtime.instance(win).cls; c; c = c.base) if (c.record.key === key) return true; return false; },
    setPawnRootWindow: (pawn, root) => runtime.namedReference(pawn, 'rootWindow').set(root),
    processScript: (win, event, args, options) => processScript(win, event, args, options),
    canvasComputeRenderSize: () => {},
  };
  // FArray over heap storage ({Data, Num, Max} at the given offset).
  W.farray = {
    construct: (o, off) => { W.setU32(o, off, 0); W.setU32(o, off + 4, 0); W.setU32(o, off + 8, 0); },
    num: (o, off) => W.i32(o, off + 4),
    data: (o, off) => W.u32(o, off),
    realloc(o, off, elementSize) {
      const max = W.i32(o, off + 8), num = W.i32(o, off + 4), old = W.u32(o, off);
      if (max <= 0) { W.setU32(o, off, 0); return; }
      const address = heap.allocRaw(max * elementSize);
      if (old) heap.bytes.copyWithin(address - 0x21000000, old - 0x21000000, old - 0x21000000 + Math.min(num, max) * elementSize);
      W.setU32(o, off, address);
    },
    empty(o, off, elementSize, slack = 0) { W.setI32(o, off + 4, 0); W.setI32(o, off + 8, slack); W.farray.realloc(o, off, elementSize); },
    add(o, off, count, elementSize) {
      const index = W.i32(o, off + 4), num = index + count;
      W.setI32(o, off + 4, num);
      if (num > W.i32(o, off + 8)) { W.setI32(o, off + 8, num + Math.trunc((3 * num) / 8) + 32); W.farray.realloc(o, off, elementSize); }
      return index;
    },
    remove(o, off, index, count, elementSize) {
      const data = W.u32(o, off), num = W.i32(o, off + 4);
      const base = data - 0x21000000;
      heap.bytes.copyWithin(base + index * elementSize, base + (index + count) * elementSize, base + num * elementSize);
      W.setI32(o, off + 4, num - count);
    },
    ptr: (o, off, i) => heap.mem.read(W.u32(o, off) + 4 * i, 'ptr'),
    setPtr: (o, off, i, v) => heap.mem.write(W.u32(o, off) + 4 * i, 'ptr', v),
    qsort(o, off, compare) {
      const n = W.i32(o, off + 4), items = [];
      for (let i = 0; i < n; i++) items.push(W.farray.ptr(o, off, i));
      items.sort(compare);
      items.forEach((item, i) => W.farray.setPtr(o, off, i, item));
    },
  };
  const rawServices = {
    read: (object, offset, kind) => heap.read(object, offset, kind === 'string' ? 'string' : kind),
    write: (object, offset, kind, value) => heap.write(object, offset, kind, value),
  };

  // ------------------------------------------------------------------
  // VM <-> native field bindings for native window classes.
  // ------------------------------------------------------------------
  const layouts = new Map();
  const FIELD_OVERRIDES = new Map([
    // TextLogWindow.bPaused: PauseLog 0x100478f0 writes bit 2 of +0x184.
    ['extension.textlogwindow.bpaused', {offset: 0x184, kind: 'bool', mask: 4}],
  ]);
  function layoutFor(cls) {
    if (!layouts.has(cls)) layouts.set(cls, nativeWindowLayout(cls));
    return layouts.get(cls);
  }
  const colorKeys = ['r', 'g', 'b', 'a'].map(c => `core.object.color.${c}`);
  function readStruct(object, entry, base = entry.offset) {
    switch (entry.struct) {
      case 'core.object.color': return Object.fromEntries(colorKeys.map((key, i) => [key, W.u8(object, base + i)]));
      case 'core.object.plane': return Object.fromEntries(['x', 'y', 'z', 'w'].map((c, i) =>
        [`core.object.${c === 'w' ? 'plane' : 'vector'}.${c}`, W.f32(object, base + 4 * i)]));
      case 'extension.extensionobject.cliprect': return Object.fromEntries(
        ['originx', 'originy', 'clipx', 'clipy', 'clipwidth', 'clipheight'].map((c, i) =>
          [`extension.extensionobject.cliprect.${c}`, W.f32(object, base + 4 * i)]));
      case 'extension.buttonwindow.buttondisplayinfo': return {
        'extension.buttonwindow.buttondisplayinfo.tx': W.ptr(object, base),
        'extension.buttonwindow.buttondisplayinfo.tlcolor': readStruct(object, {struct: 'core.object.color'}, base + 4),
        'extension.buttonwindow.buttondisplayinfo.txcolor': readStruct(object, {struct: 'core.object.color'}, base + 8),
      };
      default: return boundary(`Native window struct ${entry.struct} has no binding`);
    }
  }
  function writeStruct(object, entry, value, base = entry.offset) {
    if (entry.struct !== 'core.object.color') boundary(`Script write to native struct ${entry.struct} is not bound`);
    colorKeys.forEach((key, i) => W.setU8(object, base + i, value[key] ?? 0));
  }
  function bindingFor(object, entry) {
    const override = FIELD_OVERRIDES.get(entry.field.key);
    const e = override ? {...entry, ...override} : entry;
    const read = () => {
      if (e.kind === 'bool') return Boolean(W.u32(object, e.offset) & e.mask);
      if (e.arrayDim > 1) {
        const values = [];
        for (let i = 0; i < e.arrayDim; i++) values.push(readElement(object, e, e.offset + i * e.size));
        return values;
      }
      return readElement(object, e, e.offset);
    };
    const write = value => {
      value = refValue(value);
      if (e.kind === 'bool') {
        const word = W.u32(object, e.offset);
        W.setU32(object, e.offset, value ? (word | e.mask) : (word & ~e.mask));
        return;
      }
      if (e.arrayDim > 1) {
        value.forEach((item, i) => writeElement(object, e, e.offset + i * e.size, item));
        return;
      }
      writeElement(object, e, e.offset, value);
    };
    return {get: read, set: write};
  }
  function readElement(object, e, at) {
    switch (e.kind) {
      case 'u8': return W.u8(object, at);
      case 'i32': return W.i32(object, at);
      case 'f32': return W.f32(object, at);
      case 'ptr': return W.ptr(object, at);
      case 'string': return heap.read(object, at, 'string');
      case 'name': return heap.read(object, at, 'name');
      case 'struct': return readStruct(object, e, at);
      default: return boundary(`Native window field kind ${e.kind}`);
    }
  }
  function writeElement(object, e, at, value) {
    switch (e.kind) {
      case 'u8': return W.setU8(object, at, value);
      case 'i32': return W.setI32(object, at, value);
      case 'f32': return W.setF32(object, at, value);
      case 'ptr': return W.setPtr(object, at, value ?? null);
      case 'string': return heap.write(object, at, 'string', String(value ?? ''));
      case 'name': return heap.write(object, at, 'name', String(value ?? 'None'));
      case 'struct': return writeStruct(object, e, value, at);
      default: return boundary(`Native window field kind ${e.kind}`);
    }
  }
  /** InitProperties for native members: class defaults land in the image
   * before the native constructor runs (UObject::StaticConstructObject). */
  function bindNativeFields(object, cls) {
    const layout = layoutFor(cls), instance = runtime.instance(object);
    for (const entry of layout.fields.values()) {
      const binding = bindingFor(object, entry);
      instance.bindings.set(entry.field.key, binding);
      for (let c = cls; c; c = c.base) {
        const authored = c.defaults?.get(entry.field.key);
        if (!authored) continue;
        const value = runtime.defaultValue(c, entry.field);
        binding.set(value);
        break;
      }
    }
    return layout;
  }

  // ------------------------------------------------------------------
  // Object creation: StaticConstructObject + family constructor.
  // ------------------------------------------------------------------
  let nameCounter = 0;
  const families = new WeakMap();
  const destroyed = new WeakSet();
  function familyOf(win) {
    const family = families.get(win);
    if (!family) boundary('Native window has no admitted family');
    return family;
  }
  function staticConstructObject({classObject, outer, name = 'None', flags = 0, template = null}) {
    if (lower(name) !== 'none' || flags !== 0 || template !== null)
      boundary('Window host StaticConstructObject only models NAME_None, flags 0, no template');
    const cls = classObject?.linkedClass;
    if (!cls) boundary(`Window host received an unlinked class ${classObject?.key}`);
    const family = nativeWindowFamily(cls);
    if (!family || !FAMILIES[family]) boundary(`Window family is not admitted: ${cls.record.key} (${family ?? 'no native window ancestry'})`);
    const object = {name: `${cls.record.name}${nameCounter++}`, outer};
    heap.allocate(object, NATIVE_WINDOW_CLASS_SIZES[family] + 0x80);
    runtime.attach(object, cls);
    families.set(object, family);
    bindNativeFields(object, cls);
    constructFamily(object, family);
    return object;
  }
  function constructFamily(win, family) {
    switch (family) {
      case 'extension.window': return constructWindowNative(win, {...rawServices, coreObjectConstructor: () => {}});
      case 'extension.textwindow': return F.constructTextWindow(W, win);
      case 'extension.buttonwindow': return F.constructButtonWindow(W, win);
      case 'extension.togglewindow': return F.constructToggleWindow(W, win);
      case 'extension.tilewindow': return constructTileWindow(win, {...rawServices, coreObjectConstructor: () => {}});
      case 'extension.tabgroupwindow': return F.constructTabGroupWindow(W, win);
      case 'extension.radioboxwindow': return F.constructRadioBoxWindow(W, win);
      case 'extension.textlogwindow': return F.constructTextLogWindow(W, win);
      case 'extension.modalwindow': return F.constructModalWindow(W, win);
      case 'extension.rootwindow': return F.constructRootWindow(W, win);
      case 'extension.computerwindow': return constructComputerWindowNative(win, {...rawServices,
        constructWindow: ({object}) => constructWindowNative(object, {...rawServices, coreObjectConstructor: () => {}})});
      default: return boundary(`Window family ${family} has no recovered constructor`);
    }
  }
  // XWindow::Init XGC allocation leaves (operator new + XGC::XGC).
  function allocateGc(outer) {
    const gc = {name: `GC${nameCounter++}`, outer};
    heap.allocate(gc, 0xb8 + 0x10);
    runtime.attach(gc, gcClass);
    return gc;
  }
  const initServices = {
    ...rawServices,
    pointerWord: ({object}) => heap.addressOf(object),
    fNameNone: () => 0,
    xgcOperatorNew: ({outer}) => allocateGc(outer),
    xgcConstructor: ({object}) => constructWindowGcNative(object, {...rawServices,
      coreObjectConstructor: () => {}, nativeAddress: heap.addressOf(object)}),
    addChild: ({parent, child, flag}) => addWindowChildNative(parent, child, flag, {
      read: (o, off) => heap.read(o, off, 'ptr'), write: (o, off, v) => heap.write(o, off, 'ptr', v)}),
    childAdded: ({parent, child}) => V.childAdded(parent, child),
    descendantAdded: ({parent, child}) => V.descendantAdded(parent, child),
    setFonts: request => setWindowGcFontsNative(request, {write: rawServices.write}),
  };
  W.initWindow = (win, parent) => initWindowNative({window: win, parent}, initServices);
  W.initText = (win, parent) => initTextWindowNative(win, parent, {...rawServices,
    initWindow: args => initWindowNative(args, initServices), makeAcceleratorTableDirty: ({object}) => T.makeAcceleratorTableDirty(W, object)});
  function initFamily(win, parent) {
    switch (familyOf(win)) {
      case 'extension.window': return W.initWindow(win, parent);
      case 'extension.textwindow': return W.initText(win, parent);
      case 'extension.buttonwindow': return F.initButtonWindow(W, win, parent);
      case 'extension.togglewindow': return F.initToggleWindow(W, win, parent);
      case 'extension.tilewindow': return initTileWindow(win, parent, {...rawServices, initWindow: args => initWindowNative(args, initServices)});
      case 'extension.tabgroupwindow': return F.initTabGroupWindow(W, win, parent);
      case 'extension.radioboxwindow': return F.initRadioBoxWindow(W, win, parent);
      case 'extension.textlogwindow': return F.initTextLogWindow(W, win, parent);
      case 'extension.modalwindow': return F.initModalWindow(W, win, parent);
      case 'extension.rootwindow': return boundary('XRootWindow::Init(XWindow*) 0x10005ca0: "Root cannot have a parent window!"');
      default: return boundary(`Window family ${familyOf(win)} has no recovered Init`);
    }
  }

  // ------------------------------------------------------------------
  // ProcessScript with typed parameter blocks (XWindow::ProcessScript 0x1004ded0).
  // ------------------------------------------------------------------
  function processScript(win, event, args = [], {checked = false, result} = {}) {
    if (checked && !runtime.scriptability()) return result;
    const record = runtime.lookup(win, event, false);
    if (!record) {
      if (checked) boundary(`Window.ProcessScript checked missing-function diagnostic: ${event}`);
      return result;
    }
    if (!record.function) boundary(`Window script event is not prepared: ${record.key}`);
    const fn = record.function;
    if (args.length !== fn.parameters.length) boundary(`Window event ${record.key} parameter block has ${args.length} of ${fn.parameters.length}`);
    if (fn.result) {
      const cell = {reference: true, value: result, get() { return this.value; }, set(v) { this.value = v; }};
      runtime.processEvent(win, event, args, cell, record);
      return cell.value;
    }
    runtime.processEvent(win, event, args, null, record);
    return undefined;
  }

  // ------------------------------------------------------------------
  // Virtual dispatch: family overrides, else the XWindow ProcessScript bridge.
  // ------------------------------------------------------------------
  const is = (win, ...keys) => keys.includes(familyOf(win));
  const V = {
    childAdded: (win, child) => processScript(win, 'ChildAdded', [child]),            // 0x100034c0
    childRemoved: (win, child) => processScript(win, 'ChildRemoved', [child]),        // 0x100034e0
    descendantAdded(win, child) {                                                      // 0x10003500 / RadioBox 0x10038b90
      processScript(win, 'DescendantAdded', [child]);
      if (is(win, 'extension.radioboxwindow')) radioBoxDescendantAdded(win, child);
    },
    descendantRemoved(win, child) {                                                    // 0x10003520 / RadioBox / Modal / Root
      if (is(win, 'extension.radioboxwindow')) return radioBoxDescendantRemoved(win, child);
      processScript(win, 'DescendantRemoved', [child]);
      if (is(win, 'extension.modalwindow', 'extension.rootwindow')) {
        if (W.ptr(win, 0x178) === child) W.setPtr(win, 0x178, null);                    // 0x10037444
        if (is(win, 'extension.rootwindow')) rootDescendantRemoved(win, child);
      }
    },
    parentRequestedPreferredSize(win, bW, w, bH, h) {
      switch (familyOf(win)) {
        case 'extension.textwindow': case 'extension.buttonwindow': case 'extension.togglewindow':
        case 'extension.textlogwindow': return textPreferredSize(win, bW, w, bH, h);
        case 'extension.tilewindow': return tileComputeChildSizes(win, bW, w, bH, h);
        case 'extension.tabgroupwindow': case 'extension.modalwindow': case 'extension.rootwindow':
          return tabGroupPreferredSize(win, bW, w, bH, h);
        case 'extension.radioboxwindow': return radioBoxPreferredSize(win, bW, w, bH, h);
        default: return windowPreferredSize(win, bW, w, bH, h);
      }
    },
    parentRequestedGranularity(win, hg, vg) {
      if (is(win, 'extension.window', 'extension.tabgroupwindow', 'extension.modalwindow', 'extension.rootwindow', 'extension.radioboxwindow', 'extension.computerwindow')) {
        const args = [f(hg), f(vg)];
        processScript(win, 'ParentRequestedGranularity', args);
        return {h: f(args[0]), v: f(args[1])};
      }
      return boundary(`ParentRequestedGranularity override of ${familyOf(win)} is not recovered`);
    },
    childRequestedVisibilityChange(win, child, visible) {
      switch (familyOf(win)) {
        case 'extension.tilewindow':                                                    // 0x10048940
          setChildVisibility(child, visible); askParentForReconfigure(win); return;
        case 'extension.tabgroupwindow': case 'extension.modalwindow': case 'extension.rootwindow':
        case 'extension.radioboxwindow':                                                // 0x10045870 / 0x100389d0
          setChildVisibility(child, visible); if (!visible) askParentForReconfigure(win); return;
        default: processScript(win, 'ChildRequestedVisibilityChange', [child, Boolean(visible)]); // 0x10003540
      }
    },
    childRequestedReconfiguration(win, child) {
      switch (familyOf(win)) {
        case 'extension.tilewindow': case 'extension.tabgroupwindow': case 'extension.modalwindow':
        case 'extension.radioboxwindow': return 0;                                     // 0x100421d0
        case 'extension.rootwindow': return T.rootChildRequestedReconfiguration(W, win, child) ? 1 : 0;
        default: return processScript(win, 'ChildRequestedReconfiguration', [child], {result: false}) ? 1 : 0;
      }
    },
    configurationChanged(win) {
      switch (familyOf(win)) {
        case 'extension.tilewindow': return tileConfigurationChanged(win);
        case 'extension.tabgroupwindow': case 'extension.modalwindow': case 'extension.rootwindow':
          return tabGroupConfigurationChanged(win);
        case 'extension.radioboxwindow': return radioBoxConfigurationChanged(win);
        case 'extension.textlogwindow': return textLogConfigurationChanged(win);
        default: return processScript(win, 'ConfigurationChanged', []);              // 0x10003600
      }
    },
    visibilityChanged(win, visible) {
      processScript(win, 'VisibilityChanged', [Boolean(visible)]);                     // 0x10003610 / 0x10037330
      if (is(win, 'extension.modalwindow') && W.ptr(win, T.O.parent))
        boundary('XModalWindow::VisibilityChanged keyboard/mouse grab for a child modal');
      if (is(win, 'extension.computerwindow')) boundary('XComputerWindow::VisibilityChanged is not recovered');
    },
    sensitivityChanged(win, sensitive) {
      processScript(win, 'SensitivityChanged', [Boolean(sensitive)]);                  // 0x10003630
      if (is(win, 'extension.buttonwindow', 'extension.togglewindow')) {               // 0x10007f10
        if (!sensitive && (W.u32(win, 0x174) & 2)) W.setU32(win, 0x174, W.u32(win, 0x174) & 0xfffffffc);
        changeButtonAppearance(win);
      }
    },
    tick(win, delta) {
      switch (familyOf(win)) {
        case 'extension.buttonwindow': case 'extension.togglewindow': return buttonTick(win, delta);
        case 'extension.textlogwindow': return textLogTick(win, delta);
        case 'extension.modalwindow': return F.buildAcceleratorTable(W, win);
        case 'extension.rootwindow': return rootTickVirtual(win, delta);
        case 'extension.computerwindow': return boundary('XComputerWindow::Tick is not recovered');
        default: return undefined;                                                     // 0x10003be0: ret 4
      }
    },
    draw(win, gc) {
      switch (familyOf(win)) {
        case 'extension.textwindow': return textDraw(win, gc);
        case 'extension.buttonwindow': case 'extension.togglewindow': return buttonDraw(win, gc);
        case 'extension.textlogwindow': return textLogDraw(win, gc);
        case 'extension.computerwindow': return boundary('XComputerWindow::Draw 0x1000ed60 is not recovered');
        default: return processScript(win, 'DrawWindow', [gc]);                         // 0x10003bf0
      }
    },
    postDraw: (win, gc) => processScript(win, 'PostDrawWindow', [gc]),                  // 0x10003c80
    styleChanged: win => processScript(win, 'StyleChanged', []),                        // 0x10003d10
    mouseGrabLost: () => undefined,                                                     // 0x10003be0
    toggleChanged(win, button, toggle) {
      if (is(win, 'extension.radioboxwindow')) return radioBoxToggleChanged(win, button, toggle);
      return processScript(win, 'ToggleChanged', [button, Boolean(toggle)], {result: false}) ? 1 : 0; // 0x10003d80
    },
    cleanUp: win => cleanUpFamily(win),
  };
  W.v = V;

  // ------------------------------------------------------------------
  // Window-level natives shared by several bodies.
  // ------------------------------------------------------------------
  const reconfiguration = {...rawServices,
    readGlobal: name => globals.get(name), writeGlobal: (name, _kind, value) => globals.set(name, value),
    parentRequestedReconfiguration: ({parent, child}) => V.childRequestedReconfiguration(parent, child),
    childRequestedReconfiguration: ({parent, child}) => V.childRequestedReconfiguration(parent, child),
    configurationChanged: ({object}) => V.configurationChanged(object),
    resizeChild: ({object}) => T.resizeChild(W, object),
  };
  function askParentForReconfigure(win) { return askParentForReconfigureNative(win, reconfiguration); }
  const configureChildServices = {...rawServices,
    readGlobal: name => globals.get(name), writeGlobal: (name, _kind, value) => globals.set(name, value),
    configurationChanged: ({object}) => V.configurationChanged(object),
    resizeChild: ({object}) => T.resizeChild(W, object),
    boundsUpdate: ({object}) => boundsUpdateNative(object, rawServices),
    sortWindowLists: ({object}) => F.resortWindowTables(W, object),
    safeDestroy: ({object}) => safeDestroy(object),
  };
  function configureChild(win, x, y, w, h) { return configureChildNative(win, f(x), f(y), f(w), f(h), configureChildServices); }
  const visibility = {...rawServices,
    readGlobal: name => globals.get(name), writeGlobal: (name, _kind, value) => globals.set(name, value),
    childRequestedVisibilityChange: ({parent, child, visible}) => V.childRequestedVisibilityChange(parent, child, visible),
    checkFocusWindow: ({object}) => T.checkFocusWindow(W, object),
    checkGrabbedWindow: ({object}) => T.checkGrabbedWindow(W, object),
    recomputeInitTree: ({object, effectiveVisibility}) => T.recomputeInitTree(W, object, effectiveVisibility),
    invokeVisibilityChange: ({object, effectiveVisibility}) => T.invokeVisibilityChange(W, object, effectiveVisibility),
    reconfigureTree: ({object}) => T.reconfigureTree(W, object, 0),
    makeAcceleratorTableDirty: ({object}) => T.makeAcceleratorTableDirty(W, object),
  };
  function setVisibility(win, visible) { return setVisibilityNative({object: win, visible: Boolean(visible)}, visibility); }
  function setChildVisibility(win, visible) { return setChildVisibilityNative({object: win, visible: Boolean(visible)}, visibility); }
  W.native = {
    configureChild, askParentForReconfigure, setVisibility, setChildVisibility,
    setSelectability: (win, selectable) => T.setSelectability(W, win, selectable),
    addWindowToTables: (tabGroup, win) => F.addWindowToTables(W, tabGroup, win),
    removeWindowFromTables: (tabGroup, win) => F.removeWindowFromTables(W, tabGroup, win),
    safeDestroy: win => safeDestroy(win),
    playSound: (win, sound) => { if (sound) soundRequests.push({window: win, sound}); },
  };
  const soundRequests = [];

  // Placeholders filled by the layout/draw sections below (hoisted functions).
  function windowPreferredSize(win, bW, w, bH, h) {                                    // 0x10050390
    const args = [Boolean(bW), f(w), Boolean(bH), f(h)];
    processScript(win, 'ParentRequestedPreferredSize', args);
    return {width: f(args[1]), height: f(args[3])};
  }
  function textPreferredSize() { return boundary('XTextWindow::ParentRequestedPreferredSize is wired in the layout slice'); }
  function tileComputeChildSizes() { return boundary('XTileWindow::ComputeChildSizes is wired in the layout slice'); }
  function tabGroupPreferredSize() { return boundary('XTabGroupWindow::ParentRequestedPreferredSize is wired in the layout slice'); }
  function radioBoxPreferredSize() { return boundary('XRadioBoxWindow::ParentRequestedPreferredSize is wired in the layout slice'); }
  function tileConfigurationChanged() { return boundary('XTileWindow::ConfigurationChanged is wired in the layout slice'); }
  function tabGroupConfigurationChanged(win) {                                          // 0x10045640
    if (W.u8(win, 0x164) & 2) boundary('XTabGroupWindow::ConfigurationChanged bSizeChildrenToParent branch');
    return processScript(win, 'ConfigurationChanged', []);
  }
  function radioBoxConfigurationChanged() { return boundary('XRadioBoxWindow::ConfigurationChanged is wired in the layout slice'); }
  function textLogConfigurationChanged() { return boundary('XTextLogWindow::ConfigurationChanged is wired in the layout slice'); }
  function radioBoxDescendantAdded(win, child) {                                         // 0x10038b90 (after the script bridge)
    if (!W.isA(child, 'extension.togglewindow')) return;
    let w = child;
    while (w && !W.isA(w, 'extension.radioboxwindow')) w = W.ptr(w, T.O.parent);
    if (w !== win) return;
    const index = W.farray.add(win, 0x178, 1, 4);
    W.farray.setPtr(win, 0x178, index, child);
  }
  function radioBoxDescendantRemoved() { return boundary('XRadioBoxWindow::DescendantRemoved is wired in the destroy slice'); }
  function rootDescendantRemoved() { return boundary('XRootWindow::DescendantRemoved is wired in the destroy slice'); }
  function radioBoxToggleChanged() { return boundary('XRadioBoxWindow::ToggleChanged is not recovered'); }
  function changeButtonAppearance() { return boundary('XButtonWindow::ChangeButtonAppearance is wired with the button natives'); }
  function buttonTick() { return undefined; }
  function textLogTick() { return boundary('XTextLogWindow::Tick is wired in the tick slice'); }
  function rootTickVirtual() { return boundary('XRootWindow::Tick is wired in the tick slice'); }
  function textDraw() { return boundary('XTextWindow::Draw is wired in the draw slice'); }
  function buttonDraw() { return boundary('XButtonWindow::Draw is wired in the draw slice'); }
  function textLogDraw() { return boundary('XTextLogWindow::Draw is wired in the draw slice'); }
  function cleanUpFamily() { return boundary('Window CleanUp is wired in the destroy slice'); }
  function safeDestroy() { return boundary('Window SafeDestroy is wired in the destroy slice'); }

  // ------------------------------------------------------------------
  // Lifecycle published to the shared runtime natives (windowLifecycle).
  // ------------------------------------------------------------------
  const lifecycle = {
    host: null,
    errorDevice: {name: 'GError'},
    isScriptable: () => true,
    hierarchy: {readParent: object => heap.read(object, T.O.parent, 'ptr'), readType: object => heap.read(object, T.O.type, 'u8')},
    reconfiguration, configureChild: configureChildServices, visibility,
    sensitivity: rawServices, size: rawServices, position: rawServices, text: rawServices,
    backgroundStyle: {...rawServices, generatePolyFlags: ({gc}) => updatePolyFlagsFromFlags(gcMemory(gc, gcServices), heap.objectAddress(gc))},
    surface: rawServices,
    tile: {...rawServices, askParentForReconfigure: ({object}) => askParentForReconfigure(object)},
    order: {...rawServices,
      addChild: ({parent, child, flag}) => initServices.addChild({parent, child, flag}),
      checkFocusWindow: ({object}) => T.checkFocusWindow(W, object)},
    staticConstructObject: request => staticConstructObject(request),
    initVtable: ({object, parent}) => initFamily(object, parent),
    processScript: ({object, event, parameters, thirdArgument}) => {
      if (parameters !== null) boundary('CreateNewWindow ProcessScript with parameters');
      return processScript(object, event, [], {checked: thirdArgument !== 0});
    },
    read: (object, key) => heap.read(object, key === 'lockCount' ? T.O.lock : T.O.flags, key === 'lockCount' ? 'i32' : 'u32'),
    write: (object, key, value) => heap.write(object, key === 'lockCount' ? T.O.lock : T.O.flags, key === 'lockCount' ? 'i32' : 'u32', value),
    setVisibility: ({object, visible}) => setVisibility(object, visible),
    askParentForReconfigure: ({object}) => askParentForReconfigure(object),
    safeDestroy: ({object}) => safeDestroy(object),
  };
  const gcServices = {mem: heap.mem, objectAddress: object => heap.objectAddress(object)};

  // ------------------------------------------------------------------
  // Root construction: APlayerPawnExt::ConstructRootWindow 0x10037e70.
  // ------------------------------------------------------------------
  function constructRootWindow(pawn) {
    const rootClassName = gameConfig?.rootWindowClass ?? 'DeusEx.DeusExRootWindow';
    const [pkg, name] = rootClassName.split('.');
    const asset = packages.get(pkg);
    const cls = classes.get(`${lower(pkg)}.${lower(name)}`) ?? null;
    if (!asset || !cls) boundary(`Root window class ${rootClassName} is not linked`);
    const root = staticConstructObject({classObject: cls.record, outer: null});
    F.initRootWindow(W, root, pawn);
    processScript(root, 'InitWindow', [], {checked: true});
    setVisibility(root, true);
    return root;
  }

  const host = {
    runtime, heap, W, lifecycle, classes, globals, boundaryLog, soundRequests, resourceImages, textureInfo,
    families: win => families.get(win) ?? null,
    isDestroyed: win => destroyed.has(win),
    processScript, constructRootWindow, configureChild, askParentForReconfigure, setVisibility,
    install() {
      runtime.windowLifecycle = {...runtime.windowLifecycle, ...lifecycle};
      return host;
    },
  };
  lifecycle.host = host;
  return host;
}
