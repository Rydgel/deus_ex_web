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
import * as S from './script-window-scroll-children.mjs';
import * as A from './script-window-scroll-area.mjs';
import * as SL from './script-window-scroll-layout.mjs';
import * as SC from './script-window-scroll-configuration.mjs';
import * as SM from './script-window-scroll-movement.mjs';
import * as SI from './script-window-scroll-input.mjs';
import {clipShowArea} from './script-window-scroll-show-area.mjs';
import {cleanScaleMembers,destroyScaleMembers} from './script-window-scroll-cleanup.mjs';
import {setSensitivityNative} from './script-window-sensitivity.mjs';
import {createNewWindowNative} from './script-window-child.mjs';
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
import {cleanUpWindowNative, preDestroyWindowNative, safeDestroyWindowNative} from './script-window-destroy.mjs';
import {updatePolyFlagsFromFlags, gcMemory, GC} from './script-gc-state-model.mjs';
import {decodeFontExport, writeFontImage, UFONT, FONT_PAGE} from './script-font-model.mjs';
import {readObject} from '../unreal/objects.mjs';
import {readTexture} from '../unreal/textures.mjs';
import {refValue} from './script-vm.mjs';
import {dispatchWindowHostNative} from './script-window-host-natives.mjs';
import {dispatchGcNative} from './script-window-gc-dispatch.mjs';
import {gcPushGC} from './script-gc-push-gc.mjs';
import {gcPopGC} from './script-gc-pop-gc.mjs';
import {gcCopyGC} from './script-gc-copy-gc.mjs';
import {gcGetTextExtent} from './script-gc-get-text-extent.mjs';
import {gcGetFontHeight} from './script-gc-get-font-height.mjs';
import {gcEnableDrawing} from './script-gc-enable-drawing.mjs';
import {gcSetStyle} from './script-gc-set-style.mjs';
import {gcSetTileColor} from './script-gc-set-tile-color.mjs';
import {gcDrawIcon} from './script-gc-draw-icon.mjs';
import {gcTileEmitGate,bitsToF32} from './script-gc-draw-model.mjs';
import * as D from './script-window-family-draw.mjs';
import * as Log from './script-window-text-log.mjs';
import * as L from './script-window-family-layout.mjs';
import {createInputConsole} from './script-input-console.mjs';
import {rootTickNative,moveTabGroupNative} from './script-window-root-tick.mjs';
import {dispatchWindowSoundNative,windowPlaySound} from './script-window-sound.mjs';
import {createWindowActorRefDispatcher} from './script-window-actor-refs.mjs';
import {writeWindowSceneFrame} from './script-window-scene-frame.mjs';
import {setToggleNative} from './script-window-toggle-set.mjs';
import * as Timers from './script-window-timers.mjs';
import * as Input from './script-window-input.mjs';
import * as Mouse from './script-window-mouse.mjs';
import {rootVectorToCoordinates,windowVectorToCoordinates} from './script-window-projection.mjs';
import {activateButtonNative} from './script-window-activate-button.mjs';

const f = Math.fround;
const lower = value => String(value).toLowerCase();
const f32BitsView = new DataView(new ArrayBuffer(4));
const f32BitsOf = value => (f32BitsView.setFloat32(0, value, true), f32BitsView.getUint32(0, true));
const NATIVE_WINDOW_KEYS = new Set(Object.keys(NATIVE_WINDOW_CLASS_SIZES));

/** Native class families admitted by the host, keyed by Extension class key. */
const FAMILIES = Object.freeze({
  'extension.window': {vtable: F.VTABLES.window},
  'extension.textwindow': {vtable: F.VTABLES.textwindow},
  'extension.buttonwindow': {vtable: F.VTABLES.buttonwindow},
  'extension.togglewindow': {vtable: F.VTABLES.togglewindow},
  // Extension.dll's exported ??_7XCheckboxWindow@@6B@ differs from the toggle
  // vftable only in the destructor, Init +0x54, CleanUp +0x58 (a call to
  // XToggleWindow::CleanUp), ParentRequestedPreferredSize +0x7c and Draw
  // +0xd8 (scripts/sdk-layouts.mjs --retail). Every other slot dispatches as
  // toggle.
  'extension.checkboxwindow': {vtable: F.VTABLES.checkboxwindow, dispatch: 'extension.togglewindow'},
  'extension.tilewindow': {vtable: F.VTABLES.tilewindow},
  'extension.tabgroupwindow': {vtable: F.VTABLES.tabgroupwindow},
  'extension.radioboxwindow': {vtable: F.VTABLES.radioboxwindow},
  'extension.textlogwindow': {vtable: F.VTABLES.textlogwindow},
  'extension.modalwindow': {vtable: F.VTABLES.modalwindow},
  'extension.rootwindow': {vtable: F.VTABLES.rootwindow},
  'extension.computerwindow': {vtable: F.VTABLES.computerwindow},
  'extension.scalewindow': {vtable:S.CHILD_VTABLES.scale},
  'extension.scalemanagerwindow': {vtable:S.CHILD_VTABLES.manager},
  'extension.clipwindow': {vtable:S.CHILD_VTABLES.clip},
  'extension.scrollareawindow': {vtable:A.SCROLL_AREA.vtable},
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
  ['Extension', ['scalewindow','scalemanagerwindow','clipwindow','scrollareawindow','window', 'textwindow', 'buttonwindow', 'togglewindow', 'tilewindow', 'tabgroupwindow',
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
  const inputConsole=await createInputConsole(runtime,assets);
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
  for(const path of ['augmentation.gethotkey','augmentation.isactive','augmentationmanager.refreshaugdisplay','deusexplayer.clearaugmentationdisplay','deusexplayer.addaugmentationdisplay','deusexplayer.updateaugmentationdisplaystatus'])await runtime.prepareFunction(deusEx,deusEx.exportsByPath.get(path));
  // These globalconfig fields are consumed by original HUD Init/UpdateSettings.
  // Keep compiled defaults where the supplied installation has no scalar.
  const config=inputConsole.config;
  for(const name of ['bObjectNames','bObjectBeltVisible','bHitDisplayVisible','bAmmoDisplayVisible','bDisplayAmmoByClip',
    'bAugDisplayVisible','bCompassVisible','bCrosshairVisible','bHUDShowAllAugs',
    'bHUDBordersVisible','bHUDBordersTranslucent','bHUDBackgroundTranslucent']){
    const value=config.get('DeusEx.DeusExPlayer',name);
    if(value!==undefined)runtime.namedReference(player,name).set(/^(true|1)$/i.test(value));
  }
  for(const [name,convert] of [['logTimeout',Math.fround],['maxLogLines',v=>Number(v)&255],
    ['translucencyLevel',v=>Number(v)&255],['MenuThemeName',String],['HUDThemeName',String]]){
    const value=config.get('DeusEx.DeusExPlayer',name);
    if(value!==undefined)runtime.namedReference(player,name).set(convert(value));
  }
  const themeManager=runtime.namedReference(player,'ThemeManager').get();
  if(themeManager)for(const prefix of ['Menu','HUD'])runtime.dispatchSpawnedEvent(themeManager,`Set${prefix}ThemeByName`,[runtime.namedReference(player,`${prefix}ThemeName`).get()]);
  for(const path of ['deusexplayer.activatebelt','deusexplayer.restrictinput'])await runtime.prepareFunction(deusEx,deusEx.exportsByPath.get(path));


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
  const timerNodes = new Set();
  let lastTickTime=performance.now()/1000;
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
    setPawnField: (pawn, name, value) => runtime.namedReference(pawn, name).set(value),
    processScript: (win, event, args, options) => processScript(win, event, args, options),
    mouseClickLog: win => boundaryLog.push({log:'GLog',text:`Assigning Last Button Window to ${objectFullName(win)}`}),
    canvasComputeRenderSize: () => {},
    // XRootWindow::GetWindowsTickOffset(0) 0x1003a3b0 over the host clock.
    tickOffset:()=>Timers.windowsTickOffset(performance.now()/1000,lastTickTime),
    // XWindow::AddTimer's GMalloc(0x20): a registered node, so pointer walks
    // of the timer lists (XWindow::CleanUp) resolve it.
    allocTimerNode:()=>{const node={windowTimerNode:true};heap.allocate(node,Timers.WINDOW_TIMER.size);timerNodes.add(node);return node;},
    soundPawnFields:pawn=>({location:runtime.namedReference(pawn,'Location').get(),viewRotation:runtime.namedReference(pawn,'ViewRotation').get()}),
    deferWindowSound:request=>soundRequests.push(request),
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
      if (old) heap.copyBytes(address,old,Math.min(num,max)*elementSize);
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
      heap.copyBytes(data+index*elementSize,data+(index+count)*elementSize,(num-index-count)*elementSize);
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
  const families = new WeakMap(), checkboxes = new WeakSet();
  const isCheckbox = win => checkboxes.has(win);
  const externalSubtrees = new WeakSet();
  W.externalSubtree=win=>externalSubtrees.has(win);
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
    families.set(object, FAMILIES[family].dispatch ?? family);
    if (family === 'extension.checkboxwindow') checkboxes.add(object);
    bindNativeFields(object, cls);
    constructFamily(object, family);
    return object;
  }
  function constructFamily(win, family) {
    switch (family) {
      case 'extension.scalewindow': return S.constructScrollChild(W,win,'scale');
      case 'extension.scalemanagerwindow': return S.constructScrollChild(W,win,'manager');
      case 'extension.clipwindow': return S.constructScrollChild(W,win,'clip');
      case 'extension.scrollareawindow': return A.constructScrollAreaWindow(W,win);
      case 'extension.window': return constructWindowNative(win, {...rawServices, coreObjectConstructor: () => {}});
      case 'extension.textwindow': return F.constructTextWindow(W, win);
      case 'extension.buttonwindow': return F.constructButtonWindow(W, win);
      case 'extension.togglewindow': return F.constructToggleWindow(W, win);
      case 'extension.checkboxwindow': return F.constructCheckboxWindow(W, win);
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
  W.initTabGroup=(win,parent)=>F.initTabGroupWindow(W,win,parent);
  W.createNewWindow=(name,parent,flag)=>createNewWindowNative({newClass:classes.get(`extension.${name.toLowerCase()}`).record,parent,bShow:Boolean(flag),errorDevice:lifecycle.errorDevice},lifecycle);
  function initFamily(win, parent) {
    if (isCheckbox(win)) return F.initCheckboxWindow(W, win, parent);
    switch (familyOf(win)) {
      case 'extension.scalewindow': return S.initScale(W,win,parent);
      case 'extension.scalemanagerwindow': return S.initScaleManager(W,win,parent);
      case 'extension.clipwindow': return S.initClip(W,win,parent);
      case 'extension.scrollareawindow': return A.initScrollAreaWindow(W,win,parent);
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
    convertVectorToCoordinates:(win,vector)=>is(win,'extension.rootwindow')?rootVectorToCoordinates(W,win,vector):windowVectorToCoordinates(W,win,vector),
    childAdded: (win, child) => processScript(win, 'ChildAdded', [child]),            // 0x100034c0
    childRemoved(win, child) {                                                       // 0x100034e0 / 0x10042480
      if(is(win,'extension.scalemanagerwindow'))return S.managerChildRemoved(W,win,child,processScript);
      return processScript(win,'ChildRemoved',[child]);
    },
    descendantAdded(win, child) {                                                      // 0x10003500 / RadioBox 0x10038b90
      processScript(win, 'DescendantAdded', [child]);
      if (is(win, 'extension.radioboxwindow')) radioBoxDescendantAdded(win, child);
    },
    descendantRemoved(win, child) {                                                    // 0x10003520 / RadioBox / Modal / Root
      if (is(win, 'extension.scrollareawindow')) return A.scrollAreaDescendantRemoved(W,win,child);
      if (is(win, 'extension.radioboxwindow')) return radioBoxDescendantRemoved(win, child);
      if (is(win, 'extension.rootwindow')) rootDescendantRemoved(win, child);        // then XModalWindow's
      processScript(win, 'DescendantRemoved', [child]);
      if (is(win, 'extension.modalwindow', 'extension.rootwindow') && W.ptr(win, 0x178) === child)
        W.setPtr(win, 0x178, null);                                                     // 0x10037444
    },
    parentRequestedPreferredSize(win, bW, w, bH, h) {
      if (isCheckbox(win)) return L.checkboxPreferredSize(W, win, bW, w, bH, h);
      switch (familyOf(win)) {
        case 'extension.scalewindow': return SL.scalePreferredSize(W,win);
        case 'extension.scalemanagerwindow': return SL.managerPreferredSize(W,win);
        case 'extension.clipwindow': return SL.clipPreferredSize(W,win,bW,w,bH,h);
        case 'extension.scrollareawindow': return SL.scrollAreaPreferredSize(W,win,bW,w,bH,h);
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
      if(is(win,'extension.tilewindow'))return SL.tileGranularity(W,win,hg,vg);
      if (is(win, 'extension.window', 'extension.tabgroupwindow', 'extension.modalwindow', 'extension.rootwindow', 'extension.radioboxwindow', 'extension.computerwindow', 'extension.scalewindow', 'extension.scalemanagerwindow', 'extension.clipwindow', 'extension.scrollareawindow')) {
        const args = [f(hg), f(vg)];
        processScript(win, 'ParentRequestedGranularity', args);
        return {h: f(args[0]), v: f(args[1])};
      }
      if (is(win, 'extension.textwindow', 'extension.buttonwindow', 'extension.togglewindow', 'extension.textlogwindow'))
        return L.textGranularity(W, win, hg, vg, (w, h1, v1) => {                     // 0x10046880 -> 0x10050450
          const args = [f(h1), f(v1)];
          processScript(w, 'ParentRequestedGranularity', args);
          return {h: f(args[0]), v: f(args[1])};
        });
      return boundary(`ParentRequestedGranularity override of ${familyOf(win)} is not recovered`);
    },
    childRequestedVisibilityChange(win, child, visible) {
      switch (familyOf(win)) {
        case 'extension.scalemanagerwindow': case 'extension.clipwindow': case 'extension.scrollareawindow':
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
        case 'extension.scalemanagerwindow': case 'extension.clipwindow': case 'extension.scrollareawindow':
        case 'extension.radioboxwindow': return 0;                                     // 0x100421d0
        case 'extension.rootwindow': return T.rootChildRequestedReconfiguration(W, win, child) ? 1 : 0;
        default: return processScript(win, 'ChildRequestedReconfiguration', [child], {result: false}) ? 1 : 0;
      }
    },
    configurationChanged(win) {
      switch (familyOf(win)) {
        case 'extension.scrollareawindow': return SC.scrollAreaConfiguration(W,win);
        case 'extension.scalemanagerwindow': return SC.managerConfiguration(W,win);
        case 'extension.scalewindow': return SC.scaleConfiguration(W,win);
        case 'extension.clipwindow': return SC.clipConfiguration(W,win);
        case 'extension.tilewindow': return tileConfigurationChanged(win);
        case 'extension.tabgroupwindow': case 'extension.modalwindow': case 'extension.rootwindow':
          return tabGroupConfigurationChanged(win);
        case 'extension.radioboxwindow': return radioBoxConfigurationChanged(win);
        case 'extension.textlogwindow': return textLogConfigurationChanged(win);
        default: return processScript(win, 'ConfigurationChanged', []);              // 0x10003600
      }
    },
    visibilityChanged(win, visible) {
      // XModalWindow::VisibilityChanged 0x10037330: the script event, then the
      // root keyboard/mouse grab counters for a parented modal.
      if (is(win, 'extension.modalwindow')) return Input.modalVisibilityChanged(W, win, visible, T.getRootWindow);
      processScript(win, 'VisibilityChanged', [Boolean(visible)]);                     // 0x10003610
      if (is(win, 'extension.computerwindow')) boundary('XComputerWindow::VisibilityChanged is not recovered');
    },
    // vtable +0x78, called by InvokeTimers for a nameless timer: XButtonWindow::
    // Timer 0x100080e0 for the Button/Toggle/Checkbox families; every other
    // family keeps XWindow::Timer 0x100504f0 (`ret 0xc`).
    timer(win, id) {
      if (is(win, 'extension.buttonwindow', 'extension.togglewindow'))
        Timers.buttonTimer(W, win, id, changeButtonAppearance);
    },
    sensitivityChanged(win, sensitive) {
      processScript(win, 'SensitivityChanged', [Boolean(sensitive)]);                  // 0x10003630
      if (is(win, 'extension.buttonwindow', 'extension.togglewindow')) {               // 0x10007f10
        if (!sensitive && (W.u32(win, 0x174) & 2)) W.setU32(win, 0x174, W.u32(win, 0x174) & 0xfffffffc);
        changeButtonAppearance(win);
      }
    },
    tick(win, delta) {
      if(is(win,'extension.scalewindow'))return SI.scaleTick(W,win,delta);
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
      if (isCheckbox(win)) return D.checkboxDraw(W, win, gc);
      switch (familyOf(win)) {
        case 'extension.textwindow': return textDraw(win, gc);
        case 'extension.buttonwindow': case 'extension.togglewindow': return buttonDraw(win, gc);
        case 'extension.textlogwindow': return textLogDraw(win, gc);
        case 'extension.computerwindow': return boundary('XComputerWindow::Draw 0x1000ed60 is not recovered');
        default: return processScript(win, 'DrawWindow', [gc]);                         // 0x10003bf0
      }
    },
    scaleAttributesChanged:(win,...args)=>is(win,'extension.scalemanagerwindow')?SC.managerScaleAttributes(W,win,...args):processScript(win,'ScaleAttributesChanged',args,{result:false}),
    // XWindow::ClipAttributesChanged 0x10003f00 / ScrollArea 0x10043b50.
    clipAttributesChanged:(win,...args)=>is(win,'extension.scrollareawindow')?SC.scrollClipAttributes(W,win,...args):processScript(win,'ClipAttributesChanged',args,{result:false}),
    postDraw: (win, gc) => processScript(win, 'PostDrawWindow', [gc]),                  // 0x10003c80
    styleChanged: win => processScript(win, 'StyleChanged', []),                        // 0x10003d10
    mouseGrabLost: () => undefined,                                                     // 0x10003be0
    toggleChanged(win, button, toggle) {
      if (is(win, 'extension.radioboxwindow')) return radioBoxToggleChanged(win, button, toggle);
      return processScript(win, 'ToggleChanged', [button, Boolean(toggle)], {result: false}) ? 1 : 0; // 0x10003d80
    },
    cleanUp: win => { destroyFamily(win).members?.(win); return cleanUpWindowNative(win, destroyServices); },
  };
  // Mouse position, hit-test and focus virtuals (vtable +0x60, +0x8c,
  // +0x9c..+0xb4) of the admitted families: script-window-mouse.mjs.
  Object.assign(V, Mouse.mouseFocusVirtuals(W, {familyOf, processScript: (win, event, args, options) => processScript(win, event, args, options),
    changeButtonAppearance: win => changeButtonAppearance(win), boundary}));
  // Key routing and button activation (docs/script-window-input.md).
  Object.assign(V, {
    scalePositionChanged:(win,...args)=>is(win,'extension.scalemanagerwindow')?SM.managerScalePosition(W,win,...args):processScript(win,'ScalePositionChanged',args,{result:false}),
    scaleRangeChanged:(win,...args)=>is(win,'extension.scrollareawindow')?SM.scrollScaleRange(W,win,...args):processScript(win,'ScaleRangeChanged',args,{result:false}),
    clipPositionChanged:(win,...args)=>is(win,'extension.scrollareawindow')?SM.scrollClipPosition(W,win,...args):processScript(win,'ClipPositionChanged',args,{result:false}),
    // vtable +0xbc: XWindow::RawKeyPressed 0x10003750 in every admitted family.
    rawKeyPressed: (win, key, action, repeat) =>
      processScript(win, 'RawKeyPressed', [key & 0xff, action & 0xff, Boolean(repeat)], {result: false}),
    // vtable +0xcc: XWindow::VirtualKeyPressed 0x10003a40; Computer/Edit override it.
    virtualKeyPressed(win, key, repeat) {
      if (is(win, 'extension.computerwindow')) boundary('XComputerWindow::VirtualKeyPressed 0x1000f530 is not recovered');
      if (is(win, 'extension.editwindow')) boundary('XEditWindow::VirtualKeyPressed 0x10021480 is not recovered');
      return processScript(win, 'VirtualKeyPressed', [key & 0xff, Boolean(repeat)], {result: false});
    },
    // Root vtable +0x124 / +0x12c.
    handleVirtualKeyboard(root, key, action, repeat) {
      if (!is(root, 'extension.rootwindow')) boundary('HandleVirtualKeyboard reached a non-root window');
      return Input.handleVirtualKeyboard(W, root, key, action, repeat, {topChild: T.topChild, lowerSibling: T.lowerSibling});
    },
    handleButtons(root,key,action) {
      if(!is(root,'extension.rootwindow'))boundary('HandleButtons reached a non-root window');
      return Input.handleButtons(W,root,key,action,{topChild:T.topChild,lowerSibling:T.lowerSibling,
        getMouseWindow:(r,modal)=>Mouse.getMouseWindow(W,r,modal),convertCoordinates:(...args)=>Mouse.convertCoordinates(W,...args),
        setFocusWindow:(r,target)=>Mouse.setFocusWindow(W,r,target),getRootWindow:T.getRootWindow,tickOffset:W.tickOffset});
    },
    // Button-family vtable +0x124.
    pressButton(win, key) {
      if (is(win, 'extension.togglewindow')) return Input.togglePressButton(W,win,key,
        {setToggle:(w,value)=>setToggleNative(w,value,lifecycle.toggle)});
      if (!is(win, 'extension.buttonwindow')) boundary('PressButton reached a non-button window');
      return Input.buttonPressButton(W, win, key, {changeButtonAppearance: w => changeButtonAppearance(w),
        addActivateTimer: Timers.addActivateTimer, activateButton: (w, k) => W.native.activateButton(w, k)});
    },
    // vtable +0xe8 / +0xec: XWindow::ButtonActivated 0x10003d20 / ButtonActivatedRight 0x10003d50.
    buttonActivated: (win, source) => is(win,'extension.scalemanagerwindow')?SM.managerButtonActivated(W,win,source):processScript(win, 'ButtonActivated', [source], {result: false}),
    buttonActivatedRight: (win, source) => processScript(win, 'ButtonActivatedRight', [source], {result: false}),
  });
  const inheritedMousePressed=V.mouseButtonPressed;
  V.mouseButtonPressed=(win,...args)=>is(win,'extension.togglewindow')?Input.toggleMousePressed(W,win,...args,{processScript}):
    is(win,'extension.buttonwindow')?Input.buttonMousePressed(W,win,...args,
    {processScript,changeButtonAppearance,tickOffset:W.tickOffset,activateButton:(w,key)=>W.native.activateButton(w,key)}):
    is(win,'extension.scalewindow')?SI.scaleMousePressed(W,win,...args):is(win,'extension.scrollareawindow')?SM.scrollMousePressed(W,win,...args):inheritedMousePressed(win,...args);
  const inheritedMouseMoved=V.mouseMoved,inheritedMouseReleased=V.mouseButtonReleased;
  V.mouseMoved=(win,...args)=>is(win,'extension.scalewindow')?SI.scaleMouseMoved(W,win,...args):inheritedMouseMoved(win,...args);
  V.mouseButtonReleased=(win,...args)=>is(win,'extension.togglewindow')?Input.toggleMouseReleased(W,win,...args,
    {processScript,isPointInWindow:(w,x,y)=>Mouse.isPointInWindow(W,w,x,y),setToggle:(w,value)=>setToggleNative(w,value,lifecycle.toggle)}):
    is(win,'extension.buttonwindow')?Input.buttonMouseReleased(W,win,...args,
    {processScript,changeButtonAppearance,activateButton:(w,key)=>W.native.activateButton(w,key),isPointInWindow:(w,x,y)=>Mouse.isPointInWindow(W,w,x,y)}):
    is(win,'extension.scalewindow')?SI.scaleMouseReleased(W,win,...args):inheritedMouseReleased(win,...args);
  const inheritedShowArea=V.childRequestedShowArea;
  V.childRequestedShowArea=(win,...args)=>is(win,'extension.clipwindow')?clipShowArea(W,win,...args):inheritedShowArea(win,...args);
  // The four new families override these native slots. Until translated,
  // reject them explicitly instead of silently using Window/TabGroup behavior.
  for(const [family,methods] of Object.entries({
    'extension.scalewindow':['draw'],
  }))for(const method of methods){
    const inherited=V[method];V[method]=(win,...args)=>{
      if(is(win,family))return boundary(`${family}.${method} native override is not recovered`);
      if(!inherited)return boundary(`Window.${method} script bridge is not recovered`);
      return inherited(win,...args);
    };
  }
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
    tabGroupPreferredSize:(...args)=>L.tabGroupPreferredSize(W,...args),
    setSensitivity:(object,sensitive)=>setSensitivityNative({object,sensitive},lifecycle.sensitivity),
    setScaleButtons:(...args)=>S.managerSetButtons(W,...args),
    setScale:(...args)=>S.managerSetScale(W,...args),
    setOrientation:(...args)=>S.scaleOrientation(W,...args),
    setNumTicks:(...args)=>S.scaleNumTicks(W,...args),
    setThumbSpan:(...args)=>S.scaleThumbSpan(W,...args),
    enableStretchedScale:(...args)=>S.stretchScale(W,...args),
    forceChildSize:(...args)=>S.forceClipChildSize(W,...args),
    enableAutoRepeat:(win,...args)=>dispatchWindowHostNative(W,{index:1595,receiver:win,argumentCount:args.length,evaluateArgument:i=>args[i]}),
    changeScalePosition:(...args)=>SM.changeScalePosition(W,...args),
    setTickPosition:(...args)=>SM.setTickPosition(W,...args),
    moveThumb:(...args)=>SM.moveThumb(W,...args),
    setClipPosition:(...args)=>SM.setClipPosition(W,...args),
    getScaleValueString:()=>boundary('Scale.GetValueString 0x1003e460 formatting is not recovered'),
    getCursorPos:(win)=>SI.getCursorPos(W,win),
    setSelectability: (win, selectable) => T.setSelectability(W, win, selectable),
    makeAcceleratorTableDirty: win => T.makeAcceleratorTableDirty(W, win),
    addWindowToTables: (tabGroup, win) => F.addWindowToTables(W, tabGroup, win),
    removeWindowFromTables: (tabGroup, win) => F.removeWindowFromTables(W, tabGroup, win),
    safeDestroy: win => safeDestroy(win),
    invokeTimers: (win, delta) => Timers.invokeTimers(W, win, delta),
    setFocusWindow: (win, target) => Mouse.setFocusWindow(W, win, target),
    getMouseWindow: root => Mouse.getMouseWindow(W, root, null),
    paintCursor: (root, gc, mouse) => Mouse.paintCursor(W, root, gc, mouse),
    moveTabGroup: (win, direction) => moveTabGroupNative(W, win, direction, {...T, ...F, setFocusWindow: (root, target) => Mouse.setFocusWindow(W, root, target)}),
    moveFocus: (win, direction, wrap) => Mouse.moveFocus(W, win, direction, wrap,
      {getTabGroupWindow: T.getTabGroupWindow, moveTabGroup: (root, move) => W.native.moveTabGroup(root, move)}),
    // XButtonWindow::ActivateButton 0x100077e0 through its existing translation.
    activateButton: (win, key) => activateButtonNative(win, key, {read: (object, offset, kind) => heap.read(object, offset, offset === 0 && kind === 'ptr' ? 'u32' : kind),
      activateButton: ({object, source, virtualSlot}) => virtualSlot === 0xec ? V.buttonActivatedRight(object, source) : V.buttonActivated(object, source)}),
    playSound: (...args)=>windowPlaySound(W,...args),
  };
  const soundRequests = [];

  // Placeholders filled by the layout/draw sections below (hoisted functions).
  function windowPreferredSize(win, bW, w, bH, h) {                                    // 0x10050390
    const args = [Boolean(bW), f(w), Boolean(bH), f(h)];
    processScript(win, 'ParentRequestedPreferredSize', args);
    return {width: f(args[1]), height: f(args[3])};
  }
  const textPreferredSize=(...args)=>L.textPreferredSize(W,...args);
  const tileComputeChildSizes=(...args)=>L.tileComputeChildSizes(W,...args);
  const tabGroupPreferredSize=(...args)=>L.tabGroupPreferredSize(W,...args);
  const radioBoxPreferredSize=(...args)=>L.radioBoxPreferredSize(W,...args);
  const tileConfigurationChanged=(win)=>L.tileConfigurationChanged(W,win);
  const tabGroupConfigurationChanged=(win)=>L.tabGroupConfigurationChanged(W,win);
  const radioBoxConfigurationChanged=(win)=>L.radioBoxConfigurationChanged(W,win);
  function textLogConfigurationChanged(win) { return Log.textLogConfigurationChanged(W,win); }
  function radioBoxDescendantAdded(win, child) {                                         // 0x10038b90 (after the script bridge)
    if (!W.isA(child, 'extension.togglewindow')) return;
    let w = child;
    while (w && !W.isA(w, 'extension.radioboxwindow')) w = W.ptr(w, T.O.parent);
    if (w !== win) return;
    const index = W.farray.add(win, 0x178, 1, 4);
    W.farray.setPtr(win, 0x178, index, child);
  }
  // XRadioBoxWindow::DescendantRemoved 0x10038cb0: FindItem in the +0x178
  // toggle array; a found entry clears the +0x184 selection when it is that
  // entry and is removed (FArray::Remove(i, 1, 4)). The script bridge follows.
  function radioBoxDescendantRemoved(win, child) {
    const count = W.farray.num(win, 0x178);
    let index = 0;
    while (index < count && W.farray.ptr(win, 0x178, index) !== child) index++;
    if (index < count) {
      if (W.ptr(win, 0x184) === W.farray.ptr(win, 0x178, index)) W.setPtr(win, 0x184, null);
      W.farray.remove(win, 0x178, index, 1, 4);
    }
    processScript(win, 'DescendantRemoved', [child]);
  }
  // XRootWindow::DescendantRemoved 0x1003b5c0: forget +0x624 (the last
  // button window) with its GLog line, then XModalWindow's body.
  function rootDescendantRemoved(win, child) {
    if (W.ptr(win, 0x624) !== child) return;
    boundaryLog.push({log: 'GLog', text: `Tried to remove lastbuttonwindow descendant. ${objectFullName(child)}`});
    W.setPtr(win, 0x624, null);
  }
  function objectFullName(object) {
    const path = [];
    for (let at = object; at; at = at.outer) path.unshift(at.name);
    return `${runtime.instance(object).cls.record.name} ${path.join('.')}`;
  }
  function radioBoxToggleChanged(win,button,toggle) { // 10038a60
    if(is(button,'extension.togglewindow')){
      if(toggle){
        for(let i=0;i<W.farray.num(win,0x178);i++)if(W.farray.ptr(win,0x178,i)===button){
          const old=W.ptr(win,0x184);if(old===button)return 1;
          W.setPtr(win,0x184,button);if(old)setToggleNative(old,0,lifecycle.toggle);break;
        }
      }else if(W.u8(win,0x174)&1){
        if(W.ptr(win,0x184)===button)setToggleNative(button,1,lifecycle.toggle);return 1;
      }else if(W.ptr(win,0x184)!==button)return 1;
      else W.setPtr(win,0x184,null);
    }
    return processScript(win,'ToggleChanged',[button,Boolean(toggle)],{result:false})?1:0;
  }
  function changeButtonAppearance(win) { return D.changeButtonAppearance(W,win); }
  function buttonTick(win,delta) { return D.buttonTick(W,win,delta); }
  function textLogTick(win,delta) { return Log.textLogTick(W,win,delta); }
  function rootTickVirtual(win,delta) { return rootTickNative(W,win,delta,{...T,...F,setFocusWindow:(root,target)=>Mouse.setFocusWindow(W,root,target)}); }
  function textDraw(win,gc) { return D.textDraw(W,win,gc); }
  function buttonDraw(win,gc) { return D.buttonDraw(W,win,gc); }
  function textLogDraw(win,gc) { return Log.textLogDraw(W,win,gc); }
  // ------------------------------------------------------------------
  // Destruction: the recovered SafeDestroy/PreDestroy/KillAllChildren/CleanUp
  // order (script-window-destroy.mjs) over each family's own CleanUp and
  // deleting destructor. docs/script-window-destroy.md.
  // ------------------------------------------------------------------
  const UOBJECT_FLAGS = 0x1c, RF_DESTROYED = 0x00800000, RF_BASE_DESTROYED = 0x80000000;
  const DESTROY_FAMILIES = {
    // Recovered scroll-family owning members and inherited cleanup routes.
    // docs/script-window-scroll-cleanup.md; native allocator ownership remains external.
    'extension.scalemanagerwindow': {},
    'extension.scrollareawindow': {},
    'extension.scalewindow': {members:win=>cleanScaleMembers(W,win),destructor:win=>destroyScaleMembers(W,win)},
    'extension.clipwindow': {members:win=>tabGroupCleanUp(win),destructor:win=>{W.farray.empty(win,0x158,4);W.farray.empty(win,0x14c,4);}},
    // XWindow::CleanUp 0x1004bec0 and deleting destructor 0x10004860.
    'extension.window': {},
    // XTextWindow::CleanUp 0x10045c30 empties the text FString (+0x168)
    // before XWindow::CleanUp; ~XTextWindow 0x10008d40 finalizes it again.
    'extension.textwindow': {members: win => W.heap.write(win, 0x168, 'string', '')},
    // XTileWindow::CleanUp 0x10048430 / ~XTileWindow 0x10014ee0: the
    // 12-byte-element FArray at +0x168.
    'extension.tilewindow': {members: win => W.farray.empty(win, 0x168, 0xc)},
    // XButtonWindow::CleanUp 0x10007770 is XTextWindow::CleanUp; ~XButtonWindow
    // 0x100091d0 reaches ~XTextWindow's FString finalization.
    'extension.buttonwindow': {members: win => W.heap.write(win, 0x168, 'string', '')},
    // XToggleWindow::CleanUp 0x100498a0 (also XCheckboxWindow's, 0x1000a7d0)
    // only calls XButtonWindow::CleanUp; ~XToggleWindow/~XCheckboxWindow
    // 0x10009f00 chain down to ~XTextWindow's FString finalization.
    'extension.togglewindow': {members: win => W.heap.write(win, 0x168, 'string', '')},
    // XTabGroupWindow::CleanUp 0x10044ea0: leave an enclosing modal's table,
    // then empty the row/column tables; ~XTabGroupWindow destroys them.
    'extension.tabgroupwindow': {members: win => tabGroupCleanUp(win), destructor: win => tabGroupTables(win)},
    // XRadioBoxWindow::CleanUp 0x10038710 empties the +0x178 toggle array,
    // clears the +0x184 selection, then XTabGroupWindow::CleanUp;
    // ~XRadioBoxWindow 0x10015680 frees +0x178, then ~XTabGroupWindow.
    'extension.radioboxwindow': {
      members: win => { W.farray.empty(win, 0x178, 4); W.setPtr(win, 0x184, null); tabGroupCleanUp(win); },
      destructor: win => { W.farray.empty(win, 0x178, 4); tabGroupTables(win); },
    },
    // XTextLogWindow::CleanUp 0x100475b0 is XTextWindow::CleanUp;
    // ~XTextLogWindow 0x100145c0 frees the 20-byte log rows at +0x178.
    'extension.textlogwindow': {members: win => W.heap.write(win, 0x168, 'string', ''), destructor: win => W.farray.empty(win, 0x178, 20)},
    // XModalWindow::CleanUp 0x10036cf0: RemoveTabGroupFromTable(self), empty the
    // +0x17c tab-group table, ClearAcceleratorTable, then XTabGroupWindow::CleanUp.
    // ~XModalWindow 0x10005110 destroys +0x17c, then ~XTabGroupWindow's tables.
    'extension.modalwindow': {
      members: win => {
        F.removeTabGroupFromTable(W, win, win);
        W.farray.empty(win, 0x17c, 4);
        F.clearAcceleratorTable(W, win);
        tabGroupCleanUp(win);
      },
      destructor: win => { W.farray.empty(win, 0x17c, 4); tabGroupTables(win); },
    },
  };
  function tabGroupTables(win) { W.farray.empty(win, 0x14c, 4); W.farray.empty(win, 0x158, 4); }
  function tabGroupCleanUp(win) {
    const modal = T.getModalWindow(W, win);
    if (modal && modal !== win) F.removeTabGroupFromTable(W, modal, win);
    tabGroupTables(win);
  }
  function destroyFamily(win) {
    const spec = DESTROY_FAMILIES[families.get(win)];
    if (!spec) boundary(`Window destruction is not recovered for ${families.get(win) ?? 'an unadmitted window'}`);
    return spec;
  }
  // Core ConditionalDestroy 0x1014fdb0 with XWindow::Destroy 0x1004c010 as
  // the virtual: PreDestroy (already bBeingDestroyed), the zero-lock
  // assertion, then UObject::Destroy (RF flag and ExitProperties).
  function conditionalDestroyWindow(win) {
    const flags = W.u32(win, UOBJECT_FLAGS);
    if (flags & RF_DESTROYED) return false;
    W.setU32(win, UOBJECT_FLAGS, flags | RF_DESTROYED);
    preDestroyWindowNative(win, destroyServices);
    if (W.i32(win, T.O.lock) > 0) boundary('XWindow::Destroy asserts a zero lock count');
    W.setU32(win, UOBJECT_FLAGS, W.u32(win, UOBJECT_FLAGS) | RF_BASE_DESTROYED);
    runtime.exitProperties(win);
    return true;
  }
  // XGC deleting destructor -> ~XGC 0x10002c70 -> XGC::Destroy 0x10026d40 for
  // a window's own (unpushed) GC: PopGC(0), then every free-list node is
  // unlinked and deleted, with a GLog warning past 16. Host GCs have no
  // registry slot and the host heap never frees.
  function destroyGc(gc) {
    const Lg = gcMemory(gc, gcServices), base = Lg.base;
    if (Lg.read(base + GC.owner, 'u32') !== 0) boundary('Destroying a pushed XGC node is not recovered');
    gcPopGC(gc, 0, gcServices);
    let count = 0;
    for (let node = Lg.read(base + GC.freeList, 'u32'); node; node = Lg.read(base + GC.freeList, 'u32')) {
      Lg.write(base + GC.freeList, 'u32', Lg.read(node + GC.stackTop, 'u32'));
      count++;
    }
    if (count > 16) boundaryLog.push({log: 'GLog', text: `***WARNING: GC contains an abnormally large GC stack! (${count})`});
  }
  const destroyServices = {
    ...rawServices,
    setVisibility: ({object, visible}) => setVisibility(object, visible),
    setSelectability: ({object, selectable}) => T.setSelectability(W, object, selectable),
    processScript: ({object, event, parameters, thirdArgument}) => {
      if (parameters !== null) boundary('Window destruction ProcessScript with parameters');
      return processScript(object, event, [], {checked: thirdArgument !== 0});
    },
    cleanUp: ({object, baseCleanUp}) => { destroyFamily(object).members?.(object); return baseCleanUp(); },
    childRemoved: ({parent, child}) => V.childRemoved(parent, child),
    descendantRemoved: ({ancestor, child}) => V.descendantRemoved(ancestor, child),
    // XWindow::CleanUp frees each timer node through GMalloc->Free.
    freeGc: ({object}) => {
      if (!timerNodes.delete(object)) boundary('Window timer list release reached a node the timer allocator did not create');
    },
    destroyGc: ({object}) => destroyGc(object),
    // The whole scalar deleting destructor: the family members after its own
    // ConditionalDestroy, then the XWindow and XExtensionObject steps, ~UObject
    // (host windows have no registry slot) and operator delete.
    deleteWindow: ({object}) => {
      const spec = destroyFamily(object);
      conditionalDestroyWindow(object);
      (spec.destructor ?? spec.members)?.(object);
      conditionalDestroyWindow(object);
      conditionalDestroyWindow(object);
      destroyed.add(object);
      families.delete(object);
    },
  };
  function safeDestroy(win) { return safeDestroyWindowNative(win, destroyServices); }

  // ------------------------------------------------------------------
  // Lifecycle published to the shared runtime natives (windowLifecycle).
  // ------------------------------------------------------------------
  const actorRefs=createWindowActorRefDispatcher(W,{isDeleted:actor=>runtime.namedReference(actor,'bDeleteMe').get()});
  const lifecycle = {
    host: null,
    errorDevice: {name: 'GError'},
    isScriptable: () => true,
    handleNative: call => {
      const sound=dispatchWindowSoundNative(W,call);if(sound.handled)return sound;
      const reference=actorRefs(call);if(reference.handled)return reference;
      const input=inputConsole.playerConsoleCommand(call);if(input.handled)return input;
      const gc=dispatchGcNative(heap,gcServices,call);
      return gc.handled?gc:dispatchWindowHostNative(W,call);
    },
    hierarchy: {readParent: object => heap.read(object, T.O.parent, 'ptr'), readType: object => heap.read(object, T.O.type, 'u8')},
    reconfiguration, configureChild: configureChildServices, visibility,
    // Window.SetFocusWindow (1440) runs script-window-focus.mjs with these leaves.
    focus: Mouse.focusServices(W),
    sensitivity: {...rawServices,
      checkFocusWindow: ({object})=>T.checkFocusWindow(W,object),
      checkGrabbedWindow: ({object})=>T.checkGrabbedWindow(W,object),
      makeAcceleratorTableDirty: ({object})=>T.makeAcceleratorTableDirty(W,object),
      notifySensitivityChanged: ({object,sensitive})=>T.invokeSensitivityChange(W,object,sensitive)},
    size: rawServices, position: rawServices,
    // TextWindow.SetText reaches XWindow::SetAcceleratorKey when the text is
    // the accelerator (+0x150 textIsAccelerator), which dirties the modal's table.
    text: {...rawServices, makeAcceleratorTableDirty: ({object})=>T.makeAcceleratorTableDirty(W,object)},
    toggle: {...rawServices,
      read:(object,offset,kind)=>heap.read(object,offset,kind==='ptr'&&([0x188,0x18c].includes(offset)||(offset>=0x1a4&&offset<0x1ec&&(offset-0x1a4)%12!==0))?'u32':kind),
      toggleChanged:({object,source,toggle})=>V.toggleChanged(object,source,toggle)},
    changeStyle:{...rawServices,dispatchVirtual:({object})=>V.styleChanged(object)},
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
    destroy: destroyServices,
  };
  const gcServices = {mem: heap.mem, objectAddress: object => object.base??heap.objectAddress(object),
    allocateObject: ()=>heap.allocRaw(GC.size),constructUObject: ()=>{},
  };
  const drawCommands=[];
  const canvas={name:'PlayHUDCanvas'};heap.allocate(canvas,0x80);
  const sceneFrame={name:'HUDSceneFrame'};heap.allocate(sceneFrame,0x300);
  const viewport=heap.allocRaw(0xc0),node=heap.addressOf(sceneFrame),renderInterface=heap.allocRaw(4),renderTable=heap.allocRaw(0x100),canvasTable=heap.allocRaw(0x60);
  const put=(at,off,value,kind='u32')=>heap.mem.write(at+off,kind,value);
  W.setU32(canvas,0,canvasTable);put(canvasTable,0x5c,4);
  W.setU32(canvas,0x78,viewport);W.setU32(canvas,0x7c,node);put(node,0,viewport);
  put(viewport,0x64,renderInterface);put(renderInterface,0,renderTable);put(renderTable,0x7c,3);
  gcServices.texCache={records:Array.from({length:5},()=>heap.allocRaw(0x84)),static:heap.allocRaw(0x84),head:0,count:0};
  gcServices.callVirtual=(slot,object,command)=>{
    if(slot===1){put(command.record,0,object);return;}
    if(slot===2)return;
    if(slot!==3&&slot!==4)boundary(`Unknown HUD renderer virtual ${slot}`);
    const pointer=slot===3?heap.mem.read(command.record,'u32'):command.texture;
    const resource=resourceImages.get(pointer);if(!resource)boundary(`Unknown HUD texture pointer ${pointer}`);
    drawCommands.push({texture:resource.ref,x:bitsToF32(command.x),y:bitsToF32(command.y),
      width:bitsToF32(command.xl),height:bitsToF32(command.yl),u:bitsToF32(command.u),v:bitsToF32(command.v),
      ul:bitsToF32(command.ul),vl:bitsToF32(command.vl),
      color:command.color.slice(0,3).map(bits=>bitsToF32(bits)*255),
      style:command.polyFlags&4?3:command.polyFlags&0x40?4:command.polyFlags&2?2:1});
  };
  W.gc = {
    services:gcServices,
    get(win){const gc=W.ptr(win,T.O.wGc);if(gc){gcPushGC(gc,gcServices);gcCopyGC(gc,heap.addressOf(W.ptr(win,T.O.gGc)),gcServices);}return gc;},
    release(_win,gc){if(gc)gcPopGC(gc,-1,gcServices);},
    // XGC::GetTextExtent writes the X and Y extents; the layout bodies read them
    // as the text width and height.
    textExtent:(gc,width,text)=>{
      const extent=gcGetTextExtent(gc,width,text,gcServices);
      return {width:extent.xExtent,height:extent.yExtent};
    },
    fontHeight:(gc,space)=>gcGetFontHeight(gc,space,gcServices),
    push:gc=>gcPushGC(gc,gcServices),pop:(gc,depth)=>gcPopGC(gc,depth,gcServices),
    setCanvas:(gc,canvas)=>W.setPtr(gc,GC.canvas,canvas), // XGC::SetCanvas 0x10026ec0
    setMultipliers:(gc,h,v)=>{W.setI32(gc,0x9c,h);W.setI32(gc,0xa0,v);}, // 0x10026ed0
    enableDrawing:(gc,enabled)=>gcEnableDrawing(gc,enabled,gcServices),
    // XGC::SetStyle 0x10027170, SetTileColor 0x100274f0 and DrawIcon 0x100289c0.
    setStyle:(gc,style)=>gcSetStyle(gc,style,gcServices),
    setTileColor:(gc,color)=>gcSetTileColor(gc,color>>>0,gcServices),
    drawIcon:(gc,x,y,texture)=>gcDrawIcon(gc,f32BitsOf(x),f32BitsOf(y),heap.addressOf(texture),gcServices),
    drawIconPattern:(gc,x,y,w,h,u,v,ul,vl,texture)=>gcTileEmitGate(gcMemory(gc,gcServices),{x,y,w,h,u,v,ul,vl,texture:heap.addressOf(texture)}),
    cleanUp(){ // XGC::CleanUp 100269b0 -> cache flush 10026a20.
      const cache=gcServices.texCache;
      for(const record of cache.records){
        const texture=heap.mem.read(record,'u32');
        if(texture)gcServices.callVirtual(2,texture,{record});
        heap.mem.write(record,'u32',0);heap.mem.write(record+0x80,'u32',0);
      }
      cache.head=0;cache.count=0;
    },
  };

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
    host.root=root;host.hud=runtime.namedReference(root,'hud').get();
    const augManager=runtime.namedReference(pawn,'AugmentationSystem').get();
    if(augManager)runtime.dispatchSpawnedEvent(augManager,'RefreshAugDisplay',[]);
    return root;
  }

  const host = {
    runtime, heap, W, lifecycle, classes, globals, boundaryLog, soundRequests, resourceImages, textureInfo,
    root:null,hud:null,owns:object=>families.has(object),
    // Original Engine Actor.EInputKey names (index = EInputKey value).
    inputKeyNames:inputConsole.names,
    delegateLegacySubtree:object=>externalSubtrees.add(object),
    raw:{allocate:heap.allocate,read:heap.read,write:heap.write,addressOf:heap.addressOf},
    families: win => families.get(win) ?? null,
    isDestroyed: win => destroyed.has(win),
    processScript, constructRootWindow, configureChild, askParentForReconfigure, setVisibility,
    canvas,node,
    tick(root,seconds){lastTickTime=performance.now()/1000;T.rootTick(W,root,f(seconds));},
    // XInputExt::Process 0x1002d0b0 offers each key to XRootWindow::Process first.
    key(root,key,action,delta=0){return Input.rootProcess(W,root,key,action,delta);},
    // Browser/viewport adapter into the already recovered root mouse route.
    // Coordinates are drawing-buffer pixels, matching the root canvas size.
    pointer(root,{x=0,y=0,dx=0,dy=0,relative=false,key=null,action=null}){
      if(!W.i32(root,Input.ROOT_INPUT.mouseGrab))return false;
      const px=relative?f(W.f32(root,Mouse.MOUSE.mouseX)+f(dx)):f(x);
      const py=relative?f(W.f32(root,Mouse.MOUSE.mouseY)+f(dy)):f(y);
      Mouse.setRootCursorPos(W,root,px,py);
      if(key!==null&&action!==null)Input.rootProcess(W,root,key,action);
      return true;
    },
    draw(root,width,height,view){
      if(view){writeWindowSceneFrame(W,node,{...view,width,height,renderMode:5});W.setPtr(root,0x740,sceneFrame);}
      W.setF32(canvas,0x3c,width);W.setF32(canvas,0x40,height);
      T.resizeRoot(W,root,canvas);T.reconfigureTree(W,root,0);T.initializeWindows(W,root);
      drawCommands.length=0;T.paintWindows(W,root,canvas);return drawCommands.slice();
    },
    install() {
      runtime.windowLifecycle = {...runtime.windowLifecycle, ...lifecycle};
      // Multiplayer is explicitly deferred. Original single-player InitWindow
      // invokes this key-rebinding helper, but Training does not need it.
      runtime.boundaryFunctions.set('deusex.deusexrootwindow.conditionalbindmultiplayerkeys',()=>{
        boundaryLog.push({function:'DeusExRootWindow.ConditionalBindMultiplayerKeys',reason:'Multiplayer key initialization deferred'});
      });
      return host;
    },
  };
  lifecycle.host = host;
  return host;
}
