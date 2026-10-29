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
import {hostNow} from './host-clock.mjs';
import {bumpReceiverEpoch} from './receiver-epoch.mjs';
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
import {initTextWindowNative, setTextMarginsNative, WINDOW_TEXT_OFFSETS} from './script-window-text.mjs';
import {constructTileWindow, initTileWindow} from './script-window-tile.mjs';
import {constructComputerWindowNative, initComputerWindowNative} from './script-window-computer.mjs';
import * as Computer from './script-window-computer-playback.mjs';
import {resizeWindowNative} from './script-window-size.mjs';
import {setWindowAlignmentsNative} from './script-window-alignments.mjs';
import {askParentForReconfigureNative, WINDOW_RECONFIGURE_GLOBALS} from './script-window-reconfigure.mjs';
import {configureChildNative, WINDOW_CONFIGURE_CHILD_GLOBALS} from './script-window-configure-child.mjs';
import {boundsUpdateNative} from './script-window-bounds-update.mjs';
import {setVisibilityNative, setChildVisibilityNative} from './script-window-visibility.mjs';
import {cleanUpWindowNative, preDestroyWindowNative, safeDestroyWindowNative} from './script-window-destroy.mjs';
import {updatePolyFlagsFromFlags, gcMemory, GC} from './script-gc-state-model.mjs';
import {decodeFontExport, writeFontImage, UFONT, FONT_PAGE} from './script-font-model.mjs';
import {readObject} from '../unreal/objects.mjs';
import {readTexture} from '../unreal/textures.mjs';
import {refValue, assign} from './script-vm.mjs';
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
import {createConsoleCommands, DEFAULT_DISPLAY_MODES} from './script-console-command.mjs';
import {createNativeConfig} from './script-native-config.mjs';
import {rootTickNative,moveTabGroupNative} from './script-window-root-tick.mjs';
import {dispatchWindowSoundNative,windowPlaySound} from './script-window-sound.mjs';
import {createWindowActorRefDispatcher, addActorReference, removeActorReference, isActorReferenceValid} from './script-window-actor-refs.mjs';
import {writeWindowSceneFrame} from './script-window-scene-frame.mjs';
import {rootRenderViewport} from './script-root-render-viewport.mjs';
import {setToggleNative} from './script-window-toggle-set.mjs';
import * as Timers from './script-window-timers.mjs';
import * as Input from './script-window-input.mjs';
import * as TK from './script-window-typed-keys.mjs';
import * as VP from './script-window-viewport.mjs';
import {writeWindowSceneFrame as writeViewportFrame} from './script-window-scene-frame.mjs';
import {gcDrawPattern as gcDrawPatternBody} from './script-gc-draw-pattern.mjs';
import {gcSetTileColor as gcSetTileColorBody} from './script-gc-set-tile-color.mjs';
import {f32Bits as viewportF32Bits} from './script-gc-draw-model.mjs';
import * as Mouse from './script-window-mouse.mjs';
import {rootVectorToCoordinates,windowVectorToCoordinates} from './script-window-projection.mjs';
import {activateButtonNative} from './script-window-activate-button.mjs';
import * as LT from './script-window-large-text.mjs';
import * as ED from './script-window-edit.mjs';
import * as LIST from './script-window-list.mjs';
import {scaleDraw} from './script-window-scale-draw.mjs';
import {listMemory} from './script-window-list-model.mjs';
import {gcGetTextExtent as gcTextExtent} from './script-gc-get-text-extent.mjs';
import {editMemory, cleanUpUndo, setTextVirtual, textChangedRange} from './script-edit-model.mjs';
import {dispatchEditWindowNative} from './script-window-edit-natives.mjs';
import {isKeyDownNative} from './script-window-is-key-down.mjs';
import {enableTextAsAcceleratorNative} from './script-window-text.mjs';
import {textWindowGetText} from './script-text-get-text.mjs';
import {textWindowGetTextLength} from './script-text-get-text-length.mjs';
import {releaseHandle} from './script-object-handles.mjs';
import {createWindowFArray} from './script-window-farray.mjs';
import {potCeiling} from './script-root-snapshot.mjs';
import {constructNativeObject} from './script-player-log.mjs';
import {plainTexture} from './script-window-plain-texture.mjs';
import {HudCommandStream} from './script-window-command-stream.mjs';

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
  'extension.largetextwindow': {vtable: LT.LARGE_TEXT.vtable},
  'extension.editwindow': {vtable: ED.EDIT.vtable},
  'extension.listwindow': {vtable: LIST.LIST.vtable},
  'extension.viewportwindow': {vtable: VP.VIEWPORT.vtable},
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
    'radioboxwindow', 'textlogwindow', 'modalwindow', 'rootwindow', 'computerwindow', 'largetextwindow', 'editwindow', 'listwindow', 'viewportwindow', 'gc', 'extensionobject']],
  ['DeusEx', ['deusexrootwindow', 'deusexhud', 'hudbasewindow', 'hudsharedborderwindow', 'hudammodisplay',
    'hudhitdisplay', 'crosshair', 'hudobjectbelt', 'hudobjectslot', 'hudactiveitemsdisplay',
    'hudactiveitemsborderbase', 'hudactiveaugsborder', 'hudactiveitemsborder', 'hudactiveitembase',
    'hudactiveaug', 'hudactiveitem', 'damagehuddisplay', 'hudcompassdisplay', 'hudmultiskills',
    'hudinformationdisplay', 'hudlogdisplay', 'frobdisplaywindow', 'augmentationdisplaywindow',
    'hudmissionstarttextdisplay', 'hudbarkdisplay', 'hudreceiveddisplay', 'actordisplaywindow',
    'deusexscopeview', 'progressbarwindow', 'hudinfolinkdisplay', 'hudconwindowfirst', 'staticwindow',
    'colorthememanager', 'colortheme']],
]);

export async function createWindowHost({runtime, assets, player, gameConfig = null, log = null}) {
  if (!runtime?.attach || !assets?.get) throw new TypeError('Window host requires ScriptRuntime and AssetStore');
  const inputConsole=await createInputConsole(runtime,assets);
  // UEngine::InputEvent -> XInputExt::Process -> bindings -> the viewport's
  // Exec chain; also PlayerPawn.ConsoleCommand (docs/script-console-command.md).
  const isA=(object,key)=>{for(let cls=runtime.instance(object).cls;cls;cls=cls.base)if(cls.record.key===key)return true;return false;};
  const input={hostBinding:()=>false,flushRenderDevice:null,platformKeys:new Uint8Array(255),mouseDeltaX:0,mouseDeltaY:0};
  let updatePlatformInput=()=>boundary('UWindowsViewport::UpdateInput has no browser key snapshot adapter');
  // UViewport SizeX/SizeY (+0x78/+0x7c): the browser drawing buffer the root
  // canvas is painted at, set by each HUD frame (UWindowsViewport::ResizeViewport's
  // place). Unknown until the first frame or an explicit resizeViewport.
  let viewportSize=null;
  const resizeViewport=(sizeX,sizeY)=>{
    if(!Number.isInteger(sizeX)||!Number.isInteger(sizeY)||sizeX<0||sizeY<0)
      throw new TypeError('Viewport size must be two non-negative integers');
    viewportSize={sizeX,sizeY};
  };
  // The native config classes behind `get/set ini:Engine.Engine.<Device> <Property>`
  // (docs/script-native-config.md). The live audio objects belong to the current level.
  const nativeConfig=createNativeConfig({gconfig:await runtime.classLoader.prepareConfig(),audio:()=>runtime.audio??null});
  /** What the render device last took from the client config on a Flush (docs/script-native-config.md). */
  // fullscreenToggles / relaunches / exitRequests count the host requests the Exec chain made (UWindowsViewport::Exec ToggleFullscreen,
  // USystem::Exec RELAUNCH and EXIT/QUIT); the page performs each once (docs/host-services.md).
  // `fullscreen`: whether the viewport is fullscreen (the BLIT_Fullscreen flag SetRes passes as IsFullscreen()): the client's
  // StartupFullscreen until the page says (the browser's fullscreen is the page's; main.mjs reports it).
  const display={brightness:nativeConfig.instance('WinDrv.WindowsClient','Brightness'),flushes:0,resolution:null,resolutionVersion:0,
    fullscreen:Boolean(nativeConfig.instance('WinDrv.WindowsClient','StartupFullscreen')),fullscreenToggles:0,relaunches:0,relaunchArguments:null,exitRequests:0,
    // RootWindow.GenerateSnapshot's requests to the page (docs/root-snapshot.md): the frame the page last drew is the texture's source.
    snapshotRequests:[],snapshotSerial:0,snapshotReleased:[],
    // Textures whose pixels the simulation holds (a SaveInfo's Snapshot, W.snapshot.adopt): sent to the page once each, in the next frame snapshot.
    images:[],imageSerial:0};
  // DDeusExGameEngine::Exec's SAVEGAME n and DELETEGAME n (DeusEx 0x1000ed70): the session that saves games installs the bodies (game-save.mjs).
  const gameEngineHooks={saveGame:null,deleteGame:null};
  const consoleCommands=createConsoleCommands({runtime,input:inputConsole,services:{
    gameEngine:gameEngineHooks,
    nativeConfig:()=>nativeConfig,
    // UWindowsViewport::Exec SetRes -> RenDev->SetRes: the browser render device takes the request.
    setResolution(request){display.resolution={...request};display.resolutionVersion++;},
    viewportFullscreen:()=>display.fullscreen,
    toggleFullscreen(){display.fullscreenToggles++;},
    relaunch(args){display.relaunchArguments=args;display.relaunches++;},
    // appRequestExit(0) (Core 0x1016b2f0): its GLog line, then GIsRequestingExit for the host
    requestExit(){log?.('Log','appRequestExit(0)');display.exitRequests++;},
    viewportSize(){
      if(!viewportSize)boundary('UViewport SizeX/SizeY are unknown before the first frame');
      return viewportSize;
    },
    // The display modes UD3DRenderDevice enumerated (GetRes): a host input. On a real display the mode the game runs in is one
    // of them, so MenuChoice_Resolution.LoadSetting finds GetCurrentRes in GetRes's list; the page's size is not one of the
    // default modes, and without it there the choice falls back to its first mode and the Display screen's OK set 640x480.
    // The default modes plus the viewport's own size, in ascending order.
    displayModes(){
      const modes=[...DEFAULT_DISPLAY_MODES];
      if(viewportSize&&!modes.some(mode=>mode.width===viewportSize.sizeX&&mode.height===viewportSize.sizeY))
        for(const bits of [16,32])modes.push({width:viewportSize.sizeX,height:viewportSize.sizeY,bits});
      return modes.sort((a,b)=>a.width-b.width||a.height-b.height||a.bits-b.bits);
    },
    viewport(){
      const viewport=runtime.readNamed(player,'Player');
      if(!viewport)throw new Error('Console commands require the local UViewport');
      return viewport;
    },
    // XInputExt::Process: a PlayerPawnExt viewport actor's root (+0x894) first.
    rootProcess(key,action,delta){
      const actor=runtime.readNamed(runtime.readNamed(player,'Player'),'Actor');
      if(!actor||!isA(actor,'extension.playerpawnext'))return false;
      const root=runtime.readNamed(actor,'rootWindow');
      return Boolean(root&&Input.rootProcess(W,root,key,action,delta));
    },
    // XInputExt::Key 0x1002d2b0's IsA(APlayerPawnExt) and XRootWindow::Key.
    isPlayerPawnExt:actor=>isA(actor,'extension.playerpawnext'),
    rootKey:(root,key)=>TK.rootKey(W,root,key),
    hostBinding:(key,action)=>input.hostBinding(key,action),
    flushRenderDevice:allow=>{
      input.flushRenderDevice?.(allow);
      // UD3DRenderDevice::Flush 0x10002e32 re-reads Client->Brightness (+0x6c) for the gamma ramp.
      display.brightness=nativeConfig.instance('WinDrv.WindowsClient','Brightness');display.flushes++;
    },
    // ResetInput clears UInput's held table before WinDrv polls the platform.
    // The browser's event-fed device snapshot is kept separately and replayed
    // through InputEvent in native key order.
    updateInput(viewport,immediate){
      if(immediate!==0&&immediate!==1)boundary(`Unsupported UWindowsViewport::UpdateInput mode ${immediate}`);
      if(viewport!==runtime.readNamed(player,'Player'))boundary('UWindowsViewport::UpdateInput requires the local viewport');
      updatePlatformInput(viewport,immediate);
    },
  }});
  const nativeMouseKey=name=>inputConsole.names.findIndex(candidate=>candidate?.toLowerCase()===`ik_${name}`.toLowerCase());
  updatePlatformInput=(_viewport,immediate)=>{
    // UWindowsViewport::UpdateInput accumulates integer cursor movement and
    // delivers MouseX/MouseY axis edges before its GetKeyState reconciliation.
    const dx=input.mouseDeltaX,dy=input.mouseDeltaY;
    input.mouseDeltaX=0;input.mouseDeltaY=0;
    if(dx){const key=nativeMouseKey('MouseX');if(key<0)boundary('Engine EInputKey IK_MouseX is not linked');consoleCommands.inputEvent(key,4,Math.fround(dx));}
    if(dy){const key=nativeMouseKey('MouseY');if(key<0)boundary('Engine EInputKey IK_MouseY is not linked');consoleCommands.inputEvent(key,4,Math.fround(-dy));}
    for(let key=0;key<input.platformKeys.length;key++)
      if(consoleCommands.state.held[key]&&!input.platformKeys[key])
        consoleCommands.inputEvent(key,3,0);
      else if(immediate===1&&input.platformKeys[key]&&!consoleCommands.state.held[key])
        consoleCommands.inputEvent(key,1,0);
  };
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
  // RootWindow.GenerateSnapshot returns an Engine.Texture (the exec's UTexture subclass, vtable 0x100613e8).
  const snapshotTextureClass = await loadClass(packages.get('Engine'), 'texture');
  for (const field of snapshotTextureClass.propertyLink ?? []) await runtime.field(field);
  const gcClass = classes.get('extension.gc');
  for(const path of ['augmentation.gethotkey','augmentation.isactive','augmentationmanager.refreshaugdisplay','deusexplayer.clearaugmentationdisplay','deusexplayer.addaugmentationdisplay','deusexplayer.updateaugmentationdisplaystatus'])await runtime.prepareFunction(deusEx,deusEx.exportsByPath.get(path));
  // These globalconfig fields are consumed by original HUD Init/UpdateSettings.
  // Keep compiled defaults where the supplied installation has no scalar.
  const config=inputConsole.config;
  for(const name of ['bObjectNames','bObjectBeltVisible','bHitDisplayVisible','bAmmoDisplayVisible','bDisplayAmmoByClip',
    'bAugDisplayVisible','bCompassVisible','bCrosshairVisible','bHUDShowAllAugs',
    'bHUDBordersVisible','bHUDBordersTranslucent','bHUDBackgroundTranslucent']){
    const value=config.get('DeusEx.DeusExPlayer',name);
    if(value!==undefined)runtime.writeNamed(player,name,/^(true|1)$/i.test(value));
  }
  for(const [name,convert] of [['logTimeout',Math.fround],['maxLogLines',v=>Number(v)&255],
    ['translucencyLevel',v=>Number(v)&255],['MenuThemeName',String],['HUDThemeName',String]]){
    const value=config.get('DeusEx.DeusExPlayer',name);
    if(value!==undefined)runtime.writeNamed(player,name,convert(value));
  }
  const themeManager=runtime.readNamed(player,'ThemeManager');
  if(themeManager)for(const prefix of ['Menu','HUD'])runtime.dispatchSpawnedEvent(themeManager,`Set${prefix}ThemeByName`,[runtime.readNamed(player,`${prefix}ThemeName`)]);
  for(const path of ['deusexplayer.activatebelt','deusexplayer.restrictinput'])await runtime.prepareFunction(deusEx,deusEx.exportsByPath.get(path));


  // ------------------------------------------------------------------
  // Native heap with resource images for textures and fonts.
  // ------------------------------------------------------------------
  const resourceImages = new Map();      // heap address -> {kind, ref, ...}
  const textureInfo = new Map();          // texture ref -> {address, width, height}
  // The arena range lets the Rust core's GC natives address the heap
  // (script-vm-gc.mjs); a release invalidates its cached addresses.
  const heap = createNativeHeap({external: (value, api) => materialize(value, api), arena: runtime.objectArena?.(),
    onRelease: () => runtime.scriptVm?.gc?.invalidate()});
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
  // A font loaded through the shared graph (DynamicLoadObject) carries the
  // original UFont::Serialize result: use its CharactersPerPage, Pages and
  // glyph arrays instead of re-decoding the export bytes.
  function nativeFontImage(ref, record) {
    const graph = runtime.classLoader.graph;
    const pages = record.instanceValues.get(0x2c);
    const decoded = {charsPerPage: record.instanceValues.get(0x28), pageCount: pages.num,
      pages: pages.data.slice(0, pages.num).map(page => ({chars: page.characters.data
        .slice(0, page.characters.num).map(c => [c.startU, c.startV, c.uSize, c.vSize])}))};
    const font = writeFontImage(heap.mem, decoded), table = heap.mem.read(font + UFONT.pages, 'u32');
    heap.mem.write(font + UFONT.pageMax, 'i32', pages.max);
    for (let page = 0; page < pages.num; page++) {
      const texture = pages.data[page].texture, at = table + page * FONT_PAGE.size;
      heap.mem.write(at + FONT_PAGE.maxChars, 'i32', pages.data[page].characters.max);
      if (!texture) { heap.mem.write(at + FONT_PAGE.texture, 'u32', 0); continue; }
      const linker = graph.slotOf(texture, 0x10), index = graph.slotOf(texture, 0x14) + 1;
      const pageRef = {key: `${ref.key}.page${page}`, asset: linker.asset, index, kind: 'Texture'};
      heap.mem.write(at + FONT_PAGE.texture, 'u32', textureImage(linker.asset, index, pageRef));
    }
    resourceImages.set(font, {kind: 'font', ref});
    return font;
  }
  function fontImage(ref) {
    // Class-default font references are constructed but not preloaded in
    // Play (RF_NeedLoad/RF_NeedPostLoad still set); they keep the decoder.
    const record = runtime.classLoader?.nativeRecords.get(ref);
    if (record?.resourceConstructed === 'Engine.Font' &&
        !(runtime.classLoader.graph.slotOf(record, 0x1c) & 0x01000200)) return nativeFontImage(ref, record);
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
  // The snapshot textures GenerateSnapshot made (docs/root-snapshot.md): script object -> {key, width, height, address}. The page holds
  // their pixels (it made them from its own frame); the native image here only carries the size and the reference the HUD commands name.
  const snapshotTextures = new WeakMap();
  function snapshotTextureImage(info) {
    const address = heap.allocRaw(0x60);
    heap.mem.write(address, 'u32', textureVtable);
    heap.mem.write(address + 0x34, 'i32', info.width);
    heap.mem.write(address + 0x38, 'i32', info.height);
    resourceImages.set(address, {kind: 'texture', ref: {key: info.key, dynamic: true, width: info.width, height: info.height}, width: info.width, height: info.height});
    return address;
  }
  function materialize(value) {
    const snapshot = value && typeof value === 'object' ? snapshotTextures.get(value) : undefined;
    if (snapshot) return snapshot.address;
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
  let lastTickTime=hostNow()/1000;
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
    // Host windows are not GObjObjects records, so neither the collector's
    // root array nor the root-window list membership reaches the Core GC.
    addToRoot: () => {},
    removeFromRoot: () => {},
    isA: (win, key) => { for (let c = runtime.instance(win).cls; c; c = c.base) if (c.record.key === key) return true; return false; },
    setPawnRootWindow: (pawn, root) => runtime.writeNamed(pawn, 'rootWindow',root),
    setPawnField: (pawn, name, value) => runtime.writeNamed(pawn, name,value),
    processScript: (win, event, args, options) => processScript(win, event, args, options),
    mouseClickLog: win => boundaryLog.push({log:'GLog',text:`Assigning Last Button Window to ${objectFullName(win)}`}),
    canvasComputeRenderSize: () => {},
    // XRootWindow::GetWindowsTickOffset(0) 0x1003a3b0 over the host clock.
    tickOffset:()=>Timers.windowsTickOffset(hostNow()/1000,lastTickTime),
    // XWindow::AddTimer's GMalloc(0x20): a registered node, so pointer walks
    // of the timer lists (XWindow::CleanUp) resolve it.
    allocTimerNode:()=>{const node={windowTimerNode:true};heap.allocate(node,Timers.WINDOW_TIMER.size);timerNodes.add(node);return node;},
    soundPawnFields:pawn=>({location:runtime.readNamed(pawn,'Location'),viewRotation:runtime.readNamed(pawn,'ViewRotation')}),
    // Extension 0x10050277: the body's call on pawn->XLevel->Engine->Audio
    // (script-window-sound.mjs): Galaxy's PlaySound with (None, 0, Sound,
    // Location, Volume, 100, Pitch). The request stays recorded.
    deferWindowSound:request=>soundRequests.push(request),
    audioOf:pawn=>runtime.audioOf(pawn),
    computerPauser:pawn=>runtime.readNamed(runtime.readNamed(pawn,'Level'),'Pauser'),
  };
  W.farray = createWindowFArray(W, heap);
  const rawServices = {
    read: (object, offset, kind) => heap.read(object, offset, kind === 'string' ? 'string' : kind),
    write: (object, offset, kind, value) => heap.write(object, offset, kind, value),
  };
  const computerServices={...rawServices,
    resize:({object,width,height})=>resizeWindowNative(object,width,height,{...rawServices,askParentForReconfigure:({object})=>askParentForReconfigure(object)}),
    appendQueuedEvent({object,event}){
      const index=W.farray.add(object,0x1e0,1,32),at=W.u32(object,0x1e0)+index*32;
      for(let i=0;i<32;i+=4)heap.mem.write(at+i,'u32',0);
      heap.mem.write(at,'u32',event.type);heap.mem.write(at+4,'f32',event.time);
      if(event.type===1)heap.mem.write(at+8,'u32',event.colorWord);
      else{
        heap.mem.write(at+8,'u16',event.charCode);
        heap.mem.write(at+16,'i32',event.param0);heap.mem.write(at+20,'i32',event.param1);
        heap.mem.write(at+24,'u32',event.flags);
      }
      return index;
    },
    arrayRealloc:({object,arrayOffset,elementSize,num,max})=>{W.setI32(object,arrayOffset+4,num);W.setI32(object,arrayOffset+8,max);W.farray.realloc(object,arrayOffset,elementSize);},
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
  /** A native member of a window object as a binding (script-bindings.mjs): the object and its layout entry
   * are fields, with get and set on the prototype, not a closure pair and a context for each member. */
  class FieldBinding {
    constructor(object, e) { this.object = object; this.e = e; }
    get() {
      const object = this.object, e = this.e;
      if (e.kind === 'bool') return Boolean(W.u32(object, e.offset) & e.mask);
      if (e.arrayDim > 1) {
        const values = [];
        for (let i = 0; i < e.arrayDim; i++) values.push(readElement(object, e, e.offset + i * e.size));
        return values;
      }
      return readElement(object, e, e.offset);
    }
    set(value) {
      const object = this.object, e = this.e;
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
    }
  }
  function bindingFor(object, entry) {
    const override = FIELD_OVERRIDES.get(entry.field.key);
    return new FieldBinding(object, override ? {...entry, ...override} : entry);
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
      instance.setBinding(entry.field.key, binding);
      instance.bindingsVersion++;
      // The object is BOUND now: the Rust receiver table computes it again.
      bumpReceiverEpoch();
      runtime.noteBoundKey(entry.field.key);
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
  // Names: UObject::StaticConstructObject with NAME_None, MakeUniqueObjectName (Core 0x101575b0): the class name without its trailing digits
  // and the class's own counter (Class+0x488, shared with every other object of the class), so a window and a GC are numbered per class (the
  // Underworld capture's TextWindow9, TileWindow18, GC505 at the same moment), not from one counter. No map export or loaded object holds such a
  // name, so the counter's next value is the name.
  const nextName = cls => { runtime.applyClassCounterSeed?.(cls); const prefix = cls.record.name.replace(/[0-9]+$/, ''), suffix = String(cls.nameCounter | 0); cls.nameCounter = (cls.nameCounter + 1) | 0;
    return prefix.slice(0, 62 - suffix.length) + suffix; };
  // A window and a graphics context are UObjects: each takes a GObjObjects slot
  // when it is created and gives it back when it is deleted. Host windows are
  // outside the host registry, so the original's slot model (seeded when the
  // boot is over, original-object-index.mjs) is told directly.
  const slotModel = () => runtime.actorLifecycle?.construction?.registry?.original ?? null;
  function takeOriginalSlot(object, cls) { slotModel()?.take(object, cls, object.name); }
  function giveBackOriginalSlot(object) { slotModel()?.giveBack(object); }
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
    const object = {name: nextName(cls), outer};
    heap.allocate(object, NATIVE_WINDOW_CLASS_SIZES[family] + 0x80);
    takeOriginalSlot(object, cls.record.name);
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
      case 'extension.largetextwindow': return LT.constructLargeTextWindow(W, win, constructWindowPart);
      case 'extension.editwindow': return ED.constructEditWindow(W, win, constructWindowPart);
      case 'extension.listwindow': return LIST.constructListWindow(W, win, constructWindowPart);
      case 'extension.viewportwindow': return VP.constructViewportWindow(W, win);   // 0x10018af0
      default: return boundary(`Window family ${family} has no recovered constructor`);
    }
  }
  // The XWindow part both text-family constructors inline (0x10012a50) or
  // call (XWindow::XWindow 0x10003130): UObject, the XExtensionObject vtable,
  // the clip rectangle and the XWindow vtable. FString(ENoInit) stores nothing.
  function constructWindowPart(win) {
    W.uobjectConstructor(win); W.setU32(win, 0, F.VTABLES.extensionobject);
    for (let o = 0xd4; o <= 0xe8; o += 4) W.setU32(win, o, 0);
    W.setU32(win, 0, F.VTABLES.window);
  }
  // XGC::operator new (Extension.dll 0x10002c40) is UObject::StaticConstructObject(GC's class, ...), so InitProperties copies the class's
  // authored defaults into the new object before XGC::XGC (0x10026ad0) runs, and the constructor never writes the slot of the one
  // default GC carries: underlineTexture (+0x84), tagged reference 20, Texture Extension.Solid (docs/interface-frames.md). Every
  // underlined accelerator letter of the original's buttons is drawn from it (GC.DrawText's second emit, script-gc-draw-text.mjs).
  const gcDefaultSlots = [];
  for (const field of gcClass.propertyOrder ?? []) {
    if (!gcClass.defaults?.has(field.key)) continue;
    if (field.kind !== 'ObjectProperty') boundary(`GC class default ${field.key} is a ${field.kind}: only object references are recovered`);
    const offset = runtime.classLoader.graph.slotOf(field.loadRecord, 0x48);
    gcDefaultSlots.push({offset, value: runtime.defaultValue(gcClass, field)});
  }
  // XWindow::Init XGC allocation leaves (operator new + XGC::XGC).
  function allocateGc(outer) {
    const gc = {name: nextName(gcClass), outer};
    heap.allocate(gc, 0xb8 + 0x10);
    takeOriginalSlot(gc, 'GC');
    runtime.attach(gc, gcClass);
    for (const {offset, value} of gcDefaultSlots) heap.write(gc, offset, 'ptr', value);
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
      case 'extension.computerwindow': return initComputerWindowNative(win,parent,{...computerServices,
        initWindow:({object,parent})=>W.initWindow(object,parent),
        getRootWindow:({object})=>T.getRootWindow(W,object),
        getPlayerPawn:({object})=>W.ptr(object,T.ROOT.parentPawn),
        readLevelPauser:({player})=>W.computerPauser(player),
        createNewWindow:({classPointer,parent,bShow})=>W.createNewWindow(classPointer===0x100ae5b8?'window':'editwindow',parent,bShow),
        setWindowAlignments:({object,alignments})=>setWindowAlignmentsNative(object,...alignments,{...rawServices,askParentForReconfigure:({object})=>askParentForReconfigure(object)}),
        setTextMargins:({object,horizontal,vertical})=>setTextMarginsNative(object,horizontal,vertical,{...rawServices,askParentForReconfigure:({object})=>askParentForReconfigure(object)}),
        setInsertionPointBlinkRate:({object,rate,flags})=>{W.setF32(object,0x23c,rate);W.setF32(object,0x240,flags);},
        setSelectability:({object,selectable})=>T.setSelectability(W,object,selectable),
      });
      case 'extension.largetextwindow': return initLargeText(win, parent);
      case 'extension.editwindow': return ED.initEditWindow(W, win, parent, editEnv);
      case 'extension.listwindow': return LIST.initListWindow(W, win, parent, listEnv);
      case 'extension.viewportwindow': return VP.initViewportWindow(W, win, parent, viewportEnv);   // 0x10049f10
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
    convertVectorToCoordinates:(win,vector)=>is(win,'extension.rootwindow')?rootVectorToCoordinates(W,win,vector)
      :is(win,'extension.viewportwindow')?VP.viewportVectorToCoordinates(W,win,vector):windowVectorToCoordinates(W,win,vector),
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
        case 'extension.largetextwindow': return LT.largeTextPreferredSize(W, win, bW, w, bH, h);
        case 'extension.editwindow': return ED.editPreferredSize(W, win, bW, w, bH, h);
        case 'extension.listwindow': return LIST.listPreferredSize(W, win);              // 0x10033260
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
      if (is(win, 'extension.largetextwindow', 'extension.editwindow'))                 // 0x1002e380 -> 0x10050450
        return LT.largeTextGranularity(W, win, hg, vg, (w, h1, v1) => {
          const args = [f(h1), f(v1)];
          processScript(w, 'ParentRequestedGranularity', args);
          return {h: f(args[0]), v: f(args[1])};
        });
      if (is(win, 'extension.listwindow'))                                               // 0x100332c0 -> 0x10050450
        return LIST.listGranularity(W, win, (w, h1, v1) => {
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
        case 'extension.largetextwindow': return LT.largeTextConfigurationChanged(W, win);
        case 'extension.editwindow': return ED.editConfigurationChanged(W, win, editEnv);
        default: return processScript(win, 'ConfigurationChanged', []);              // 0x10003600
      }
    },
    visibilityChanged(win, visible) {
      // XModalWindow::VisibilityChanged 0x10037330: the script event, then the
      // root keyboard/mouse grab counters for a parented modal.
      if (is(win, 'extension.modalwindow')) return Input.modalVisibilityChanged(W, win, visible, T.getRootWindow);
      if (is(win, 'extension.editwindow')) return ED.editVisibilityChanged(W, win, visible, editEnv);
      if (is(win, 'extension.computerwindow')) return Computer.computerVisibilityChanged(W,win,visible);
      if (is(win, 'extension.listwindow')) return LIST.listVisibilityChanged(W, win, visible, listEnv); // 0x10033d90
      processScript(win, 'VisibilityChanged', [Boolean(visible)]);                     // 0x10003610
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
        case 'extension.computerwindow': return Computer.computerTick(W,win,delta);
        case 'extension.editwindow': return ED.editTick(W, win, delta, editEnv);
        case 'extension.listwindow': return LIST.listTick(W, win, delta, listEnv);     // 0x10033e50
        default: return undefined;                                                     // 0x10003be0: ret 4
      }
    },
    draw(win, gc) {
      if (isCheckbox(win)) return D.checkboxDraw(W, win, gc);
      switch (familyOf(win)) {
        case 'extension.textwindow': return textDraw(win, gc);
        case 'extension.buttonwindow': case 'extension.togglewindow': return buttonDraw(win, gc);
        case 'extension.textlogwindow': return textLogDraw(win, gc);
        case 'extension.computerwindow': return Computer.computerDraw(W,win,gc);
        case 'extension.largetextwindow': return LT.largeTextDraw(W, win, gc);
        case 'extension.editwindow': return ED.editDraw(W, win, gc, editEnv);
        case 'extension.listwindow': return LIST.listDraw(W, win, gc, listEnv);        // 0x10033350
        case 'extension.viewportwindow': return VP.viewportDraw(W, win, gc, viewportEnv);   // 0x1004a770
        case 'extension.scalewindow': return scaleDraw(W, win, gc);                     // 0x1003fb10 (no script DrawWindow)
        default: return processScript(win, 'DrawWindow', [gc]);                         // 0x10003bf0
      }
    },
    scaleAttributesChanged:(win,...args)=>is(win,'extension.scalemanagerwindow')?SC.managerScaleAttributes(W,win,...args):processScript(win,'ScaleAttributesChanged',args,{result:false}),
    // XWindow::ClipAttributesChanged 0x10003f00 / ScrollArea 0x10043b50.
    clipAttributesChanged:(win,...args)=>is(win,'extension.scrollareawindow')?SC.scrollClipAttributes(W,win,...args):processScript(win,'ClipAttributesChanged',args,{result:false}),
    postDraw: (win, gc) => is(win, 'extension.viewportwindow') ? VP.viewportPostDraw(W, win, gc, viewportEnv)   // 0x1004af20
      : processScript(win, 'PostDrawWindow', [gc]),                                    // 0x10003c80
    styleChanged: win => processScript(win, 'StyleChanged', []),                        // 0x10003d10
    mouseGrabLost: () => undefined,                                                     // 0x10003be0
    toggleChanged(win, button, toggle) {
      if (is(win, 'extension.radioboxwindow')) return radioBoxToggleChanged(win, button, toggle);
      return processScript(win, 'ToggleChanged', [button, Boolean(toggle)], {result: false}) ? 1 : 0; // 0x10003d80
    },
    cleanUp: win => { destroyFamily(win).members?.(win); return cleanUpWindowNative(win, destroyServices); },
    // vtable +0x114 / +0x118: XWindow::TextChanged 0x10004010 and
    // EditActivated 0x10004050 are script bridges with a bool result.
    textChanged: (win, edit, modified) => processScript(win, 'TextChanged', [edit, Boolean(modified)], {result: false}) ? 1 : 0,
    editActivated: (win, edit, modified) => processScript(win, 'EditActivated', [edit, Boolean(modified)], {result: false}) ? 1 : 0,
    // vtable +0xc8 KeyPressed, reached by the root's typed-character route
    // (XRootWindow::HandleKeyboard, docs/script-window-typed-keys.md): Edit
    // 0x10021290, List 0x10033ae0, Modal and Root 0x10037510, every other
    // admitted family the XWindow bridge 0x10003830.
    keyPressed(win, key) {
      switch (TK.keyPressedBody(familyOf(win))) {
        case 'XEditWindow::KeyPressed': return ED.editKeyPressed(W, win, key, editEnv);
        case 'XListWindow::KeyPressed': return LIST.listKeyPressed(W, win, key, listEnv);
        case 'XModalWindow::KeyPressed': return TK.modalKeyPressed(W, win, key,
          {processScript, buildAcceleratorTable: F.buildAcceleratorTable, getRootWindow: T.getRootWindow,
            topChild: T.topChild, lowerSibling: T.lowerSibling});
        default: return TK.windowKeyPressed(processScript, win, key);
      }
    },
    // vtable +0xd0: XWindow::AcceleratorKeyPressed 0x10003a80 in every family.
    acceleratorKeyPressed: (win, key) => TK.windowAcceleratorKeyPressed(processScript, win, key),
    // Root vtable +0x128: XRootWindow::HandleKeyboard 0x1003b720.
    handleKeyboard(root, key) {
      if (!is(root, 'extension.rootwindow')) boundary('HandleKeyboard reached a non-root window');
      return TK.handleKeyboard(W, root, key, {topChild: T.topChild, lowerSibling: T.lowerSibling, getRootWindow: T.getRootWindow});
    },
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
      if (is(win, 'extension.editwindow')) return ED.editVirtualKeyPressed(W, win, key, repeat, editEnv);
      if (is(win, 'extension.listwindow')) return LIST.listVirtualKeyPressed(W, win, key, repeat, listEnv); // 0x10033ca0
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
    // vtable +0x108 / +0x10c: XWindow::ListRowActivated 0x10003f50 and
    // ListSelectionChanged 0x10003f90, script bridges with a bool result.
    listRowActivated: (win, list, row) => processScript(win, 'ListRowActivated', [list, row | 0], {result: false}) ? 1 : 0,
    listSelectionChanged: (win, list, count, focus) => processScript(win, 'ListSelectionChanged', [list, count | 0, focus | 0], {result: false}) ? 1 : 0,
  });
  const inheritedMousePressed=V.mouseButtonPressed;
  V.mouseButtonPressed=(win,...args)=>is(win,'extension.listwindow')?LIST.listMouseButtonPressed(W,win,...args,listEnv):is(win,'extension.editwindow')?ED.editMouseButtonPressed(W,win,...args,editEnv):is(win,'extension.togglewindow')?Input.toggleMousePressed(W,win,...args,{processScript}):
    is(win,'extension.buttonwindow')?Input.buttonMousePressed(W,win,...args,
    {processScript,changeButtonAppearance,tickOffset:W.tickOffset,activateButton:(w,key)=>W.native.activateButton(w,key)}):
    is(win,'extension.scalewindow')?SI.scaleMousePressed(W,win,...args):is(win,'extension.scrollareawindow')?SM.scrollMousePressed(W,win,...args):inheritedMousePressed(win,...args);
  const inheritedMouseMoved=V.mouseMoved,inheritedMouseReleased=V.mouseButtonReleased;
  V.mouseMoved=(win,...args)=>is(win,'extension.listwindow')?LIST.listMouseMoved(W,win,...args,listEnv):is(win,'extension.editwindow')?ED.editMouseMoved(W,win,...args,editEnv):is(win,'extension.scalewindow')?SI.scaleMouseMoved(W,win,...args):inheritedMouseMoved(win,...args);
  const inheritedCursorRequested=V.cursorRequested;
  V.cursorRequested=(win,...args)=>is(win,'extension.editwindow')?ED.editCursorRequested(W,win,...args,editEnv):inheritedCursorRequested(win,...args);
  V.mouseButtonReleased=(win,...args)=>is(win,'extension.listwindow')?LIST.listMouseButtonReleased(W,win,...args,listEnv):is(win,'extension.editwindow')?ED.editMouseButtonReleased(W,win,...args,editEnv):is(win,'extension.togglewindow')?Input.toggleMouseReleased(W,win,...args,
    {processScript,isPointInWindow:(w,x,y)=>Mouse.isPointInWindow(W,w,x,y),setToggle:(w,value)=>setToggleNative(w,value,lifecycle.toggle)}):
    is(win,'extension.buttonwindow')?Input.buttonMouseReleased(W,win,...args,
    {processScript,changeButtonAppearance,activateButton:(w,key)=>W.native.activateButton(w,key),isPointInWindow:(w,x,y)=>Mouse.isPointInWindow(W,w,x,y)}):
    is(win,'extension.scalewindow')?SI.scaleMouseReleased(W,win,...args):inheritedMouseReleased(win,...args);
  const inheritedShowArea=V.childRequestedShowArea;
  V.childRequestedShowArea=(win,...args)=>is(win,'extension.clipwindow')?clipShowArea(W,win,...args):inheritedShowArea(win,...args);
  W.v = V;
  /** XRootWindow::GenerateSnapshot 0x10039410 as the exec 0x1003cf30 calls it (docs/root-snapshot.md): a new Texture of the root's snapshot
   * size rounded up to powers of two (SetSnapshotSize, +0x738/+0x73c), filled from the viewport's last frame. The frame is the page's
   * (the simulation has none): the request goes out in the frame snapshot and the page fills the texture before it draws the HUD
   * that names it. The returned object is a UTexture subclass of the transient package (vtable 0x100613e8), USize/VSize the powers of two. */
  W.snapshot = {
    generate(root, bFilter) {
      if (!viewportSize) boundary('RootWindow.GenerateSnapshot reads the viewport frame, whose size is unknown before the first frame');
      const snapW = W.i32(root, 0x738), snapH = W.i32(root, 0x73c), pitch = potCeiling(snapW), height = potCeiling(snapH);
      if (!pitch || !height) boundary(`RootWindow.GenerateSnapshot with a ${snapW} x ${snapH} snapshot size (Init of an empty texture is not recovered)`);
      const base = runtime.actorLifecycle?.construction, outer = base?.transientPackage;
      if (!outer) boundary('RootWindow.GenerateSnapshot requires the transient package Outer');
      const object = runtime.allocateObject(snapshotTextureClass, {outer, name: 'None', flags: 0, template: null}, {...base,
        validate: args => args.cls === snapshotTextureClass && args.outer === outer && args.template === null && args.flags === 0 && args.name === 'None',
        initNativeProperties: () => {}});
      const native = runtime.instance(object).nativeObject;
      native.nativeVtable = 0x10179dfc;          // UObject::UObject, then the Extension subclass' vtable
      constructNativeObject(native, 0x100613e8, 'Snapshot texture', {destroyObjectBase: receiver => runtime.destroyObjectBase(receiver)});
      runtime.writeNamed(object, 'USize', pitch);
      runtime.writeNamed(object, 'VSize', height);
      const serial = ++display.snapshotSerial, info = {key: `snapshot:${serial}`, width: pitch, height};
      info.address = snapshotTextureImage(info);
      snapshotTextures.set(object, info);
      display.snapshotRequests.push({serial, key: info.key, sizeX: viewportSize.sizeX, sizeY: viewportSize.sizeY, snapW, snapH, bFilter: Boolean(bFilter)});
      if (display.snapshotRequests.length > 8) display.snapshotRequests.splice(0, display.snapshotRequests.length - 8);
      return object;
    },
    /** A script Texture whose pixels the simulation already has (a SaveInfo's Snapshot, docs/save-storage.md "The snapshot"): the object gets the
     * raw image and the reference GenerateSnapshot's textures have (the HUD commands that draw it name `image:<serial>`), and the pixels
     * (`data`: RGBA bytes, top row first) go to the page once, in the next frame snapshot's `display.images`. An object adopted again (a load of another file
     * that holds an export of the same name replaces the object in place) keeps its image and key: the page takes the new pixels under that key,
     * so a window that holds the pointer shows the new picture, as it would the object's new contents. */
    adopt(object, {width, height, data}) {
      let info = snapshotTextures.get(object);
      if (info?.key.startsWith('image:')) {
        info.width = width; info.height = height;
        heap.mem.write(info.address + 0x34, 'i32', width);
        heap.mem.write(info.address + 0x38, 'i32', height);
        resourceImages.set(info.address, {kind: 'texture', ref: {key: info.key, dynamic: true, width, height}, width, height});
      } else {
        info = {key: `image:${++display.imageSerial}`, width, height};
        info.address = snapshotTextureImage(info);
        snapshotTextures.set(object, info);
      }
      display.images.push({key: info.key, width, height, data});
      return info;
    },
    /** RootWindow.SetSnapshotSize (native 1523's stores, +0x738 / +0x73c): SaveGame calls it with 160 x 120 before its own GenerateSnapshot, and it stays. */
    setSize(root, width, height) { W.setI32(root, 0x738, width); W.setI32(root, 0x73c, height); },
    /** XRootWindow::GenerateSnapshot for a SaveInfo's texture (travel step 4, docs/save-storage.md "Writing a save"): the simulation keeps no script-visible texture
     * for it. The request goes to the page like generate's, flagged `deliver`: the page answers with the grey picture's indices (`snapshot` message, by `jobId`), made
     * from the frame it draws next, and the save is committed with it. Returns the request's serial, or null before the page has told its frame size. */
    requestForSave(snapW, snapH, bFilter, jobId) {
      if (!viewportSize) return null;
      const serial = ++display.snapshotSerial;
      display.snapshotRequests.push({serial, key: null, sizeX: viewportSize.sizeX, sizeY: viewportSize.sizeY, snapW, snapH, bFilter: Boolean(bFilter), deliver: true, jobId});
      if (display.snapshotRequests.length > 8) display.snapshotRequests.splice(0, display.snapshotRequests.length - 8);
      return serial;
    },
    release(object) {
      const info = snapshotTextures.get(object);
      if (!info) return;
      display.snapshotReleased.push(info.key);
      if (display.snapshotReleased.length > 16) display.snapshotReleased.splice(0, display.snapshotReleased.length - 16);
    },
  };

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
    moveTabGroup: (win, direction) => moveTabGroupNative(W, win, direction, treeServices()),
    moveFocus: (win, direction, wrap) => Mouse.moveFocus(W, win, direction, wrap,
      {getTabGroupWindow: T.getTabGroupWindow, moveTabGroup: (root, move) => W.native.moveTabGroup(root, move)}),
    // XButtonWindow::ActivateButton 0x100077e0 through its existing translation.
    activateButton: (win, key) => activateButtonNative(win, key, {read: (object, offset, kind) => heap.read(object, offset, offset === 0 && kind === 'ptr' ? 'u32' : kind),
      activateButton: ({object, source, virtualSlot}) => virtualSlot === 0xec ? V.buttonActivatedRight(object, source) : V.buttonActivated(object, source)}),
    playSound: (...args)=>windowPlaySound(W,...args),
  };
  const soundRequests = [];

  // ------------------------------------------------------------------
  // LargeTextWindow / EditWindow (script-window-large-text.mjs,
  // script-window-edit.mjs, script-edit-model.mjs). Process-global cells of
  // the edit bodies: the shared L"" 0x10099ea8, the clipboard FString
  // 0x1009ae00, ConvertScriptString's static FString 0x100aead0 with its
  // init flag 0x100aeac8 and run scratch 0x100add98, the filterText
  // character slot, the InsertText temp FString (a native stack temporary),
  // KeyPressed's static two-character buffer 0x1009b318 and the text copy
  // EnableSingleLineEditing/EnableUppercaseOnly (1887/1889) take on the stack.
  // ------------------------------------------------------------------
  const editGlobals = {emptyWString: heap.allocRaw(4), clipboard: heap.allocRaw(12), convertBuffer: heap.allocRaw(12),
    convertFlag: heap.allocRaw(4), convertRun: heap.allocRaw(0x1000), charSlot: heap.allocRaw(8), scratchInsert: heap.allocRaw(12),
    keyBuffer: heap.allocRaw(4), scratchCopy: heap.allocRaw(12), textResult: heap.allocRaw(12)};
  const editMem = {...heap.mem, ...editGlobals,
    alloc: size => heap.allocRaw(size),
    readString(address) { let text = ''; for (let at = address; ; at += 2) { const unit = heap.mem.read(at, 'u16'); if (!unit) return text; text += String.fromCharCode(unit); } },
    allocString(text) {
      const at = heap.allocRaw((text.length + 1) * 2);
      for (let i = 0; i < text.length; i++) heap.mem.write(at + 2 * i, 'u16', text.charCodeAt(i));
      heap.mem.write(at + 2 * text.length, 'u16', 0);
      return at;
    },
  };
  const editServices = {mem: editMem, objectAddress: win => heap.addressOf(win),
    updateCaret: (win, _base, sticky) => ED.computeCursorConfig(W, win, sticky, editEnv),
    resetBlink: win => ED.showCursor(W, win, editEnv),
    columnFromX: (win, _base, row, xBits) => ED.xToCol(W, win, row, bitsToF32(xBits)),
    askParentForReconfigure: win => askParentForReconfigure(win),
    textChanged: (win, receiver, _base, changed) => V.textChanged(heap.objectAt(receiver), win, changed),
    // Core UObject::FindFunction(FilterChar, 0) over the window's class chain.
    findFilterChar: win => runtime.lookup(win, 'FilterChar', false) ? 1 : 0,
    scriptFilterChar(win, text) {
      const args = [text];
      const result = processScript(win, 'FilterChar', args, {result: true});
      return {result: Boolean(result), text: String(args[0] ?? '')};
    },
  };
  const enableTextAccelerator = (win, flag) => enableTextAsAcceleratorNative(win, flag, {
    read: (object, offset, kind) => heap.read(object, offset, kind), write: (object, offset, kind, raw) => heap.write(object, offset, kind, raw),
    makeAcceleratorTableDirty: ({object}) => W.native.makeAcceleratorTableDirty(object)});
  const initLargeText = (win, parent) => LT.initLargeTextWindow(W, win, parent, W.initText, enableTextAccelerator);
  const textCleanUp = win => W.heap.write(win, 0x168, 'string', '');                   // XTextWindow::CleanUp 0x10045c30
  const editEnv = {
    editL: win => editMemory(win, editServices),
    initLargeText,
    askParentForReconfigure: win => askParentForReconfigure(win),
    askParentToShowArea: (win, x, y, w, h) => Mouse.askParentToShowArea(W, win, x, y, w, h),
    setSelectability: (win, selectable) => T.setSelectability(W, win, selectable),
    getRootWindow: win => T.getRootWindow(W, win),
    getCursorPos: win => W.native.getCursorPos(win),
    playSound: (win, sound, volume, pitch, x, y) => windowPlaySound(W, win, sound, volume, pitch, x, y),
    processScript: (win, event, args, options) => processScript(win, event, args, options),
    isFocusWindow: win => { const root = T.getRootWindow(W, win); return Boolean(root && W.ptr(root, T.ROOT.focus) === win); },
    isKeyDown: (win, key) => isKeyDownNative(win, key, {read: (object, offset, kind) => heap.read(object, offset, kind)}),
    largeTextDraw: (win, gc) => LT.largeTextDraw(W, win, gc),
    keyBuffer: () => editGlobals.keyBuffer,
    get v() { return V; },
  };
  // ------------------------------------------------------------------
  // ListWindow (script-window-list.mjs over script-window-list-model.mjs).
  // Image cells of the list bodies: the shared L"" 0x10099ea8, the sort
  // column list 0x100a6f28/0x100a7348, the glyph-miss pair 0x100aeba0 and
  // a stand-in for GetCharSize's out slot; KeyPressed's stack FString.
  // ------------------------------------------------------------------
  const readWString = address => { let text = ''; for (let at = address; ; at += 2) { const unit = heap.mem.read(at, 'u16'); if (!unit) return text; text += String.fromCharCode(unit); } };
  const listMem = {...heap.mem, emptyWString: editGlobals.emptyWString, sortList: heap.allocRaw(0x400), sortCount: heap.allocRaw(4),
    glyphMiss: heap.allocRaw(0x10), glyphScratch: heap.allocRaw(4),
    alloc: size => heap.allocRaw(size), free: address => heap.mem.free(address), realloc: (address, size) => heap.realloc(address, size),
    readString: readWString, allocString: editMem.allocString};
  const listServices = {mem: listMem, objectAddress: win => heap.addressOf(win),
    // XWindow::GetGC 0x1004ddc0 / ReleaseGC 0x1004de50.
    acquireContext: win => heap.addressOf(W.gc.get(win)),
    releaseContext: (win, _base, gc) => W.gc.release(win, gc ? heap.objectAt(gc) : null),
    // XGC::GetTextExtent 0x10027bb0(0, &width, &height, text).
    measureString(_win, gc, outW, outH, text) {
      const extent = gcTextExtent(heap.objectAt(gc), 0, readWString(text), gcServices);
      heap.mem.write(outW, 'f32', extent.xExtent); heap.mem.write(outH, 'f32', extent.yExtent);
    },
    askParentForReconfigure: win => askParentForReconfigure(win),
    selectionChanged: (win, receiver, _base, count, focus) => V.listSelectionChanged(heap.objectAt(receiver), win, count, focus),
    isBlock: address => heap.blockSize(address) !== undefined,
    scratchString: heap.allocRaw(12),
  };
  const listEnv = {
    L: win => listMemory(win, listServices), listServices,
    windowInit: (win, parent) => W.initWindow(win, parent),
    setSelectability: (win, selectable) => T.setSelectability(W, win, selectable),
    askParentToShowArea: (win, x, y, w, h) => Mouse.askParentToShowArea(W, win, x, y, w, h),
    playSound: (win, sound, volume, pitch, x, y) => windowPlaySound(W, win, sound ? heap.objectAt(sound) : null, volume, pitch, x, y),
    processScript: (win, event, args, options) => processScript(win, event, args, options),
    listRowActivated: (receiver, list, row) => V.listRowActivated(receiver, list, row),
    isKeyDown: (win, key) => isKeyDownNative(win, key, {read: (object, offset, kind) => heap.read(object, offset, kind)}),
    tickOffset: () => f(W.tickOffset()),
    getCursorPos: win => W.native.getCursorPos(win),
    mouseMoved: (win, x, y) => V.mouseMoved(win, x, y),
    isFocusWindow: win => { const root = T.getRootWindow(W, win); return Boolean(root && W.ptr(root, T.ROOT.focus) === win); },
    windowDraw: (win, gc) => processScript(win, 'DrawWindow', [gc]),                  // XWindow::Draw 0x10003bf0
  };
  // ------------------------------------------------------------------
  // ViewportWindow (script-window-viewport.mjs, docs/script-window-viewport.md).
  // Play's renderer stands behind GetRenderer: CreateMasterFrame allocates a
  // heap FSceneNode image whose consumed fields ComputeRenderSize fills from
  // the frame's camera and the player's FovAngle (the scene-frame
  // translation), ClearZ marks the pass, DrawWorld queues a 'viewport' draw
  // command in window order (the page draws the world from that camera into
  // the frame's rectangle), FinishMasterFrame frees the image.
  // The view's world frame (OccludeBsp, the actors it draws, render
  // feedback) is planned by `viewportPlanner` (sim-session.mjs) inside
  // DrawWorld, while Draw holds the origin's bHidden and the player's
  // bBehindView, as URender::DrawWorld (Render.dll 0x10b1cb90) reads them.
  // ------------------------------------------------------------------
  let viewportPlanner = null;
  const playRenderer = {name: 'PlayRenderer'};
  const viewportFrames = new Map();
  const isDeletedActor = actor => Boolean(runtime.readNamed(actor, 'bDeleteMe'));
  const viewportViews = (player, edit) => {
    const views = [...runtime.readNamed(player, 'AdditionalViews')];
    const result = edit(views);
    runtime.writeNamed(player, 'AdditionalViews', views);
    return result;
  };
  const viewportEnv = {
    windowInit: (win, parent) => W.initWindow(win, parent),
    windowDraw: (win, gc) => processScript(win, 'DrawWindow', [gc]),                  // XWindow::Draw 0x10003bf0
    windowPostDraw: (win, gc) => processScript(win, 'PostDrawWindow', [gc]),          // XWindow::PostDraw 0x10003c80
    getRootWindow: win => T.getRootWindow(W, win),
    getPlayerPawn: win => { const root = T.getRootWindow(W, win); return root ? W.ptr(root, T.ROOT.parentPawn) : null; },
    // XWindow AddActorRef 0x1004fe20 / RemoveActorRef 0x1004fea0 / IsActorValid 0x1004ff20.
    addActorRef(win, actor) { const pawn = viewportEnv.getPlayerPawn(win); if (pawn) addActorReference(actorRefs.tableFor(pawn), actor, isDeletedActor); },
    removeActorRef(win, actor) { const pawn = viewportEnv.getPlayerPawn(win); if (pawn) removeActorReference(actorRefs.tableFor(pawn), actor, isDeletedActor); },
    isActorValid(win, actor) { const pawn = viewportEnv.getPlayerPawn(win); return pawn ? isActorReferenceValid(actorRefs.tableFor(pawn), actor, isDeletedActor) : false; },
    actor: {
      location: actor => runtime.readNamed(actor, 'Location').map(Math.fround),
      rotation: actor => runtime.readNamed(actor, 'Rotation').map(v => v | 0),
      viewRotation: actor => runtime.readNamed(actor, 'ViewRotation').map(v => v | 0),
      eyeHeight: actor => Math.fround(runtime.readNamed(actor, 'EyeHeight')),
      isPawn: actor => isA(actor, 'engine.pawn'),
      isPlayerPawn: actor => isA(actor, 'engine.playerpawn'),
      hidden: actor => runtime.readNamed(actor, 'bHidden') ? 1 : 0,
      setHidden: (actor, value) => runtime.writeNamed(actor, 'bHidden', Boolean(value)),
      behindView: actor => runtime.readNamed(actor, 'bBehindView') ? 1 : 0,
      setBehindView: (actor, value) => runtime.writeNamed(actor, 'bBehindView', Boolean(value)),
      fovBits: actor => f32BitsOf(runtime.readNamed(actor, 'FovAngle')),
      setFovBits: (actor, value) => runtime.writeNamed(actor, 'FovAngle', bitsToF32(value)),
      addAdditionalView: (player, actor) => viewportViews(player, views => VP.addAdditionalView(views, actor)),
      removeAdditionalView: (player, actor) => viewportViews(player, views => VP.removeAdditionalView(views, actor)),
    },
    render: {
      getRenderer: win => viewportEnv.getPlayerPawn(win) ? playRenderer : null,
      createMasterFrame(_renderer, _viewport, location, rotation) {
        const frame = {name: 'ViewportSceneNode'};
        heap.allocate(frame, 0x300);
        viewportFrames.set(frame, {location: [...location], rotation: [...rotation], clearZ: false});
        return frame;
      },
      // FSceneNode::ComputeRenderSize reads Viewport->Actor->FovAngle, the
      // window's fov while Draw holds it there.
      computeRenderSize(frame) {
        const camera = viewportFrames.get(frame), viewer = runtime.readNamed(runtime.readNamed(player, 'Player'), 'Actor') ?? player;
        const width = W.i32(frame, 0xa8), height = W.i32(frame, 0xac);
        camera.fov = Math.fround(runtime.readNamed(viewer, 'FovAngle'));
        if (width > 0 && height > 0)
          writeViewportFrame(W, frame, {location: camera.location, rotation: camera.rotation, width, height, fov: camera.fov});
      },
      clearZ(_viewport, frame) { viewportFrames.get(frame).clearZ = true; },
      // URender::DrawWorld from the frame: the origin is bHidden now unless
      // bShowActor, the player bBehindView unless it shows its weapons.
      drawWorld(_renderer, frame, {origin}) {
        const camera = viewportFrames.get(frame), viewer = runtime.readNamed(runtime.readNamed(player, 'Player'), 'Actor') ?? player;
        const command = {kind: 'viewport', x: W.i32(frame, 0xb0), y: W.i32(frame, 0xb4), width: W.i32(frame, 0xa8), height: W.i32(frame, 0xac),
          location: camera.location, rotation: camera.rotation, fov: camera.fov, clearZ: camera.clearZ,
          hidden: origin && runtime.readNamed(origin, 'bHidden') ? [origin.name] : [],
          behindView: Boolean(runtime.readNamed(viewer, 'bBehindView')), pass: null};
        if (viewportPlanner) command.pass = viewportPlanner(command);
        emitOther(command);
      },
      finishMasterFrame() {
        for (const frame of viewportFrames.keys()) heap.free(frame);
        viewportFrames.clear();
      },
    },
    processScript: (win, event, args) => processScript(win, event, args),
    gc: {
      pushGC: gc => W.gc.push(gc),                                                   // XGC::PushGC 0x100278d0
      setStyle: (gc, style) => W.gc.setStyle(gc, style),                             // 0x10027170
      setTileColor: (gc, color) => gcSetTileColorBody(gc, color, W.gc.services),     // 0x100274f0
      drawPattern: (gc, x, y, w, h, ox, oy, texture) =>                              // 0x10028a60
        gcDrawPatternBody(gc, ...[x, y, w, h, ox, oy].map(viewportF32Bits), texture, W.gc.services),
      popGC: gc => W.gc.pop(gc, -1),                                                 // 0x100279f0
    },
  };
  // XLargeTextWindow::SetText 0x1002d6b0 / AppendText 0x1002d730 and
  // XEditWindow::SetText 0x1001e260 / AppendText 0x1001e310: the TextWindow
  // exec bodies call these through vtable +0x11c / +0x120.
  function textVirtual(win, method, text) {
    const family = families.get(win);
    if (family !== 'extension.largetextwindow' && family !== 'extension.editwindow') return false;
    if (family === 'extension.largetextwindow') {
      const services = {...lifecycle.text, askParentForReconfigure: ({object}) => askParentForReconfigure(object)};
      if (method === 'setText') LT.largeTextSetText(W, win, text, services);
      else LT.largeTextAppendText(W, win, text, services, makeAreaDirty);
      return true;
    }
    const buffer = editMem.allocString(text.split('\0', 1)[0]), L = editMemory(win, editServices);
    try {
      if (method === 'setText') setTextVirtual(L, buffer);
      else ED.editAppendText(W, win, buffer, editEnv);
    } finally { editMem.free(buffer); }
    return true;
  }
  // XLargeTextWindow::MakeAreaDirty 0x1002d8b0 (the edit model's textChangedRange).
  const makeAreaDirty = (win, position, removed, inserted) => textChangedRange(editMemory(win, editServices), position, removed, inserted);

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
  function buttonTick(win,delta) {
    return Input.buttonTick(W,win,delta,{getCursorPos:Mouse.getCursorPos,isPointInWindow:Mouse.isPointInWindow,
      activateButton:(w,key)=>W.native.activateButton(w,key),boundary});
  }
  function textLogTick(win,delta) { return Log.textLogTick(W,win,delta); }
  // The services of the tab-group and root-tick natives: the tree and family functions (module namespaces, whose exports do not change)
  // and the focus setter. Merged once; merging the two namespaces for each root tick was most of the HUD tick's allocation.
  let treeServicesObject = null;
  function treeServices() { return treeServicesObject ??= {...T, ...F, setFocusWindow: (root, target) => Mouse.setFocusWindow(W, root, target)}; }
  function rootTickVirtual(win,delta) { return rootTickNative(W,win,delta,treeServices()); }
  // ViewportWindow 1940-1943 (the bodies that reach actor references and the player's AdditionalViews); the leaf setters are host
  // natives. Apart from handleNative: its inner closures would give every native that reaches it a context object.
  function viewportNative(call) {
    const arg=(i,fallback)=>i<call.argumentCount?(refValue(call.evaluateArgument(i))??fallback):fallback;
    const win=call.receiver,vec=v=>Array.isArray(v)?v.map(Math.fround):['x','y','z'].map(k=>Math.fround(v?.[`core.object.vector.${k}`]??0));
    const rot=r=>Array.isArray(r)?r.map(v=>v|0):['pitch','yaw','roll'].map(k=>(r?.[`core.object.rotator.${k}`]??0)|0);
    if(call.index===1940)VP.setViewportActor(W,win,arg(0,null),arg(1,true)?1:0,arg(2,true)?1:0,viewportEnv);   // exec 0x1004b380
    else if(call.index===1941)VP.setViewportLocation(W,win,vec(arg(0,null)),arg(1,true)?1:0,viewportEnv);    // exec 0x1004b440
    else if(call.index===1942)VP.setWatchActor(W,win,arg(0,null),arg(1,true)?1:0,viewportEnv);               // exec 0x1004b510
    else VP.setViewportRotation(W,win,rot(arg(0,null)),viewportEnv);                                        // exec 0x1004b5a0
    return {handled:true,value:undefined};
  }
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
    'extension.computerwindow': {members:win=>Computer.computerCleanUp(W,win),destructor:win=>Computer.computerDestroyMembers(W,win)},
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
    // XLargeTextWindow::CleanUp 0x1002d560 / ~XLargeTextWindow 0x100127a0.
    'extension.largetextwindow': {members: win => LT.cleanUpLargeTextWindow(W, win, textCleanUp), destructor: win => LT.destroyLargeTextMembers(W, win)},
    // XListWindow::CleanUp 0x1002ead0 / ~XListWindow 0x10015de0.
    'extension.listwindow': {members: win => LIST.cleanUpListWindow(listEnv.L(win)), destructor: win => LIST.destroyListMembers(listEnv.L(win))},
    // XViewportWindow::CleanUp 0x1004a070: SetViewportActor(NULL, TRUE, TRUE),
    // then XWindow::CleanUp; ~XViewportWindow 0x10018a60 has no members.
    'extension.viewportwindow': {members: win => VP.setViewportActor(W, win, null, 1, 1, viewportEnv)},
    // XEditWindow::CleanUp 0x1001d0b0 (undo records, then XLargeTextWindow's)
    // / ~XEditWindow 0x10014510 (the undo TArray, then ~XLargeTextWindow).
    'extension.editwindow': {
      members: win => { cleanUpUndo(editMemory(win, editServices)); LT.cleanUpLargeTextWindow(W, win, textCleanUp); },
      destructor: win => { const data = W.u32(win, ED.EDIT.bufferList); if (data) heap.freeRaw(data); for (let i = 0; i < 12; i += 4) W.setU32(win, ED.EDIT.bufferList + i, 0); LT.destroyLargeTextMembers(W, win); },
    },
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
    // XRootWindow::CleanUp 0x10039240: unlink this root from the root-window
    // list (global 0x100aa8f8, next +0x58c; the removed root keeps its own
    // next), clear the pawn's rootWindow (+0x894) only while it still names
    // this root, RemoveFromRoot, then XModalWindow::CleanUp. ~XRootWindow
    // 0x100059c0 has no root-only members: ~XModalWindow's +0x17c table, then
    // ~XTabGroupWindow's (its Destroy 0x10039320 is XWindow::Destroy).
    'extension.rootwindow': {
      members: win => {
        let previous = null, current = W.global('rootWindowList');
        while (current && current !== win) { previous = current; current = W.ptr(current, T.ROOT.nextRoot); }
        if (current) {
          if (previous) W.setPtr(previous, T.ROOT.nextRoot, W.ptr(win, T.ROOT.nextRoot));
          else W.setGlobal('rootWindowList', W.ptr(win, T.ROOT.nextRoot));
        }
        const pawn = W.ptr(win, T.ROOT.parentPawn);
        if (pawn && runtime.readNamed(pawn, 'rootWindow') === win) W.setPawnRootWindow(pawn, null);
        W.removeFromRoot(win);
        DESTROY_FAMILIES['extension.modalwindow'].members(win);
      },
      destructor: win => DESTROY_FAMILIES['extension.modalwindow'].destructor(win),
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
  // registry slot; operator delete returns each node and the GC image to the
  // heap.
  function destroyGc(gc) {
    const Lg = gcMemory(gc, gcServices), base = Lg.base;
    if (Lg.read(base + GC.owner, 'u32') !== 0) boundary('Destroying a pushed XGC node is not recovered');
    gcPopGC(gc, 0, gcServices);
    let count = 0;
    for (let node = Lg.read(base + GC.freeList, 'u32'); node; node = Lg.read(base + GC.freeList, 'u32')) {
      Lg.write(base + GC.freeList, 'u32', Lg.read(node + GC.stackTop, 'u32'));
      // `call [vtable+0xc]` with 1 (0x10026d9a): the node's whole deleting destructor, its ~UObject's slot
      // release included, before the next node and before this GC's own ~UObject.
      const holder = pushedNodes.get(node);
      if (holder) { pushedNodes.delete(node); giveBackOriginalSlot(holder); }
      heap.freeRaw(node);
      count++;
    }
    if (count > 16) boundaryLog.push({log: 'GLog', text: `***WARNING: GC contains an abnormally large GC stack! (${count})`});
    giveBackOriginalSlot(gc);
    heap.free(gc);
    // R1a: the GC's handle ends with it (docs/rust-core.md). Its image range
    // is left to the runtime's finalizer: a host window has no released
    // flag, so a later access would read a reused range.
    releaseHandle(gc);
  }
  const destroyServices = {
    ...rawServices,
    // The adapter's trace hook; the InfoLink shell's merged lifecycle routes
    // it by owner, so host windows must not fall through to the shell's log.
    onEvent: () => {},
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
      heap.free(object);
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
      giveBackOriginalSlot(object);
      heap.free(object);
      releaseHandle(object);
    },
  };
  function safeDestroy(win) { return safeDestroyWindowNative(win, destroyServices); }

  // ------------------------------------------------------------------
  // Lifecycle published to the shared runtime natives (windowLifecycle).
  // ------------------------------------------------------------------
  const actorRefs=createWindowActorRefDispatcher(W,{isDeleted:actor=>runtime.readNamed(actor,'bDeleteMe')});
  const lifecycle = {
    computer:computerServices,
    host: null,
    errorDevice: {name: 'GError'},
    isScriptable: () => true,
    handleNative: call => {
      const sound=dispatchWindowSoundNative(W,call);if(sound.handled)return sound;
      if(call.index===1472){
        // XWindow::execFindWindow 0x10053700: P_GET_FLOAT pointX, pointY, P_GET_FLOAT_REF relativeX, relativeY (a local when the
        // argument is no variable), then FindWindow 0x1004f650, which writes them only on a hit; the window is the result.
        if(call.argumentCount!==4)throw new Error('Window.FindWindow requires pointX, pointY, relativeX and relativeY');
        const x=Math.fround(refValue(call.evaluateArgument(0))),y=Math.fround(refValue(call.evaluateArgument(1)));
        const relativeX=call.evaluateArgument(2),relativeY=call.evaluateArgument(3);
        const hit=Mouse.findWindow(W,call.receiver,x,y);
        if(hit){if(relativeX?.reference)assign(relativeX,hit.x);if(relativeY?.reference)assign(relativeY,hit.y);}
        return {handled:true,value:hit?.win??null};
      }
      const reference=actorRefs(call);if(reference.handled)return reference;
      const command=inputConsole.playerConsoleCommand(call,consoleCommands);if(command.handled)return command;
      // ViewportWindow 1940-1943 (the bodies that reach actor references and
      // the player's AdditionalViews); the leaf setters are host natives.
      if(call.index>=1940&&call.index<=1943)return viewportNative(call);
      if(call.index>=1720&&call.index<=1812){
        const list=LIST.dispatchListWindowNative(W,call,listEnv,refValue);if(list.handled)return list;
      }
      if(call.index===1860||(call.index>=1880&&call.index<=1921)){
        const edit=dispatchEditWindowNative(W,call,{editServices,textServices:editServices,edit:editEnv});if(edit.handled)return edit;
      }
      // TextWindow.GetText 1552 (exec 0x10046cd0: the +0x168 FString copied
      // into the result) and GetTextLength 1553 (0x10046d70), the validated
      // script-text-get-text*.mjs bodies over a result cell.
      if(call.index===1552||call.index===1553){
        if(call.argumentCount!==0)boundary(`TextWindow native ${call.index} takes no parameters`);
        const out=editGlobals.textResult;
        if(call.index===1553){textWindowGetTextLength(call.receiver,out,editServices);return {handled:true,value:heap.mem.read(out,'i32')};}
        for(let i=0;i<12;i+=4)heap.mem.write(out+i,'u32',0);
        textWindowGetText(call.receiver,out,editServices);
        const value=editMem.readString(heap.mem.read(out,'u32')||editGlobals.emptyWString);
        const data=heap.mem.read(out,'u32');if(data)heap.mem.free(data);
        return {handled:true,value};
      }
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
    // `realloc` (GMalloc) lets AppendText grow the raw FString like 0x10045e60.
    text: {...rawServices, realloc: (address, size) => heap.realloc(address, size), makeAcceleratorTableDirty: ({object})=>T.makeAcceleratorTableDirty(W,object)},
    // TextWindow.SetText/AppendText virtual overrides (vtable +0x11c/+0x120).
    textVirtual: (object, method, text) => textVirtual(object, method, text),
    // CriticalDelete of a snapshot texture (script-runtime.mjs criticalDelete): the page drops its pixels.
    snapshotReleased: object => W.snapshot.release(object),
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
  // XGC::PushGC's new node (0x10027944) comes from XGC::operator new (0x10002c40), UObject::StaticConstructObject of the GC
  // class: a registered GC that takes a GObjObjects slot (AddObject) and keeps it on the GC's free list until XGC::Destroy
  // deletes it (destroyGc). The first text DrawText of a window's GC makes one (the Underworld capture's GC519..GC521,
  // docs/object-index-captures.md). Its slot holder, by the node's address.
  const pushedNodes = new Map();
  // `transientPayloads`: callVirtual below reads a glyph's emit block at the call and keeps none of it, so UGC::DrawText may hand it
  // one object rewritten for each glyph (script-gc-draw-text.mjs glyphCommand).
  const gcServices = {mem: heap.mem, objectAddress: object => object.base??heap.objectAddress(object), transientPayloads: true,
    allocateObject: () => {
      const node = heap.allocRaw(GC.size), holder = {name: nextName(gcClass)};
      takeOriginalSlot(holder, 'GC');
      pushedNodes.set(node, holder);
      return node;
    },
    constructUObject: ()=>{},
  };
  const drawCommands=[];
  // draw's mode 'stream': the tiles go into commandStream as numbers (script-window-command-stream.mjs), the other kinds beside them
  const commandStream=new HudCommandStream();
  let streaming=false;
  const emitOther=command=>{if(streaming)commandStream.other(command);else drawCommands.push(command);};
  // GC.DrawActor / GC.ClearZ (script-gc-draw-actor.mjs, docs/gc-draw-actor.md). The XGC body runs on the HUD canvas' render graph
  // and the Actor's own fields; its three leaves are these services. ClearZ and DrawActor queue ordered 'clearZ' and 'actor'
  // commands among the tile commands. An actor command carries the planner's draw (sim-session.mjs planHudActor: the mesh
  // binding's frame record for the actor in the state the body set), null without a planner (headless paints record the call).
  // bConstrain's FSceneNode::ComputeRenderSize of the HUD frame is not recovered here: unsupported, raised, never guessed.
  let actorPlanner=null;
  const readName=(actor,name)=>runtime.readNamed(actor,name);
  gcServices.actor={
    read:actor=>({hidden:readName(actor,'bHidden')?1:0,unlit:readName(actor,'bUnlit')?1:0,style:readName(actor,'Style'),
      drawScale:f32BitsOf(readName(actor,'DrawScale')),scaleGlow:f32BitsOf(readName(actor,'ScaleGlow')),
      skins:[...readName(actor,'MultiSkins'),readName(actor,'Skin')]}),
    write:(actor,fields)=>{
      if('hidden' in fields)runtime.writeNamed(actor,'bHidden',Boolean(fields.hidden));
      if('unlit' in fields)runtime.writeNamed(actor,'bUnlit',Boolean(fields.unlit));
      if('style' in fields)runtime.writeNamed(actor,'Style',fields.style);
      if('drawScale' in fields)runtime.writeNamed(actor,'DrawScale',bitsToF32(fields.drawScale));
      if('scaleGlow' in fields)runtime.writeNamed(actor,'ScaleGlow',bitsToF32(fields.scaleGlow));
      if('skins' in fields){runtime.writeNamed(actor,'MultiSkins',fields.skins.slice(0,8));runtime.writeNamed(actor,'Skin',fields.skins[8]);}
    },
  };
  gcServices.render={
    clearZ:()=>{emitOther({kind:'clearZ'});},
    drawActor:(_render,frame,actor)=>{
      const command={kind:'actor',actor:actor.name,draw:null};
      if(actorPlanner)command.draw=actorPlanner(actor,{x:W.i32(frame,0xb0),y:W.i32(frame,0xb4),width:W.i32(frame,0xa8),height:W.i32(frame,0xac)});
      emitOther(command);
    },
    computeRenderSize:()=>boundary('GC.DrawActor bConstrain resizes the HUD frame (FSceneNode::ComputeRenderSize) and draws in the clip box: not modelled (no shipped script passes bConstrain)'),
  };
  const canvas={name:'PlayHUDCanvas'};heap.allocate(canvas,0x88);
  const sceneFrame={name:'HUDSceneFrame'};heap.allocate(sceneFrame,0x300);
  const viewport=heap.allocRaw(0xc0),node=heap.addressOf(sceneFrame),renderInterface=heap.allocRaw(4),renderTable=heap.allocRaw(0x100),canvasTable=heap.allocRaw(0x60);
  const renderBase=heap.allocRaw(4);
  const put=(at,off,value,kind='u32')=>heap.mem.write(at+off,kind,value);
  W.setU32(canvas,0,canvasTable);put(canvasTable,0x5c,4);
  W.setU32(canvas,0x78,viewport);W.setU32(canvas,0x7c,node);put(node,0,viewport);
  // UCanvas.Render (+0x80): the URenderBase GC.DrawActor draws through (script-gc-draw-actor.mjs); only its identity
  // is held here, the draw is the actor planner's (setActorDrawPlanner).
  W.setU32(canvas,0x80,renderBase);
  put(viewport,0x64,renderInterface);put(renderInterface,0,renderTable);put(renderTable,0x7c,3);
  gcServices.texCache={records:Array.from({length:5},()=>heap.allocRaw(0x84)),static:heap.allocRaw(0x84),head:0,count:0};
  // A draw whose caller takes the tile commands in the form the page does (sim-session.mjs plainHudCommands: the texture as plain
  // data) gets them so, built once; the colour array is the previous command's while its three words stay (a text is drawn in a
  // colour or two), frozen as shared.
  let plainTiles=false,tileColor=Object.freeze([NaN,NaN,NaN]),tileColorBits=[-1,-1,-1];
  const colorOf=bits=>{
    const r=bits[0],g=bits[1],b=bits[2],last=tileColorBits;
    if(r!==last[0]||g!==last[1]||b!==last[2]){
      tileColor=Object.freeze([bitsToF32(r)*255,bitsToF32(g)*255,bitsToF32(b)*255]);last[0]=r;last[1]=g;last[2]=b;
    }
    return tileColor;
  };
  gcServices.callVirtual=(slot,object,command)=>{
    if(slot===1){put(command.record,0,object);return;}
    if(slot===2)return;
    if(slot!==3&&slot!==4)boundary(`Unknown HUD renderer virtual ${slot}`);
    const pointer=slot===3?heap.mem.read(command.record,'u32'):command.texture;
    const resource=resourceImages.get(pointer);if(!resource)boundary(`Unknown HUD texture pointer ${pointer}`);
    if(plainTiles){
      if(streaming){
        const at=commandStream.beginTile(plainTexture(resource.ref),colorOf(command.color),
          command.polyFlags&4?3:command.polyFlags&0x40?4:command.polyFlags&2?2:1),words=commandStream.words;
        words[at+4]=bitsToF32(command.x);words[at+5]=bitsToF32(command.y);words[at+6]=bitsToF32(command.xl);words[at+7]=bitsToF32(command.yl);
        words[at+8]=bitsToF32(command.u);words[at+9]=bitsToF32(command.v);words[at+10]=bitsToF32(command.ul);words[at+11]=bitsToF32(command.vl);
        return;
      }
      drawCommands.push({texture:plainTexture(resource.ref),x:bitsToF32(command.x),y:bitsToF32(command.y),
        width:bitsToF32(command.xl),height:bitsToF32(command.yl),u:bitsToF32(command.u),v:bitsToF32(command.v),
        ul:bitsToF32(command.ul),vl:bitsToF32(command.vl),color:colorOf(command.color),
        style:command.polyFlags&4?3:command.polyFlags&0x40?4:command.polyFlags&2?2:1});
      return;
    }
    drawCommands.push({texture:resource.ref,x:bitsToF32(command.x),y:bitsToF32(command.y),
      width:bitsToF32(command.xl),height:bitsToF32(command.yl),u:bitsToF32(command.u),v:bitsToF32(command.v),
      ul:bitsToF32(command.ul),vl:bitsToF32(command.vl),
      color:[bitsToF32(command.color[0])*255,bitsToF32(command.color[1])*255,bitsToF32(command.color[2])*255],
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
    // PushGC/PopGC per window run in Rust over the arena-backed heap
    // (gc.rs; script-vm-gc.mjs, GC_NATIVE switch).
    push:gc=>{const rust=runtime.scriptVm?.gc;
      return (rust?.stackReady(heap)?rust.push(heap,gcServices,gc):undefined)??gcPushGC(gc,gcServices);},
    pop:(gc,depth)=>{const rust=runtime.scriptVm?.gc;
      if(rust?.stackReady(heap))rust.pop(heap,gcServices,gc,depth);else gcPopGC(gc,depth,gcServices);},
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
    host.root=root;host.hud=runtime.readNamed(root,'hud');
    const augManager=runtime.readNamed(pawn,'AugmentationSystem');
    if(augManager)runtime.dispatchSpawnedEvent(augManager,'RefreshAugDisplay',[]);
    return root;
  }

  const host = {
    runtime, heap, W, lifecycle, classes, globals, boundaryLog, soundRequests, resourceImages, textureInfo,
    computerText:win=>Computer.computerDisplayedText(W,win),
    root:null,hud:null,owns:object=>families.has(object),
    // Rebind viewport/console routing; root construction remains the native
    // ConstructRootWindow entry, invoked by its actual startup caller.
    bindPlayer(next){runtime.instance(next);player=next;},
    // Original Engine Actor.EInputKey names (index = EInputKey value).
    inputKeyNames:inputConsole.names,
    // The UInput object (Extension.InputExt) a UViewport holds at +0x60.
    input:inputConsole,
    delegateLegacySubtree:object=>externalSubtrees.add(object),
    raw:{allocate:heap.allocate,read:heap.read,write:heap.write,addressOf:heap.addressOf},
    families: win => families.get(win) ?? null,
    /** The world frame of each ViewportWindow DrawWorld (sim-session.mjs). */
    setViewportPlanner(planner){viewportPlanner=planner;},
    /** GC.DrawActor's mesh draw (sim-session.mjs planHudActor): called with the actor in the state the XGC body set. */
    setActorDrawPlanner(planner){actorPlanner=planner;},
    isDestroyed: win => destroyed.has(win),
    processScript, constructRootWindow, configureChild, askParentForReconfigure, setVisibility,
    canvas,node,
    tick(root,seconds){lastTickTime=hostNow()/1000;T.rootTick(W,root,f(seconds));},
    // XInputExt::Process 0x1002d0b0 offers each key to XRootWindow::Process first.
    key(root,key,action,delta=0){return Input.rootProcess(W,root,key,action,delta);},
    consoleCommands,nativeConfig,display,snapshot:W.snapshot,gameEngineHooks,
    /** UEngine::InputEvent for one browser key edge. The optional
     * hostBinding override remains only for isolated legacy fixtures. */
    inputEvent(key,action,{delta=0,hostBinding=()=>false,flushRenderDevice=null}={}){
      const saved={...input};input.hostBinding=hostBinding;input.flushRenderDevice=flushRenderDevice;
      if(action===1&&key>=0&&key<input.platformKeys.length)input.platformKeys[key]=1;
      else if(action===3&&key>=0&&key<input.platformKeys.length)input.platformKeys[key]=0;
      try{return consoleCommands.inputEvent(key,action,delta);}
      finally{Object.assign(input,saved);}
    },
    /** One WM_CHAR/WM_SYSCHAR character unit from the platform: WinDrv's
     * ViewportWndProc drops 0x0d, then Client->Engine->Key (XGameEngineExt::Key,
     * docs/script-window-typed-keys.md). Returns {handled, console}. */
    typedKey(char){
      if(!Number.isInteger(char)||char<0||char>0xffff)throw new TypeError('A typed character is one UTF-16 code unit');
      if(char===0x0d)return {handled:false,console:false,filtered:true};
      return consoleCommands.key(char);
    },
    /** Platform-side ResetInput. Blur/hidden handlers pass releasePhysical;
     * other native reset sites preserve the event-fed physical snapshot. */
    resetInput({releasePhysical=false}={}){
      if(releasePhysical)input.platformKeys.fill(0);
      consoleCommands.resetInput();
    },
    /** Raw browser relative motion is sampled at UpdateInput, not converted to
     * actor axes per DOM event. Native cursor coordinates are signed int32. */
    mouseMotion(dx,dy){
      if(!Number.isFinite(dx)||!Number.isFinite(dy))boundary('Non-finite viewport mouse movement is unsupported');
      input.mouseDeltaX=(input.mouseDeltaX+Math.trunc(dx))|0;
      input.mouseDeltaY=(input.mouseDeltaY+Math.trunc(dy))|0;
    },
    viewportReadInput(delta){return consoleCommands.viewportReadInput(delta);},
    // Browser/viewport adapter into the already recovered root mouse route.
    // Coordinates are drawing-buffer pixels, matching the root canvas size.
    /** Whether a window holds the root's mouse (the grab count pointer() tests): a menu or another modal is open. */
    mouseGrabbed(root){return Boolean(W.i32(root,Input.ROOT_INPUT.mouseGrab));},
    pointer(root,{x=0,y=0,dx=0,dy=0,relative=false,key=null,action=null}){
      if(!W.i32(root,Input.ROOT_INPUT.mouseGrab))return false;
      const px=relative?f(W.f32(root,Mouse.MOUSE.mouseX)+f(dx)):f(x);
      const py=relative?f(W.f32(root,Mouse.MOUSE.mouseY)+f(dy)):f(y);
      Mouse.setRootCursorPos(W,root,px,py);
      if(key!==null&&action!==null)Input.rootProcess(W,root,key,action);
      return true;
    },
    resizeViewport,
    get viewportSize(){return viewportSize;},
    /** The 3D view's rect in drawing-buffer pixels for a width x height
     * viewport: XRootWindow PreRender's frame edit (script-root-render-viewport). */
    renderViewport(root,width,height){return rootRenderViewport(W,root,{x:0,y:0,width,height});},
    draw(root,width,height,view,plain=false){
      resizeViewport(width,height);
      // The root's frame (+0x740) is the canvas frame after PreRender's edit
      // and ComputeRenderSize, so projection centres on the render rect
      // (ConvertVectorToCoordinates adds renderX/Y back). With rendering off
      // the size is 0 x 0 and the previous frame stays (nothing projects).
      const rect=view?rootRenderViewport(W,root,{x:0,y:0,width,height}):null;
      if(rect?.width>0&&rect.height>0){host.lastSceneFrame={input:{...view,width:rect.width,height:rect.height,renderMode:5},
        value:writeWindowSceneFrame(W,node,{...view,width:rect.width,height:rect.height,renderMode:5})};W.setPtr(root,0x740,sceneFrame);}
      W.setF32(canvas,0x3c,width);W.setF32(canvas,0x40,height);
      T.resizeRoot(W,root,canvas);T.reconfigureTree(W,root,0);T.initializeWindows(W,root);
      drawCommands.length=0;commandStream.reset();
      // The Rust core may run the GC natives while this paint runs
      // (script-vm-gc.mjs open: only when this host's dispatch would).
      const gcNatives=runtime.scriptVm?.gc;
      gcNatives?.open({heap,services:gcServices,handleNative:lifecycle.handleNative});
      plainTiles=plain===true||plain==='stream';streaming=plain==='stream';
      try{T.paintWindows(W,root,canvas);}finally{plainTiles=false;streaming=false;gcNatives?.close();}
      return plain==='stream'?commandStream.finish():drawCommands.slice();
    },
    install() {
      runtime.windowLifecycle = {...runtime.windowLifecycle, ...lifecycle};
      return host;
    },
  };
  lifecycle.host = host;
  return host;
}
