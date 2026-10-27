import {farMoveMode} from './script-vm-render.mjs';
import {hostNow} from './host-clock.mjs';
import { execUpdateParticles } from './script-particles.mjs';
import {setWindowHeightNative} from './script-window-size.mjs';
import {setTileWindow} from './script-window-tile.mjs';
import {setWindowConfigurationNative} from './script-window-configuration.mjs';
import { readClass } from '../unreal/classes.mjs';
import { readFieldLinks, readFunctionMetadata, readPropertyMetadata, readStateMetadata, readStructMetadata } from '../unreal/script-metadata.mjs';
import { ScriptObjects } from './script-objects.mjs';
import { ScriptClassLoader } from './script-class-loader.mjs';
import { compileFunction, refValue } from './script-vm.mjs';
import { clientTravelNative } from './script-travel.mjs';
import { ScriptState, stateChanged } from './script-state.mjs';
import {execAttachDecal,execDetachDecal,DecalBoundaryError,attachDecalSurfaces,detachDecalSurfaces} from './script-decal.mjs';
import {
  zeroValue, copyValue, propertyReference, storageReference, arrayReference, propertyCodec, NO_ELEMENT,
} from './script-values.mjs';
import { objectImageCells, readCell, writeCell, readFixedElement, isFixedCell, scalarCell, pointerOffset } from './script-object-image.mjs';
import { createFrameLocals, FrameStack, LocalCellStorage } from './script-frame-locals.mjs';
import { releaseHandle } from './script-object-handles.mjs';
import { loadScriptVmKernel } from './script-vm-kernel.mjs';
import { loadTraceKernel } from './trace-kernel.mjs';
import { RustScriptVm, classDefaultsChanged } from './script-vm-rust.mjs';
import { ObjectArena } from './script-object-arena.mjs';
import { destroyScriptProperty } from './script-property-destroy.mjs';
import { createAllActorsIterator, createTraceActorsIterator, createTraceVisibleActorsIterator, createTraceTextureIterator, createRadiusActorsIterator, createVisibleActorsIterator, createVisibleCollidingActorsIterator, createBasedActorsIterator, createCycleActorsIterator } from './script-iterators.mjs';
import { actorRadiusCheck } from './collision-hash-radius.mjs';
import { scriptTrace, scriptFastTrace } from './script-trace.mjs';
import { execParabolicTrace, levelParabolicServices } from './script-actor-parabolic-trace.mjs';
import { setActorTimer, updateActorTimer } from './script-timers.mjs';
import { sleepActor, pollActorSleep } from './script-sleep.mjs';
import { probeNames, probeIndex } from '../unreal/probe-names.mjs';
import { conditionalDestroyScriptObject, destroyScriptObject } from './script-object-lifecycle.mjs';
import { setScriptOwner } from './script-owner.mjs';
import { destroyScriptActor } from './script-destroy.mjs';
import { scriptObjectToString } from './script-string-operations.mjs';
import { constructFreshScriptObject, allocateFreshScriptObject, constructActorBase, nativeConstructorFor } from './script-object-construction.mjs';
import { checkActorEncroachment, actorBlockedBy } from './check-encroachment.mjs';
import { setBase } from './walking-callbacks.mjs';
import { playerMove } from './player-move.mjs';
import { moveActorRiders } from './move-riders.mjs';
import { farMoveActor } from './relocation.mjs';
import { isMapMoveHost, linkLiveCollision } from './map-actor-native.mjs';
import { actorWordOf, flagWord, MOTION_WORD } from './actor-flag-words.mjs';
import { liveVector } from './actor-mirror-fields.mjs';
import { saveConfig, configRoot, loadConfig as loadObjectConfig, defaultsObject } from './script-config.mjs';
import {
  installActorCollisionView, findActorBase, setCollisionArguments,
  setActorCollision, setActorCollisionSize, setActorPhysics,
} from './script-actor-collision.mjs';
import { execPlayAnim, execLoopAnim, execTweenAnim, execPlayBlendAnim, execTweenBlendAnim, isAnimating } from './play-anim.mjs';
import { execGetAnimGroup } from './script-get-anim-group.mjs';
import { animationView, animationTickView } from './script-anim.mjs';
import { tickActorAnimation } from './animation-tick.mjs';
import { createLodMeshFrameCache, getLodMeshFrame } from './lodmesh-frame.mjs';
import { getActorSkin, getMeshTexture, execGetMeshTexture, readLodMeshSurfaces } from './lodmesh-materials.mjs';
import { createUMeshFrameCache, getUMeshFrame } from './umesh-frame.mjs';
import { readUMeshSurfaces } from './umesh-surfaces.mjs';
import { tickStandaloneActor, actorInStasis } from './actor-tick.mjs';
import { scriptedPawnTick } from './scripted-pawn-tick.mjs';
import { bumpBaseEpoch,bumpActorsEpoch } from './base-epoch.mjs';
import { bumpReceiverEpoch } from './receiver-epoch.mjs';
const ACTOR_BASE_KEY='engine.actor.base';
import { tickStandaloneLevel } from './level-tick.mjs';
import { dispatchFinishAnim, pollFinishAnim } from './finish-anim.mjs';
import { ScriptResourceRegistry } from './script-resources.mjs';
import { execActorPlaySound, execPawnClientHearSound } from './script-sound.mjs';
import { actorProcessRemoteFunction } from './process-remote-function.mjs';
import { execMove } from './script-move.mjs';
import {
  dispatchMoveTo, dispatchMoveToward, dispatchTurnTo, dispatchTurnToward,
  dispatchStrafeTo, dispatchStrafeFacing, pollStrafeTo, pollStrafeFacing,
  dispatchWaitForLanding, pollMoveTo, pollMoveToward, pollTurnTo,
  pollTurnToward, pollWaitForLanding,
} from './script-pawn-locomotion.mjs';
import { runScriptPawnPhysics, pawnPhysicsView } from './script-pawn-physics.mjs';
import { moveSmoothActor, moveSmoothPawn } from './move-smooth.mjs';
import { execAiPickRandomDestination, execAiDirectionReachable, execFindPathToward, execFindPathTo, execEAdjustJump, actorReachable, pointWorker, aiDirection, createReachablePathnodesIterator } from './script-pawn-nav.mjs';
import { actorLightLevelExtended, execAIGetLightLevel, execAIVisibility } from './script-ai-visibility.mjs';
import { execMakeNoise } from './script-noise.mjs';
import { execPawnAlliance } from './script-pawn-alliance.mjs';
import { execPawnCarcass } from './script-pawn-carcass.mjs';
import {
  execLineOfSightTo, execCanSee, execPlayerCanSeeMe,
  execPickTarget, execPickAnyTarget, execAICanSee, showPawnSelf, checkPawnEnemyVisible,
} from './script-pawn-perception.mjs';
import { fastLineCheck } from './fast-line-check.mjs';
import { isOverlapping, beginTouch, endTouch } from './actor-touch.mjs';
import { setScriptRotation } from './script-set-rotation.mjs';
import { execSetLocation } from './script-set-location.mjs';
import { bindActorConversations } from './script-conversation-wrapper.mjs';
import { bindConversationsNative } from './script-native-conversation-list.mjs';
import { constructConversationItem, releaseConversationItem } from './script-conversation-item-lifecycle.mjs';
import { RANDOM_LABEL_NATIVE, decodeRandomLabelLabels, getLabelCount, getLabel, getRandomLabel } from './script-conversation-random-label.mjs';
import { execScriptSpawn, spawnActor } from './script-spawn.mjs';
import { createFlagBase } from './script-triggers.mjs';
import { addPawn, removePawn } from './pawn-list.mjs';
import { importText } from './config-text.mjs';
import { importClassText } from './script-class-import-text.mjs';
import { UnmodelledClassLookup } from './original-loaded.mjs';
import { ScriptProcess } from './script-process.mjs';
import { setActorZone } from './zone.mjs';
import { prepareContextResults, zeroContextResult } from './script-context-results.mjs';
import { cleanupScriptReferences, cleanupLevelDestroyed, cleanupSites, cleanupFields, cleanupImageSites } from './script-cleanup.mjs';
import { OriginalObjectIndexModel } from './original-object-index.mjs';
import { destructScriptObject, freeScriptObject, releaseScriptCameraPoint } from './script-object-release.mjs';
import { TEXT_PARSER_NATIVE } from './script-text-parser.mjs';
import { EXT_STRING_CLASS_MEMBERS, constructTextParserObject, dispatchTextParserNative, releaseTextParserObject } from './script-text-parser-natives.mjs';
import { serializeScriptReferences } from './script-reference-serialization.mjs';
import { serializeRuntimeActor } from './script-runtime-serialization.mjs';
import { readScriptStructValue } from './script-struct-values.mjs';
import { loadScriptStructLayout } from './script-struct-layout.mjs';
import { readObject } from '../unreal/objects.mjs';
import { prepareMapProperties } from './script-map-properties.mjs';
import { extensionStringToName } from './script-extension-strings.mjs';
import { scriptIsInState, scriptGetStateName } from './script-state-queries.mjs';
import { createConversationEventsNativeService } from './script-conversation-events.mjs';
import { bindSpeechActor } from './script-conversation-speech.mjs';
import { bindConversationAction } from './script-conversation-action-bind.mjs';
import {
  isConversationBaseBindClass,
  bindConversationBaseActor,
  isConversationMoveCameraBindClass,
  bindConversationMoveCameraActor,
} from './script-conversation-base-bind.mjs';
import {
  isConversationCheckObjectBindClass,
  bindConversationCheckObjectActor,
} from './script-conversation-check-object-bind.mjs';
import {
  isConversationTransferObjectBindClass,
  bindConversationTransferObjectActor,
} from './script-conversation-transfer-object-bind.mjs';
import { clearConversationEvents } from './script-conversation-clear.mjs';
import { conversationSpeechLength, conversationSoundLength } from './script-conversation-sound-length.mjs';
import { conversationSpeechAudio } from './script-conversation-speech-audio.mjs';
import { createNewWindowNative } from './script-window-child.mjs';
import { processWindowScript } from './script-window-script.mjs';
import { getRootWindowNative } from './script-window-hierarchy.mjs';
import { getParentWindowNative } from './script-window-parent.mjs';
import { askParentForReconfigureNative } from './script-window-reconfigure.mjs';
import { setWindowSizeNative } from './script-window-size.mjs';
import { setWindowWidthNative } from './script-window-width.mjs';
import { setFocusWindowNative } from './script-window-focus.mjs';
import { changeStyleWindowNative } from './script-window-change-style.mjs';
import { setChildVisibilityNative, showWindowNative, isWindowVisibleNative } from './script-window-visibility.mjs';
import {
  setSensitivityNative, enableWindowNative, disableWindowNative, isWindowSensitiveNative,
  getTopChildNative, getBottomChildNative, getHigherSiblingNative, getLowerSiblingNative,
  getClientObjectNative, windowSensitivityOptionalDefault,
} from './script-window-sensitivity.mjs';
import { getToggleNative } from './script-window-toggle-get.mjs';
import { setToggleNative } from './script-window-toggle-set.mjs';
import { changeToggleNative } from './script-window-change-toggle.mjs';
import { findStairRotation } from './script-pawn-stair-rotation.mjs';
import { configureChildNative } from './script-window-configure-child.mjs';
import { setWindowPositionNative } from './script-window-position.mjs';
import { setWindowAlignmentsNative } from './script-window-alignments.mjs';
import { setBackgroundStyleNative, setBackgroundSmoothingNative } from './script-window-background-style.mjs';
import { raiseWindowNative, hideWindowNative } from './script-window-order.mjs';
import { lowerWindowNative } from './script-window-lower.mjs';
import { setWindowBackgroundNative, setWindowTileColorNative } from './script-window-surface.mjs';
import { killAllChildrenNative, safeDestroyWindowNative } from './script-window-destroy.mjs';
import { PLAYER_DESTROY, destroyDeusExPlayerNative, destroyFlagBaseNative, destroyPlayerPawnExtNative } from './script-player-destroy.mjs';
import {
  appendTextNative, convertScriptString, setWindowFontNative, setWindowTextColorNative, setTextNative,
  setTextAlignmentsNative, setTextMarginsNative,
} from './script-window-text.mjs';
import {
  setComputerTextSizeNative, setComputerTextFontNative,
  setComputerTextTimingNative, setComputerFadeSpeedNative,
  setComputerCursorColorNative, showComputerTextCursorNative,
  clearComputerScreenNative, printComputerTextNative,
  enableComputerWordWrapNative,
} from './script-window-computer.mjs';
import {
  execDynamicLoadObject,DynamicLoadObjectBoundaryError,PreparedDynamicLoadGraph,
} from './script-dynamic-load-object.mjs';
import {staticLoadObject as execStaticLoadObject} from './script-static-load-object.mjs';
import {CLIENT_LAZY_LOAD,clientTextureLodSet} from './script-client-resource-settings.mjs';
import {DEUSEX_VERSION_NATIVE,getDeusExVersion} from './script-deusex-version.mjs';
import {execObjectLog} from './script-log.mjs';
import {execVRand} from './script-vrand.mjs';
import {execRotRand} from './script-rot-rand.mjs';
import {parseToken} from './script-console-command.mjs';
import {GAME_DIRECTORY} from './script-game-directory.mjs';
// A spawned actor's +0x1ec word over its object image (actor-flag-words.mjs);
// null for a class without linked offsets (an isolated harness), whose
// collision view composes the same bools from their fields.
const imagedMotionWord=instance=>instance.cells&&instance.base?flagWord(instance,MOTION_WORD):null;

const lower=name=>String(name).toLowerCase();
// Event and function names are a small fixed vocabulary: keep their lowercase.
const lowerNames=new Map();
const lowerName=name=>{
  if(typeof name!=='string')return lower(name);
  let key=lowerNames.get(name);
  if(key===undefined)lowerNames.set(name,key=name.toLowerCase());
  return key;
};
/** The boundary functions (a Map by function key) with change listeners:
 * the Rust interpreter's call cache (script-vm-events.mjs) holds decisions
 * that depend on which keys are present. */
class BoundaryFunctions extends Map {
  constructor(entries){super(entries);this.listeners=[];}
  set(key,value){
    super.set(key,value);
    for(const listener of this.listeners??[])listener();
    return this;
  }
  delete(key){
    const removed=super.delete(key);
    for(const listener of this.listeners)listener();
    return removed;
  }
  clear(){
    super.clear();
    for(const listener of this.listeners)listener();
  }
}
// Per linked class: whether its chain reaches engine.actor (fixed once linked).
const actorChains=new WeakMap();
const reachesActor=cls=>{
  let result=actorChains.get(cls);
  if(result===undefined){
    result=false;
    for(let entry=cls;entry;entry=entry.base)if(entry.record.key==='engine.actor'){result=true;break;}
    actorChains.set(cls,result);
  }
  return result;
};
// A prepared function's destroyable locals (CPF_NeedCtorLink), with and
// without its parameters; the field list is fixed once prepared.
const destroyedLocals=new WeakMap();
const memberCaches=new WeakMap();
// Stage 1b (docs/object-memory.md): per class, each spelled property name
// resolved once to a handle on its linked field (a miss included).
const fieldTables=new WeakMap();
const fieldTable=cls=>{
  let table=fieldTables.get(cls);
  if(!table)fieldTables.set(cls,table=new Map());
  return table;
};
const animationTickViews=new WeakMap();
/** One attached object's VM record. Every record shares this hidden class:
 * the fields later code fills in are declared here, and an actor's
 * pendingKill (its bDeleteMe) is a prototype getter rather than a property
 * redefined per record, which left actor records in dictionary mode. */
class ScriptInstance {
  constructor(runtime,cls,slots,state,storage){
    // The slot fallback's defaults as of attachment. An object whose every
    // property has an image cell never reads a slot, so it keeps no copy.
    this.runtime=runtime;this.cls=cls;this.fieldTable=fieldTable(cls);
    this.defaultsSnapshot=storage.complete?undefined:new Map(cls.defaults);
    this.slots=slots;this.bindings=new Map();this.state=state;this.singular=false;
    // The image is [base, base+size) of the runtime's object arena (R0).
    this.cells=storage.cells;this.arena=storage.arena;this.base=storage.base;this.size=storage.size;this.refs=storage.refs;
    this.poison=storage.poison?.size?storage.poison:null;this.imageSource=storage.source;
    this.nativeObject=undefined;this.globalIndex=undefined;this.textParser=undefined;this.randomLabels=undefined;
    this.receiver=null;this.deleteMe=null;this.pendingKillValue=false;
    // The Rust actor tick's field mask and class flags (actor-tick-kernel.mjs).
    this.tickDesc=undefined;
    // The image range's release token (arena, base, size); see releaseObjectImage.
    this.imageToken=storage.base?{arena:storage.arena,base:storage.base,size:storage.size,released:false}:null;
  }
  /** The image addressed from zero, for callers outside the access paths. */
  get image(){return this.base?this.arena.window(this.base,this.size):null;}
  // An actor's pendingKill is its bDeleteMe and cannot be assigned; another
  // object keeps whatever its host assigns (fixtures set it directly).
  get pendingKill(){
    return this.deleteMe!==null?Boolean(this.runtime.readField(this.receiver,this.deleteMe)):this.pendingKillValue;
  }
  set pendingKill(value){
    if(this.deleteMe!==null)throw new TypeError('Cannot set property pendingKill of an actor, which has only a getter');
    this.pendingKillValue=value;
  }
}
/** An image cell as a reference's storage (storageReference): the VM builds
 * one reference per variable operand, so its accessors are methods, not
 * closures. A value that could not be produced is rethrown as before. */
class CellStorage {
  constructor(runtime,instance,field,cell){
    this.descriptor=null;this.runtime=runtime;this.instance=instance;this.field=field;this.cell=cell;
  }
  get(){
    const instance=this.instance,entry=instance.poison?.get(this.field.key);
    return entry?entry.read():readCell(this.cell,instance.arena.view,instance.refs,instance.base);
  }
  /** One element of a fixed-array cell (PropertyReference element reads);
   * a poisoned value keeps the whole-value path and its error timing. */
  readElement(index){
    const instance=this.instance;
    if(!isFixedCell(this.cell)||instance.poison?.get(this.field.key))return NO_ELEMENT;
    return readFixedElement(this.cell,instance.arena.view,instance.refs,index,instance.base);
  }
  set(value){
    const instance=this.instance,entry=instance.poison?.get(this.field.key);
    if(entry?.write)entry.read();
    writeCell(this.cell,instance.arena.view,instance.refs,value,instance.base);
    if(entry)this.runtime.clearPoison(instance,this.field.key);
  }
}
// The VM's local operands (R2a): a linked frame's cell, else the field's
// entry in the Map storage of an unlinked function. The same scope checks
// and value copy (the field codec is readWhole's copyStored) either way.
const localValue=(locals,field)=>{
  if(!field)throw new Error('Local bytecode property reference was cleared');
  const cell=locals.layout?.cells.get(field.key);
  if(cell)return propertyCodec(field).read(locals.readCell(cell));
  if(!locals.has(field.key))throw new Error(`Local is outside the function: ${field.key}`);
  return propertyCodec(field).read(locals.get(field.key));
};
const localReference=(locals,field)=>{
  if(!field)throw new Error('Local bytecode property reference was cleared');
  const cell=locals.layout?.cells.get(field.key);
  if(cell)return storageReference(field,new LocalCellStorage(locals,cell));
  if(!locals.has(field.key))throw new Error(`Local is outside the function: ${field.key}`);
  return propertyReference(field,()=>locals.get(field.key),value=>locals.set(field.key,value));
};
// CleanupDestroyed's reference pass over an instance's image, per class
// cells: the pointer sites in play's visit order (script-cleanup.mjs
// cleanupSites) and their image offsets; false where a top-level field it
// reads has no cell (the reference path runs). A bound field's sites are
// read through the binding (script-cleanup.mjs cleanupImageSites).
const cleanupPlans=new WeakMap();
// The runtimes' services objects so far (their cacheId).
let servicesCount=0;
export function cleanupPlan(instance) {
  const cells=instance.cells,fields=instance.cls.propertyLink;
  if(!cells||instance.poison)return null;
  let plan=cleanupPlans.get(cells);
  if(plan===undefined||plan&&plan.fields!==fields){
    plan=false;
    const keys=cleanupFields(fields).map(field=>field.key),sites=cleanupSites(fields);
    if(sites&&keys.every(key=>cells.has(key))){
      const offsets=sites.map(site=>pointerOffset(cells.get(site.path[0].field.key),site.path));
      if(offsets.every(offset=>offset!==null))plan={fields,sites,offsets:Uint32Array.from(offsets)};
    }
    cleanupPlans.set(cells,plan);
  }
  return plan||null;
}
const imageFinalizer=new FinalizationRegistry(token=>{
  if(token.released)return;
  token.released=true;token.arena.release(token.base,token.size);
});
const sameDefaults=(snapshot,defaults)=>{
  if(snapshot.size!==defaults.size)return false;
  for(const [key,values] of defaults)if(snapshot.get(key)!==values)return false;
  return true;
};
/** exec bodies resolve each out expression to a raw address; a non-assignable
 * expression lands in a private temporary whose writes never escape. */
const writeSlot=value=>value?.reference&&typeof value.set==='function'?value:{set(){}};

/** Linked, synchronous original script calls. Loading/linking remains async;
 * an event never suspends halfway through an original call to fetch an asset.
 * A prepared function/state subset fails explicitly on an unprepared target. */
// Function bodies run in the Rust interpreter (script-vm-rust.mjs,
// docs/rust-core.md R2b) by default. SCRIPT_VM=js keeps the JavaScript VM,
// the reference every Rust kind is validated against; in the browser the
// page's ?scriptVm=js sets DEUS_EX_SCRIPT_VM. Any other value is an error.
const scriptVmSetting=()=>{
  const value=(typeof process!=='undefined'&&process.env?.SCRIPT_VM)||globalThis.DEUS_EX_SCRIPT_VM||'rust';
  if(value!=='rust'&&value!=='js')throw new Error(`SCRIPT_VM must be 'rust' or 'js', not '${value}'`);
  return value;
};
const scriptVmRust=()=>scriptVmSetting()==='rust';
const SCRIPT_VM_CHECK=typeof process!=='undefined'&&process.env?.SCRIPT_VM_CHECK==='1';
// Mesh payloads the script-side mesh consumers (anim sequences, textures)
// accept: ULodMesh and a classic UMesh (docs/umesh.md).
const MESH_PAYLOADS=new Set(['decoded-lodmesh','decoded-mesh']);
// soundField names served from the level container or native graph.
// Native function bodies Core ProcessEvent reaches through UFunction::Func
// (1013f936) for a FUNC_Native event, keyed by function record key; `this` is
// the ScriptRuntime and `args` the copied parameter block.
const NATIVE_EVENT_BODIES=Object.freeze({
  // APawn::execClientHearSound 0x103dfc40 (docs/galaxy-audio.md "Play").
  'engine.pawn.clienthearsound'(receiver,args){execPawnClientHearSound(receiver,args,this.audioServices());},
});
const SOUND_LEVEL_FIELDS=new Set(['XLevel','Level','Actors','PawnList','nextPawn','NetMode','TimeSeconds',
  'DemoRecDriver','Model','Engine','Client','Viewports','ServerConnection','Actor']);

/** The script process's class loader (script-process.mjs). Its services read the level attached now through `shared.runtime`; they
 * are made here, outside a runtime's constructor, so that their closures keep no runtime alive (a closure made in the constructor
 * shares its scope with the ones that capture `this`). */
function createProcessClassLoader(shared,assets,objects){
  return new ScriptClassLoader({assets,objects,
    resources:()=>shared.runtime.resourceRegistry(),
    // Retain Play's explicit deferred mesh policy on the shared archive.
    meshLoadServices:{getLazyLoad:()=>1},
    // Texture/Palette/Sound/Font constructors and serializers. The clock is
    // the host's appSeconds; the mip bias is UBitmap::__Client's
    // TextureLODSet from the installed WindowsClient config.
    resourceServices:{
      seconds:()=>hostNow()/1000,
      getLazyLoad:()=>shared.runtime.lazyLoad,setLazyLoad:value=>{shared.runtime.lazyLoad=value;},
      mipBias:(texture,lodSet)=>{
        const config=shared.classLoader.graph.config;
        if(!config)throw new Error('Texture mip bias requires the prepared GConfig');
        return clientTextureLodSet(config)[lodSet]??0;
      },
    },
    lifecycle:{logReceiver:{kind:'GWarn'},
      logEndLoad:event=>shared.runtime.loadLifecycle.push({op:'Logf',...event}),
      reallocLoaded:event=>shared.runtime.loadLifecycle.push({op:'FArrayRealloc',num:event.num,max:event.max})},
  });
}

export class ScriptRuntime {
  constructor(assets,{native,warning,levelFor,actorLifecycle,rng,nameServices,conversationObjects,conversationLifecycle,windowLifecycle,logDevice,relocation,nativeClassLoading=false,boundaryNatives=[],boundaryFunctions=[],process=null}={}) {
    this.instanceKey=Symbol('ScriptRuntime instance');this.classIsACache=new WeakMap();this.arena=new ObjectArena();
    // The original's process state that outlives this level (script-process.mjs): the package identities, readiness, the classes and
    // the class loader. A runtime built without one has a process of its own.
    const shared=this.process=process??new ScriptProcess(assets);
    // Each runtime builds its classes' default images in its own arena: the Rust interpreter reads an image only from its arena.
    this.classImages=new WeakMap();
    this.lastLinkedReceiver=null;this.lastLinkedInstance=undefined;
    this.nameSpelling=assets?.nameSpelling??null;this.objects=new ScriptObjects(assets,shared);this.classes=shared.classes;this.functions=shared.functions;
    // GLazyLoad for a client launch (docs/script-font-load.md). The mesh
    // archive keeps Play's separately documented deferred policy below.
    this.lazyLoad=CLIENT_LAZY_LOAD;this.loadLifecycle=[];
    // The class loader is the process's; its services reach the level attached now (ScriptProcess.attach).
    this.classLoader=nativeClassLoading?(shared.classLoader??=createProcessClassLoader(shared,assets,this.objects)):null;
    if(this.classLoader){
      const resolve=this.objects.resolve.bind(this.objects);
      this.objects.resolve=async(asset,index)=>{
        try{return await resolve(asset,index);}catch(error){
          // ULinkerLoad::VerifyImport resolves native-registered objects
          // (Core.Class, Engine.Viewport, Engine.Music...) that appear only as
          // imports — the metadata path knows package exports alone, so the
          // recovered linker's import table owns those misses.
          const record=this.classLoader.graph.indexToObject(this.classLoader.graph.buildLinker(asset.name),index);
          return this.classLoader.identity(record);
        }};
    }
    // The process's: the linked classes in link order (the loaded UClass objects SaveConfig's GObjObjects walk reloads, script-config.mjs),
    // Engine.Actor's class and readiness.
    this.linkedClasses=shared.linkedClasses;this.actorClass=shared.actorClass;
    this.states=shared.states;this.structs=shared.structs;this.structLayouts=shared.structLayouts;this.instances=new WeakMap();this.native=native;this.warning=warning;this.logDevice=logDevice;
    this.eventsEnabled=true;
    this.conversationLists=new Map();
    // Every object each prepared ConversationList's load reaches (prepareConversations).
    this.conversationListObjects=new Map();
    this.conversationLifecycle=conversationLifecycle;
    this.windowLifecycle=windowLifecycle;
    this.conversationEventNative=createConversationEventsNativeService({
      objects:conversationObjects,
      read:(object,key)=>this.readNamed(object,key),
      write:(object,key,value)=>this.writeNamed(object,key,value),
      reference:object=>{this.instance(object);return object;},
      isA:(object,name)=>{
        for(let cls=this.instance(object).cls;cls;cls=cls.base)
          if(cls.record.key===`engine.${name.toLowerCase()}`)return true;
        return false;
      },
      bindActor:args=>{
        const key=this.instance(args.event).cls.record.key;
        if(key==='consys.coneventspeech')return bindSpeechActor({...args,
          read:(object,key)=>this.readNamed(object,key),
          write:(object,key,value)=>this.writeNamed(object,key,value),
        });
        if(key==='consys.coneventanimation'||key==='consys.coneventtrade')
          return bindConversationAction({...args,
            read:(object,key)=>this.readNamed(object,key),
            write:(object,key,value)=>this.writeNamed(object,key,value),
          });
        if(isConversationCheckObjectBindClass(key)){
          const services=this.conversationLifecycle?.checkObject;
          return bindConversationCheckObjectActor({...args,
            read:(object,key)=>this.readNamed(object,key),
            write:(object,key,value)=>this.writeNamed(object,key,value),
            classRef:services?.classRef,
            createPackage:typeof services?.createPackage==='function'
              ? details=>services.createPackage(details):null,
            staticLoadObject:typeof services?.staticLoadObject==='function'
              ? request=>services.staticLoadObject(request):null,
          });
        }
        if(isConversationTransferObjectBindClass(key)){
          const services=this.conversationLifecycle?.transferObject;
          return bindConversationTransferObjectActor({...args,
            read:(object,key)=>this.readNamed(object,key),
            write:(object,key,value)=>this.writeNamed(object,key,value),
            classRef:services?.classRef,
            createPackage:typeof services?.createPackage==='function'
              ? details=>services.createPackage(details):null,
            staticLoadObject:typeof services?.staticLoadObject==='function'
              ? request=>services.staticLoadObject(request):null,
          });
        }
        if(isConversationMoveCameraBindClass(key))
          return bindConversationMoveCameraActor({classKey:key});
        if(isConversationBaseBindClass(key))return bindConversationBaseActor({classKey:key});
        throw new Error(`Original conversation event BindActor is unsupported: ${key}`);
      },
    });
    this.originalObjectIndex=null;
    this.resources=null;
    this.preparedObjects=new Map();
    this.dynamicLoadGraph=null;
    // Spawned actors that carry the recovered collision/native view
    // (installActorCollisionView). Natives 262/283/3970 route to the
    // recovered bodies only for these receivers; map actors keep their
    // host-native paths.
    this.collisionViewActors=new WeakSet();
    // Native indices the host owns as external boundaries: invokeNative delegates
    // these to the `native` callback even when the runtime has a built-in body.
    // Focused script harnesses use this to record a native (e.g. PlaySound 264)
    // instead of running its full engine implementation. Play currently retains
    // that sound boundary until its native listener/audio graph is connected.
    this.boundaryNatives=new Set(boundaryNatives);
    // Scripted functions the host owns as external boundaries (parallel to
    // boundaryNatives): a Map from lowercase function key to a handler
    // `(call)=>returnValue`. When a script call resolves to such a function,
    // callFunction invokes the handler instead of executing the unbuilt body,
    // e.g. DeusExPlayer.StartDataLinkTransmission. Its host-selected return value
    // can affect later branches and does not establish the original result. The handler
    // receives {record, receiver, argumentCount, evaluateArgument}.
    this.boundaryFunctions=new BoundaryFunctions(boundaryFunctions);
    this.levelFor=receiver=>{
      const object=(receiver?.[this.instanceKey]??this.instances.get(receiver))?.nativeObject;
      return object&&Object.hasOwn(object,'xLevel')?object.xLevel:levelFor?.(receiver);
    };
    this.actorLifecycle=actorLifecycle;
    this.rng=rng;
    this.nameServices=nameServices;
    this.relocation=relocation;
    this.contextResults=shared.contextResults;
    this.levelTickActorOptions=new WeakSet();this.levelTickActorServices=new WeakMap();
    this.services={
      // A number naming these services in caches that outlive the level (script-vm.mjs operandCache).
      cacheId:++servicesCount,
      invoke:call=>this.invoke(call),invokeNative:call=>this.invokeNative(call),
      iterator:call=>this.createIterator(call),
      objectReference:(script,index,node)=>this.objects.operand(script,node),
      castObject:(value,target,kind)=>this.castObject(value,target,kind),
      objectToString:value=>scriptObjectToString(value,object=>this.instances.get(object)?.nativeObject??object),
      zeroContextResult:(script,node,size)=>zeroContextResult(this.contextResults.get(script),node,size),
      localReference:(locals,script,node)=>localReference(locals,this.objects.operand(script,node)),
      // refValue(localReference(...)): same operand/scope checks and value
      // copy (the field codec is readWhole's copyStored), without the lvalue.
      localValue:(locals,script,node)=>localValue(locals,this.objects.operand(script,node)),
      // The same services with the operand already resolved by the caller
      // (the compiled VM keeps it while objects.operandEpoch is unchanged).
      operand:(script,node)=>this.objects.operand(script,node),
      operandEpoch:()=>this.objects.operandEpoch,
      localValueOf:localValue,
      localReferenceOf:localReference,
      // assign(localReferenceOf(locals, field), valueOf(frame)) without the
      // lvalue: the same scope checks and descriptor before the value is
      // evaluated, then PropertyReference.set's merge-store and returned copy.
      assignLocalOf:(locals,field,valueOf,frame)=>{
        if(!field)throw new Error('Local bytecode property reference was cleared');
        // R2a: a linked frame's cell; the stored value is read after the
        // right-hand side is evaluated, as the Map storage was.
        const cell=locals.layout?.cells.get(field.key);
        if(cell){
          const codec=propertyCodec(field),value=valueOf(frame);
          locals.writeCell(cell,codec.store(value,locals.readCell(cell)));
          return codec.assigned(value);
        }
        if(!locals.has(field.key))throw new Error(`Local is outside the function: ${field.key}`);
        const codec=propertyCodec(field),value=valueOf(frame);
        locals.set(field.key,codec.store(value,locals.get(field.key)));
        return codec.assigned(value);
      },
      assignFieldOf:(receiver,field,valueOf,frame)=>this.assignField(receiver,field,valueOf,frame),
      fieldValueOf:(receiver,field)=>this.fieldValue(receiver,field),
      fieldReferenceOf:(receiver,field)=>this.fieldReference(receiver,field),
      fieldReference:(receiver,script,node)=>this.fieldReference(receiver,this.objects.operand(script,node)),
      fieldValue:(receiver,script,node)=>this.fieldValue(receiver,this.objects.operand(script,node)),
      defaultReference:(receiver,script,node)=>this.defaultReference(receiver,this.objects.operand(script,node)),
      arrayReference:(index,ref)=>arrayReference(index,ref,this.warning),
      structReference:(ref,script,node)=>this.structReference(ref,this.objects.operand(script,node)),
      structValue:(ref,script,node)=>this.structValue(ref,this.objects.operand(script,node)),
      warning:message=>this.warning?.(message),
      newObject:request=>this.newObject(request),
      dispatchStateEvent:(receiver,name)=>this.processEvent(receiver,name),
      isPendingKill:receiver=>this.instance(receiver).pendingKill,
      gotoLabel:(receiver,name)=>this.instance(receiver).state.gotoLabel(name),
      pollLatent:call=>{
        if(call.index===384)return pollActorSleep(this.latentFloat(call.receiver),call.state,call.seconds);
        if(call.index===0x181)return pollFinishAnim({
          animation:animationView(this,call.receiver),state:call.state,
        });
        if([501,503,505,507,509,511,528].includes(call.index))
          return this.pollPawnLocomotion(call);
        if(!this.pollLatent)throw new Error(`Unimplemented original latent action ${call.index}`);
        return this.pollLatent(call);
      },
    };
    shared.attach(this);
  }
  async field(record,ancestry=[]) {
    record.metadata??=readPropertyMetadata(record.asset,record.index);
    const struct=record.metadata.structRef?await this.objects.resolve(record.asset,record.metadata.structRef):null;
    // Check before reusing the pending field: a by-value cycle would otherwise
    // await its own promise instead of reporting the invalid linked layout.
    if(struct&&ancestry.includes(struct.key))throw new Error(`Cyclic by-value script struct: ${struct.key}`);
    if(!record.fieldPending)record.fieldPending=(async()=>{
      if(record.metadata.type==='array'&&record.metadata.innerRef){
        const inner=await this.objects.resolve(record.asset,record.metadata.innerRef);
        // Dynamic container cycles need their own VM/value contract. Linking
        // the scalar inner here suffices for native integer-array storage.
        if(inner?.kind==='IntProperty'||inner?.kind==='StrProperty')record.metadata.innerMetadata=(await this.field(inner)).metadata;
      }
      if(struct){
        record.metadata.structKey=struct.key;
        record.metadata.structFields=await this.structFields(struct,ancestry);
        record.metadata.structLayout=await this.structLayout(struct,ancestry);
        record.metadata.elementSize=record.metadata.structLayout.propertiesSize;
        if(record.metadata.structLayout.destroyHead&&!(record.metadata.flags&0x1000))
          record.metadata.flags=(record.metadata.flags|0x400000)>>>0;
      }
      return record;
    })();
    return record.fieldPending;
  }
  async structFields(record,ancestry=[]) {
    if(ancestry.includes(record.key))throw new Error(`Cyclic by-value script struct: ${record.key}`);
    if(!this.structs.has(record.key))this.structs.set(record.key,(async()=>{
      const path=[...ancestry,record.key],metadata=readStructMetadata(record.asset,record.index,{includeChildren:false});
      const fields=[],seen=new Set();
      let child=await this.objects.resolve(record.asset,metadata.childrenRef);
      while(child){
        if(seen.has(child.key))throw new Error(`Cyclic struct child chain: ${child.key}`);
        seen.add(child.key);
        if(child.kind.endsWith('Property'))fields.push(await this.field(child,path));
        const {nextRef}=readFieldLinks(child.asset,child.index);
        child=await this.objects.resolve(child.asset,nextRef);
      }
      if(metadata.baseRef)fields.push(...await this.structFields(await this.objects.resolve(record.asset,metadata.baseRef),path));
      return fields;
    })());
    return this.structs.get(record.key);
  }
  async structLayout(record,ancestry=[]) {
    if(ancestry.includes(record.key))throw new Error(`Cyclic by-value script struct layout: ${record.key}`);
    if(!this.structLayouts.has(record.key))this.structLayouts.set(record.key,loadScriptStructLayout(this,record,ancestry));
    return this.structLayouts.get(record.key);
  }
  async members(record) {
    const fields=new Map(),methods=new Map(),states=new Map();
    for(const [i,entry] of record.asset.pkg.exports.entries())if(entry.outer===record.index){
      const member=await this.objects.resolve(record.asset,i+1),name=lower(entry.name);
      if(entry.className==='Function')methods.set(name,member);
      else if(entry.className==='State')states.set(name,member);
      else if(entry.className.endsWith('Property'))fields.set(name,member);
    }
    return {fields,methods,states};
  }
  /** Auto uses UField.Next order, not the package export-table order. */
  async linkedChildren(record,firstRef) {
    const stateOrder=[],propertyOrder=[],seen=new Set();
    let field=await this.objects.resolve(record.asset,firstRef);
    while(field){
      if(seen.has(field.key))throw new Error(`Cyclic class child chain: ${field.key}`);
      seen.add(field.key);
      if(field.kind==='State'){
        const metadata=readStateMetadata(field.asset,field.index,{includeChildren:false});
        stateOrder.push({record:field,flags:metadata.stateFlags});
      }else if(field.kind.endsWith('Property'))propertyOrder.push(await this.field(field));
      const {nextRef}=readFieldLinks(field.asset,field.index);
      field=await this.objects.resolve(field.asset,nextRef);
    }
    return {stateOrder,propertyOrder};
  }
  async loadClass(asset,index) {
    const record=await this.objects.resolve(asset,index);
    if(record.kind!=='Class')throw new Error(`Expected script class: ${record.key}`);
    if(!this.classes.has(record.key)){
      const pending=(async()=>{
        let cls;
        if(this.classLoader)cls=await this.classLoader.linkClass(this,record);
        else {
          // Explicit decoded-metadata adapter retained for isolated VM
          // fixtures. Play opts into the recovered native class loader.
          const metadata=readClass(record.asset,record.index);
          const base=metadata.base?await this.loadClass(record.asset,metadata.base):null;
          cls={record,metadata,base,nameCounter:0,...await this.members(record),
            ...await this.linkedChildren(record,metadata.children),defaults:new Map(base?.defaults)};
          cls.propertyLink=[...cls.propertyOrder,...(base?.propertyLink??[])];
          cls.destructorLink=cls.propertyLink.filter(field=>field.metadata.flags&0x00400000);
          for(const property of metadata.properties){
            const field=this.lookupMember(cls,'fields',property.name);
            if(!field)throw new Error(`Default property is not linked: ${record.key}.${property.name}`);
            const values=new Map(cls.defaults.get(field.key));
            let value=property.value;
            if(property.type===10)value=await this.authoredStructProperty(record.asset,field,property,values.get(property.arrayIndex));
            else if(!property.decoded)value={unsupported:`Undecoded default ${record.key}.${property.name}`};
            else if([5,8].includes(property.type)){
              value=await this.objects.resolve(record.asset,value);
              // A class-valued default (class'WeaponAssaultGun') is usable
              // only with its linked ancestry, which the original package
              // linker always builds; object references need no such work.
              if(value?.kind==='Class')await this.loadClass(value.asset,value.index);
            }
            values.set(property.arrayIndex,value);cls.defaults.set(field.key,values);
          }
        }
        if(record.key==='core.object')await this.field(this.lookupMember(cls,'fields','ObjectFlags'));
        if(record.key==='engine.actor'){
          this.actorClass=this.process.actorClass=cls;
          for(const name of ['Tag','TimerRate','TimerCounter','bTimerLoop'])await this.field(this.lookupMember(cls,'fields',name));
        }
        record.linkedClass=cls;
        this.linkedClasses.add(cls);
        return cls;
      })();
      this.classes.set(record.key,pending);pending.catch(()=>this.classes.delete(record.key));
    }
    return this.classes.get(record.key);
  }
  lookupMember(node,table,name) {
    // A prepared node's member tables and base chain never change, so its
    // resolution (a miss included) is memoized per node, table and spelling
    // instead of lowercasing and walking the chain on every host property
    // access (docs/play-frame-cost.md).
    if(!node)return null;
    let tables=memberCaches.get(node);
    if(!tables)memberCaches.set(node,tables={});
    const cache=tables[table]??=new Map();
    let member=cache.get(name);
    if(member===undefined){
      const key=lower(name);member=null;
      for(let current=node;current;current=current.base){
        const found=current[table]?.get(key);if(found){member=found;break;}
      }
      cache.set(name,member);
    }
    return member;
  }
  async prepareClassOperands(bindings) {
    for(const record of bindings.values())if(record?.kind==='Class')
      await this.loadClass(record.asset,record.index);
  }
  async prepareObjectType(record) {
    if(record.kind==='Class'){
      await this.loadClass(record.asset,record.index);
      return record;
    }
    if(!record.entry?.classIndex)throw new Error(`Native object class is not linked: ${record.key}`);
    record.objectClass=await this.loadClass(record.asset,record.entry.classIndex);
    return record;
  }
  castObject(value,target,kind) {
    if(value==null)return null;
    if(kind!=='dynamic'&&kind!=='meta')throw new Error(`Unknown original cast kind: ${kind}`);
    if(target===null)return kind==='dynamic'?value:null;
    if(target?.kind==='NativeClass'&&kind==='dynamic')return this.castToNativeClass(value,target);
    if(target?.kind!=='Class')throw new Error('Object cast target is not a linked class identity');
    let cls;
    if(kind==='meta'){
      if(value.kind==='Class'){
        cls=value.linkedClass;
        if(!cls)throw new Error(`Class-object ancestry is not prepared: ${value.key}`);
      }else{
        if(this.instances.has(value)||value.objectClass)return null;
        throw new Error(`Native metaclass identity is not linked: ${value.key??'<object>'}`);
      }
    }else{
      cls=this.instances.get(value)?.cls??value.objectClass;
      if(!cls)throw new Error(`Object class ancestry is not prepared: ${value.key??'<object>'}`);
    }
    for(;cls;cls=cls.base)if(cls.record===target)return value;
    return null;
  }
  async prepareFunction(asset,index) {
    // The Rust operator and BSP trace kernels are in place before any
    // compiled body runs.
    await loadScriptVmKernel();
    await loadTraceKernel();
    await this.scriptVmInstance();
    const record=await this.objects.resolve(asset,index);
    if(record.kind!=='Function')throw new Error(`Expected script function: ${record.key}`);
    if(record.function)return record;
    const script=readFunctionMetadata(record.asset,record.index),compiled=compileFunction(script);
    const bindings=await this.objects.link(script,compiled.decoded);
    await this.prepareClassOperands(bindings);
    for(const field of bindings.values())if(field?.kind.endsWith('Property'))await this.field(field);
    this.contextResults.set(script,await prepareContextResults(this,script,compiled.decoded));
    await this.prefetchDynamicLoadPackages(compiled.decoded,bindings);
    const fields=[];
    for(const child of script.children)if(child.className?.endsWith('Property'))fields.push(await this.field(await this.objects.resolve(record.asset,child.index)));
    record.function={record,script,compiled,fields,parameters:fields.filter(field=>field.metadata.parameter&&!field.metadata.return),
      result:fields.find(field=>field.metadata.return)??null};
    this.functions.set(record.key,record);
    return record;
  }
  async prepareState(asset,index) {
    const record=await this.objects.resolve(asset,index);
    if(this.states.has(record.key))return this.states.get(record.key);
    const script=readStateMetadata(record.asset,record.index,{includeChildren:false}),compiled=compileFunction(script);
    const bindings=await this.objects.link(script,compiled.decoded);
    await this.prepareClassOperands(bindings);
    for(const field of bindings.values())if(field?.kind.endsWith('Property'))await this.field(field);
    this.contextResults.set(script,await prepareContextResults(this,script,compiled.decoded));
    await this.prefetchDynamicLoadPackages(compiled.decoded,bindings);
    const labels=new Map();
    if(script.labelTableOffset!==0xffff){
      const table=[...compiled.decoded.statements.values()].find(({node})=>node.op===0x0c&&node.offset+1===script.labelTableOffset)?.node;
      if(!table)throw new Error(`Missing original state label table: ${record.key}`);
      for(const label of table.labels)if(lower(label.name)!=='none')labels.set(lower(label.name),label.target);
    }
    const node={record,script,compiled,labels,...await this.members(record),base:script.baseRef?await this.prepareState(record.asset,script.baseRef):null};
    this.states.set(record.key,node);return node;
  }
  /** Attach storage to an existing loaded identity. This is not SpawnActor or
   * its startup/lifetime sequence. Overrides retain original field identity. */
  attach(instance,cls,overrides=new Map()) {
    if(this.instances.has(instance))throw new Error('Script instance is already attached');
    const state=new ScriptState(instance,this.services);state.locals=new Map();
    const storage=this.objectStorage(cls),slots=new Map();
    for(const [key,value] of overrides){
      const cell=storage.cells?.get(key);
      if(!cell){slots.set(key,value);continue;}
      const field=storage.source.layout.fields.get(key);
      writeCell(cell,storage.arena.view,storage.refs,copyValue(field,value),storage.base);
      storage.poison?.delete(key);
    }
    this.linkInstance(instance,new ScriptInstance(this,cls,slots,state,storage));
    state.transition(null,cls.metadata);
    return state;
  }
  /** Stage 1d (docs/object-memory.md): the image cells of a class linked by
   * the native class loader, or null for a class without linked offsets (the
   * isolated decoded-metadata fixtures), whose objects keep logical slots. */
  objectCells(cls) {
    if(!this.classLoader||!cls?.loadRecord)return null;
    const loader=this.classLoader;
    return objectImageCells(cls,{graph:loader.graph,identity:record=>loader.identity(record)});
  }
  /** A class's default image: each imaged property's default value, the
   * block InitProperties copies from Defaults. It is rebuilt when a class
   * default changes, so a new object sees defaults as of its construction,
   * as the per-object default snapshot did. A default that cannot be
   * produced is recorded and rethrown by any access to that property. */
  classImage(cls) {
    const layout=this.objectCells(cls);
    if(!layout)return null;
    const classImages=this.classImages??=new WeakMap();
    let image=classImages.get(cls);
    if(image&&sameDefaults(image.defaults,cls.defaults))return image;
    const arena=this.objectArena(),base=arena.alloc(layout.size);
    const defaults=new Map(cls.defaults),refs=new Array(layout.refCount).fill(null);
    let poison=null;
    for(const [key,cell] of layout.cells){
      const field=layout.fields.get(key);
      let value;
      try{value=this.defaultValue(cls,field,defaults);}
      catch{(poison??=new Map()).set(key,{read:()=>this.defaultValue(cls,field,defaults),write:true,lazy:false});continue;}
      writeCell(cell,arena.view,refs,value,base);
    }
    // A replaced default image is only a copy source; its range is released.
    if(image)image.arena.release(image.base,image.layout.size);
    image={layout,defaults,arena,base,refs,poison};
    classImages.set(cls,image);
    // The Rust interpreter reads DefaultVariable in class images (R2b-5).
    classDefaultsChanged();
    return image;
  }
  /** The class's default image when it is current (classImage would return
   * it unchanged), else null; nothing is built. The Rust interpreter reads
   * DefaultVariable there (script-vm-rust.mjs). */
  currentClassImage(cls) {
    const image=this.classImages?.get(cls);
    return image&&sameDefaults(image.defaults,cls.defaults)?image:null;
  }
  /** The runtime's object arena (docs/rust-core.md, R0). Harnesses built with
   * Object.create(ScriptRuntime.prototype) get theirs on first use. */
  objectArena(){return this.arena??=new ObjectArena();}
  /** Fresh storage for one object of `cls`: a copy of the class image, which
   * is in this runtime's arena (classImage). */
  objectStorage(cls) {
    const source=this.classImage(cls);
    if(!source)return {cells:null,arena:null,base:0,size:0,refs:null,poison:null,source:null,complete:false};
    const arena=this.objectArena(),size=source.layout.size,base=arena.alloc(size);
    arena.bytes.set(source.arena.bytes.subarray(source.base,source.base+size),base);
    return {cells:source.layout.cells,arena,base,size,refs:source.refs.slice(),
      poison:source.poison&&new Map(source.poison),source,complete:source.layout.cells.size===cls.propertyLink.length};
  }
  /** Make released image ranges reusable: at a purge's end or a level
   * tick's start, when no reference made before the release is in use
   * (docs/rust-core.md). */
  reclaimReleased(){this.arena?.reclaim();}
  /** Core's free of a released object's memory: its image range goes back to
   * the arena (reused after the next reclaim). */
  releaseObjectImage(identity) {
    // R1a: the identity's lifetime ends here, so its handle does too.
    releaseHandle(identity);
    const token=(identity?.[this.instanceKey]??this.instances?.get(identity))?.imageToken;
    if(!token||token.released)return;
    token.released=true;
    imageFinalizer.unregister(token);
    token.arena.release(token.base,token.size);
  }
  /** Construct fresh script storage using the class-default/template values,
   * followed by registry insertion and a verified class-native constructor.
   * This deliberately does not run the separate SpawnActor startup sequence. */
  /** Opcode 0x11, Core execNew (0x1013d9f0): evaluate Outer, Name, Flags and
   * Class; a None Outer becomes GetTransientPackage(); flags outside
   * RF_ScriptMask 0x704005 are logged and masked; then
   * StaticConstructObject(Class, Outer, Name, Flags, NULL). Name and flags are
   * only recovered as None and 0, an omitted Outer (default Self unless Self
   * is INDEX_NONE) is not recovered, and only classes with a recovered
   * constructor are admitted: `new(Self) class'NanoKeyInfo'` for
   * CreateNanoKeyInfo and `new(None) class'DeusExTextParser'` for
   * InformationDevices.CreateInfoWindow. */
  newObject({outer, name, flags, classRef}) {
    if (String(name ?? 'None').toLowerCase() !== 'none' || (flags ?? 0) !== 0)
      throw new Error('new optional name and flags are only recovered as None and 0');
    if (outer === undefined) throw new Error('new with an omitted Outer (default Self) is not recovered');
    const cls = classRef?.linkedClass;
    if (!cls) throw new Error('new requires a linked class');
    if (!Number.isInteger(cls.nameCounter)) cls.nameCounter = 0;
    const base = this.actorLifecycle?.construction;
    if (!base?.registry || typeof base.findObject !== 'function' || typeof base.internName !== 'function')
      throw new Error('new requires the live object registry');
    const construct = (nativeOuter, nativeConstructor, initNativeProperties = base.initNativeProperties) =>
      this.constructObject(cls, {outer: nativeOuter, name: 'None', flags: 0, template: null}, {
        ...base, initNativeProperties, nativeConstructor,
        validate: args => args.cls === cls && args.outer === nativeOuter && args.template === null &&
          args.flags === 0 && String(args.name).toLowerCase() === 'none',
      });
    // UClass::Bind copies the nearest native ancestor's ClassConstructor into
    // a script-only class; RF_Native (0x04000000) marks that ancestor.
    let nativeRoot = cls;
    while (nativeRoot && !((nativeRoot.metadata?.entry?.flags ?? 0) & 0x04000000)) nativeRoot = nativeRoot.base;
    if (nativeRoot?.record.key === 'core.object' && cls !== nativeRoot) {
      // UObject::InternalConstructor: the UObject vtable, whose Destroy slot
      // is UObject::Destroy. Outers: the player (new(Self) from DeusExPlayer,
      // e.g. CreateNanoKeyInfo and AddNote) or the transient package.
      const nativeOuter = outer ? this.playerNativeObject(outer) : base.transientPackage;
      if (!nativeOuter) throw new Error('new(None) requires the GetTransientPackage() object');
      return construct(nativeOuter, object => {
        object.nativeVtable = 0x10179dfc;
        object.destroy = receiver => this.destroyObjectBase(receiver);
      });
    }
    if (cls.record.key === TEXT_PARSER_NATIVE.classKey) {
      if (outer !== null) throw new Error('new DeusExTextParser is only recovered with a None Outer');
      if (!base.transientPackage) throw new Error('new(None) requires the GetTransientPackage() object');
      // The parser's reflected fields are all `const native`; its constructor
      // owns them, so InitProperties leaves no actor-native storage.
      return construct(base.transientPackage, object => constructTextParserObject(object, {
        state: (identity, parser) => { this.instance(identity).textParser = parser; },
        destroyObjectBase: receiver => this.destroyObjectBase(receiver),
      }), () => {});
    }
    throw new Error(`new is only recovered for script-only Object subclasses and DeusExTextParser, got ${classRef?.key ?? 'None'}`);
  }
  /** Core execCriticalDelete (native 751, body 0x1013db50): evaluate the
   * object, P_FINISH, then call its scalar deleting destructor (vtable +0xc,
   * flag 1) when it is not None. The int result is never written. Only
   * deleting destructors that are recovered are dispatched. */
  criticalDelete(call) {
    if (call.argumentCount !== 1) throw new Error('CriticalDelete requires one object argument');
    const target = refValue(call.evaluateArgument(0));
    if (target === null || target === undefined) return undefined;
    const object = this.instance(target).nativeObject, services = this.actorLifecycle?.objectRelease;
    if (!object || !services) throw new Error(`CriticalDelete requires native object and release bindings (${target?.name ?? '?'}, ${this.instance(target).cls?.record?.name ?? '?'})`);
    const release = {...services, conditionalDestroy: item => this.conditionalDestroy(item.identity), warning: this.warning};
    if (object.nativeVtable === TEXT_PARSER_NATIVE.vtable) releaseTextParserObject(object, 1, release);
    else if (object.nativeVtable === 0x10179dfc || object.nativeVtable === 0x100613e8) {
      // UObject's deleting destructor 0x1015dd00: ~UObject, then operator delete. The snapshot texture (RootWindow.GenerateSnapshot,
      // Extension vtable 0x100613e8) has its own slot-3 destructor 0x1003d100: ~UTexture (Engine), then operator delete of its 0xc0
      // bytes; the mips and palette it frees are the page's here (docs/root-snapshot.md).
      const snapshotTexture = object.nativeVtable === 0x100613e8;   // ~UObject resets the vtable
      destructScriptObject(object, release);
      freeScriptObject(object, release);
      if (snapshotTexture) this.windowLifecycle?.snapshotReleased?.(target);
    } else if (object.nativeVtable === 0x10027fe8) {
      // ConHistory (DeusEx vtable 0x10027fe8, slot +0x0c = 0x100146a0, flags 1): ~DConHistory (ConSys 0x10003400: the class vtable, ConditionalDestroy
      // = DConHistory::Destroy 0x1000ca20 deleting every event from firstEvent, the three FString members, the DConObject vtable, ConditionalDestroy
      // again and ~UObject), then ??3UObject(this, 0x5c). The class member teardown only frees native storage the host does not have, which is what
      // deleteObject is (docs/script-loadmap-gc.md "ConHistory CriticalDelete"; the events own destructor 0x10014730 is the same shape).
      this.deleteObject(target);
    } else if (object.nativeVtable === 0x10027ad0 || object.nativeVtable === 0x10027b24) {
      // DeusExLog (vtable 0x10027ad0, slot +0x0c = 0x1000dda0) and DataVaultImageNote (0x10027b24, 0x1000e0e0), flags 1: ~UDeusExLog 0x1000db40 / ~UDataVaultImageNote
      // 0x1000de40 (the class vtable, ConditionalDestroy, the FString member's TArray<TCHAR> emptied and its storage freed, ~UObject), then ??3UObject(this, 0x38 / 0x44).
      // The same shape as the history event's destructor above: the member teardown frees native storage the host does not have, which is what deleteObject is.
      this.deleteObject(target);
    } else if (object.nativeVtable === GAME_DIRECTORY.vtable) {
      // XGameDirectory (DeusEx vtable 0x10027e58, slot +0x0c = 0x10013260, flags 1): ~XGameDirectory 0x10012c30 (the vtable, ConditionalDestroy = XGameDirectory::Destroy
      // 0x100170d0: PurgeAllSaveInfo and the temp SaveInfo, then UObject::Destroy; the FString and array members; ~UObject), then ??3UObject(this, 0x54).
      this.deleteObject(target);
    } else throw new Error(`CriticalDelete deleting destructor is not recovered for native vtable 0x${(object.nativeVtable >>> 0).toString(16)}`);
    return undefined;
  }
  /** A live replay's measured class counters (Class+0x488, which MakeUniqueObjectName reads and the whole session advanced: the capture's
   * earlier maps), from the original's traced AddObject names (live-probe.mjs `classCounters`): the class's next generated name starts
   * there, once. */
  applyClassCounterSeed(cls) {
    const seeds=this.classCounterSeeds,key=cls?.record?.name?.toLowerCase();
    if(!seeds?.size||!key||!seeds.has(key))return;
    cls.nameCounter=seeds.get(key);seeds.delete(key);
  }
  playerNativeObject(player) {
    const instance = this.instance(player);
    if (Number.isInteger(instance.nativeObject?.index)) return instance.nativeObject;
    // A saved level's pawn is a map export whose GObjObjects slot nothing measured; the registry gives it the slot AddObject would
    // (a modeled index, docs/travel.md "Unresolved" 10), as it does a spawned player's.
    if (instance.nativeObject?.modeledIndex) {
      const construction = this.actorLifecycle?.construction, existing = instance.nativeObject;
      const packageOuter = this.levelFor(player)?.nativeObject?.outer;
      if (!packageOuter || !Number.isInteger(packageOuter.index)) throw new Error('new(Self) requires the level package outer');
      existing.outer = packageOuter;
      const fname = construction.internName(existing.name);
      if (!fname || !Number.isInteger(fname.index)) throw new Error('Player FName is not interned');
      existing.index = -1; existing.nameIndex = fname.index; existing.hashNext = null; existing.objectClass = instance.cls;
      construction.registry.add(existing);
      return existing;
    }
    if (instance.nativeObject) throw new Error('Player native object index is unmeasured');
    const level = this.levelFor(player);
    const packageOuter = level?.nativeObject?.outer;
    if (!packageOuter || !Number.isInteger(packageOuter.index))
      throw new Error('new(Self) requires the level package outer');
    const construction = this.actorLifecycle?.construction;
    const spelled = this.readNamed(player, 'Name');
    const fname = construction.internName(typeof spelled === 'string' && spelled ? spelled : 'JCDentonMale');
    if (!fname || !Number.isInteger(fname.index)) throw new Error('Player FName is not interned');
    const object = {
      identity: player, index: -1, hashNext: null, stateFrame: instance.state ?? null,
      linker: null, linkerIndex: -1, outer: packageOuter, flags: 0,
      name: fname.name, nameIndex: fname.index, objectClass: instance.cls,
      destroy: receiver => this.destroyActorBase(receiver),
    };
    construction.registry.add(object);
    instance.nativeObject = object;
    return object;
  }
  constructObject(cls,options,services) {
    return this.initializeObjectStorage(cls,options,services,constructFreshScriptObject);
  }
  allocateObject(cls,options,services) {
    return this.initializeObjectStorage(cls,options,services,allocateFreshScriptObject);
  }
  initializeObjectStorage(cls,options,services,allocate) {
    if(typeof services.initNativeProperties!=='function')
      throw new Error('Construction requires explicit native template storage');
    const object=allocate({...options,cls},{...services,
      initProperties:(object,template)=>{
        if(template&&this.instance(template).cls!==cls)
          throw new Error('Cross-class construction templates are not implemented');
        const slots=new Map(),storage=this.objectStorage(cls);
        // Core.Object declares only the five native UObject header properties;
        // InitProperties starts after that header, at original offset +0x28.
        // The image copy already holds each imaged default; a default that
        // cannot be produced still fails construction, in link order.
        for(const field of cls.propertyLink)if(!field.key.startsWith('core.object.')){
          const cell=storage.cells?.get(field.key);
          if(cell&&!template){storage.poison?.get(field.key)?.read();continue;}
          const value=template?this.fieldReference(template,field).get():this.defaultValue(cls,field);
          if(!cell){slots.set(field.key,copyValue(field,value));continue;}
          writeCell(cell,storage.arena.view,storage.refs,copyValue(field,value),storage.base);
          storage.poison?.delete(field.key);
        }
        this.linkInstance(object.identity,new ScriptInstance(this,cls,slots,null,storage));
        this.bindNativeObject(object.identity,object);
        services.initNativeProperties(object,template);
      },
    });
    return object.identity;
  }
  /** Core UObject::InitExecution's script-visible frame setup. Actor's level
   * validation and native subclass overrides remain the lifecycle host's job. */
  initExecution(receiver) {
    const instance=this.instance(receiver);
    const flags=this.fieldReference(receiver,this.lookupMember(instance.cls,'fields','ObjectFlags'));
    instance.state?.setStateNode(null);
    const state=new ScriptState(receiver,this.services);state.locals=new Map();
    state.probeMask=[0xffffffff,0xffffffff];
    // Original allocation/constructor leaves +0x24 untouched. Until a state
    // operation writes it, polling would depend on unrecovered allocator data.
    state.latent=undefined;
    instance.state=state;
    stateChanged(receiver);
    if(instance.nativeObject)instance.nativeObject.stateFrame=state;
    flags.set(flags.get()|0x02000000);
    return state;
  }
  /** Bind original native identity fields to a separately registered object.
   * Allocation, class-native constructor selection and the actor world are not
   * implied by attaching script storage or by this binding. */
  bindNativeObject(receiver,object) {
    const instance=this.instance(receiver);
    // A freshly constructed object carries its registry slot. A pre-placed map
    // export is registered in GObjObjects too, but its slot is only known from a
    // measured capture (docs/boot-replay.md); `null` records "registered, slot
    // unmeasured" rather than fabricating an index, while `-1` stays the
    // original unregistered marker Core ConditionalDestroy rejects.
    if(object.identity!==receiver||!(Number.isInteger(object.index)||object.index===null))
      throw new Error('Invalid native object identity record');
    instance.nativeObject=object;
    // Fresh construction allocates the native FName before returning the
    // script identity. Preserve that canonical spelling on the identity so
    // spawned actors expose the original `ClassName1` name to world arrays and
    // callers, just as their reflected Name field does.
    receiver.name=object.name;
    const bind=(name,get,set)=>this.bindProperty(receiver,this.lookupMember(instance.cls,'fields',name),{get,set});
    bind('ObjectFlags',()=>object.flags,value=>{object.flags=value>>>0;});
    bind('Outer',()=>object.outer?.identity??null,()=>{throw new Error('Changing native Outer requires object rename support');});
    bind('Name',()=>object.name,()=>{throw new Error('Changing native Name requires object rename support');});
    bind('Class',()=>instance.cls.record,()=>{throw new Error('Changing native Class is unsupported');});
    bind('ObjectInternal',()=>{throw new Error('Raw native ObjectInternal pointers are not represented by the script host');},()=>{throw new Error('Writing native ObjectInternal is unsupported');});
    for(let cls=instance.cls;cls;cls=cls.base)if(cls===this.actorClass){
      instance.receiver=receiver;instance.deleteMe=this.lookupMember(cls,'fields','bDeleteMe');
      break;
    }
  }
  exitProperties(receiver) {
    const instance=this.instance(receiver),fields=instance.cls.destructorLink;
    if(!fields)throw new Error('Original property destructor chain is not linked');
    this.destroyProperties(fields,field=>this.fieldReference(receiver,field));
  }
  /** Shared logical storage bridge for UObject and function-local DestroyValue.
   * Fields are supplied in the original linked destructor-chain order. */
  destroyProperties(fields,referenceFor) {
    const services={
      readSlot:(property,offset)=>{
        // Parsed packages omit linked ElementSize. StrProperty::Link establishes
        // the 12-byte FString stride; generic struct offsets remain unresolved.
        if(offset===0x38&&property.metadata?.type==='string'&&property.metadata.elementSize==null)return 12;
        if(offset===0x5c&&property.metadata?.type==='array'&&property.metadata.innerMetadata)
          return property.metadata.innerMetadata;
        if(offset===0x5c&&property.metadata?.type==='struct'){
          const members=property.metadata.structFields;
          if(!members)throw new Error(`Original struct destructor fields are not linked: ${property.key}`);
          // UStruct::Link builds +68 from NeedCtorLink fields in this original
          // derived-then-inherited order. +68 is not the +38 Children iterator.
          return {fields:members.filter(field=>field.metadata.flags&0x00400000)};
        }
      },
    };
    for(const field of fields)destroyScriptProperty(field,referenceFor(field),services);
  }
  destroyFunctionLocals(fn,locals,{parameters=true}={}) {
    // UFunction has no inheritance super. UStruct::Link builds +68 in its
    // own Children order, selecting CPF_NeedCtorLink. ProcessEvent skips the
    // parameter prefix at 1013f963; CallFunction destroys that prefix too.
    let cached=destroyedLocals.get(fn);
    if(!cached||cached.source!==fn.fields)destroyedLocals.set(fn,cached={source:fn.fields,
      all:fn.fields.filter(field=>field.metadata.flags&0x00400000),
      locals:fn.fields.filter(field=>(field.metadata.flags&0x00400000)&&!field.metadata.parameter)});
    const fields=parameters?cached.all:cached.locals;
    if(!fields.length)return;
    this.destroyProperties(fields,field=>propertyReference(field,
      ()=>locals.get(field.key),value=>locals.set(field.key,value)));
  }
  conditionalDestroy(receiver) {
    const object=this.instance(receiver).nativeObject;
    if(!object)throw new Error('ConditionalDestroy requires native object registration');
    return conditionalDestroyScriptObject(object,{destroy:object.destroy,warning:this.warning});
  }
  destroyObjectBase(receiver) {
    const object=this.instance(receiver).nativeObject;
    if(!object)throw new Error('UObject.Destroy requires native object registration');
    return destroyScriptObject(object,{exitProperties:actor=>this.exitProperties(actor)});
  }
  /** AActor::Destroy (Engine thunk 0x10301f8c, body 0x10368f60): a non-null
   * RenderInterface (+0x314, the reflected Actor.RenderInterface) is
   * ConditionalDestroy'd and cleared, then UObject::Destroy. */
  destroyActorBase(receiver) {
    const object=this.instance(receiver).nativeObject;
    if(!object)throw new Error('AActor.Destroy requires native object registration');
    const renderInterface=this.readNamed(receiver,'RenderInterface');
    if(renderInterface){this.conditionalDestroy(renderInterface);this.writeNamed(receiver,'RenderInterface',null);}
    return this.destroyObjectBase(receiver);
  }
  /** The Destroy virtual (+0x24) of a constructed actor's native vtable. */
  actorDestroyHook(object) {
    const vtable=object.nativeVtable;
    if(vtable!==PLAYER_DESTROY.deusExPlayerVtable&&vtable!==PLAYER_DESTROY.playerPawnExtVtable)
      return receiver=>this.destroyActorBase(receiver);
    const services={
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
      // Core GObjInGarbageCollection (0x102a264c), set only while PurgeGarbage runs.
      inGarbageCollection:()=>this.garbageCollecting===true,
      conditionalDestroy:target=>this.conditionalDestroy(target),
      safeDestroyWindow:root=>{
        const windows=this.windowLifecycle?.destroy;
        if(!windows)throw new Error('PlayerPawnExt rootWindow SafeDestroy requires the window lifecycle');
        return safeDestroyWindowNative(root,windows);
      },
      destroyActorBase:actor=>this.destroyActorBase(actor),
    };
    return vtable===PLAYER_DESTROY.deusExPlayerVtable
      ?receiver=>destroyDeusExPlayerNative(receiver,services)
      :receiver=>destroyPlayerPawnExtNative(receiver,services);
  }
  /** A class scalar deleting destructor (vtable +0x0c, flag 1) whose class
   * member teardown only frees native storage the host does not have: the
   * guarded ConditionalDestroy, ~UObject 0x10150040, then ??3UObject
   * (docs/script-object-release.md). */
  deleteObject(receiver) {
    const object=this.instance(receiver).nativeObject,services=this.actorLifecycle?.objectRelease;
    if(!object||!services)throw new Error('Object deletion requires native object and release bindings');
    const release={...services,conditionalDestroy:item=>this.conditionalDestroy(item.identity),warning:this.warning};
    release.conditionalDestroy(object);
    destructScriptObject(object,release);
    freeScriptObject(object,release);
  }
  releaseObject(receiver,flags=1) {
    const object=this.instance(receiver).nativeObject,services=this.actorLifecycle?.finalRelease;
    if(!object||!services)throw new Error('Final release requires native object and allocator bindings');
    return releaseScriptCameraPoint(object,flags,{
      ...services,conditionalDestroy:object=>this.conditionalDestroy(object.identity),warning:this.warning,
    });
  }
  /** Whether a collection or a deleting destructor released the object: host
   * caches drop such identities instead of reading them. */
  isReleased(receiver) {
    return (receiver?.[this.instanceKey]??this.instances.get(receiver))?.nativeObject?.released===true;
  }
  /** Whether a linked class's chain reaches `base` (a class record). The
   * chain is fixed once linked; iterators test thousands of actors per call. */
  classIsA(cls,base) {
    // Lazy: harnesses build a runtime with Object.create(prototype).
    const caches=this.classIsACache??=new WeakMap(),cache=caches.get(cls);
    let result=cache?.get(base);
    if(result===undefined){
      result=false;
      for(let entry=cls;entry;entry=entry.base)if(entry.record===base){result=true;break;}
      if(cache)cache.set(base,result);else caches.set(cls,new Map([[base,result]]));
    }
    return result;
  }
  /** Attach storage to a receiver. The WeakMap stays the authority; a
   * non-enumerable per-runtime symbol on the receiver is a direct link that
   * spares the hash lookup on every property access (attachment is permanent). */
  linkInstance(receiver,instance) {
    if(instance.cls?.purged)throw new Error(`An object of a collected class generation: ${instance.cls.record.key} (the collector purged it; script-process-collection.mjs)`);
    this.instances.set(receiver,instance);
    // An object of the class exists, so the original holds the class loaded (original-loaded.mjs), and the process collection keeps it
    // while this level lives (script-process-collection.mjs levelSeeds).
    if(instance.cls?.loadRecord)this.classLoader?.originalLoads.reach([instance.cls.loadRecord]);
    if(instance.cls)(this.attachedClasses??=new Set()).add(instance.cls);
    bumpReceiverEpoch();
    stateChanged(receiver);
    // An object the collection model never frees (it was unreachable, so the
    // host's own GC reclaimed it) returns its image range when collected.
    if(instance.imageToken)imageFinalizer.register(receiver,instance.imageToken,instance.imageToken);
    if(this.instanceKey&&Object.isExtensible(receiver))
      Object.defineProperty(receiver,this.instanceKey,{value:instance,enumerable:false,writable:false,configurable:false});
  }
  instance(receiver) {
    // Actor host objects are dictionary-mode, so the link load is a hash
    // lookup; host code mostly reads several fields of one receiver in a row.
    // Only a symbol link is remembered: it is non-writable, so the pair stays
    // valid forever. The released check below still runs on every access.
    let instance=this.lastLinkedInstance;
    if(instance===undefined||receiver!==this.lastLinkedReceiver){
      instance=receiver?.[this.instanceKey];
      if(instance!==undefined&&this.instanceKey!==undefined){this.lastLinkedReceiver=receiver;this.lastLinkedInstance=instance;}
      else instance=this.instances.get(receiver);
    }
    if(!instance)throw new Error(`Object is not attached to script runtime: ${receiver?.key??receiver?.name??'None'}`);
    if(instance.nativeObject?.released)throw new Error('Script object allocation has been released');
    return instance;
  }
  /** instance() for host lookups that branch on attachment: null where
   * instance() would throw (not attached, or released). CleanupDestroyed's
   * reference pass asks this of every resource pointer, and a thrown Error
   * per pointer cost ~160 ms per sweep (docs/script-cleanup.md). */
  attachedInstance(receiver) {
    let instance=this.lastLinkedInstance;
    if(instance===undefined||receiver!==this.lastLinkedReceiver){
      instance=receiver?.[this.instanceKey];
      if(instance!==undefined&&this.instanceKey!==undefined){this.lastLinkedReceiver=receiver;this.lastLinkedInstance=instance;}
      else instance=this.instances.get(receiver);
    }
    return !instance||instance.nativeObject?.released?null:instance;
  }
  /** Core.IsProbing0x10115670 against the actor's live state-frame probe mask.
   * A no-state actor probes everything (the recovered init mask is all ones);
   * a name outside the reserved probe interval is always probed. */
  isProbing(receiver,name){return this.instance(receiver).state?.isProbing(probeNames.get(lowerName(name))??-1)??true;}
  defaultValue(cls,field,defaults=cls.defaults) {
    if(!field.metadata)throw new Error(`Property is not prepared: ${field.key}`);
    const authored=defaults.get(field.key),value=zeroValue(field);
    if(!authored)return value;
    if(field.metadata.arrayDim>1){
      for(const [index,item] of authored){if(item?.unsupported)throw new Error(item.unsupported);value[index]=item;}
      return copyValue(field,value);
    }
    const item=authored.get(0);if(item?.unsupported)throw new Error(item.unsupported);
    return authored.has(0)?copyValue(field,item):value;
  }
  authoredStructValue(field,value) {
    const metadata=field.metadata,keys=metadata.structFields;
    if(!keys||['core.object.vector','core.object.rotator'].includes(metadata.structKey))return value;
    // Normalize the existing tagged-property decoder's established Color and
    // Scale forms into linked member identities. Other authored struct tails
    // remain opaque in that reader and never enter this conversion.
    const values=metadata.structKey==='core.object.color'?{r:value[0],g:value[1],b:value[2],a:value[3]}
      :metadata.structKey==='core.object.scale'?{scale:value.scale,sheerrate:value.shearRate,sheeraxis:value.shearAxis}:null;
    if(!values)throw new Error(`Authored script struct is not decoded: ${metadata.structKey}`);
    return Object.fromEntries(keys.map(member=>{
      if(!Object.hasOwn(values,lower(member.name)))throw new Error(`Authored struct member is not decoded: ${member.key}`);
      return [member.key,values[lower(member.name)]];
    }));
  }
  async authoredStructProperty(asset,field,property,initialValue,resolveObject=async(asset,index)=>{
    const object=await this.objects.resolve(asset,index);
    // Same linked-ancestry contract as the plain class-valued default above.
    if(object?.kind==='Class')await this.loadClass(asset,index);
    return object;
  }) {
    const key=field.metadata.structKey;
    if(!key||lower(property.struct)!==key.split('.').at(-1))
      throw new Error(`Authored struct tag does not match linked property: ${field.key}`);
    return readScriptStructValue(asset,field,property.data,{initialValue,resolveObject});
  }
  fieldReference(receiver,field) {
    // A class object is not attached as a script instance, but execContext still
    // reads its immutable Object Name — Weapon.SetSwitchPriority compares
    // Class.Name against the config WeaponPriority list during a weapon pickup.
    // Serve Name from the class record; other header fields on an unattached
    // class stay an explicit boundary.
    if(receiver?.kind==='Class'&&field.key==='core.object.name'&&!this.instances.has(receiver))
      return propertyReference(field,()=>receiver.name,()=>{throw new Error('Class Name is immutable');});
    const instance=this.instance(receiver);
    const binding=instance.bindings.get(field.key);
    if(binding)return propertyReference(field,binding.get,binding.set);
    const cell=instance.cells?.get(field.key);
    if(cell){
      const poisoned=instance.poison?.get(field.key);
      if(poisoned&&!poisoned.lazy)poisoned.read();
      return storageReference(field,new CellStorage(this,instance,field,cell));
    }
    if(!instance.slots.has(field.key))instance.slots.set(field.key,this.defaultValue(instance.cls,field,instance.defaultsSnapshot));
    return propertyReference(field,()=>instance.slots.get(field.key),field.key===ACTOR_BASE_KEY
      ?value=>{instance.slots.set(field.key,value);bumpBaseEpoch();}
      :value=>instance.slots.set(field.key,value));
  }
  /** refValue(fieldReference(receiver, field)) without allocating the
   * lvalue: the same binding/cell/slot selection, poison pre-read, slot
   * default and ordering, then the reference's readWhole copy (the codec). */
  fieldValue(receiver,field) {
    if(receiver?.kind==='Class'&&field.key==='core.object.name'&&!this.instances.has(receiver))
      return this.fieldReference(receiver,field).get();
    const instance=this.instance(receiver);
    const binding=instance.bindings.size?instance.bindings.get(field.key):undefined;
    if(binding){const codec=propertyCodec(field);return codec.read(binding.get());}
    const cell=instance.cells?.get(field.key);
    if(cell){
      const poisoned=instance.poison?.get(field.key);
      if(poisoned&&!poisoned.lazy)poisoned.read();
      const codec=propertyCodec(field),entry=instance.poison?.get(field.key);
      return codec.read(entry?entry.read():readCell(cell,instance.arena.view,instance.refs,instance.base));
    }
    if(!instance.slots.has(field.key))instance.slots.set(field.key,this.defaultValue(instance.cls,field,instance.defaultsSnapshot));
    const codec=propertyCodec(field);
    return codec.read(instance.slots.get(field.key));
  }
  /** assign(fieldReference(receiver, field), valueOf(frame)) without the
   * lvalue: the same storage selection, poison pre-read, slot default and
   * descriptor before the value is evaluated, then PropertyReference.set's
   * read-merge-store (CellStorage get/set order) and returned copy. A
   * binding or an unattached class keeps the reference path itself. */
  assignField(receiver,field,valueOf,frame) {
    if(receiver?.kind==='Class'&&field.key==='core.object.name'&&!this.instances.has(receiver))
      return this.fieldReference(receiver,field).set(valueOf(frame));
    const instance=this.instance(receiver);
    if(instance.bindings.size&&instance.bindings.has(field.key))
      return this.fieldReference(receiver,field).set(valueOf(frame));
    const cell=instance.cells?.get(field.key);
    if(cell){
      const poisoned=instance.poison?.get(field.key);
      if(poisoned&&!poisoned.lazy)poisoned.read();
      const codec=propertyCodec(field),value=valueOf(frame);
      const current=instance.poison?.get(field.key);
      const stored=codec.store(value,current?current.read():readCell(cell,instance.arena.view,instance.refs,instance.base));
      const entry=instance.poison?.get(field.key);
      if(entry?.write)entry.read();
      writeCell(cell,instance.arena.view,instance.refs,stored,instance.base);
      if(entry)this.clearPoison(instance,field.key);
      return codec.assigned(value);
    }
    if(!instance.slots.has(field.key))instance.slots.set(field.key,this.defaultValue(instance.cls,field,instance.defaultsSnapshot));
    const codec=propertyCodec(field),value=valueOf(frame);
    instance.slots.set(field.key,codec.store(value,instance.slots.get(field.key)));
    if(field.key===ACTOR_BASE_KEY)bumpBaseEpoch();
    return codec.assigned(value);
  }
  namedReference(receiver,name) {
    return this.fieldReference(receiver,this.namedField(receiver,name));
  }
  namedField(receiver,name) {
    return this.namedHandle(this.instance(receiver),name).field;
  }
  /** The attached instance's handle for a spelled property name: its linked
   * field, resolved once per class, the field's value codec and its image
   * cell. A class's member tables only hold fields whose linking finished
   * before the class was returned, so the codec is built once, on first value
   * access; cells are per class. */
  namedHandle(instance,name) {
    const table=instance.fieldTable??=fieldTable(instance.cls);
    let handle=table.get(name);
    if(handle===undefined){
      const field=this.lookupMember(instance.cls,'fields',name);
      table.set(name,handle=field?{field,codec:null,cell:instance.cells?.get(field.key)??null}:null);
    }
    if(!handle)throw new Error(`Original property was not found: ${name}`);
    return handle;
  }
  /** fieldReference(receiver, field).get() without allocating the lvalue.
   * Host code reads values; only the VM needs assignable references. */
  readField(receiver,field) {
    if(receiver?.kind==='Class'&&!this.instances.has(receiver))return this.fieldReference(receiver,field).get();
    return this.readInstanceField(this.instance(receiver),field);
  }
  readInstanceField(instance,field,codec=propertyCodec(field),cell=instance.cells?.get(field.key)) {
    const binding=instance.bindings.size?instance.bindings.get(field.key):undefined;
    if(binding)return codec.read(binding.get());
    return this.readStorage(instance,field,codec,cell);
  }
  /** The object's own storage for a property: its image cell, or the logical
   * slot of a property without one. A cell read is the codec's copy of the
   * stored value; a slot is filled with its default on first access. */
  readStorage(instance,field,codec,cell) {
    if(cell){
      const poisoned=instance.poison?.get(field.key);
      return poisoned?codec.read(poisoned.read()):readCell(cell,instance.arena.view,instance.refs,instance.base);
    }
    let raw=instance.slots.get(field.key);
    if(raw===undefined&&!instance.slots.has(field.key))
      instance.slots.set(field.key,raw=this.defaultValue(instance.cls,field,instance.defaultsSnapshot));
    return codec.read(raw);
  }
  /** fieldReference(receiver, field).set(value): same storage order and
   * returned logical copy, without allocating the lvalue. */
  writeField(receiver,field,value) {
    if(receiver?.kind==='Class'&&!this.instances.has(receiver))return this.fieldReference(receiver,field).set(value);
    return this.writeInstanceField(this.instance(receiver),field,value);
  }
  writeInstanceField(instance,field,value,codec=propertyCodec(field),cell=instance.cells?.get(field.key)) {
    const binding=instance.bindings.size?instance.bindings.get(field.key):undefined;
    if(binding)binding.set(codec.store(value,binding.get()));
    else this.writeStorage(instance,field,value,codec,cell);
    return codec.copy(value);
  }
  writeStorage(instance,field,value,codec,cell) {
    if(cell){
      const poisoned=instance.poison?.get(field.key);
      if(poisoned?.write)poisoned.read();
      writeCell(cell,instance.arena.view,instance.refs,codec.copy(value),instance.base);
      if(poisoned)this.clearPoison(instance,field.key);
      return;
    }
    let raw=instance.slots.get(field.key);
    if(raw===undefined&&!instance.slots.has(field.key))
      instance.slots.set(field.key,raw=this.defaultValue(instance.cls,field,instance.defaultsSnapshot));
    instance.slots.set(field.key,codec.store(value,raw));
    if(field.key===ACTOR_BASE_KEY)bumpBaseEpoch();
  }
  // A receiver attached as a script instance is never the unattached-class
  // case readField/writeField serve, so the name path goes straight to it.
  readNamed(receiver,name) {
    const instance=this.instance(receiver),handle=this.namedHandle(instance,name);
    return this.readInstanceField(instance,handle.field,handle.codec??=propertyCodec(handle.field),handle.cell);
  }
  writeNamed(receiver,name,value) {
    const instance=this.instance(receiver),handle=this.namedHandle(instance,name);
    return this.writeInstanceField(instance,handle.field,value,handle.codec??=propertyCodec(handle.field),handle.cell);
  }
  /** Actor.LatentFloat (AActor+0xe0) as {get, set}: Sleep's remaining time
   * (script-sleep.mjs). */
  latentFloat(receiver) {
    return {get:()=>this.readNamed(receiver,'LatentFloat'),set:value=>this.writeNamed(receiver,'LatentFloat',value)};
  }
  /** readNamed(receiver, name) as an indexable view: {length, at(i)} of the
   * array readNamed would return, or null where it is not an array. An
   * unbound, unpoisoned fixed-array cell yields each element from its own
   * cell (readNamed builds the same values for all of them); any other
   * storage reads the whole value once. */
  readNamedElements(receiver,name) {
    const instance=this.instance(receiver),handle=this.namedHandle(instance,name),cell=handle.cell;
    if(cell&&isFixedCell(cell)&&!(instance.bindings.size&&instance.bindings.has(handle.field.key))
      &&!instance.poison?.get(handle.field.key))
      return {length:cell.dim,at:index=>readFixedElement(cell,instance.arena.view,instance.refs,index,instance.base)};
    const whole=this.readInstanceField(instance,handle.field,handle.codec??=propertyCodec(handle.field),cell);
    return Array.isArray(whole)?{length:whole.length,at:index=>whole[index]}:null;
  }
  /** readNamed/writeNamed for one (receiver, name) pair, with the instance
   * and handle resolved once. Host views (collision views) read the same
   * fields of every actor each frame. Attachment is permanent, so only the
   * released-allocation check has to run per access. */
  boundField(receiver,name) {
    const instance=this.instance(receiver),handle=this.namedHandle(instance,name);
    const field=handle.field,codec=handle.codec??=propertyCodec(field),cell=handle.cell;
    return {
      get:()=>{
        if(instance.nativeObject?.released)throw new Error('Script object allocation has been released');
        return this.readInstanceField(instance,field,codec,cell);
      },
      set:value=>{
        if(instance.nativeObject?.released)throw new Error('Script object allocation has been released');
        return this.writeInstanceField(instance,field,value,codec,cell);
      },
    };
  }
  /** A bound property's storage beneath its host binding. A binding whose
   * host state is absent (an actor without live Touching slots, a player
   * region not yet zoned) falls back to it, as it fell back to the map
   * actor's stored initial value. */
  readStoredField(receiver,field) {
    const instance=this.instance(receiver);
    return this.readStorage(instance,field,propertyCodec(field),instance.cells?.get(field.key));
  }
  writeStoredField(receiver,field,value) {
    const instance=this.instance(receiver);
    this.writeStorage(instance,field,value,propertyCodec(field),instance.cells?.get(field.key));
  }
  hasImageCell(receiver,field) {
    return Boolean(this.instance(receiver).cells?.has(field.key));
  }
  /** Map-authored properties over the class defaults: the serialized tagged
   * properties a loaded level actor gets after InitProperties
   * (docs/script-map-actors.md). `initial(field)` is prepareMapProperties'
   * value for one field, and `initial.authoredFields` lists the authored
   * ones. A value the map adapter cannot produce, or that its property cannot
   * copy, is rethrown by later accesses the way the map binding threw on
   * first read; a property without an image cell stays with the host. */
  applyInitialProperties(receiver,initial) {
    const instance=this.instance(receiver);
    if(!instance.cells)return;
    const source=this.classImage(instance.cls);
    if(source!==instance.imageSource)this.copyStorage(instance,{bytes:source.arena.bytes.subarray(source.base,source.base+source.layout.size),
      refs:source.refs,poison:source.poison});
    instance.imageSource=source;
    // A map actor's property reached its default through a binding, which
    // threw on get and set, not when the reference was made.
    if(instance.poison)for(const [key,entry] of instance.poison)instance.poison.set(key,{...entry,lazy:true});
    for(const field of initial.authoredFields){
      const cell=instance.cells.get(field.key);
      if(!cell)continue;
      let value,logical;
      try{value=initial(field);}
      catch{this.poisonField(instance,field.key,{read:()=>initial(field),write:true,lazy:true});continue;}
      try{logical=copyValue(field,value);}
      catch{this.poisonField(instance,field.key,{read:()=>value,write:false,lazy:true});continue;}
      writeCell(cell,instance.arena.view,instance.refs,logical,instance.base);
      if(instance.poison?.has(field.key))this.clearPoison(instance,field.key);
    }
  }
  /** The object's storage, to restore with restoreStorage (a mover reset). */
  snapshotStorage(receiver) {
    const instance=this.instance(receiver);
    if(!instance.base)return null;
    return {bytes:instance.arena.snapshot(instance.base,instance.size),refs:instance.refs.slice(),poison:instance.poison&&new Map(instance.poison)};
  }
  restoreStorage(receiver,snapshot) {
    if(snapshot)this.copyStorage(this.instance(receiver),snapshot);
  }
  /** Overwrite in place: live references hold the image and refs arrays. */
  copyStorage(instance,{bytes,refs,poison}) {
    bumpBaseEpoch();
    instance.arena.bytes.set(bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),instance.base);
    for(let index=0;index<refs.length;index++)instance.refs[index]=refs[index];
    instance.poison=poison?.size?new Map(poison):null;
    bumpReceiverEpoch();
  }
  poisonField(instance,key,entry) {
    bumpBaseEpoch();
    (instance.poison??=new Map()).set(key,entry);
    bumpReceiverEpoch();
  }
  clearPoison(instance,key) {
    instance.poison.delete(key);
    if(!instance.poison.size){instance.poison=null;bumpReceiverEpoch();}
  }
  async prepareResource(reference) {
    if(!reference)return null;
    return this.resourceRegistry().materialize(reference.asset,reference.index);
  }
  resourceRegistry() {
    // The process's: the resources and the package and native-class identities outlive a level (script-process.mjs).
    const shared=this.process;
    if(!shared)return this.resources??=new ScriptResourceRegistry({assets:this.objects.assets,objects:this.objects,
      indexProvider:this.originalObjectIndex,loader:this.classLoader});
    return this.resources??=shared.resources??=new ScriptResourceRegistry({assets:this.objects.assets,objects:this.objects,
      indexProvider:this.originalObjectIndex,loader:this.classLoader,process:shared});
  }
  /**
   * Finish the asynchronous package work before a synchronous original native
   * frame can request this object through DynamicLoadObject.
   */
  async prepareDynamicLoadObject(path){
    if(typeof path!=='string'||!path.includes('.'))
      throw new TypeError('DynamicLoadObject preparation requires Package.ObjectPath');
    const [packageName,...parts]=path.split('.');
    const asset=await this.objects.assets.get(packageName);
    const exportPath=parts.join('.').toLowerCase(),index=asset.exportsByPath.get(exportPath);
    if(!index)throw new DynamicLoadObjectBoundaryError(`Original package export is absent: ${path}`,
      'DYNAMIC_LOAD_OBJECT_NOT_FOUND',{path});
    const object=await this.objects.resolve(asset,index);
    await this.prepareObjectType(object);
    const resource=await this.prepareResource(object);
    this.dynamicLoadGraph??=new PreparedDynamicLoadGraph({objects:this.objects,resources:this.resources,
      onEvent:event=>this.warning?.({type:'DynamicLoadObject',...event})});
    await this.dynamicLoadGraph.prepare(object,resource);
    return object;
  }
  /** Synchronous recovered StaticLoadObject reached by the wrapper. Packages
   * the focused prepared routes own keep that graph; any other package whose
   * bytes were fetched ahead of the frame (prefetchDynamicLoadPackages) runs
   * StaticLoadObject over the shared class/resource graph. */
  loadPreparedDynamicObject(request){
    const packageName=lower(String(request.name).split('.')[0]);
    const classKey=request.classRef?.key??request.classRef?.record?.key;
    let object;
    // UClass objects belong to the shared native class/linker graph. A
    // prepared resource route may own textures/sounds from the same package,
    // but it has no native Core.Class Outer/metadata for FindExportIndex.
    if((classKey==='core.class'||classKey==='native:core.class')&&
      this.classLoader?.graph.packageAssets.has(packageName))
      object=this.loadGraphDynamicObject(request);
    else if(this.dynamicLoadGraph?.ownsPackage(packageName)){
      object=this.dynamicLoadGraph.load(request);
      this.modelPreparedDynamicLoad(this.dynamicLoadGraph.lastEvents);
    }
    else if(this.classLoader?.graph.packageAssets.has(packageName))object=this.loadGraphDynamicObject(request);
    else throw new DynamicLoadObjectBoundaryError(
      `DynamicLoadObject package linker is not prepared: ${request.name}`,
      'DYNAMIC_LOAD_OBJECT_FIRST_LOAD',{path:request.name});
    if(object!==null&&this.castObject(object,request.classRef,'dynamic')===null)
      throw new DynamicLoadObjectBoundaryError(`DynamicLoadObject class mismatch for ${request.name}`,
        'DYNAMIC_LOAD_OBJECT_CLASS_MISMATCH',{path:request.name,classRef:request.classRef});
    return object;
  }
  /** The registry slots DDeusExTextParser::OpenText's StaticLoadObject(XExtString, NULL, "Package.Name", ...) takes in the original, which Play's text source
   * (createExtStringSource) reads without creating them (docs/script-text-parser.md "Registry"): a package the process had not loaded gets its UPackage and
   * LinkerLoad; the first text loaded from any package loads Extension:XExtString from Extension.u (the registered placeholder UClass is replaced and its
   * members are created); the text object is one AddObject and OpenText deletes it before returning (ResetLoaders, then the delete). Capture kpd1, tick 30:
   * the class, its 21 members and ExtString 00_Datacube01 are created, the class's placeholder slot, the text object and the parser are freed. A text that is
   * not found (StaticLoadObject returns NULL) creates nothing modeled here: not measured. */
  modelExtStringLoad(path){
    const original=this.actorLifecycle?.construction?.registry?.original;
    if(!original?.packages)return;
    const dot=path.indexOf('.');
    original.loadPackage(path.slice(0,dot));
    original.loadNativeClass('ExtString',EXT_STRING_CLASS_MEMBERS);
    const holder={};
    original.take(holder,'ExtString',path.slice(dot+1));
    original.giveBack(holder);
  }
  /** The registry slots a prepared route's StaticLoadObject takes in the original (original-object-index.mjs, as the speech audio's load in
   * script-conplay-live.mjs): GetPackageLinker's first load of a package creates its UPackage (ResolveName, create) and its LinkerLoad; CreateExport
   * creates the export the first time; EndLoad's Preload of a Texture serializes its Palette reference, whose CreateExport is one more object. The
   * Island capture kil1 (tick 481: HUDInfoLinkDisplay.SetSpeaker's DynamicLoadObject("InfoPortraits.AlexJacobson")) records exactly
   * Package InfoPortraits, LinkerLoad, Texture AlexJacobson, Palette Palette50. A texture's other references (DetailTexture, MacroTexture, BumpMap,
   * AnimNext) would load the same way: none is modeled, and a portrait route that reaches one is not covered. */
  modelPreparedDynamicLoad(events){
    const original=this.actorLifecycle?.construction?.registry?.original;
    if(!original?.packages)return;
    // only the exports of a package this run loaded first: an export of a package the original held at the measured start (a ConversationList the
    // Mission01 conversations reach, capture hck1 tick 24) creates nothing there
    this.firstLoadedPackages??=new WeakMap();
    const loadedHere=this.firstLoadedPackages.get(original)??new Set();
    this.firstLoadedPackages.set(original,loadedHere);
    for(const event of events??[]){
      if(event.op==='CreateLinkerLoad'){ if(original.loadPackage(event.root?.name))loadedHere.add(String(event.root?.name).toLowerCase()); }
      else if(event.op==='CreateExport'&&event.existing?.asset&&loadedHere.has(event.existing.asset.name.toLowerCase())){
        const object=event.existing,asset=object.asset,cls=asset.pkg.exports[object.index-1]?.className;
        if(!original.loadExport(object,cls,object.name)||cls!=='Texture')continue;
        const palette=readObject(asset.pkg,asset.bytes,object.index).values.Palette;
        if(!(palette>0))continue;
        const entry=asset.pkg.exports[palette-1],key=`${asset.name}.${entry.path}`.toLowerCase();
        // the canonical object when it was resolved, else one stable holder per export (loadExport counts an object once)
        this.preparedExportHolders??=new Map();
        const holder=this.objects.lookup(key)??this.preparedExportHolders.get(key)??{key};
        this.preparedExportHolders.set(key,holder);
        original.loadExport(holder,entry.className,entry.name);
      }
    }
  }
  /** The registry slots the shared graph's StaticLoadObject takes in the original, as modelPreparedDynamicLoad does for the prepared routes: a package
   * the process had not loaded gets its UPackage and LinkerLoad (GetPackageLinker's first load), then each object of that package is created once, in
   * the order EndLoad preloads them: GObjLoaded's, which is their creation order (CreateExport appends to it; a Font's Serialize creates its page
   * Textures, a Texture's its Palette). Capture dxb2 (DX.dx, tick 1600, MenuMain's buttons' DynamicLoadObject("DXFonts.MainMenuTrueType")): Package
   * DXFonts, LinkerLoad, Font MainMenuTrueType, Texture Texture0, Texture Texture1, Palette Palette1, the order Play's events give. A class's first load
   * from such a package (its functions, states and properties) is not measured and stays out of the model. */
  modelGraphDynamicLoad(events){
    const original=this.actorLifecycle?.construction?.registry?.original;
    if(!original?.packages)return;
    this.firstLoadedPackages??=new WeakMap();
    const loadedHere=this.firstLoadedPackages.get(original)??new Set();
    this.firstLoadedPackages.set(original,loadedHere);
    const structural=/^(Class|Function|State|Enum|Struct|Const|TextBuffer|\w*Property)$/;
    for(const event of events??[]){
      if(event.op==='CreateLinkerLoad'){ if(original.loadPackage(event.root?.name))loadedHere.add(lower(event.root.name)); continue; }
      if(event.op!=='CreateExport'&&event.op!=='Preload')continue;
      const object=event.op==='Preload'?event.object:event.existing;
      if(!object)continue;
      const identity=this.classLoader.identity(object),asset=identity?.asset;
      if(!asset||!loadedHere.has(lower(asset.name)))continue;
      const cls=asset.pkg.exports[identity.index-1]?.className;
      if(!cls||structural.test(cls))continue;
      original.loadExport(object,cls,identity.name);
    }
  }
  /** StaticLoadObject over the shared graph: its linkers, CreateExport,
   * Preload/PostLoad and a load scope around Play's never-flushed queue.
   * See docs/script-font-load.md ("DynamicLoadObject route"). */
  loadGraphDynamicObject(request){
    const loader=this.classLoader,graph=loader.graph;
    const classRef=loader.nativeIdentity(request.classRef);
    const restore=graph.suspendLoadQueue();
    let result;
    try{
      result=execStaticLoadObject({...request,classRef},
        graph.staticLoadServices({appGetDllHandle:name=>this.appGetDllHandle(name)}));
    }catch(error){
      restore({failed:true});
      throw error;
    }
    restore();
    // the original's load request: what it loaded is the original's (original-loaded.mjs)
    if(result.object!==null)loader.originalLoads.reach([result.object]);
    this.modelGraphDynamicLoad(result.events);
    for(const event of result.events)this.warning?.({type:'DynamicLoadObject',...event});
    return result.object===null?null:loader.identity(result.object);
  }
  /** appGetDllHandle(appBaseDir()+Name): LoadLibrary of <Name>.dll in System. */
  appGetDllHandle(name){
    const libraries=this.objects.assets?.libraries;
    if(!(libraries instanceof Set))throw new Error('appGetDllHandle requires the installed System file listing');
    if(libraries.has(`${lower(name)}.dll`))
      throw new Error(`Package DLL ${name}.dll exists; native package binding is not implemented`);
    return null;
  }
  /** A literal DynamicLoadObject("Package.Object", ...) argument names a
   * package whose bytes must be fetched before the synchronous native frame.
   * Only the bytes are fetched: no linker or object is created, so the call
   * still reaches GetPackageLinker's first-load branch. */
  async prefetchDynamicLoadPackages(decoded,bindings){
    if(!this.classLoader||!decoded?.expressions)return;
    for(const node of decoded.expressions.values()){
      if(node?.op!==0x1c||bindings.get(node.functionIndex)?.key!=='core.object.dynamicloadobject')continue;
      const name=node.args?.[0];
      if(name?.op==='literal'&&typeof name.value==='string')await this.prefetchDynamicLoadPackage(name.value);
      // An instance-variable path (CreditsScrollWindow.StartMusic's
      // ScrollMusicString): the values its declaring class and that class's
      // subclasses in the same package give it by default. Another runtime
      // value still reaches the first-load boundary.
      else if(name?.op===0x01)for(const value of await this.defaultStringValues(bindings.get(name.fieldIndex)))
        await this.prefetchDynamicLoadPackage(value);
    }
  }
  async prefetchDynamicLoadPackage(path){
    if(typeof path!=='string'||!path.includes('.'))return;
    const packageName=path.split('.')[0];
    if(this.classLoader.graph.packageAssets.has(lower(packageName)))return;
    let asset;
    try{asset=await this.objects.assets.get(packageName);}catch{return;} // absent: the call reaches file lookup
    await this.classLoader.prepare(asset);
  }
  /** A string property's default values in its declaring class and in every
   * subclass the same package exports. */
  async defaultStringValues(field){
    const asset=field?.asset,owner=field?.entry?.outer;
    if(!asset||!(owner>0)||!/^strproperty$/i.test(field.entry.className??''))return [];
    const exports=asset.pkg.exports,values=new Set();
    const descends=index=>{for(let i=index;i>0;i=exports[i-1].superIndex)if(i===owner)return true;return false;};
    for(let index=1;index<=exports.length;index++){
      if(exports[index-1].className!=='Class'||!descends(index))continue;
      const cls=await this.loadClass(asset,index),member=this.lookupMember(cls,'fields',field.entry.name??field.name);
      if(!member)continue;
      try{const value=this.defaultValue(cls,member);if(typeof value==='string'&&value)values.add(value);}catch{}
    }
    return [...values];
  }
  /** Engine's inlined IsA over a natively loaded object's Class/SuperField
   * chain, for a native-only class target (Font, Sound...). */
  castToNativeClass(value,target){
    const loader=this.classLoader;
    if(!loader)throw new Error('Native-only class casts require the native class loader');
    const record=loader.nativeRecords.get(value)??value.loadRecord;
    if(!record)throw new Error(`Native-only class cast needs a natively loaded object: ${value.key??'<object>'}`);
    const graph=loader.graph;
    for(let cls=graph.classRecordOf(record);cls;cls=graph.superOf(cls))if(loader.identity(cls)===target)return value;
    return null;
  }
  /** Prepare only the tagged logical values of an existing non-Actor export.
   * Native payloads, constructors and saved state require separate services.
   * References keep canonical identity; preparation does not recursively run
   * native loading or script startup. See docs/script-loaded-objects.md. */
  async prepareObject(reference) {
    if(reference===null)return null;
    if(!reference?.asset||!Number.isInteger(reference.index)||reference.index<=0)
      throw new TypeError('Loaded property preparation requires a canonical package export');
    const canonical=await this.objects.resolve(reference.asset,reference.index);
    if(canonical!==reference)throw new Error('Loaded property preparation requires the canonical object identity');
    if(this.preparedObjects.has(reference.key))return this.preparedObjects.get(reference.key);
    if(this.instances.has(reference))return reference;
    const pending=(async()=>{
      const {asset,entry}=reference;
      const cls=await this.loadClass(asset,entry.classIndex);
      for(let current=cls;current;current=current.base)if(current.record.key==='engine.actor')
        throw new Error('Loaded Actor preparation requires the original world host');
      const stored=readObject(asset.pkg,asset.bytes,reference.index);
      if(stored.stack!==null)throw new Error('Loaded object saved execution stacks are not implemented');
      // ConEventRandomLabel carries a `native private DynamicArray labels`
      // payload after its tagged properties (docs/script-instructor-conversation.md,
      // script-conversation-random-label.mjs). Decode it; every other trailing
      // native payload remains an explicit boundary.
      let randomLabels=null;
      if(cls.record.key===RANDOM_LABEL_NATIVE.classKey&&stored.reader.offset!==entry.serialSize){
        randomLabels=decodeRandomLabelLabels(stored.reader,asset.pkg.version);
      }
      if(stored.reader.offset!==entry.serialSize)
        throw new Error(`Loaded object has an unsupported native payload: ${reference.key}`);
      const initial=await prepareMapProperties(this,asset,{...reference,properties:stored.properties},cls,new Map());
      const slots=new Map();
      for(const field of cls.propertyLink)if(!field.key.startsWith('core.object.'))
        slots.set(field.key,copyValue(field,initial(field)));
      const resource=await this.prepareResource(reference);
      this.attach(reference,cls,slots);
      if(randomLabels!==null)this.instance(reference).randomLabels=randomLabels;
      const immutable=(name,get)=>this.bindProperty(reference,this.lookupMember(cls,'fields',name),{
        get,set:()=>{throw new Error(`Loaded ${name} mutation requires its native lifecycle service`);},
      });
      immutable('Name',()=>reference.name);
      immutable('Class',()=>cls.record);
      immutable('Outer',()=>resource.outer?.object??resource.outer??null);
      for(const name of ['ObjectFlags','ObjectInternal'])immutable(name,()=>{
        throw new Error(`Loaded ${name} requires the live native object lifecycle`);
      });
      return reference;
    })();
    this.preparedObjects.set(reference.key,pending);
    pending.catch(()=>this.preparedObjects.delete(reference.key));
    return pending;
  }
  async prepareMesh(receiver) {
    return this.prepareMeshReference(this.readNamed(receiver,'Mesh'));
  }
  /** prepareMesh for a mesh the caller names: a pawn's weapon is drawn with its
   * ThirdPersonMesh swapped into Mesh (docs/weapon-attachment.md), which the
   * actor's own Mesh field never holds. */
  async prepareMeshReference(reference) {
    if(!reference||!['LodMesh','Mesh'].includes(reference.kind))return null;
    const resource=await this.prepareResource(reference);
    if(!MESH_PAYLOADS.has(resource.payloadStatus))
      throw new Error(`Original mesh payload is unsupported: ${reference.key}`);
    return resource.payload;
  }
  /** Original AActor::execPlayAnim reads Actor.Mesh (+0x174) and calls the
   * mesh's sequence lookup. Package/resource preparation must finish before
   * this synchronous script boundary. */
  meshPayload(receiver) {
    return this.meshResource(this.readNamed(receiver,'Mesh'))?.payload??null;
  }
  meshResource(reference) {
    if(!reference||!['LodMesh','Mesh'].includes(reference.kind))return null;
    const resource=this.resources?.resources.get(reference.key);
    if(!resource||this.resources.pending.has(reference.key)||!MESH_PAYLOADS.has(resource.payloadStatus))
      throw new Error(`Original mesh resource is not prepared: ${reference.key}`);
    return resource;
  }
  /** Original ULodMesh::GetFrame over the same prepared resource and reflected
   * animation fields as PlayAnim/Tick. Callers supply original FCoords and a
   * measured or modeled global UObject identity, not a package export index.
   * This pose boundary does not select triangles, materials or lighting. */
  getActorMeshFrame(receiver,coords,options={}) {
    const mesh=this.meshPayload(receiver);
    if(!mesh)throw new Error('Original GetFrame requires a prepared mesh');
    const services={
      read:(actor,name)=>this.readNamed(actor,name),
      objectIndex:actor=>this.soundField(actor,'ObjectIndex'),
    };
    // A classic UMesh: UMesh::GetFrame, which has no requested count (umesh-frame.mjs).
    if(mesh.payloadStatus==='decoded-mesh')
      return getUMeshFrame(mesh,receiver,coords,{...services,cache:this.umeshFrameCache??=createUMeshFrameCache()},options);
    return getLodMeshFrame(mesh,receiver,coords,{
      cache:this.meshFrameCache??=createLodMeshFrameCache(),
      read:(actor,name)=>this.readNamed(actor,name),
      objectIndex:actor=>this.soundField(actor,'ObjectIndex'),
    },options);
  }
  meshTextureServices() {
    const read=(actor,name)=>this.readNamed(actor,name);
    const resource=reference=>{
      const value=this.meshResource(reference);
      if(!value)throw new Error('Original mesh texture array requires a prepared mesh');
      return value;
    };
    return {read,getSkin:(actor,index)=>getActorSkin(actor,index,read),
      textureCount:reference=>resource(reference).payload.objectReferences.length,
      textureAt:(reference,index)=>resource(reference).payloadReferences.find(edge=>edge.slot===`textures[${index}]`)?.target.object??null,
      warning:text=>this.warning?.({type:'GetMeshTexture',message:text}),
    };
  }
  /** Renderer-side UMesh::GetTexture; native 1013 has separate bounds rules. */
  getActorMeshTexture(receiver,index) {
    const reference=this.readNamed(receiver,'Mesh');
    if(!reference)throw new Error('Original GetTexture requires Actor.Mesh');
    return getMeshTexture(reference,receiver,index,this.meshTextureServices());
  }
  /** getActorMeshTexture for a mesh the caller names (a weapon's ThirdPersonMesh). */
  getMeshTextureOf(reference,receiver,index) {
    if(!reference)throw new Error('Original GetTexture requires a mesh');
    return getMeshTexture(reference,receiver,index,this.meshTextureServices());
  }
  getActorMeshSurfaces(receiver,options={}) {
    return this.getMeshSurfaces(this.readNamed(receiver,'Mesh'),options);
  }
  /** readLodMeshSurfaces of a prepared mesh the caller names. */
  getMeshSurfaces(reference,options={}) {
    const mesh=this.meshResource(reference)?.payload??null;
    if(!mesh)throw new Error('Original surface decoding requires a prepared mesh');
    if(mesh.payloadStatus==='decoded-mesh')return readUMeshSurfaces(mesh);
    return readLodMeshSurfaces(mesh,options);
  }
  /** Native PlaySound264 services per docs/script-sound.md: reflected fields,
   * the level native graph (Model/demo driver) and the global UObject index.
   * The index comes only from a registered native object identity record; an
   * unbound emitter reaches the translated native's own explicit error. */
  soundServices(call) {
    return {
      read:(actor,name)=>this.soundField(actor,name),
      isA:(actor,kind)=>{
        const tail=lower(String(kind).split('.').pop());
        for(let cls=this.instance(actor).cls;cls;cls=cls.base)
          if(lower(cls.record.name)===tail)return true;
        return false;
      },
      // Frame.Node +4 ancestry: a script-function frame supplies its flags,
      // anything else is the original null.
      frameFunctionFlags:()=>Number.isInteger(call.script?.functionFlags)?call.script.functionFlags:null,
      fastLineCheck:(model,start,end)=>{
        if(!model)throw new Error('Original sound requires the live level model');
        return fastLineCheck(model,start,end);
      },
      processNativeEvent:(receiver,name,args)=>this.processNativeEvent(receiver,name,args),
    };
  }
  /** Native Move266 services: reflected fields plus the live level's
   * MoveActor boundary (ULevel::MoveActor, vtable +0x88). A scene without the
   * movement service leaves the slot unset so the wrapper raises its explicit
   * unlinked-service error instead of approximating movement. */
  moveServices(call) {
    const level=this.levelFor(call.receiver);
    return {
      read:(actor,name)=>this.soundField(actor,name),
      moveActor:typeof level?.moveActor==='function'?level.moveActor.bind(level):undefined,
    };
  }
  /** Pawn-locomotion native view (docs/script-pawn-locomotion.md): the
   * recovered bodies read/write the pawn's script-declared movement fields.
   * Each property binds the reflected field once; vectors/rotators stay
   * [x,y,z]/[pitch,yaw,roll] arrays and flags stay booleans, matching the
   * shapes the oracle probe's fabricated memory exposes. */
  pawnView(receiver) {
    const fields={
      physics:'Physics',location:'Location',velocity:'Velocity',acceleration:'Acceleration',
      rotation:'Rotation',desiredRotation:'DesiredRotation',rotationRate:'RotationRate',
      floor:'Floor',destination:'Destination',focus:'Focus',latentFloat:'LatentFloat',
      moveTimer:'MoveTimer',desiredSpeed:'DesiredSpeed',maxDesiredSpeed:'MaxDesiredSpeed',
      meleeRange:'MeleeRange',groundSpeed:'GroundSpeed',waterSpeed:'WaterSpeed',
      airSpeed:'AirSpeed',accelRate:'AccelRate',avgPhysicsTime:'AvgPhysicsTime',
      collisionRadius:'CollisionRadius',collisionHeight:'CollisionHeight',
      moveTarget:'MoveTarget',faceTarget:'FaceTarget',
      bCanStrafe:'bCanStrafe',bReducedSpeed:'bReducedSpeed',bCanSwim:'bCanSwim',
      bAdvancedTactics:'bAdvancedTactics',bCanGlide:'bCanGlide',bIsPlayer:'bIsPlayer',
    };
    const view={self:receiver};
    for(const [prop,name] of Object.entries(fields)){
      const ref=this.namedReference(receiver,name);
      Object.defineProperty(view,prop,{get:()=>ref.get(),set:value=>ref.set(value),enumerable:true});
    }
    return view;
  }
  /** ZoneInfo projection the falling/swim gates consume: Region.Zone plus the
   * ZoneInfo class default's ZoneGravity.z (the be200 assert path reads
   * zone->Class->ClassDefaultObject+0x324). */
  locomotionZone(actor) {
    if(!actor)return null;
    const zone=this.regionValue(actor).zone;
    if(!zone)return null;
    const cls=this.instance(zone)?.cls;
    const gravity=this.readNamed(zone,'ZoneGravity');
    const field=cls?this.lookupMember(cls,'fields','ZoneGravity'):null;
    const defaults=field?this.defaultValue(cls,field):null;
    return {gravityZ:gravity?.[2],defaultGravityZ:defaults?.[2],
      waterZone:Boolean(this.readNamed(zone,'bWaterZone'))};
  }
  locomotionServices() {
    return {
      isA:(actor,name)=>{
        const tail=lower(String(name).split('.').pop());
        for(let cls=this.instance(actor)?.cls;cls;cls=cls.base)
          if(lower(cls.record.name)===tail)return true;
        return false;
      },
      readField:(actor,name)=>this.readNamed(actor,name),
      processEvent:(actor,name,args)=>this.processEvent(actor,name,args),
      // FindFunctionChecked against the object's class chain: NULL when the
      // class never declares the name (e.g. SpawnNotification on pawns).
      findFunction:(actor,name)=>this.lookup(actor,name)?.function??null,
      zone:actor=>this.locomotionZone(actor),
    };
  }
  /** Latent move/turn setups (Engine bodies at PAWN_LOCOMOTION_CONTRACT):
   * every argument expression is evaluated before the body runs, exactly as
   * the original GNatives-dispatch order (all evals precede all writes). */
  pawnLocomotion(call) {
    const dispatch={500:dispatchMoveTo,502:dispatchMoveToward,504:dispatchStrafeTo,506:dispatchStrafeFacing,
      508:dispatchTurnTo,510:dispatchTurnToward,527:dispatchWaitForLanding}[call.index];
    const args=[];
    for(let i=0;i<call.argumentCount;i++)args.push(refValue(call.evaluateArgument(i)));
    return dispatch({pawn:this.pawnView(call.receiver),state:this.instance(call.receiver).state,
      args,services:this.locomotionServices()});
  }
  pollPawnLocomotion(call) {
    const poll={501:pollMoveTo,503:pollMoveToward,505:pollStrafeTo,507:pollStrafeFacing,509:pollTurnTo,
      511:pollTurnToward,528:pollWaitForLanding}[call.index];
    return poll({pawn:this.pawnView(call.receiver),state:call.state,dt:call.seconds,
      services:this.locomotionServices()});
  }
  /** Native MakeNoise512 services: the PlaySound level graph plus field
   * writes (instigator noise slots, listener Stimulus), probe-mask queries,
   * the bidirectional class test and appWarnf warnings (0xf1/0xf2). */
  noiseServices(call) {
    const services=this.soundServices(call);
    services.write=(actor,name,value)=>this.writeNamed(actor,name,value);
    services.warn=code=>this.warning?.({type:'MakeNoise',kind:code});
    services.isProbing=(actor,name)=>this.isProbing(actor,name);
    services.relatedClass=(a,b)=>{
      const ca=this.instance(a).cls,cb=this.instance(b).cls;
      if(!ca||!cb)return !ca&&!cb;
      const contains=(cls,record)=>{for(let node=cls;node;node=node.base)if(node.record===record)return true;return false;};
      return contains(ca,cb.record)||contains(cb,ca.record);
    };
    return services;
  }
  /** DeusEx ScriptedPawn alliance services (2105-2107, script-pawn-alliance.mjs).
   * The Rust interpreter's JavaScript path for these natives uses the same
   * services (script-vm-perception.mjs). */
  allianceServices() {
    return {
      read:(actor,name)=>this.readNamed(actor,name),
      elements:(actor,name)=>this.readNamedElements(actor,name),
      isA:(actor,key)=>{
        for(let cls=this.instance(actor).cls;cls;cls=cls.base)
          if(cls.record.key===key)return true;
        return false;
      },
    };
  }
  /** Native Actor/Pawn perception services (514/531/532/533/534/700/701/705) per
   * docs/script-pawn-perception.md: the shared LOS worker, the two target
   * pickers and the AICanSee visibility worker. Field reads come through the
   * soundField level graph; the trace primitives are the BSP FastLineCheck
   * and the SingleLineCheck (MultiLineCheck) wrapper — no navigation graph is
   * consulted by any of these bodies. */
  /** Natives 710/711 and 713-716 on the Rust AI event manager (script-vm-aievent.mjs): the exec wrappers' argument defaults
   * (0x1036d440: visibility, direction and LOS checks on, cylinder off; 0x1036d750 and 0x1036d8e0: value 1.0, radius 800.0). An
   * EX_Nothing argument is `undefined` and keeps its default. */
  aiEventNative(aiEvents,call) {
    const arg=(i,fallback)=>{
      if(call.argumentCount<=i)return fallback;
      const value=refValue(call.evaluateArgument(i));
      return value===undefined?fallback:value;
    };
    const receiver=call.receiver,event=arg(0,'');
    switch(call.index) {
      case 710: {
        const callback=arg(1,''),score=arg(2,'');
        const checks=[arg(3,true),arg(4,true),arg(5,false),arg(6,true)].map(Boolean);
        aiEvents.setCallback(receiver,event,callback,score,checks);
        return;
      }
      case 711: aiEvents.clearCallback(receiver,event);return;
      case 713: case 714: {
        const type=Number(arg(1,0)),value=Math.fround(Number(arg(2,1))),radius=Math.fround(Number(arg(3,800)));
        if(call.index===713)aiEvents.send(receiver,event,type,value,radius);
        else aiEvents.start(receiver,event,type,value,radius);
        return;
      }
      case 715: aiEvents.end(receiver,event,Number(arg(1,0)));return;
      default: aiEvents.clear(receiver,event);return;
    }
  }
  perceptionServices(call) {
    const services=this.soundServices(call);
    services.write=(actor,name,value)=>this.writeNamed(actor,name,value);
    services.level=receiver=>this.levelFor(receiver);
    services.levelInfo=level=>level?.actors?.[0]??null;
    services.levelActors=level=>level?.actors??null;
    services.model=level=>level?.model??null;
    services.pawnList=level=>level?.pawnList??null;
    services.nextPawn=pawn=>pawn?.nextPawn??null;
    /* netMode==0 / netMode==3 net list: the original iterates Engine->Players
     * (UPlayer Pawn slots). The browser runtime keeps no separate UPlayer
     * TArray; in standalone the net players are exactly the pawn list's
     * bIsPlayer pawns. Network client/server modes are outside the browser
     * port's modeled graph (docs/script-pawn-perception.md). */
    services.netPlayers=level=>{
      const out=[];
      for(let pawn=level?.pawnList;pawn;pawn=pawn.nextPawn)
        if(this.readNamed(pawn,'bIsPlayer'))out.push(pawn);
      return out;
    };
    services.rand=()=>{
      if(typeof this.rng?.frand!=='function')
        throw new Error('Pawn perception requires the shared original RNG stream');
      return Math.fround(this.rng.frand());
    };
    /* PickTarget's same-team test (0x103baee3..0x103baf0e): GameInfo->+0x328
     * bit 0x200 (bTeamGame) gates a PRI->+0x340 team-byte compare; missing PRIs
     * or a non-team game keep the candidate. */
    services.sameTeam=(viewer,cand,levelInfo)=>{
      const game=this.readNamed(levelInfo,'Game');
      if(!game)return false;
      const viewerPri=this.readNamed(viewer,'PlayerReplicationInfo');
      const candPri=this.readNamed(cand,'PlayerReplicationInfo');
      if(!viewerPri||!candPri)return false;
      if(!this.readNamed(game,'bTeamGame'))return false;
      return (Number(this.readNamed(viewerPri,'Team'))&0xff)
        ===(Number(this.readNamed(candPri,'Team'))&0xff);
    };
    // AIVisibility reads the reflected LevelInfo float, unlike MakeNoise's
    // double ULevel clock. Full Level.Tick publishes this field before actors.
    services.read=(actor,name)=>name==='TimeSeconds'?this.readNamed(actor,name):this.soundField(actor,name);
    services.zone=actor=>this.regionValue(actor).zone;
    services.lightLineCheck=(level,source,end,start)=>{
      if(typeof level?.hash?.lineCheck!=='function')
        throw new Error('AIGetLightLevel requires the live level query services');
      return level.hash.lineCheck(start,end,[0,0,0],6,0,source).outside;
    };
    services.lighting=(other,oLoc)=>typeof this.perceptionLighting==='function'
      ?this.perceptionLighting(other,oLoc):actorLightLevelExtended(other,oLoc,services);
    /* SingleLineCheck (0x103c7430): MultiLineCheck(end,start,extent=0,
     * checkActors=1,worldActor=Level,extra=4), then walk hits in order — the
     * viewer's owner chain and the target are skipped, a world (LevelInfo)
     * hit or a bBlockSight&&!bHidden actor blocks the line. */
    services.singleLineCheck=(level,viewer,target,end,start)=>{
      if(!level?.hash||typeof level.hash.multiLineCheck!=='function')
        throw new Error('AICanSee LOS requires the live level collision hash');
      const worldActor=level.actors?.[0]??null;
      const hits=level.hash.multiLineCheck({end,start,extent:[0,0,0],checkActors:1,worldActor,extra:4});
      const blocked=actor=>{
        if(!actor)return false;
        for(let node=viewer;node;node=this.readNamed(node,'Owner'))
          if(actor===node)return false;
        if(actor===target)return false;
        if(actor===worldActor)return true;
        const blocks=this.readNamed(actor,'bBlockSight'),hidden=this.readNamed(actor,'bHidden');
        return Boolean(blocks)&&!Boolean(hidden);
      };
      for(const hit of hits)if(blocked(hit.actor))return false;
      return true;
    };
    return services;
  }
  /** Actor.Tick's internal visibility helpers share the already recovered LOS
   * worker and live PawnList. Native validity and the double clock stay explicit;
   * reflected LevelInfo.TimeSeconds is not a substitute for XLevel.TimeSeconds. */
  pawnTickVisibilityServices(receiver,{level,isValid,failAssert}={}) {
    const services=this.perceptionServices({receiver});
    if(level)services.level=actor=>actor===receiver?level:this.levelFor(actor);
    services.isProbing=(actor,name)=>this.isProbing(actor,name);
    services.isValid=isValid??this.actorLifecycle?.references?.isValid;
    services.failAssert=failAssert??(line=>{throw new Error(`Original Pawn visibility assertion at source line ${line}`);});
    services.timeSeconds=world=>world?.timeSeconds;
    services.findFunctionChecked=(actor,name)=>{
      const record=this.lookup(actor,name);
      if(!record)throw new Error(`Original Pawn visibility event was not found: ${name}`);
      return record;
    };
    services.processEvent=(actor,record,args)=>this.processEvent(actor,record.name,args,null,record);
    return services;
  }
  showPawnSelf(receiver,options={}) {
    return showPawnSelf(receiver,this.pawnTickVisibilityServices(receiver,options));
  }
  checkPawnEnemyVisible(receiver,options={}) {
    return checkPawnEnemyVisible(receiver,this.pawnTickVisibilityServices(receiver,options));
  }
  /** Record the measured global UObject index (Core.dll GObjObjects slot) for
   * an attached object. The original PlaySound channel id and other native
   * paths derive from this global identity, and a map-package export index is
   * not a valid substitute (docs/script-sound.md). The value is original
   * evidence captured from the live game (tools/dump-gobjects-win.c), not a
   * fabricated or inferred index. */
  registerGlobalObjectIndex(receiver,index) {
    if(!Number.isInteger(index)||index<0||index>0x7fffffff)
      throw new Error('Global UObject index must be a non-negative int32');
    this.instance(receiver).globalIndex=index;
  }
  /** Install a capture-backed global-index provider (the live GObjObjects dump,
   * tools/dump-gobjects-win.c). With it attached, soundField('ObjectIndex')
   * resolves any pre-placed object's true global slot by (class, name) — no
   * per-actor registerGlobalObjectIndex call. Runtime-spawned objects are absent
   * from the load-time capture and fall through to their modeled registry slot
   * (docs/boot-replay.md). The provider must expose indexFor(className,name). */
  setOriginalObjectIndex(provider) {
    if(provider!==null&&typeof provider?.indexFor!=='function')
      throw new Error('Original object-index provider requires indexFor(className, name)');
    this.originalObjectIndex=provider;
    if(this.resources)this.resources.indexProvider=provider;
  }
  /** Resolve a pre-placed object's true global UObject index from the attached
   * capture-backed provider by (class, name). The provider never guesses: an
   * absent or ambiguous key yields null, so a runtime spawn falls through to its
   * modeled registry slot rather than borrowing a wrong index. Original evidence
   * only. */
  resolveOriginalObjectIndex(receiver,instance=this.instance(receiver)) {
    const provider=this.originalObjectIndex;
    if(!provider)return null;
    const className=instance.cls?.record?.name;
    if(typeof className!=='string')return null;
    let objectName;
    try{objectName=this.readNamed(receiver,'Name');}
    catch(error){return null;}
    if(typeof objectName!=='string')return null;
    const index=provider.indexFor(className,objectName);
    return Number.isInteger(index)?index:null;
  }
  /** Prepare canonical reflected fields for a mission list and every object
   * its load reaches. ConBindEvents loads the list through StaticLoadObject:
   * each serialized object reference Preload reads goes through IndexToObject,
   * whose CreateExport appends the export to GObjLoaded, and EndLoad preloads
   * every appended entry (docs/script-linker-imports.md,
   * docs/script-end-load.md). So the whole graph the list reaches in its
   * package (ConItem chain, Conversations, ConFlagRef/ConEvent chains,
   * ConSpeech, ConChoice, jumpCon targets) is loaded before BindConversations,
   * whichever path later reads it: ConPlay, DataLinkPlay or ConPlayBark
   * (docs/script-conversation-binding.md, "Loaded graph"). Every reference
   * the list's exports serialize is a tagged ObjectProperty; their Outers are
   * the package root. This does not perform native StaticLoadObject/PostLoad
   * ownership. */
  async prepareConversations(missionNumber=0,packageName='DeusExConText') {
    if(!Number.isInteger(missionNumber)||missionNumber<0)throw new Error('Invalid conversation mission');
    const path=`ConList_Mission${String(missionNumber).padStart(2,'0')}`;
    const key=lower(`${packageName}.${path}`);
    if(this.conversationLists.has(key))return this.conversationLists.get(key);
    const asset=await this.objects.assets.get(packageName);
    // ConBindEvents' StaticLoadObject creates the package's linker at each level's start (LoadMap's collection unloaded the previous level's): its names enter
    // the process table before any of its objects is read (unreal/name-spelling.mjs)
    this.nameSpelling?.enterPackage(asset.pkg);
    const index=asset.exportsByPath.get(lower(path));
    if(!index)throw new Error(`ConversationList export is unavailable: ${key}`);
    const list=await this.prepareObject(await this.objects.resolve(asset,index));
    if(this.instance(list).cls.record.key!=='consys.conversationlist')throw new Error('Invalid ConversationList class');
    const seen=new Set();
    for(let item=this.readNamed(list,'conversations');item!==null;item=this.readNamed(item,'Next')){
      if(!item||seen.has(item))throw new Error('Invalid conversation source chain');
      seen.add(item);await this.prepareObject(item);
      await this.prepareObject(this.readNamed(item,'ConObject'));
    }
    const loaded=new Set([list]),queue=[list];
    while(queue.length){
      const object=queue.pop();
      await this.prepareObject(object);
      for(const field of this.instance(object).cls.propertyLink){
        if(field.metadata?.type!=='object'||field.key.startsWith('core.object.'))continue;
        const value=this.fieldReference(object,field).get();
        for(const target of Array.isArray(value)?value:[value]){
          // Imports (ConSys/DeusEx classes) belong to their own packages' linkers.
          if(!target||target.asset!==asset||loaded.has(target))continue;
          loaded.add(target);queue.push(target);
        }
      }
    }
    const conSys=await this.objects.assets.get('ConSys');
    this.conversationItemClass=await this.loadClass(conSys,conSys.exportsByPath.get('conlistitem'));
    this.conversationLists.set(key,list);
    this.conversationListObjects.set(key,[...loaded]);
    return list;
  }
  /** Recovered DeusEx mission wrapper with explicit native loading services. */
  bindConversationEvents(receiver) {
    return bindActorConversations(receiver,{
      levelFor:this.levelFor,
      isLevelInfo:actor=>{
        for(let cls=this.instance(actor).cls;cls;cls=cls.base)
          if(cls.record.key==='deusex.deusexlevelinfo')return true;
        return false;
      },
      read:(object,key)=>this.readNamed(object,key),
      log:message=>this.warning?.({type:'ConBindEvents',message}),
      load:request=>{
        if(typeof this.conversationLifecycle?.load!=='function')
          throw new Error('ConBindEvents StaticLoadObject lifecycle is unbound');
        return this.conversationLifecycle.load(request);
      },
      bind:(list,actor)=>this.bindConversationList(list,actor),
    });
  }
  bindConversationList(list,actor) {
    const lifecycle=this.conversationLifecycle;
    const read=(object,key)=>this.readNamed(object,key);
    const write=(object,key,value)=>this.writeNamed(object,key,value);
    return bindConversationsNative({list,actor,read,write,
      reference:object=>object,
      allocate:details=>{
        if(!this.conversationItemClass||typeof lifecycle?.nativeOuter!=='function')
          throw new Error('ConListItem requires linked class and native Outer');
        const outer=lifecycle.nativeOuter(details.outer);
        if(!outer)throw new Error('ConListItem Outer allocation is unbound');
        return this.allocateObject(this.conversationItemClass,
          {outer,name:details.name,flags:details.flags,template:null},lifecycle.construction);
      },
      construct:details=>{
        const object=this.instance(details.object).nativeObject;
        constructConversationItem(object,{write});
        object.destroy=receiver=>this.destroyObjectBase(receiver);
      },
      deleteObject:details=>{
        if(!lifecycle?.release)throw new Error('ConListItem release services are unbound');
        return releaseConversationItem(this.instance(details.object).nativeObject,details.flags,{
          ...lifecycle.release,conditionalDestroy:object=>this.conditionalDestroy(object.identity),warning:this.warning,
        });
      },
    });
  }
  soundField(actor,name) {
    if(name==='ObjectIndex'){
      const instance=this.instance(actor);
      // Prefer an explicitly registered/measured index; then the live
      // capture-backed provider for any pre-placed object (resolved once, then
      // cached on the instance); then a modeled spawn's registry slot; else the
      // original null. docs/boot-replay.md, docs/script-sound.md.
      if(Number.isInteger(instance.globalIndex))return instance.globalIndex;
      const captured=this.resolveOriginalObjectIndex(actor,instance);
      if(Number.isInteger(captured))return instance.globalIndex=captured;
      const object=instance.nativeObject;
      return object?object.index:null;
    }
    const reflected=name=>{
      try{return this.readNamed(actor,name);}
      catch(error){return undefined;}
    };
    // An ordinary reflected property (LightType on every actor in
    // AIGetLightLevel's scan) needs none of the level-graph cases below;
    // levelFor is a pure lookup, so skipping it changes no result.
    if(!SOUND_LEVEL_FIELDS.has(name)){
      const value=reflected(name);
      if(value===undefined)throw new Error(`Original sound field is not linked: ${name}`);
      return value;
    }
    // The host keeps the level graph in one container (levelFor); the original
    // splits it: XLevel is the ULevel (Actors/Model/DemoRecDriver), Level is the
    // LevelInfo actor (PawnList/NetMode). Map both faithfully onto the container
    // rather than the actor's own (unpopulated) native pointer fields.
    const level=this.levelFor(actor);
    if(name==='XLevel')return level??null;
    if(name==='Level')return level?.actors?.[0]??null;
    if(name==='Actors')return level?.actors??null;
    if(name==='PawnList')return level?.pawnList??null;
    // Pawn.nextPawn: the runtime pawn list is a JS property chain
    // (pawn-list.mjs addPawn/removePawn), not a native-graph field slot.
    if(name==='nextPawn')return actor.nextPawn??null;
    if(name==='NetMode')return level?.netMode??0;
    if(name==='TimeSeconds'){
      const value=level?.timeSeconds;
      if(value===undefined)throw new Error('Original noise field is not linked: TimeSeconds');
      return typeof value==='function'?value():value;
    }
    if(['DemoRecDriver','Model','Engine','Client','Viewports','ServerConnection','Actor'].includes(name)){
      // Native graph slots; the level container carries the established ones.
      const graph=reflected(name);
      if(graph!==undefined)return graph;
      if(name==='DemoRecDriver')return level?.demoRecDriver??null;
      if(name==='Model')return level?.model??null;
      if(name==='Engine')return level?.engine??null;
      // The level's engine container: UEngine::Client (+0x44),
      // UClient::Viewports and UPlayer::Actor (+0x30) as Play links them
      // (level.engine.client.viewports[i].actor).
      if(name==='Client'&&actor===level?.engine)return actor.client??null;
      if(name==='Viewports'&&actor===level?.engine?.client)return actor.viewports??null;
      if(name==='Actor'&&level?.engine?.client?.viewports?.includes(actor))return actor.actor??null;
      throw new Error(`Original sound native graph field is not bound: ${name}`);
    }
    const value=reflected(name);
    if(value===undefined)throw new Error(`Original sound field is not linked: ${name}`);
    return value;
  }
  /** UObject vtable +0x18 ProcessRemoteFunction for ProcessEvent's native
   * path: AActor's (0x103e5d90, process-remote-function.mjs) for actors, and
   * Core's UObject base (0x1013fa30) returns 0 for everything else. */
  processRemoteFunction(receiver,functionFlags) {
    let actor=false;
    try{for(let cls=this.instance(receiver).cls;cls;cls=cls.base)if(cls.record.key==='engine.actor'){actor=true;break;}}
    catch{return 0;}
    if(!actor)return 0;
    return actorProcessRemoteFunction(receiver,functionFlags>>>0,{read:(object,name)=>this.soundField(object,name)});
  }
  /** XLevel->Engine->Audio reads for the audio natives (execStopSound,
   * execClientHearSound): the level container's engine carries the host's
   * UAudioSubsystem facade (Play links Galaxy there), else null. */
  audioServices() {
    const services=this.soundServices(null);
    const read=services.read;
    services.read=(object,name)=>name==='Audio'?(object?.audio??null):read(object,name);
    return services;
  }
  /** Start the original's slot model (original-object-index.mjs) on the live
   * registry from a measured state: the objects created from now on take the
   * slot AddObject would give them (`originalIndex`), and the ones released
   * give it back. Called when the boot is over (the seed's count includes
   * everything the boot made) or by a harness with the original's own dump. */
  seedOriginalObjectIndex(seed) {
    const registry=this.actorLifecycle?.construction?.registry;
    if(!registry)throw new Error('The original object index model requires the live object registry');
    registry.original=new OriginalObjectIndexModel(seed);
    return registry.original;
  }
  /** The global index a sound's channel id is formed from, and where it came
   * from: `{index, source: 'measured'}` (the live capture: pre-placed actors,
   * the player), `{index, source: 'modeled'}` (the slot AddObject gives a
   * runtime spawn, continued from a measured registry state;
   * docs/object-index-captures.md "Runtime spawns"), `{index, source: 'restored'}`
   * (the model of an object of a restored or loaded level, 0x100000 + export
   * index: unverified), or null when the original index is not known: the sound
   * then stays the recorded boundary. */
  soundObjectIndex(receiver) {
    const measured=this.measuredObjectIndex(receiver);
    if(measured!==null)return {index:measured,source:'measured'};
    let instance;
    try{instance=this.instance(receiver);}catch{return null;}
    const modeled=instance.nativeObject?.originalIndex;
    if(Number.isInteger(modeled))return {index:modeled,source:'modeled'};
    // An object of a restored or loaded level has no measured slot: its registry index is modeled as 0x100000 + its export index
    // (script-doors.mjs, docs/travel.md "Unresolved" 10: labelled and unverified, the one model of a restored level).
    const restored=instance.nativeObject?.hashIndex;
    return Number.isInteger(restored)?{index:restored,source:'restored'}:null;
  }
  /** soundServices for execPlaySound: ObjectIndex is the measured or modeled
   * original index, never the host registry slot. */
  playSoundServices(call) {
    const services=this.soundServices(call),read=services.read;
    services.read=(actor,name)=>name==='ObjectIndex'?(this.soundObjectIndex(actor)?.index??null):read(actor,name);
    return services;
  }
  /** Pawn->XLevel->Engine->Audio with each pointer tested, the chain the
   * native Window.PlaySound body follows before its virtual call (Extension
   * 0x1005022a..0x10050249: pawn+0xac, level+0x40, engine+0x4c; a null at any
   * step skips the call). Unlike execStopSound's unchecked reads this returns
   * null for a missing link. docs/script-window-sound.md. */
  audioOf(actor) {
    const services=this.audioServices();
    const level=services.read(actor,'XLevel');
    if(level===null||level===undefined)return null;
    const engine=services.read(level,'Engine');
    if(engine===null||engine===undefined)return null;
    return services.read(engine,'Audio')??null;
  }
  /** The measured global UObject index of `receiver` (a map table, pawn table
   * or capture-provider value), or null. Unlike soundField('ObjectIndex') this
   * never falls back to the host registry slot of a runtime spawn, which is
   * not the original index (docs/boot-replay.md: the seeded spawn registry is
   * not wired into Play). */
  measuredObjectIndex(receiver) {
    let instance;
    try{instance=this.instance(receiver);}catch{return null;}
    if(Number.isInteger(instance.globalIndex))return instance.globalIndex;
    const captured=this.resolveOriginalObjectIndex(receiver,instance);
    return Number.isInteger(captured)?(instance.globalIndex=captured):null;
  }
  /** Native event dispatch ownership (docs/script-sound.md). Script events run
   * through ProcessEvent; native events without a script body reach the hook
   * boundary inside processEvent, and undeclared names fail explicitly. */
  processNativeEvent(receiver,name,args,resultReference=null) {
    const record=this.lookup(receiver,name);
    if(!record?.function)throw new Error(`Original native event is not implemented: ${name}`);
    return this.processEvent(receiver,name,args,resultReference);
  }
  /** ProcessEvent for native callbacks that take a declared return value
   * (e.g. EncroachingOn inside CheckEncroachment). The original passes a
   * caller result block; a result-carrying event writes into it, while a
   * probe-masked dispatch leaves the caller's zeroed slot untouched. */
  dispatchSpawnedEvent(actor,name,args=[]) {
    const record=this.lookup(actor,name);
    if(!record?.function)throw new Error(`Original event is not prepared: ${record?.key??name}`);
    const fn=record.function;
    if(fn.result){
      const cell={reference:{},value:zeroValue(fn.result),get(){return this.value},set(v){this.value=v}};
      this.processEvent(actor,name,args,cell);
      return cell.value;
    }
    this.processEvent(actor,name,args);
    return undefined;
  }
  /** UClassProperty::ImportText (Core 0x10167110): UObjectProperty::ImportText
   * (0x10166e20) with its metaclass check, for the text of a `class<...>`
   * console parameter. ReadToken(Buffer, 0x400 chars, DottedNames 1); the
   * token `None` stores None; spaces are skipped and ONE character is then
   * consumed whatever it is; a quote there starts `Class'Package.Object'`
   * (not linked: an explicit boundary), any other character leaves the token
   * to StaticFindObject(PropertyClass, ANY_PACKAGE, token, 0), whose miss
   * returns NULL. Back in UClassProperty::ImportText a found value that is not
   * a UClass or not IsChildOf(MetaClass, +0x64) is cleared to None while the
   * result stays non-NULL. Returns null for a NULL result, else the value and
   * the characters consumed. StaticFindObject finds the classes the original
   * holds (originalClass): a class Play linked only for its own readiness is
   * a miss, as it is in the original. */
  importClassText(rest,field,record) {
    const path=field.metadata.metaClass?.path;
    const metaKey=path?lower(path.includes('.')?path:`${record.key.split('.')[0]}.${path}`):null;
    // StaticFindObject(UClass, ANY_PACKAGE, token, 0).
    const find=token=>{
      const original=this.originalClass(token);
      if(original!==undefined)return original;
      // No class graph (a runtime built without native class loading): the linked classes, a class not linked an explicit boundary.
      const key=lower(token),dotted=key.includes('.');
      const matches=[...this.linkedClasses].filter(cls=>dotted?cls.record.key===key:cls.record.key.split('.').pop()===key);
      if(matches.length>1)throw new Error(`ScriptConsoleExec class name ${token} matches ${matches.length} linked classes (hash order is not recovered)`);
      if(!matches.length)throw new Error(`ScriptConsoleExec class ${token} is not a linked class in Play; StaticFindObject would search every loaded package`);
      return matches[0];
    };
    const result=importClassText(rest,{find,
      isClassChildOf:found=>{
        if(metaKey===null)return true;
        for(let cls=found;cls;cls=cls.base)if(cls.record.key===metaKey)return true;
        return false;
      },
      quoted:()=>{throw new Error(`ScriptConsoleExec Class'Package.Object' text is not recovered: ${field.key}`);}});
    return result===null?null:{value:result.value?result.value.record:null,consumed:result.consumed};
  }
  /** StaticFindObject(UClass, ANY_PACKAGE, token, 0) (Core 0x10151de0) over the classes the original holds (original-loaded.mjs
   * findClass): null for its miss, else the found class as Play linked it. Undefined without a class graph (a runtime built without
   * native class loading). A class the original holds that Play has not linked is an explicit boundary: linking is asynchronous and
   * the lookups that call this (console commands) are not. */
  originalClass(token) {
    const tracker=this.classLoader?.originalLoads;
    if(!tracker)return undefined;
    const record=tracker.findClass(token);
    if(record===null)return null;
    for(const cls of this.linkedClasses)if(cls.loadRecord===record)return cls;
    throw new UnmodelledClassLookup(`StaticFindObject(UClass, ANY_PACKAGE, ${token}) finds ${this.classLoader.graph.fullName(record)}, which the original holds and Play has not linked`);
  }
  /** UObject::ScriptConsoleExec (Core 0x10150860, thunk 0x10101870): run an
   * exec command line such as a User.ini binding's `ActivateBelt 3` on
   * `receiver`. Returns false when the command names no exec function, true
   * once it was consumed. docs/script-console-exec.md.
   *
   * GIsScriptable gates it. ParseToken(64, escapes) reads the name, an FName
   * find plus FindFunction (state first) selects it, and FUNC_Exec (0x200) is
   * required. The parameter block is zeroed. For each CPF_Parm (not
   * ReturnParm), ParseNext skips blanks and ';' comments, then the property's
   * ImportText parses in place. A NULL ImportText ends the parse: an
   * optional parameter still runs ProcessEvent with the zeros left; a
   * required one logs BadProperty and skips it. `executor` fills a first
   * object parameter of its own class. */
  scriptConsoleExec(receiver,command,executor=null) {
    if(!this.scriptability())return false;
    const text=String(command??'');
    // ParseToken 0x10147ba0 (MaxLen 64, escapes): at most 63 characters.
    const parsed=parseToken(text,64,true),token=parsed.token;
    let at=text.length-parsed.rest.length;
    if(!token||lower(token)==='none')return false;
    const record=this.lookup(receiver,token),fn=record?.function;
    if(!fn||!(fn.script.functionFlags&0x200))return false;
    const args=fn.parameters.map(field=>zeroValue(field));
    let failed=false;
    // 0x10150978-0x101509df: only the first parameter, when it IsA
    // UObjectProperty (Object or Class) whose PropertyClass (+0x5c) is null
    // or an ancestor of the executor's class, takes the executor; parsing
    // then continues with the next parameter.
    const executorTakes=field=>{
      if(!executor||(field.metadata.type!=='object'&&field.metadata.type!=='class'))return false;
      const path=field.metadata.propertyClass?.path;
      if(!path)return true;
      const target=lower(path.includes('.')?path:`${record.key.split('.')[0]}.${path}`);
      for(let cls=this.instance(executor).cls;cls;cls=cls.base)if(cls.record.key===target)return true;
      return false;
    };
    for(const [index,field] of fn.parameters.entries()){
      if(index===0&&executorTakes(field)){args[0]=executor;continue;}
      // ParseNext 0x10147b50.
      for(;;){
        while(' \t\r\n'.includes(text[at]??'\0')&&at<text.length)at++;
        if(text[at]!==';')break;
        while(at<text.length&&text[at]!=='\n'&&text[at]!=='\r')at++;
      }
      const rest=text.slice(at);
      let imported=true;
      if(field.metadata.type==='int'&&(field.metadata.arrayDim??1)<=1){
        // UIntProperty::ImportText 0x10165f00: appAtoi only when the text
        // starts with '-' or a digit, then skip every '-'/digit; never NULL.
        if(/^[-0-9]/.test(rest)){
          const number=/^[\t\n\v\f\r ]*([+-]?\d+)/.exec(rest);
          const value=number?Number(number[1]):0;
          if(!Number.isInteger(value)||value< -0x80000000||value>0x7fffffff)
            throw new Error('ScriptConsoleExec int overflow is not recovered');
          args[index]=value;
        }
        while(text[at]==='-'||/[0-9]/.test(text[at]??''))at++;
      }else if(field.metadata.type==='float'&&(field.metadata.arrayDim??1)<=1){
        // UFloatProperty::ImportText 0x10166940 (config-text.mjs): appAtof,
        // then skip to ',' ')' CR LF; never NULL, so an omitted optional
        // float (the console's bare "AltFire") imports 0.
        const parsed=importText('float',rest);
        args[index]=parsed.value;at=text.length-parsed.rest.length;
      }else if(field.metadata.type==='bool'&&(field.metadata.arrayDim??1)<=1){
        // UBoolProperty::ImportText 0x10166380 (config-text.mjs): it never
        // reads PortFlags, so the console's port flags 1 take the same fixed
        // spellings ("1"/"True" set, "0"/"False" clear); anything else is NULL.
        const parsed=importText('bool',rest);
        if(parsed){args[index]=parsed.value;at=text.length-parsed.rest.length;}
        else imported=false;
      }else if(field.metadata.type==='name'&&(field.metadata.arrayDim??1)<=1){
        // UNameProperty::ImportText 0x101674d0 (config-text.mjs 'name', the same body `set` uses): ReadToken(0x400) then
        // FName(FNAME_Add); an empty token is None, and a NULL ReadToken ends the parse. (`GiveNanoKey TestKeyA "Test key A"`:
        // the Name takes the first token, the String the whole remaining text, quotes included, as the measured travel text shows.)
        const parsed=importText('name',rest);
        if(parsed){args[index]=lower(parsed.value)==='none'?'None':parsed.value;at=text.length-parsed.rest.length;}
        else imported=false;
      }else if(field.metadata.type==='string'&&(field.metadata.arrayDim??1)<=1){
        // UStrProperty::ImportText 0x10167980: port flags 1 lack
        // PPF_Delimited (2), so the FString takes the whole remaining text
        // (to a NUL) and the buffer comes back unchanged; never NULL.
        const end=rest.indexOf('\0');
        args[index]=end<0?rest:rest.slice(0,end);
      }else if(field.metadata.type==='object'&&rest===''){
        // UObjectProperty::ImportText 0x10166e20: ReadToken yields an empty
        // token, which is not "None", and StaticFindObject finds nothing, so
        // the value is None and ImportText returns NULL.
        args[index]=null;imported=false;
      }else if(field.metadata.type==='class'&&(field.metadata.arrayDim??1)<=1){
        // UClassProperty::ImportText 0x10167110 = UObjectProperty::ImportText
        // 0x10166e20, then the metaclass check (docs/script-console-exec.md).
        const parsed=this.importClassText(rest,field,record);
        if(parsed===null){args[index]=null;imported=false;}
        else{
          args[index]=parsed.value;at=Math.min(text.length,text.length-rest.length+parsed.consumed);
          // The original's returned pointer can lie one wide char past the
          // terminator; a parameter that follows would parse memory beyond the
          // string, which has no source here.
          if(text.length-rest.length+parsed.consumed>text.length&&index+1<fn.parameters.length)
            throw new Error(`ScriptConsoleExec parameter after an object parameter that ends the text is not recovered: ${field.key}`);
        }
      }else throw new Error(`ScriptConsoleExec ImportText is not linked for ${field.metadata.type} ${field.key}`);
      if(!imported){
        if(!field.metadata.optional){failed=true;this.warning?.({type:'ScriptConsoleExec',kind:'BadProperty',function:record.key,parameter:field.key});}
        break;
      }
    }
    if(!failed){
      const cell=fn.result?{reference:{},value:zeroValue(fn.result),get(){return this.value},set(v){this.value=v}}:null;
      this.processEvent(receiver,token,args,cell,record);
    }
    return true;
  }
  /** UObject::SaveConfig (Core 0x10151540) on a live object, then the
   * defaults reload it ends with: LoadConfig(1) on the class default object of
   * every loaded class under the topmost CLASS_Config ancestor
   * (docs/script-config.md). Instances keep their own values. */
  saveObjectConfig(receiver) {
    const graph=this.classLoader?.graph,config=graph?.config;
    if(!config)throw new Error('SaveConfig requires GConfig (the native class loader and installed .ini files)');
    const cls=this.instance(receiver).cls,record=cls.loadRecord;
    if(!record)throw new Error(`SaveConfig requires the native class record: ${cls.record.key}`);
    saveConfig(graph,config,{cls:record,index:0,
      read:(property,index)=>{
        const value=this.fieldReference(receiver,this.classLoader.identity(property)).get();
        return graph.slotOf(property,0x34)>1?value[index]:value;
      }});
    const root=configRoot(graph,record);
    for(const loaded of this.linkedClasses){
      let child=false;
      for(let c=loaded.loadRecord;c;c=graph.superOf(c))if(c===root){child=true;break;}
      if(!child||!loaded.loadRecord?.defaults?.data)continue;
      loadObjectConfig(graph,config,defaultsObject(graph,loaded.loadRecord,loaded.loadRecord.defaults.data),{propagate:1});
      this.classLoader.refreshConfigDefaults(loaded);
      classDefaultsChanged();
    }
    return undefined;
  }
  /** Window's native wrapper preserves the UFunction selected by its original
   * checked/state-aware lookup. Only a null native parameter block (InitWindow)
   * is bridged here; arbitrary raw event blocks require their own typed layout. */
  processWindowScript(request) {
    return processWindowScript(request,{
      isScriptable:()=>this.scriptability(),
      findFunction:({object,event,global})=>this.lookup(object,event,global)??null,
      processEvent:({object,record,parameters})=>{
        if(parameters!==null)throw new Error('Window.ProcessScript raw parameter blocks are unbound');
        return this.processEvent(object,record.name,[],null,record);
      },
    });
  }
  /** GIsScriptable is shared by checked lookup and ProcessEvent. Each native
   * read is fresh; unchecked function lookup does not bypass the event gate. */
  scriptability() {
    const enabled=typeof this.windowLifecycle?.isScriptable==='function'
      ?this.windowLifecycle.isScriptable():this.eventsEnabled;
    if(typeof enabled!=='boolean')throw new Error('GIsScriptable requires a synchronous boolean value');
    return enabled;
  }
  setOwner(receiver,owner) {
    return setScriptOwner(receiver,owner,{
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
      processEvent:(actor,name,args)=>this.processEvent(actor,name,args),
    });
  }
  regionValue(receiver,name='Region') {
    const ref=name==='Region'?this.fieldReference(receiver,this.lookupMember(this.actorClass,'fields','Region'))
      :this.namedReference(receiver,name);
    const value=ref.get();
    return {zone:value['engine.actor.pointregion.zone'],leaf:value['engine.actor.pointregion.ileaf'],
      zoneNumber:value['engine.actor.pointregion.zonenumber']};
  }
  setRegion(receiver,zone,leaf,zoneNumber,name='Region') {
    const ref=name==='Region'?this.fieldReference(receiver,this.lookupMember(this.actorClass,'fields','Region'))
      :this.namedReference(receiver,name);
    ref.set({'engine.actor.pointregion.zone':zone,
      'engine.actor.pointregion.ileaf':leaf,'engine.actor.pointregion.zonenumber':zoneNumber});
  }
  /** Bridge the recovered Actor/APawn SetActorZone body to script fields.
   * APawn adds the foot cylinder-bottom query, EyeHeight head query, and
   * PlayerReplicationInfo.PlayerZone store (Engine 0x1039b940). */
  setSpawnActorZone(receiver,test,force) {
    const level=this.levelFor(receiver);
    if(typeof level?.pointRegion!=='function')throw new Error('SpawnActor requires the original BSP PointRegion service');
    // The common case in Rust (zone-kernel.mjs), before any store.
    if(this.scriptVm?.zone?.update(receiver,level,test,force))return;
    let isPawn=false;
    for(let cls=this.instance(receiver).cls;cls;cls=cls.base)
      if(cls.record.key==='engine.pawn'){isPawn=true;break;}
    const actor={isPawn};
    Object.defineProperties(actor,{
      deleted:{get:()=>this.readNamed(receiver,'bDeleteMe')},
      position:{get:()=>this.readNamed(receiver,'Location')},
      region:{get:()=>this.regionValue(receiver),set:value=>this.setRegion(receiver,value.zone,value.leaf,value.zoneNumber)},
    });
    if(isPawn){
      for(const [prop,name] of [['footRegion','FootRegion'],['headRegion','HeadRegion']])
        Object.defineProperty(actor,prop,{get:()=>this.regionValue(receiver,name),
          set:value=>this.setRegion(receiver,value.zone,value.leaf,value.zoneNumber,name)});
      Object.defineProperties(actor,{
        height:{get:()=>this.readNamed(receiver,'CollisionHeight')},
        eyeHeight:{get:()=>this.readNamed(receiver,'EyeHeight')},
        playerReplicationInfo:{get:()=>{
          const info=this.readNamed(receiver,'PlayerReplicationInfo');
          if(!info)return null;
          const field=this.namedReference(info,'PlayerZone');
          return {get playerZone(){return field.get();},set playerZone(value){field.set(value);}};
        }},
      });
    }
    setActorZone(actor,{levelInfo:level.actors[0],netMode:level.netMode??0,pointRegion:position=>level.pointRegion(position),
      actorLeaving:zone=>this.processEvent(zone,'ActorLeaving',[receiver]),
      zoneChange:(_,zone)=>this.processEvent(receiver,'ZoneChange',[zone]),
      actorEntered:zone=>this.processEvent(zone,'ActorEntered',[receiver]),
      footZoneChange:(_,zone)=>this.processEvent(receiver,'FootZoneChange',[zone]),
      headZoneChange:(_,zone)=>this.processEvent(receiver,'HeadZoneChange',[zone]),
    },test,force);
  }
  /** APlayerPawnExt 0x10037cc0..0x10037cf7: preserve the template's FlagBase,
   * or allocate Extension.FlagBase with Outer=this and run XFlagBase's
   * constructor. The existing FlagBase service supplies its recovered native
   * fields/methods on the actual registered UObject identity. */
  constructPlayerFlagBase(object,contract) {
    const ref=this.namedReference(object.identity,'FlagBase');
    if(ref.get())return;
    const cls=[...this.linkedClasses].find(cls=>cls.record.key==='extension.flagbase');
    if(!cls)throw new Error('PlayerPawnExt constructor requires linked Extension.FlagBase');
    const base=this.actorLifecycle?.construction;
    const identity=this.constructObject(cls,{outer:object,name:'None',flags:0,template:null},{
      ...base,
      validate:args=>args.cls===cls&&args.outer===object&&args.template===null&&args.flags===0&&args.name==='None',
      initNativeProperties:()=>{},
      nativeConstructor:flag=>{
        flag.nativeVtable=contract.vtable;
        // XFlagBase overrides Destroy (Extension 0x100239f0).
        flag.destroy=receiver=>destroyFlagBaseNative(receiver,{destroyObjectBase:target=>this.destroyObjectBase(target)});
        Object.defineProperties(flag.identity,Object.getOwnPropertyDescriptors(
          createFlagBase({defaultExpiration:contract.defaultExpiration,slots:{
            take:(holder,cls,name)=>this.actorLifecycle?.construction?.registry?.original?.take(holder,cls,name),
            giveBack:holder=>this.actorLifecycle?.construction?.registry?.original?.giveBack(holder)}})));
      },
    });
    ref.set(identity);
  }
  /** The shared collision/dispatch service table for a spawned collision-view
   * actor's recovered ULevel move/relocation entries. The hash's `$world`
   * sentinel is the hit identity; the script-visible Level actor it maps to
   * for event dispatch is actors[0] (same mapping as SpawnActor's). */
  spawnedMoveServices(view,level) {
    const levelActor=target=>target===level?.hash?.levelInfo?level.actors[0]:target;
    const dispatch=(a,name,args)=>this.dispatchSpawnedEvent(levelActor(a),name,args);
    return {
      worldActor:level.hash.levelInfo,
      multiLineCheck:query=>level.hash.multiLineCheck(query),
      removeActor:actor=>level.hash.removeActor(actor),
      addActor:actor=>level.hash.addActor(actor),
      dispatch,
      isBlockedBy:(source,other)=>actorBlockedBy(source,other,{worldActor:level.hash.levelInfo}),
      isOverlapping:(a,b)=>isOverlapping(a,b),
      beginTouch:(a,b)=>beginTouch(a,b,dispatch),
      endTouch:(a,b,suppress)=>endTouch(a,b,suppress,dispatch),
      setActorZone:(a,test,force)=>this.setSpawnActorZone(a,test,force),
      checkEncroachment:(a,position,rotation,notify)=>checkActorEncroachment(a,position,rotation,notify,{
        worldActor:level.hash.levelInfo,
        encroachmentCheck:(s,p,r,e)=>level.hash.actorEncroachmentCheck(s,p,r,e),
        dispatch}),
      // 0x103998a0-0x10399bb0: a spawned actor carrying riders recurses into
      // the same recovered MoveActor entry for each based child.
      moveRiders:(src,finalDelta,rot)=>moveActorRiders(src,finalDelta,rot,{
        riderCacheKey:'spawned-move',
        actors:level.actors,
        baseOf:other=>{const base=other.base;return base!==undefined?base:this.readNamed(other,'Base');},
        location:other=>other.position??this.readNamed(other,'Location'),
        rotation:other=>other.rotation??this.readNamed(other,'Rotation'),
        isPawn:other=>Boolean(other.lineage?.includes('engine.pawn')),
        addViewRotationYaw:(other,dyaw)=>{
          const ref=this.namedReference(other,'ViewRotation');
          const value=ref.get();
          ref.set([value[0],(value[1]+dyaw)|0,value[2]]);
        },
        moveActor:(other,riderDelta,riderRot)=>this.moveSpawnedActor(other,riderDelta,riderRot),
        actorLocation:()=>src.position,
        actorRotation:()=>src.rotation,
      }),
    };
  }
  /** ULevel::MoveActor for a spawned collision-view actor — the recursive
   * rider entry the based-rider section calls (test=0, ignorePawns=0,
   * ignoreBases=1, noFail=0). A map actor takes the same body on its own
   * native surface (moveMapRider). */
  moveSpawnedActor(view,delta,rotation) {
    if(!this.collisionViewActors.has(view))
      return this.moveMapRider(view,delta,rotation);
    const level=this.levelFor(view);
    if(!level?.hash)throw new Error('Spawned MoveActor requires the level collision hash');
    const completed=this.scriptVm?.moveActor?.rider(view,level,delta,rotation);
    if(completed!==undefined)return completed;
    // The only caller is the recovered based-rider MoveActor (vtable +0x88)
    // which passes bIgnoreBases=1 — a riding item must not be blocked by the
    // base carrying it.
    return playerMove(view,delta,{...this.spawnedMoveServices(view,level),ignoreBases:true},rotation);
  }
  /** Admit a serialized map actor to the recovered ULevel move entries. The
   * level-load host is the native actor (map-actor-native.mjs): its +0x1dc
   * word, cylinder, rotation, Base, StandingCount and Touching are the
   * members the bodies read, and script fields are bound onto them. Before a
   * move its hash cylinder is made to follow Location. Pawns, brushes and
   * map exports without a collision surface keep the explicit boundary. */
  mapMoveLevel(actor,what) {
    if(!isMapMoveHost(actor))throw new Error(`${what} for a pawn, brush or non-colliding map actor is not linked (${actor?.name??'an actor'})`);
    const level=this.levelFor(actor);
    if(!level?.hash)throw new Error(`Map actor ${what} requires the level collision hash`);
    linkLiveCollision(level.hash,actor);
    // moveQuery's source-type gate: the query keys on the source's +0x1dc bits
    // and each candidate's type, not on the source class (docs/move-query.md).
    actor.mapActor=true;
    return level;
  }
  /** The recursive based-rider MoveActor (0x103998a0-0x10399c8e: test=0,
   * ignorePawns=0, ignoreBases=1, noFail=0) for a map actor riding a moving
   * base: a picked-up item on JC after DoFrob's SetBase, or a carried
   * decoration after PutCarriedDecorationInHand. The same recovered body as a
   * spawned rider: a rider without collision skips the MultiLineCheck and the
   * hash, and the non-pawn CheckEncroachment early-returns for +0x1dc & 0x0d
   * == 0. docs/script-map-actor-move.md. */
  moveMapRider(actor,delta,rotation) {
    const level=this.mapMoveLevel(actor,'Rider MoveActor');
    return playerMove(actor,delta,{...this.spawnedMoveServices(actor,level),ignoreBases:true},rotation);
  }
  /** SetRotation's zero-Delta, zero-flag MoveActor on a map decoration.
   * Unlike the recursive rider entry above, the top-level call must retain
   * ignoreBases=0. The based-actor and encroachment passes precede commit.
   * Original stacked-crate reference: docs/script-map-actor-move.md. */
  rotateMapActor(actor,rotation) {
    const level=this.mapMoveLevel(actor,'SetRotation MoveActor');
    return playerMove(actor,[0,0,0],this.spawnedMoveServices(actor,level),rotation);
  }
  /** The level view the recovered FarMoveActor (relocation.mjs) takes: this
   * host's hash, FindSpot, CheckEncroachment, SetBase and SetActorZone. */
  relocationLevel(view,level) {
    const move=this.spawnedMoveServices(view,level);
    const adapter=Object.create(level);
    // Play's level exposes these as accessors; shadow them with own properties.
    for(const [key,value] of [['hash',level.hash],['editor',level.editor],['netMode',level.netMode??0],['actors',level.actors]])
      Object.defineProperty(adapter,key,{value,enumerable:true,writable:true});
    adapter.findSpot=(extent,position,checkActors,checkFirst)=>
      level.findSpot(extent,position,checkActors,checkFirst);
    adapter.checkEncroachment=move.checkEncroachment;
    adapter.setBase=(child,target,notify)=>setBase(child,target,move.dispatch,notify);
    adapter.setActorZone=(a,t,force)=>this.setSpawnActorZone(a,t,force);
    return adapter;
  }
  /** ULevel::FarMoveActor (0x10398ba0) for a spawned collision-view actor —
   * the recovered relocation (hash remove, FindSpot/encroachment gates,
   * based-child detach through SetBase, Location/OldLocation write,
   * SetActorZone) with the level's services bound for this host. */
  relocateSpawnedActor(view,destination,test,noCheck) {
    if(!this.collisionViewActors.has(view))
      throw new Error('FarMoveActor for a non-spawned actor is not linked');
    const level=this.levelFor(view);
    if(!level?.hash)throw new Error('Spawned FarMoveActor requires the level collision hash');
    return farMoveActor(this.relocationLevel(view,level),view,destination,test,noCheck);
  }
  /** FarMoveActor on a spawned non-Pawn view in the Rust core (render.rs
   * far_move) where the recovered body would run no callback and no query;
   * true when it moved the actor. FAR_MOVE=js keeps the JavaScript body;
   * FAR_MOVE=verify also runs that body from the same state and compares
   * the result and every field it writes. */
  noncollidingFarMove(actor,destination,noCheck) {
    const vm=this.scriptVm,mode=farMoveMode();
    if(!vm?.render||!vm.zone?.enabled||mode==='js'||!Array.isArray(destination)||destination.length!==3)return false;
    const level=this.levelFor(actor);
    if(!level?.hash||!level.zoneModel)return false;
    const model=vm.zone.model(level);
    if(!model)return false;
    const names=['Location','OldLocation','bJustTeleported','Region'];
    const state=()=>names.map(name=>this.readNamed(actor,name));
    const before=mode==='verify'?state():null;
    if(!vm.render.farMove(actor,destination,noCheck,model))return false;
    if(mode==='verify'){
      const rust=state();
      names.forEach((name,i)=>this.writeNamed(actor,name,before[i]));
      const moved=this.relocateSpawnedActor(actor,destination,0,noCheck),js=state();
      const same=(a,b)=>a===b||typeof a==='object'&&a!==null&&b!==null&&Object.keys(a).length===Object.keys(b).length&&
        Object.keys(a).every(key=>Object.is(a[key],b[key]));
      if(moved!==true||!names.every((_,i)=>same(rust[i],js[i])))
        throw new Error(`FAR_MOVE=verify: ${actor.name} FarMoveActor differs: Rust ${JSON.stringify(rust)}, JavaScript ${moved} ${JSON.stringify(js)}`);
    }
    return true;
  }
  /** The same FarMoveActor for a map actor: SetLocation on a decoration JC
   * lifts, drops or throws (DeusExPlayer.PutCarriedDecorationInHand /
   * DropDecoration), and the Actor.Tick pawn tail's FarMoveActor(Weapon,
   * Location, 0, 0) on a drawn map weapon. */
  relocateMapActor(actor,destination,test,noCheck) {
    const level=this.mapMoveLevel(actor,'FarMoveActor');
    return farMoveActor(this.relocationLevel(actor,level),actor,destination,test,noCheck);
  }
  /** XLevel vtable +0x88 MoveActor (zero flags) for a map pawn, on the
   * recovered pawn move body; returns the native success word. */
  movePawn(actor,delta,rotation,{ignoreBases=false}={}) {
    if(!this.isMapPawn(actor))throw new Error('Map pawn MoveActor requires a serialized map pawn');
    return (actor._pawnPhysics??pawnPhysicsView(actor,this.pawnPhysicsServices(actor))).moveActor(delta,rotation,ignoreBases);
  }
  /** AActor::moveSmooth (0x103c9020, move-smooth.mjs) for a map pawn a moving
   * brush pushes in CheckEncroachment, over the pawn's recovered MoveActor. */
  moveSmoothPawn(actor,delta) {
    if(!this.isMapPawn(actor))throw new Error('Map pawn moveSmooth requires a serialized map pawn');
    const view=actor._pawnPhysics??pawnPhysicsView(actor,this.pawnPhysicsServices(actor));
    return moveSmoothPawn(view,delta);
  }
  /** AActor::moveSmooth (0x103c9020, move-smooth.mjs) for a non-Pawn actor a
   * moving brush pushes in CheckEncroachment (0x1039a577 and 0x1039a75d call it
   * on every blocking non-Brush hit, with no Pawn test): a decoration, carcass,
   * pickup or fragment, serialized or spawned. Its MoveActor is the recovered
   * body those classes already run, on the same hash, touch, zone and
   * CheckEncroachment services (docs/mover-push.md). */
  moveSmoothActor(actor,delta) {
    if(this.isMapPawn(actor))throw new Error('Pawn moveSmooth uses moveSmoothPawn');
    let level;
    if(this.collisionViewActors.has(actor)){
      level=this.levelFor(actor);
      if(!level?.hash)throw new Error('Spawned moveSmooth requires the level collision hash');
    }else level=this.mapMoveLevel(actor,'moveSmooth');
    return moveSmoothActor(actor,delta,this.spawnedMoveServices(actor,level));
  }
  /** A serialized map export in the Pawn class chain, other than the
   * controlled player (the player scene owns its moves). */
  isMapPawn(actor) {
    if(!actor||actor.controlledPlayer||this.collisionViewActors.has(actor))return false;
    try{for(let cls=this.instance(actor).cls;cls;cls=cls.base)if(cls.record.key==='engine.pawn')return true;}catch{return false;}
    return false;
  }
  /** XLevel vtable +0x8c FarMoveActor for any admitted actor. A map pawn
   * (ScriptedPawn.PutInWorld's SetLocation, the pawn-nav fit tests) runs the
   * same recovered relocation through its pawn physics view, whose hash,
   * encroachment, SetBase and SetActorZone services act on the pawn itself. */
  farMoveActor(actor,destination,test=0,noCheck=0) {
    if(this.collisionViewActors.has(actor)){
      if(test===0&&!actor.pawn&&!actor.movingBrush&&this.noncollidingFarMove(actor,destination,noCheck))return true;
      return this.relocateSpawnedActor(actor,destination,test,noCheck);
    }
    if(this.isMapPawn(actor))
      return (actor._pawnPhysics??pawnPhysicsView(actor,this.pawnPhysicsServices(actor))).farMove(destination,test,noCheck);
    if(actor?.movingBrush)return this.relocateMover(actor,destination,test,noCheck);
    return this.relocateMapActor(actor,destination,test,noCheck);
  }
  /** FarMoveActor for a map mover (DeusExMover.BlowItUp's SetLocation): the
   * recovered relocation over a field view of the mover, whose OldLocation
   * and bJustTeleported are script fields, with the brush CheckEncroachment
   * (notify 1) and the hash and zone services acting on the mover itself
   * (docs/relocation.md, check-encroachment.mjs). */
  relocateMover(mover,destination,test,noCheck) {
    const level=this.levelFor(mover);
    if(!level?.hash||typeof level.checkMoverEncroachment!=='function')
      throw new Error('Mover FarMoveActor requires the scene level');
    const read=name=>this.readNamed(mover,name),write=(name,value)=>this.writeNamed(mover,name,value);
    const view={self:mover,
      get actorFlags(){return mover.actorFlags;},get flags(){return mover.flags;},
      get radius(){return mover.radius;},get height(){return mover.height;},
      get rotation(){return mover.rotation;},get standingCount(){return mover.standingCount;},
      get position(){return mover.position;},set position(value){mover.position=value;},
      get oldLocation(){return read('OldLocation');},set oldLocation(value){write('OldLocation',value);},
      // FarMoveActor only ORs in bJustTeleported (+0x1ec bit 0x100).
      get motionFlags(){return read('bJustTeleported')?0x100:0;},
      set motionFlags(value){write('bJustTeleported',Boolean(value&0x100));}};
    const adapter=Object.create(level);
    const hash=Object.create(level.hash);
    hash.removeActor=a=>level.hash.removeActor(a===view?mover:a);
    hash.addActor=a=>level.hash.addActor(a===view?mover:a);
    for(const [key,value] of [['hash',hash],['editor',level.editor],['netMode',level.netMode??0],['actors',level.actors]])
      Object.defineProperty(adapter,key,{value,enumerable:true,writable:true});
    adapter.checkEncroachment=(_actor,position,rotation,notify)=>level.checkMoverEncroachment(mover,position,rotation,notify);
    adapter.setActorZone=(_actor,test,force)=>level.setActorZone(mover,test,force);
    const moved=farMoveActor(adapter,view,destination,test,noCheck);
    // The renderer and the host collider follow the mover's offset from its
    // authored Location, as after its MoveActor.
    if(mover.collider&&mover.values?.Location)
      mover.collider.offset=mover.position.map((value,axis)=>Math.fround(value-mover.values.Location[axis]));
    return moved;
  }
  /** ULevel::SpawnActor for any linked Actor class (script-spawn.mjs). The
   * lifecycle host supplies only world bindings — the live level, its Outer
   * and construction registry — never a per-class route. */
  spawnActor(args) {
    const cls=args.cls?.linkedClass;
    if(!cls)throw new Error('Spawn class is not linked');
    const lifecycle=this.actorLifecycle;
    const level=args.level;
    // BSP world hits arrive as the collision query's $world sentinel; the
    // script-visible Level actor is the attached LevelInfo at actors[0], the
    // identity the original dispatch would target (Actor.SupportActor runs
    // on LevelInfo). Map it before the script-event dispatch.
    const levelActor=target=>target===level?.hash?.levelInfo?level.actors[0]:target;
    const services={
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
      defaultRead:(cls,name)=>this.defaultValue(cls,this.lookupMember(cls,'fields',name)),
      isActorClass:cls=>{for(;cls;cls=cls.base)if(cls===this.actorClass)return true;return false;},
      validate:input=>lifecycle?.validateSpawn?.(input),
      // Class+0x4e0: the ClassConstructor UClass::Bind stored. Classes
      // loaded through the shared graph carry it on their load record; a
      // standalone world binds its own registry through the lifecycle.
      classConstructor:cls=>typeof lifecycle?.classConstructor==='function'
        ?lifecycle.classConstructor(cls):cls?.loadRecord?.nativeConstructor,
      isChildOf:(child,classRef)=>{
        const record=classRef?.linkedClass?.record??classRef?.record??classRef;
        for(let entry=child;entry;entry=entry.base)if(entry.record===record)return true;
        return false;
      },
      construct:(cls,options,context)=>{
        const identity=this.constructObject(cls,options,
          {...lifecycle.construction,nativeConstructor:nativeConstructorFor(context.constructorSelection,{
            constructFlagBase:(object,contract)=>this.constructPlayerFlagBase(object,contract)})});
        // Every SpawnActor product is an actor: ConditionalDestroy reaches its
        // vtable's Destroy slot. That is AActor::Destroy -> UObject::Destroy,
        // as on map exports, except for the player chain's own overrides
        // (script-player-destroy.mjs).
        const object=this.instance(identity).nativeObject;
        if(object)object.destroy=this.actorDestroyHook(object);
        return identity;
      },
      setRegion:(...values)=>this.setRegion(...values),
      setNativeLevel:(actor,level)=>{this.instance(actor).nativeObject.xLevel=level;},
      setOwner:(actor,owner)=>this.setOwner(actor,owner),
      initExecution:actor=>{
        const state=this.initExecution(actor),level=this.levelFor(actor);
        if(!state||!level?.actors||level.actors[0]!==this.readNamed(actor,'Level'))
          this.warning?.({type:'ActorInitExecution',actor});
      },
      processEvent:(actor,name,eventArgs)=>this.processEvent(actor,name,eventArgs),
      setActorZone:(actor,test,force)=>this.setSpawnActorZone(actor,test,force),
      // Every spawned actor carries the native collision view: the
      // hash gate, CheckEncroachment, FindBase and later natives read the
      // +0x1dc bitfield through it. It reads and writes the object's own
      // field storage, so natives dispatched later see the same state.
      installCollisionView:actor=>{
        const lineage=[];
        for(let entry=cls;entry;entry=entry.base)lineage.push(entry.record.key);
        if(lifecycle.bindCollisionView?.(actor,cls,lineage)){
          this.collisionViewActors.add(actor);
          return actor;
        }
        installActorCollisionView(actor,{
          read:(a,name)=>this.readNamed(a,name),
          write:(a,name,value)=>this.writeNamed(a,name,value),
          bind:(a,name)=>this.boundField(a,name),
          worldActor:level.actors[0],lineage,motionWord:imagedMotionWord(this.instance(actor))});
        this.collisionViewActors.add(actor);
        return actor;
      },
      checkEncroachment:(actor,position,rotation,notify)=>checkActorEncroachment(actor,position,rotation,notify,{
        encroachmentCheck:(a,p,r,e)=>level.hash.actorEncroachmentCheck(a,p,r,e),
        dispatch:(a,name,args)=>this.dispatchSpawnedEvent(levelActor(a),name,args)}),
      findBase:actor=>findActorBase(actor,{
        lineCheck:(...lineArgs)=>level.hash.lineCheck(...lineArgs),
        dispatch:(a,name,args)=>this.dispatchSpawnedEvent(levelActor(a),name,args)}),
      destroyActor:actor=>this.destroyActor(actor,false),
      warning:this.warning,
    };
    return spawnActor({...args,cls},services);
  }
  destroyActor(receiver,netForce=false) {
    if(!this.actorLifecycle)throw new Error('Actor.Destroy requires linked world lifecycle services');
    return destroyScriptActor(receiver,{
      ...this.actorLifecycle,
      levelFor:this.actorLifecycle.levelFor??this.levelFor,
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
      processEvent:(actor,name,args)=>this.processEvent(actor,name,args),
      isProbing:(actor,name)=>this.isProbing(actor,name),
      // ULevel::DestroyActor detaches the target's Base and every based child
      // through the same recovered AActor::SetBase the execSetBase native
      // dispatch above routes; worldActor (LevelInfo) maps to level.actors[0]
      // identically.
      setBase:(actor,target,notify)=>{
        const level=this.levelFor(actor);
        const dispatch=(a,name,args)=>this.dispatchSpawnedEvent(
          a===level?.hash?.levelInfo?level.actors[0]:a,name,args);
        return setBase(actor,target,dispatch,notify);
      },
      setOwner:(actor,owner)=>this.setOwner(actor,owner),
      conditionalDestroy:actor=>this.conditionalDestroy(actor),
    },netForce);
  }
  /** UStruct.CleanupDestroyed for one object (script-cleanup.mjs). In play,
   * an object whose visited fields are all image cells has its pointers read
   * from the image, with each target's IsValid/IsPendingKill answered once
   * per `verdicts` (one level pass; a fresh map when absent); otherwise, and
   * in the editor, the reference traversal runs. */
  cleanupReferences(receiver,{editor=false,verdicts=null}={}) {
    const services=this.actorLifecycle?.references;
    if(!services)throw new Error('CleanupDestroyed requires native reference validity and pending-kill services');
    const instance=this.instance(receiver),reference=field=>this.fieldReference(receiver,field);
    const plan=editor?null:cleanupPlan(instance);
    if(plan)return cleanupImageSites(plan.sites,plan.offsets,instance.arena.view,instance.base,
      instance.bindings.size?instance.bindings:null,reference,services,verdicts??new Map());
    return cleanupScriptReferences(instance.cls.propertyLink,reference,services,{editor});
  }
  /** Reflected reference traversal only. A native class Serialize override
   * must separately route its UObject header, native members and base hook. */
  serializeReferences(receiver,archive,options={}) {
    // A native Serialize that is not the reflective one (XGameDirectory::Serialize 0x100171c0 writes only its directory list: no object reference)
    const native=this.instance(receiver).nativeObject?.serializeReferences;
    if(typeof native==='function')return native(archive,options);
    return serializeScriptReferences(this.instance(receiver).cls.propertyLink,
      descriptor=>this.fieldReference(receiver,descriptor.field),archive,options);
  }
  serializeActorGc(receiver,archive,options={}) {
    return serializeRuntimeActor(this,receiver,archive,options);
  }
  serializeDefaultReferences(cls,archive,options={}) {
    return serializeScriptReferences(cls.propertyLink,
      descriptor=>this.classDefaultReference(cls,descriptor.field),archive,options);
  }
  cleanupDestroyed(level,force=false) {
    const lifecycle=this.actorLifecycle;
    if(!lifecycle)throw new Error('CleanupDestroyed requires linked native lifecycle services');
    // The pass's IsValid/IsPendingKill answers per referenced object.
    let verdicts=null;
    return cleanupLevelDestroyed(level,{
      read:(actor,name)=>this.readNamed(actor,name),
      cleanupReferences:(actor,options)=>this.cleanupReferences(actor,{...options,verdicts:verdicts??=new Map()}),
      release:(actor,flags)=>{
        if(typeof lifecycle.release==='function')lifecycle.release(actor,flags);
        else this.releaseObject(actor,flags);
      },
      destroyActorEvents:(manager,actor)=>{
        const aiEvents=this.scriptVm?.aiEvents;
        if(aiEvents?.active)aiEvents.destroyActor(actor);
        else lifecycle.destroyActorEvents?.(manager,actor);
      },
      eventManager:levelInfo=>this.scriptVm?.aiEvents?.active&&this.scriptVm.aiEvents.levelInfo===levelInfo?true:null,
      recordArrayRemoval:lifecycle.recordArrayRemoval,
      warning:this.warning,
      settled:this.scriptVm?.render?(actors,start)=>this.scriptVm.render.compactSettled(actors,start):null,
    },force);
  }
  bindProperty(receiver,field,binding) {
    if(!field.metadata)throw new Error(`Property is not prepared: ${field.key}`);
    if(typeof binding.get!=='function'||typeof binding.set!=='function')throw new Error('Native property binding requires getter and setter');
    const instance=this.instance(receiver);
    // A binding makes the receiver BOUND for the Rust core: the perception
    // natives' Level.Actors list (script-vm-perception.mjs) is rebuilt, and
    // the receiver table computes the receiver again. Only a binding of
    // Actor.Base changes what a rider scan reads (base-epoch.mjs).
    if(field.key==='engine.actor.base')bumpBaseEpoch();else bumpActorsEpoch();
    if(binding.mirror){
      const mirrored=this.mirroredBinding(instance,field,binding);
      if(mirrored){instance.bindings.set(field.key,mirrored);bumpReceiverEpoch();return;}
    }
    instance.bindings.set(field.key,binding);bumpReceiverEpoch();
    this.noteBoundKey(field.key);
  }
  /** A binding whose value changes only through its setter keeps a copy in
   * the object's image cell, written at binding and after every set, so the
   * Rust interpreter reads the cell (its key is not a bound key). Reads in
   * JavaScript still go through the binding. SCRIPT_VM_CHECK=1 compares each
   * copy with its binding before every Rust run. */
  mirroredBinding(instance,field,binding) {
    const cell=instance.cells?.get(field.key);
    if(!cell||!scalarCell(cell)||instance.poison?.has(field.key))return null;
    const codec=propertyCodec(field);
    const write=()=>writeCell(cell,instance.arena.view,instance.refs,codec.copy(binding.get()),instance.base);
    write();
    // `mirrored`: the Rust receiver's binding set leaves this key out.
    const mirrored={get:binding.get,set:value=>{binding.set(value);write();},mirrored:true};
    if(SCRIPT_VM_CHECK)(this.mirrors??=[]).push({instance,field,cell,codec,binding:mirrored});
    return mirrored;
  }
  /** SCRIPT_VM_CHECK: every mirrored cell equals its binding's value. */
  checkMirrors() {
    for(const {instance,field,cell,codec,binding} of this.mirrors??[]){
      if(instance.imageToken?.released)continue;
      const stored=readCell(cell,instance.arena.view,instance.refs,instance.base),value=codec.copy(binding.get());
      if(!Object.is(stored,value))throw new Error(`Mirrored binding ${field.key} diverged: image ${String(stored)}, binding ${String(value)}`);
    }
  }
  /** A property key some object's host binding serves: the Rust
   * interpreter leaves that key to JavaScript on bound receivers. */
  noteBoundKey(key) {
    const keys=this.boundKeys??=new Set();
    if(keys.has(key))return;
    keys.add(key);
    this.scriptVm?.markBound(key);
  }
  /** The runtime's Rust interpreter (the default engine; null under
   * SCRIPT_VM=js or without a class loader), created once on the object
   * arena before any compiled body runs. */
  scriptVmInstance() {
    if(!this.classLoader||!scriptVmRust())return null;
    this.boundKeys??=new Set();
    return this.scriptVmReady??=RustScriptVm.create(this).then(vm=>{
      this.scriptVm=vm;this.services.scriptVm=vm;
      return vm;
    });
  }
  defaultReference(receiver,field) {
    // Inside execClassContext (`ClassExpr.default.Member`) the receiver is
    // the class identity itself; Default resolves on that class's defaults.
    if(receiver?.kind==='Class'){
      if(!receiver.linkedClass)throw new Error(`Class-context Default requires a linked class: ${receiver.key}`);
      return this.classDefaultReference(receiver.linkedClass,field);
    }
    return this.classDefaultReference(this.instance(receiver).cls,field);
  }
  classDefaultReference(cls,field) {
    if(!cls.propertyLink.includes(field))throw new Error('Class default property is not linked to this class');
    // InitClassDefaultObject (0x10152300) zeroes the default object's UObject
    // header and stores Class and Index (-1); `Default.Class` in a static
    // function (LocalMessage.ClientReceive) reads that Class. Other header
    // fields stay unbound.
    if(field.key==='core.object.class')
      return propertyReference(field,()=>cls.record,()=>{throw new Error('Class default object Class is immutable');});
    if(field.key.startsWith('core.object.'))
      throw new Error('Native class-default header storage is not bound');
    return propertyReference(field,()=>this.defaultValue(cls,field),value=>{
      const values=field.metadata.arrayDim>1
        ?new Map(value.map((item,index)=>[index,item])):new Map([[0,value]]);
      if(cls.loadRecord)this.classLoader.writeDefault(cls,field,values);
      cls.defaults.set(field.key,values);
      classDefaultsChanged();
    });
  }
  structReference(ref,member) {
    const value=refValue(ref),key=member.key.slice(0,member.key.lastIndexOf('.'));
    if(value&&typeof value==='object'&&!Array.isArray(value)){
      if(!Object.hasOwn(value,member.key))throw new Error(`Struct member is not linked: ${member.key}`);
      if(!ref?.reference)return copyValue(member,value[member.key]);
      return propertyReference(member,()=>refValue(ref)[member.key],item=>{
        const struct=refValue(ref);struct[member.key]=item;ref.set(struct);
      });
    }
    const components=key==='core.object.vector'?['X','Y','Z']:key==='core.object.rotator'?['Pitch','Yaw','Roll']:null;
    const index=components?.indexOf(member.name)??-1;
    if(index<0||ref.field?.metadata.structKey&&ref.field.metadata.structKey!==key)throw new Error(`Unsupported struct member: ${member.key}`);
    if(!ref?.reference)return copyValue(member,value[index]);
    return propertyReference(member,()=>refValue(ref)[index],item=>{const struct=refValue(ref);struct[index]=item;ref.set(struct);});
  }
  /** refValue(structReference(ref, member)): the reference form reads the
   * struct to validate the member, then again on get. Nothing runs between
   * the two reads, so the member of the first read, copied as the member
   * reference's get copies it (the codec), is the same value. */
  structValue(ref,member) {
    const value=refValue(ref),key=member.key.slice(0,member.key.lastIndexOf('.'));
    if(value&&typeof value==='object'&&!Array.isArray(value)){
      if(!Object.hasOwn(value,member.key))throw new Error(`Struct member is not linked: ${member.key}`);
      return ref?.reference?propertyCodec(member).read(value[member.key]):copyValue(member,value[member.key]);
    }
    const components=key==='core.object.vector'?['X','Y','Z']:key==='core.object.rotator'?['Pitch','Yaw','Roll']:null;
    const index=components?.indexOf(member.name)??-1;
    if(index<0||ref.field?.metadata.structKey&&ref.field.metadata.structKey!==key)throw new Error(`Unsupported struct member: ${member.key}`);
    return ref?.reference?propertyCodec(member).read(value[index]):copyValue(member,value[index]);
  }
  lookup(receiver,name,global=false) {
    // execClassContext (0x1012edb0) steps `ClassExpr.static.F()` with this =
    // the class's Defaults (+0x4d4), the class default object. Its header has
    // no StateFrame (InitClassDefaultObject 0x10152300 zeroes it), so the
    // call resolves in the class scope.
    if(receiver?.kind==='Class'&&!this.instances.has(receiver))
      return this.lookupMember(this.defaultObjectClass(receiver),'methods',name);
    const instance=this.instance(receiver);
    return (!global&&this.lookupMember(instance.state?.stateNode,'methods',name))||this.lookupMember(instance.cls,'methods',name);
  }
  /** execGotoState wrapper, including ordinary BeginState/EndState events. */
  gotoState(receiver,name='None',label='Begin') {
    const instance=this.instance(receiver),state=instance.state;
    name=lower(name||'None');label=lower(label||'Begin');if(label==='none')label='begin';
    if(name===lower(state.stateNode?.record.name??'None'))return state.gotoLabel(label);
    const automatic=name==='auto';
    let record=null;
    if(automatic){
      for(let cls=instance.cls;cls&&!record;cls=cls.base){
        if(!cls.stateOrder&&cls.states?.size)throw new Error('Original state child order is not linked');
        record=cls.stateOrder?.find(state=>state.flags&2)?.record??null;
      }
    }else if(name!=='none')record=this.lookupMember(instance.cls,'states',name);
    const node=record?this.states.get(record.key):null;
    if(record&&!node)throw new Error(`Original state is not prepared: ${record.key}`);
    const result=state.transition(node,instance.cls.metadata);
    return result===1?state.gotoLabel(label):false;
  }
  /** An enum object's native Names table (UEnum +0x34) from its loaded record. */
  enumNames(identity){
    const cached=this.enumNameTables?.get(identity);
    if(cached)return cached;
    const graph=this.classLoader?.graph;
    if(!graph)throw new Error('GetEnum requires the original native enum loader');
    let record=identity.loadRecord;
    if(!record){
      if(!graph.packageAssets.has(lower(identity.asset.name)))throw new Error(`GetEnum requires the prepared package of ${identity.key}`);
      record=graph.loadExport(identity.asset.name,identity.index);
    }
    const names=graph.slotOf(record,0x34).data.map(name=>graph.nameText(name));
    (this.enumNameTables??=new Map()).set(identity,names);
    return names;
  }
  invoke(call) {
    const record=call.kind==='final'?this.objects.operand(call.script,call.node):this.lookup(call.receiver,call.name,call.kind==='global');
    if(!record)throw new Error(`Original function was not found: ${call.name}`);
    return this.callFunction(record,call.receiver,call.argumentCount,call.evaluateArgument,call);
  }
  invokeNative(call) {
    if(call.record?.key==='engine.pawn.stopwaiting'){
      // APawn::execStopWaiting, Engine 0x103ba590: P_FINISH, then
      // LatentFloat (+0xe0) = -1.0f when StateFrame->LatentAction is Sleep's
      // poll 0x180, so the Sleep ends at its next poll. StateFrame (+0xc) is
      // read without a null test. Mover.FinishNotify reaches it for a based
      // pawn or a WaitingPawn outside ScriptedPawn's OpeningDoor override.
      if(call.argumentCount!==0)throw new Error('StopWaiting takes no arguments');
      const state=this.instance(call.receiver).state;
      if(!state)throw new Error('StopWaiting requires the pawn StateFrame');
      if(state.latent===384)this.writeNamed(call.receiver,'LatentFloat',-1);
      return undefined;
    }
    if(call.record?.key==='engine.decal.attachdecal')return execAttachDecal(call,{
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
      clientFor:actor=>{
        const engine=this.levelFor(actor)?.engine;
        if(!engine||!Object.hasOwn(engine,'client'))
          throw new DecalBoundaryError('Client.Decals','AttachDecal requires the original Engine.Client binding');
        return engine.client;
      },warning:this.warning,
      attachSurfaces:(actor,distance,direction)=>attachDecalSurfaces(actor,distance,direction,{
        level:this.levelFor(actor),
        read:(a,n)=>this.readNamed(a,n),
        write:(a,n,v)=>this.writeNamed(a,n,v),
        rand:typeof this.rng?.rand==='function'?()=>this.rng.rand():null,
        // The Mover branch's AActor::SetBase(Owner, 1), the recovered one.
        setBase:(a,target)=>{
          const level=this.levelFor(a);
          const dispatch=(x,name,args)=>this.dispatchSpawnedEvent(x===level?.hash?.levelInfo?level.actors[0]:x,name,args);
          return setBase(a,target,dispatch,true);
        },
      }),
    });
    if(call.record?.key==='engine.playerpawn.clienttravel'){
      // PlayerPawn.ClientTravel(URL, TravelType, bItems): APlayerPawn::execClientTravel (script-travel.mjs) in a session that
      // travels (runtime.travelServices), else the named stop of travel-boundary.mjs.
      return clientTravelNative(this,call,refValue);
    }
    if(call.record?.key==='engine.decal.detachdecal')return execDetachDecal(call,{
      read:(actor,name)=>this.readNamed(actor,name),
      detachSurfaces:actor=>detachDecalSurfaces(actor,{
        level:this.levelFor(actor),
        read:(a,n)=>this.readNamed(a,n),
        write:(a,n,v)=>this.writeNamed(a,n,v),
      }),
    });
    // A host may claim specific natives as external boundaries (see constructor);
    // those are delegated to the `native` callback before any built-in body runs.
    if(this.boundaryNatives.has(call.index)){
      if(!this.native)throw new Error(`Original native ${call.index} is declared a host boundary but no native handler is set`);
      return this.native({...call,runtime:this});
    }
    if(call.index===529||call.index===530){
      if(call.argumentCount!==0)throw new Error('AddPawn/RemovePawn accept no arguments');
      let isPawn=false;
      for(let cls=this.instance(call.receiver).cls;cls;cls=cls.base)
        if(cls.record.key==='engine.pawn'){isPawn=true;break;}
      if(!isPawn)throw new Error('AddPawn/RemovePawn require an original Pawn class');
      const level=this.levelFor(call.receiver);
      if(!level)throw new Error('AddPawn/RemovePawn require the live level');
      // APawn +0x498 and LevelInfo +0x54c share these field-backed host
      // slots for loaded and spawned actors. Original AddPawn never checks
      // membership; RemovePawn keeps the detached pawn's stale NextPawn.
      (call.index===529?addPawn:removePawn)(level,call.receiver);
      return undefined;
    }
    if(call.index===0&&call.record?.key==='core.object.dynamicloadobject')
      return execDynamicLoadObject(call,{staticLoadObject:request=>this.loadPreparedDynamicObject(request)});
    // Core UObject::execGetEnum 0x1013e9a0: (object E, int i) is NAME_None
    // unless E casts to UEnum and 0 <= i < Names.Num (+0x38); then Names(i) (+0x34).
    if(call.index===0&&call.record?.key==='core.object.getenum'){
      const object=refValue(call.evaluateArgument(0)),index=refValue(call.evaluateArgument(1))|0;
      if(!object||object.kind!=='Enum'||index<0)return 'None';
      const names=this.enumNames(object);
      return index<names.length?names[index]:'None';
    }
    // Core UObject::execGetConfig 0x1013e4e0 (`// DEUS_EX CAC`): two string parameters, then GConfig->GetString(Section, Key, &Value, NULL) (the vtable +0xc call at
    // 0x1013e597; no file name: the system ini) with the result copied out; a missing key leaves the empty string. MenuScreenSaveGame.GenerateNewSnapShot asks for
    // Engine.Engine GameRenderDevice.
    if(call.index===0&&call.record?.key==='core.object.getconfig'){
      if(call.argumentCount!==2)throw new Error('GetConfig requires a section and a key');
      const section=String(refValue(call.evaluateArgument(0))??''),key=String(refValue(call.evaluateArgument(1))??'');
      const config=this.classLoader?.graph?.config;
      if(!config)throw new Error('GetConfig requires GConfig (the native class loader and installed .ini files)');
      return config.getString(section,key,null)??'';
    }
    // DeusEx ParticleIterator.UpdateParticles (docs/particles.md).
    if(call.index===3017){
      if(typeof this.rng?.frand!=='function')throw new Error('UpdateParticles requires the shared original RNG stream');
      return execUpdateParticles(this,call.receiver,Math.fround(refValue(call.evaluateArgument(0))),()=>this.rng.frand());
    }
    if(call.index===231)return execObjectLog(call,{logDevice:this.logDevice});
    if(call.index===751)return this.criticalDelete(call);
    if(call.index>=TEXT_PARSER_NATIVE.indices.openText&&call.index<=TEXT_PARSER_NATIVE.indices.setPlayerName){
      const result=dispatchTextParserNative(call,{
        state:receiver=>this.instance(receiver).textParser,
        loadText:path=>{
          if(typeof this.textSource?.loadText!=='function')
            throw new Error('DeusExTextParser.OpenText requires the XExtString source');
          const text=this.textSource.loadText(path);
          if(text!==null)this.modelExtStringLoad(path);
          return text;
        },
        name:text=>{
          if(typeof this.nameServices?.internName!=='function')
            throw new Error('DeusExTextParser tag names require the shared FName service');
          return this.nameServices.internName(text);
        },
      });
      if(result.handled)return result.value;
    }
    if(call.index===DEUSEX_VERSION_NATIVE.index){
      if(call.argumentCount!==0)throw new Error('GetDeusExVersion takes no arguments');
      return getDeusExVersion();
    }
    if(call.index===1024){
      if(call.argumentCount!==1)throw new Error('StringToName requires one string argument');
      // The first spelling of a name wins (unreal/name-spelling.mjs): StringToName(con.conName $ "_Played") finds the startup package's `M00MeetPage_Played`, and a
      // new name is the process table's entry until the next LoadMap collection
      const spell=this.nameSpelling,services=spell&&this.nameServices?{...this.nameServices,internName:(text,mode)=>this.nameServices.internName(mode===1?spell.intern(text):spell.spell(text),mode)}:this.nameServices;
      const name=extensionStringToName(refValue(call.evaluateArgument(0)),services);
      if(typeof name!=='string'||name.includes('\0'))
        throw new Error('The shared FName service must return a resolved name spelling');
      return name;
    }
    if(call.index===1410){
      if(call.argumentCount>2)throw new Error('Window.NewChild accepts a class and optional boolean');
      const classArgument=call.argumentCount?refValue(call.evaluateArgument(0)):undefined;
      const showArgument=call.argumentCount>1?refValue(call.evaluateArgument(1)):undefined;
      const newClass=classArgument===undefined?null:classArgument;
      const bShow=showArgument===undefined?true:showArgument;
      return createNewWindowNative({newClass,parent:call.receiver,bShow,
        errorDevice:this.windowLifecycle?.errorDevice},{...this.windowLifecycle,
        processScript:this.windowLifecycle?.processScript??(request=>this.processWindowScript(request)),
        askParentForReconfigure:this.windowLifecycle?.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration))});
    }
    if(call.index===1411){
      if(call.argumentCount!==0)throw new Error('Window.Raise accepts no arguments');
      const order=this.windowLifecycle?.order??{};
      return raiseWindowNative(call.receiver,{...order,
        askParentForReconfigure:order.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      });
    }
    if(call.index===1412){
      if(call.argumentCount!==0)throw new Error('Window.Lower accepts no arguments');
      const order=this.windowLifecycle?.order??{};
      return lowerWindowNative(call.receiver,{...order,
        askParentForReconfigure:order.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      });
    }
    if(call.index===1409){
      if(call.argumentCount!==0)throw new Error('Window.Destroy accepts no arguments');
      return safeDestroyWindowNative(call.receiver,this.windowLifecycle?.destroy??{});
    }
    if(call.index===1459){
      // execDestroyAllChildren (0x10052f00): P_FINISH, then XWindow::KillAllChildren.
      if(call.argumentCount!==0)throw new Error('Window.DestroyAllChildren accepts no arguments');
      killAllChildrenNative(call.receiver,this.windowLifecycle?.destroy??{});
      return undefined;
    }
    if(call.index===1413){
      if(call.argumentCount>1)throw new Error('Window.Show accepts one optional boolean argument');
      const show=call.argumentCount?refValue(call.evaluateArgument(0)):true;
      return showWindowNative(call.receiver,show,this.windowLifecycle?.visibility);
    }
    if(call.index===1414){
      if(call.argumentCount!==0)throw new Error('Window.Hide accepts no arguments');
      return hideWindowNative(call.receiver,this.windowLifecycle?.visibility);
    }
    if(call.index===1415){
      if(call.argumentCount>1)throw new Error('Window.IsVisible accepts one optional boolean argument');
      const recurse=call.argumentCount?refValue(call.evaluateArgument(0)):true;
      return isWindowVisibleNative(call.receiver,recurse,this.windowLifecycle?.visibility);
    }
    if(call.index===1416){
      if(call.argumentCount>1)throw new Error('Window.SetSensitivity accepts one optional boolean argument');
      const sensitive=call.argumentCount?refValue(call.evaluateArgument(0)):windowSensitivityOptionalDefault(1416);
      return setSensitivityNative({object:call.receiver,sensitive},this.windowLifecycle?.sensitivity);
    }
    if(call.index===1417){
      if(call.argumentCount>1)throw new Error('Window.EnableWindow accepts one optional boolean argument');
      const sensitive=call.argumentCount?refValue(call.evaluateArgument(0)):windowSensitivityOptionalDefault(1417);
      return setSensitivityNative({object:call.receiver,sensitive},this.windowLifecycle?.sensitivity);
    }
    if(call.index===1418){
      if(call.argumentCount!==0)throw new Error('Window.DisableWindow accepts no arguments');
      return disableWindowNative(call.receiver,this.windowLifecycle?.sensitivity);
    }
    if(call.index===1419){
      if(call.argumentCount>1)throw new Error('Window.IsSensitive accepts one optional boolean argument');
      const recurse=call.argumentCount?refValue(call.evaluateArgument(0)):windowSensitivityOptionalDefault(1419);
      return isWindowSensitiveNative(call.receiver,recurse,this.windowLifecycle?.sensitivity);
    }
    if(call.index===1455){
      if(call.argumentCount>1)throw new Error('Window.GetTopChild accepts one optional boolean argument');
      const filterVisible=call.argumentCount?refValue(call.evaluateArgument(0)):windowSensitivityOptionalDefault(1455);
      return getTopChildNative(call.receiver,filterVisible,this.windowLifecycle?.sensitivity);
    }
    if(call.index===1456){
      if(call.argumentCount>1)throw new Error('Window.GetBottomChild accepts one optional boolean argument');
      const filterVisible=call.argumentCount?refValue(call.evaluateArgument(0)):windowSensitivityOptionalDefault(1456);
      return getBottomChildNative(call.receiver,filterVisible,this.windowLifecycle?.sensitivity);
    }
    if(call.index===1457){
      if(call.argumentCount>1)throw new Error('Window.GetHigherSibling accepts one optional boolean argument');
      const filterVisible=call.argumentCount?refValue(call.evaluateArgument(0)):windowSensitivityOptionalDefault(1457);
      return getHigherSiblingNative(call.receiver,filterVisible,this.windowLifecycle?.sensitivity);
    }
    if(call.index===1458){
      if(call.argumentCount>1)throw new Error('Window.GetLowerSibling accepts one optional boolean argument');
      const filterVisible=call.argumentCount?refValue(call.evaluateArgument(0)):windowSensitivityOptionalDefault(1458);
      return getLowerSiblingNative(call.receiver,filterVisible,this.windowLifecycle?.sensitivity);
    }
    if(call.index===1488){
      if(call.argumentCount!==0)throw new Error('Window.GetClientObject accepts no arguments');
      return getClientObjectNative(call.receiver,this.windowLifecycle?.sensitivity);
    }
    if(call.index===1612){
      if(call.argumentCount!==0)throw new Error('ToggleWindow.GetToggle accepts no arguments');
      return getToggleNative(call.receiver,this.windowLifecycle?.toggle??{});
    }
    if(call.index===1610){
      // execChangeToggle 0x10049ce0 -> XToggleWindow::ChangeToggle 0x10049910: the +0xf0 ToggleChanged walk up the parents (the
      // receiver's vtable word is a DLL table address, so it reads as a word like the other toggle reads).
      if(call.argumentCount!==0)throw new Error('ToggleWindow.ChangeToggle accepts no arguments');
      const toggle=this.windowLifecycle?.toggle??{};
      return changeToggleNative(call.receiver,{...toggle,read:toggle.read&&((object,offset,kind,details)=>toggle.read(object,offset,offset===0&&kind==='ptr'?'u32':kind,details))});
    }
    if(call.index===1611){
      if(call.argumentCount!==1)throw new Error('ToggleWindow.SetToggle requires the bNewToggle argument');
      const bNewToggle=refValue(call.evaluateArgument(0));
      return setToggleNative(call.receiver,bNewToggle,this.windowLifecycle?.toggle??{});
    }
    if(call.index===1425){
      if(call.argumentCount!==0)throw new Error('Window.GetRootWindow accepts no arguments');
      return getRootWindowNative(call.receiver,this.windowLifecycle?.hierarchy);
    }
    if(call.index===1428){
      if(call.argumentCount!==0)throw new Error('Window.GetParent accepts no arguments');
      return getParentWindowNative(call.receiver,this.windowLifecycle?.hierarchy??{});
    }
    if(call.index===1460){
      if(call.argumentCount!==0)throw new Error('Window.AskParentForReconfigure accepts no arguments');
      return askParentForReconfigureNative(call.receiver,this.windowLifecycle?.reconfiguration);
    }
    if(call.index===1461){
      if(call.argumentCount!==4)throw new Error('Window.ConfigureChild requires newX, newY, newWidth and NewHeight');
      const newX=refValue(call.evaluateArgument(0)),newY=refValue(call.evaluateArgument(1)),
        newWidth=refValue(call.evaluateArgument(2)),newHeight=refValue(call.evaluateArgument(3));
      return configureChildNative(call.receiver,newX,newY,newWidth,newHeight,
        this.windowLifecycle?.configureChild??{});
    }
    if(call.index===1430){
      if(call.argumentCount!==4)throw new Error('Window.SetConfiguration requires x, y, width and height');
      return setWindowConfigurationNative(call.receiver,...Array.from({length:4},(_,i)=>refValue(call.evaluateArgument(i))),{
        ...this.windowLifecycle?.size,
        askParentForReconfigure:request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration),
      });
    }
    if(call.index===1431){
      if(call.argumentCount!==2)throw new Error('Window.SetSize requires width and height');
      const width=refValue(call.evaluateArgument(0)),height=refValue(call.evaluateArgument(1));
      const size=this.windowLifecycle?.size??{};
      return setWindowSizeNative(call.receiver,width,height,{...size,
        askParentForReconfigure:size.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      });
    }
    if(call.index===1434){
      if(call.argumentCount!==1)throw new Error('Window.SetHeight requires one height argument');
      return setWindowHeightNative(call.receiver,refValue(call.evaluateArgument(0)),{
        ...this.windowLifecycle?.size,
        askParentForReconfigure:request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration),
      });
    }
    if(call.index===1433){
      if(call.argumentCount!==1)throw new Error('Window.SetWidth requires one width argument');
      const width=refValue(call.evaluateArgument(0));
      const size=this.windowLifecycle?.size??{};
      return setWindowWidthNative(call.receiver,width,{...size,
        askParentForReconfigure:size.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      });
    }
    if(call.index===1440){
      if(call.argumentCount!==1)throw new Error('Window.SetFocusWindow requires one window argument');
      return setFocusWindowNative(call.receiver,refValue(call.evaluateArgument(0)),this.windowLifecycle?.focus??{});
    }
    if(call.index===1493){
      if(call.argumentCount!==0)throw new Error('Window.ChangeStyle accepts no arguments');
      return changeStyleWindowNative(call.receiver,this.windowLifecycle?.changeStyle??{});
    }
    if(call.index===1432){
      if(call.argumentCount!==2)throw new Error('Window.SetPos requires x and y');
      const x=refValue(call.evaluateArgument(0)),y=refValue(call.evaluateArgument(1));
      const position=this.windowLifecycle?.position??{};
      return setWindowPositionNative(call.receiver,x,y,{...position,
        askParentForReconfigure:position.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      });
    }
    if(call.index===1438){
      if(call.argumentCount<2||call.argumentCount>6)
        throw new Error('Window.SetWindowAlignments requires HAlign, VAlign, and up to four optional margins');
      const hAlign=refValue(call.evaluateArgument(0)),vAlign=refValue(call.evaluateArgument(1));
      const hMargin0=call.argumentCount>2?refValue(call.evaluateArgument(2)):0;
      const vMargin0=call.argumentCount>3?refValue(call.evaluateArgument(3)):0;
      const hMargin1=call.argumentCount>4?refValue(call.evaluateArgument(4)):0;
      const vMargin1=call.argumentCount>5?refValue(call.evaluateArgument(5)):0;
      const position=this.windowLifecycle?.position??this.windowLifecycle?.alignments??{};
      return setWindowAlignmentsNative(call.receiver,hAlign,vAlign,hMargin0,vMargin0,hMargin1,vMargin1,{...position,
        askParentForReconfigure:position.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      });
    }
    if(call.index===1422){
      if(call.argumentCount!==1)throw new Error('Window.SetBackgroundStyle requires one byte argument');
      const newStyle=refValue(call.evaluateArgument(0));
      return setBackgroundStyleNative({window:call.receiver,newStyle},this.windowLifecycle?.backgroundStyle);
    }
    if(call.index===1423){
      if(call.argumentCount!==1)throw new Error('Window.SetBackgroundSmoothing requires one bool argument');
      const newValue=refValue(call.evaluateArgument(0));
      return setBackgroundSmoothingNative({window:call.receiver,newValue},this.windowLifecycle?.backgroundStyle);
    }
    if(call.index===1421){
      if(call.argumentCount!==1)throw new Error('Window.SetBackground requires one Texture argument');
      const background=refValue(call.evaluateArgument(0));
      const surface=this.windowLifecycle?.surface??{};
      return setWindowBackgroundNative(call.receiver,background,{...surface,
        askParentForReconfigure:surface.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      });
    }
    if(call.index===1475){
      if(call.argumentCount!==1)throw new Error('Window.SetTileColor requires one Color argument');
      return setWindowTileColorNative(call.receiver,refValue(call.evaluateArgument(0)),
        this.windowLifecycle?.surface??{});
    }
    if(call.index===1467){
      if(call.argumentCount!==1)throw new Error('Window.SetChildVisibility requires one boolean argument');
      const visible=refValue(call.evaluateArgument(0));
      return setChildVisibilityNative({object:call.receiver,visible},this.windowLifecycle?.visibility);
    }
    if(call.index===1476){
      if(call.argumentCount!==1)throw new Error('Window.SetTextColor requires one Color argument');
      const newColor=refValue(call.evaluateArgument(0));
      return setWindowTextColorNative(call.receiver,newColor,this.windowLifecycle?.text);
    }
    if(call.index===1477){
      if(call.argumentCount!==1)throw new Error('Window.SetFont requires one Font argument');
      const font=refValue(call.evaluateArgument(0));
      const text=this.windowLifecycle?.text??{};
      return setWindowFontNative(call.receiver,font,{...text,
        askParentForReconfigure:text.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      });
    }
    if(call.index===1550||call.index===1551){
      // execSetText 0x10046a30 / execAppendText 0x10046b80: evaluate the
      // string, ConvertScriptString it, then call the virtual method.
      if(call.argumentCount!==1)throw new Error(`TextWindow.${call.index===1550?'SetText':'AppendText'} requires one string argument`);
      const value=refValue(call.evaluateArgument(0));
      if(typeof value!=='string')throw new Error('TextWindow text natives require an initialized string');
      const text=this.windowLifecycle?.text??{};
      const services={...text,
        askParentForReconfigure:text.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      };
      const converted=convertScriptString(value);
      // A LargeTextWindow/EditWindow receiver overrides the virtual (vtable +0x11c/+0x120).
      if(this.windowLifecycle?.textVirtual?.(call.receiver,call.index===1550?'setText':'appendText',converted))return undefined;
      if(call.index===1551){appendTextNative(call.receiver,converted,services);return undefined;}
      return setTextNative(call.receiver,converted,services);
    }
    if(call.index===1556){
      if(call.argumentCount!==2)throw new Error('TextWindow.SetTextAlignments requires two byte arguments');
      const horizontal=refValue(call.evaluateArgument(0)),vertical=refValue(call.evaluateArgument(1));
      return setTextAlignmentsNative(call.receiver,horizontal,vertical,this.windowLifecycle?.text);
    }
    if(call.index===1557){
      if(call.argumentCount!==2)throw new Error('TextWindow.SetTextMargins requires two float arguments');
      const horizontal=refValue(call.evaluateArgument(0)),vertical=refValue(call.evaluateArgument(1));
      const text=this.windowLifecycle?.text??{};
      return setTextMarginsNative(call.receiver,horizontal,vertical,{...text,
        askParentForReconfigure:text.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      });
    }
    if(call.index===1971){
      if(call.argumentCount!==2)throw new Error('ComputerWindow.SetTextSize requires cols and rows');
      const cols=refValue(call.evaluateArgument(0)),rows=refValue(call.evaluateArgument(1));
      return setComputerTextSizeNative(call.receiver,cols,rows,this.windowLifecycle?.computer??{});
    }
    if(call.index===1973){
      if(call.argumentCount!==4)throw new Error('ComputerWindow.SetTextFont requires font, width, height, and color');
      const font=refValue(call.evaluateArgument(0));
      const width=refValue(call.evaluateArgument(1)),height=refValue(call.evaluateArgument(2));
      const color=refValue(call.evaluateArgument(3));
      return setComputerTextFontNative(call.receiver,font,width,height,color,this.windowLifecycle?.computer??{});
    }
    if(call.index===1975){
      if(call.argumentCount!==1)throw new Error('ComputerWindow.SetTextTiming requires one float argument');
      return setComputerTextTimingNative(call.receiver,refValue(call.evaluateArgument(0)),this.windowLifecycle?.computer??{});
    }
    if(call.index===1976){
      if(call.argumentCount!==1)throw new Error('ComputerWindow.SetFadeSpeed requires one float argument');
      return setComputerFadeSpeedNative(call.receiver,refValue(call.evaluateArgument(0)),this.windowLifecycle?.computer??{});
    }
    if(call.index===1978){
      if(call.argumentCount!==1)throw new Error('ComputerWindow.SetCursorColor requires one Color argument');
      return setComputerCursorColorNative(call.receiver,refValue(call.evaluateArgument(0)),this.windowLifecycle?.computer??{});
    }
    if(call.index===1980){
      if(call.argumentCount!==1)throw new Error('ComputerWindow.ShowTextCursor requires one boolean argument');
      return showComputerTextCursorNative(call.receiver,refValue(call.evaluateArgument(0)),this.windowLifecycle?.computer??{});
    }
    if(call.index===1985){
      if(call.argumentCount!==0)throw new Error('ComputerWindow.ClearScreen accepts no arguments');
      return clearComputerScreenNative(call.receiver,this.windowLifecycle?.computer??{});
    }
    if(call.index===1987){
      if(call.argumentCount>2)throw new Error('ComputerWindow.Print accepts text and an optional newline flag');
      if(call.argumentCount<1)throw new Error('ComputerWindow.Print requires text');
      const text=refValue(call.evaluateArgument(0));
      const newLine=call.argumentCount>1?refValue(call.evaluateArgument(1)):false;
      return printComputerTextNative(call.receiver,text,newLine,this.windowLifecycle?.computer??{});
    }
    if(call.index===2001){
      if(call.argumentCount!==1)throw new Error('ComputerWindow.EnableWordWrap requires one boolean argument');
      return enableComputerWordWrapNative(call.receiver,refValue(call.evaluateArgument(0)),this.windowLifecycle?.computer??{});
    }
    if(call.index===2052||call.index===2053)return this.conversationEventNative(call);
    if(call.index===RANDOM_LABEL_NATIVE.getLabelCount||call.index===RANDOM_LABEL_NATIVE.getLabel||
        call.index===RANDOM_LABEL_NATIVE.getRandomLabel){
      const labels=this.instance(call.receiver).randomLabels;
      if(!Array.isArray(labels))
        throw new Error('ConEventRandomLabel native reached an object without a decoded labels payload');
      if(call.index===RANDOM_LABEL_NATIVE.getLabelCount){
        if(call.argumentCount!==0)throw new Error('GetLabelCount accepts no arguments');
        return getLabelCount(labels);
      }
      if(call.index===RANDOM_LABEL_NATIVE.getLabel){
        if(call.argumentCount!==1)throw new Error('GetLabel accepts one index argument');
        return getLabel(labels,refValue(call.evaluateArgument(0))|0);
      }
      // GetRandomLabel: reads/writes cycleIndex(+0x50) and bLabelsCycled(+0x54)
      // and, in the random branch, draws from the shared Core appRand stream.
      if(call.argumentCount!==0)throw new Error('GetRandomLabel accepts no arguments');
      const flags={
        bCycleEvents:Boolean(this.readNamed(call.receiver,'bCycleEvents')),
        bCycleOnce:Boolean(this.readNamed(call.receiver,'bCycleOnce')),
        bCycleRandom:Boolean(this.readNamed(call.receiver,'bCycleRandom')),
      };
      const cycleRef=this.namedReference(call.receiver,'cycleIndex');
      const cycledRef=this.namedReference(call.receiver,'bLabelsCycled');
      const appRand=typeof this.rng?.rand==='function'?()=>this.rng.rand():null;
      const result=getRandomLabel(labels,flags,
        {cycleIndex:cycleRef.get()|0,bLabelsCycled:Boolean(cycledRef.get())},appRand);
      cycleRef.set(result.cycleIndex);
      cycledRef.set(result.bLabelsCycled);
      return result.label;
    }
    if(call.index===2054){
      if(call.argumentCount!==0)throw new Error('ClearBindEvents accepts no arguments');
      return clearConversationEvents(call.receiver,{read:(object,key)=>this.readNamed(object,key)});
    }
    if(call.index>=1535&&call.index<=1545){
      const args=Array.from({length:call.argumentCount},(_,i)=>refValue(call.evaluateArgument(i)));
      return setTileWindow(call.receiver,call.index,args,this.windowLifecycle?.tile);
    }
    if(call.index===2055){
      if(call.argumentCount>1)throw new Error('GetSpeechAudio accepts one integer argument');
      const soundID=call.argumentCount?refValue(call.evaluateArgument(0)):0;
      return conversationSpeechAudio(call.receiver,soundID,this.conversationLifecycle?.audio?.speechLookup);
    }
    if(call.index===2056){
      if(call.argumentCount>1)throw new Error('GetSpeechLength accepts one integer argument');
      const soundID=call.argumentCount?refValue(call.evaluateArgument(0)):0;
      const audio=this.conversationLifecycle?.audio;
      return conversationSpeechLength(call.receiver,soundID,{
        getSpeechAudio:(conversation,id)=>{
          if(audio?.speechLookup)return conversationSpeechAudio(conversation,id,audio.speechLookup);
          if(typeof audio?.getSpeechAudio!=='function')
            throw new Error('GetSpeechAudio native loading and FString ownership are unbound');
          return audio.getSpeechAudio(conversation,id);
        },
        getSoundLength:sound=>conversationSoundLength(sound,{
          read:audio?.read,loadSpecial:audio?.loadSpecial,log:audio?.log,
        }),
      });
    }
    if(call.index===277){
      // execTrace 0x103e3330: each out expression resolves through GPropAddr
      // (non-assignable expressions land in a private temporary whose writes
      // never escape), then End, then the pre-stored optional defaults
      // Start=this->Location, bTraceActors=*(this+0x1dc)&1 and Extent=(0,0,0).
      // ULevel::SingleLineCheck (vtable +0xc0) runs with flags
      // bTraceActors?0x37:6 and extra=0 over a zeroed 44-byte FCheckResult
      // (Time=1.0, Item=-1); hit.Actor is the result and the record's
      // Location/Normal publish verbatim — zeroed on a miss.
      // HitLocation/HitNormal/EndTrace are required; StartTrace, bTraceActors
      // and Extent are optional (Actor.uc:845). A caller that omits a trailing
      // optional (Pawn.TraceShot passes only five, dropping Extent) stops the
      // P_GET_*_OPTX sequence early, so evaluate each optional only when present
      // and fall back to the same pre-stored defaults the original uses.
      if(call.argumentCount<3||call.argumentCount>6)throw new Error('Trace takes three to six arguments');
      const outLocation=call.evaluateArgument(0),outNormal=call.evaluateArgument(1);
      const end=refValue(call.evaluateArgument(2)),source=call.receiver;
      const startDefault=source.position;
      const start=(call.argumentCount>3?refValue(call.evaluateArgument(3)):null)??startDefault;
      const traceDefault=Boolean(source.flags&1);
      const traceActors=(call.argumentCount>4?refValue(call.evaluateArgument(4)):null)??traceDefault;
      const extent=(call.argumentCount>5?refValue(call.evaluateArgument(5)):null)??[0,0,0];
      const queries=this.levelFor(source)?.hash;
      if(typeof queries?.lineCheck!=='function')
        throw new Error('Trace requires the live level query services');
      const hit=scriptTrace(queries,source,end,start,traceActors,extent);
      writeSlot(outLocation).set(hit.location);
      writeSlot(outNormal).set(hit.normal);
      return hit.actor??null;
    }
    if(call.index===548){
      // execFastTrace 0x103e35e0: Start's Location default is copied before
      // the optional argument's expression runs; both vectors push by value
      // into Level->Model->FastLineCheck and the byte result returns masked.
      if(call.argumentCount<1||call.argumentCount>2)throw new Error('FastTrace takes an end and an optional start');
      const source=call.receiver,end=refValue(call.evaluateArgument(0));
      const startDefault=source.position;
      const start=call.argumentCount>1?(refValue(call.evaluateArgument(1))??startDefault):startDefault;
      const level=this.levelFor(source),model=level?.model;
      if(!model)throw new Error('FastTrace requires the live level BSP model');
      return scriptFastTrace(model,source,end,start,level.fastLineCheck);
    }
    if(call.index===722){
      // execParabolicTrace 0x1036e190 -> worker 0x1036c0a0 (docs/parabolic-trace.md): the argument defaults from the
      // receiver, then the stepped trace over the live zone table (level.pointRegion) and ULevel::MultiLineCheck
      // (the collision hash). The result is the float32 time; finalLocation is written through the out slot.
      return execParabolicTrace(call,{
        read:(actor,name)=>this.readNamed(actor,name),
        services:actor=>{
          const level=this.levelFor(actor);
          const services=level?.hash&&typeof level.pointRegion==='function'
            ?levelParabolicServices(level,(zone,name)=>this.readNamed(zone,name)):null;
          // A validator may wrap the two level services to record their answers (validate-parabolic-trace-play).
          return services&&typeof this.observeParabolicServices==='function'?this.observeParabolicServices(services,actor):services;
        },
        refValue,writeSlot,
      });
    }
    if(call.index===721){
      // execInStasis 1036d320 consumes EndFunctionParms and directly calls
      // AActor::InStasis 1036bfe0; there are no script operands.
      if(call.argumentCount!==0)throw new Error('InStasis takes no arguments');
      return actorInStasis(call.receiver,{read:(actor,name)=>this.readNamed(actor,name),
        level:this.levelFor(call.receiver)});
    }
    if(call.index===718){
      // execIsOverlapping 0x1036ddb0: checkActor evaluates first; a null
      // reference publishes 0 without entering AActor::IsOverlapping
      // 0x10369430 — strict (Ra+Rb)^2 > dx^2+dy^2 and (Ha+Hb)^2 > dz^2 in
      // x87, excluded when either side carries a Primitive whose class
      // ancestry reaches Brush or when the other actor is this->+0xa8.
      if(call.argumentCount!==1)throw new Error('IsOverlapping requires one argument');
      const other=refValue(call.evaluateArgument(0));
      if(other==null)return false;
      if(call.receiver?.worldActor===undefined)
        throw new Error('IsOverlapping requires the actor collision view');
      return isOverlapping(call.receiver,other);
    }
    if(call.index===278)return execScriptSpawn(call,{
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
      levelFor:this.levelFor,spawnActor:args=>this.spawnActor(args),
    });
    if(call.index===299){
      if(call.argumentCount!==1)throw new Error('SetRotation requires one rotator argument');
      const rotation=refValue(call.evaluateArgument(0));
      return setScriptRotation(call.receiver,rotation,{
        levelFor:this.levelFor,
        read:(actor,name)=>this.readNamed(actor,name),
        write:(actor,name,value)=>this.writeNamed(actor,name,value),
      });
    }
    if(call.index===267){
      if(call.argumentCount!==1)throw new Error('SetLocation requires one vector argument');
      const location=refValue(call.evaluateArgument(0));
      return execSetLocation(call.receiver,location,{
        levelFor:this.levelFor,
        ...this.relocation,
      });
    }
    if(call.index===195){
      if(call.argumentCount!==0)throw new Error('FRand accepts no arguments');
      if(typeof this.rng?.frand!=='function')throw new Error('FRand requires the shared original RNG stream');
      return Math.fround(this.rng.frand());
    }
    if(call.index===252){
      if(call.argumentCount!==0)throw new Error('VRand accepts no arguments');
      return execVRand(this.rng);
    }
    if(call.index===320)return execRotRand(call,{rng:this.rng});
    if(call.index===167){
      if(call.argumentCount!==1)throw new Error('Rand requires one integer argument');
      const max=refValue(call.evaluateArgument(0));
      if(!Number.isInteger(max)||max< -0x80000000||max>0x7fffffff)
        throw new Error('Rand requires a signed 32-bit Max');
      if(max<=0)return 0;
      if(typeof this.rng?.rand!=='function')throw new Error('Rand requires the shared original RNG stream');
      return this.rng.rand()%max;
    }
    if(call.index===272){
      if(call.argumentCount!==1)throw new Error('SetOwner requires one owner argument');
      const owner=refValue(call.evaluateArgument(0));
      if(owner===undefined)throw new Error('SetOwner received an uninitialized native argument');
      return this.setOwner(call.receiver,owner);
    }
    if(call.index===279){
      if(call.argumentCount!==0)throw new Error('Destroy accepts no arguments');
      return this.destroyActor(call.receiver,false);
    }
    // Recovered collision/physics natives for actors carrying the spawn
    // collision view (the admitted Inventory chain). execSetCollision fills
    // skipped optional arguments from the current +0x1dc bits, and
    // SetPhysics routes its Walking/None base transitions through the
    // recovered FindBase/SetSupportBase chain against the live level hash.
    // Map-attached actors (DeusExDecorations included) run the same
    // SetBase/SetPhysics bodies on their bound host props;
    // SetCollision/SetCollisionSize keep the host paths. Movers keep theirs.
    let collisionReceiver=this.collisionViewActors.has(call.receiver);
    if(!collisionReceiver&&(call.index===298||call.index===3970)){
      const attached=this.instances.get(call.receiver);
      collisionReceiver=attached
        &&(()=>{
          let actor=false;
          for(let c=attached.cls;c;c=c.base){
            // Mover.PostBeginPlay's M.SetBase(Self) attaches slave movers to
            // their leader through the same AActor::SetBase body; movers keep
            // their own SetPhysics route.
            if(c.record.key==='engine.mover'&&call.index!==298)return false;
            if(c.record.key==='engine.actor')actor=true;
          }
          return actor;
        })();
    }
    if(collisionReceiver&&(call.index===262||call.index===283||call.index===298||call.index===3970)){
      const level=this.levelFor(call.receiver);
      const dispatch=(a,name,args)=>this.dispatchSpawnedEvent(
        a===level?.hash?.levelInfo?level.actors[0]:a,name,args);
      if(call.index===262){
        const [collide,blockActors,blockPlayers]=setCollisionArguments(call.receiver,
          call.argumentCount,index=>refValue(call.evaluateArgument(index)));
        return setActorCollision(call.receiver,collide,blockActors,blockPlayers,{level});
      }
      if(call.index===283){
        if(call.argumentCount!==2)throw new Error('SetCollisionSize requires radius and height');
        return setActorCollisionSize(call.receiver,refValue(call.evaluateArgument(0)),
          refValue(call.evaluateArgument(1)),{level});
      }
      // execSetBase (298) reaches AActor::SetBase 0x10369c80; the spawn's
      // SupportActor dispatch (Actor.SupportActor -> SetBase) lands here.
      if(call.index===298){
        if(call.argumentCount!==1)throw new Error('SetBase accepts exactly one argument');
        return setBase(call.receiver,refValue(call.evaluateArgument(0)),dispatch);
      }
      if(call.argumentCount<1||call.argumentCount>2)throw new Error('SetPhysics accepts one or two arguments');
      const newPhysics=refValue(call.evaluateArgument(0));
      const newBase=call.argumentCount>1?refValue(call.evaluateArgument(1)):null;
      return setActorPhysics(call.receiver,newPhysics,newBase,{dispatch,
        findBase:a=>findActorBase(a,{lineCheck:(...args)=>level.hash.lineCheck(...args),dispatch})});
    }
    if(call.index===261){
      if(call.argumentCount!==0)throw new Error('FinishAnim accepts no arguments');
      return dispatchFinishAnim({
        animation:animationView(this,call.receiver),
        state:this.instance(call.receiver).state,
      });
    }
    if(call.index===282)return isAnimating(animationView(this,call.receiver));
    if(call.index===293)return execGetAnimGroup(call,{
      mesh:()=>this.meshPayload(call.receiver),
      log:(kind,details)=>this.warning?.({type:'GetAnimGroup',kind,...details}),
    });
    if([259,260,294].includes(call.index)){
      const name=call.index===259?'PlayAnim':call.index===260?'LoopAnim':'TweenAnim';
      if(call.index===294?call.argumentCount!==2:call.argumentCount<1||call.argumentCount>(call.index===260?4:3))
        throw new Error(`Invalid ${name} argument count`);
      const sequenceName=refValue(call.evaluateArgument(0));
      // UnrealScript encodes a skipped optional argument as EX_Nothing even
      // when a later optional argument is present (`PlayAnim('HitTorso',,
      // 0.1)`). The native P_GET_FLOAT_OPTX wrappers retain their declared
      // defaults for that hole; do the same after evaluating each expression.
      const rateArgument=call.argumentCount>1?refValue(call.evaluateArgument(1)):undefined;
      const tweenArgument=call.argumentCount>2?refValue(call.evaluateArgument(2)):undefined;
      const minRateArgument=call.argumentCount>3?refValue(call.evaluateArgument(3)):undefined;
      const rate=rateArgument===undefined?1:rateArgument;
      const tweenTime=tweenArgument===undefined?-1:tweenArgument;
      const mesh=this.meshPayload(call.receiver);
      if(!mesh){
        // Original guard logs through 0x10599a68 and returns with no state write.
        this.warning?.({type:`${name}NoMesh`,receiver:call.receiver,sequence:sequenceName});
        return;
      }
      const view=animationView(this,call.receiver);
      const log=(kind,details)=>this.warning?.({type:name,kind,...details});
      if(call.index===294)return execTweenAnim(view,mesh,sequenceName,rateArgument,log);
      if(call.index===260)return execLoopAnim(view,mesh,sequenceName,rate,tweenTime,minRateArgument??0,log);
      return execPlayAnim(view,mesh,sequenceName,rate,tweenTime,log);
    }
    if(call.index===1012){
      if(call.argumentCount<2||call.argumentCount>3)throw new Error('Invalid TweenBlendAnim argument count');
      const sequence=refValue(call.evaluateArgument(0)),time=refValue(call.evaluateArgument(1));
      const slot=call.argumentCount>2?refValue(call.evaluateArgument(2))??0:0;
      return execTweenBlendAnim(animationTickView(this,call.receiver),this.meshPayload(call.receiver),sequence,time,slot,
        (kind,details)=>this.warning?.({type:'TweenBlendAnim',kind,...details}));
    }
    if(call.index===1010){
      if(call.argumentCount<1||call.argumentCount>4)throw new Error('Invalid PlayBlendAnim argument count');
      const sequenceName=refValue(call.evaluateArgument(0));
      // Same optional-argument hole convention as PlayAnim above.
      const rateArgument=call.argumentCount>1?refValue(call.evaluateArgument(1)):undefined;
      const tweenArgument=call.argumentCount>2?refValue(call.evaluateArgument(2)):undefined;
      const slotArgument=call.argumentCount>3?refValue(call.evaluateArgument(3)):undefined;
      const rate=rateArgument===undefined?1:rateArgument;
      const tweenTime=tweenArgument===undefined?-1:tweenArgument;
      const slot=slotArgument===undefined?0:slotArgument;
      const mesh=this.meshPayload(call.receiver);
      const log=(kind,details)=>this.warning?.({type:'PlayBlendAnim',kind,...details});
      return execPlayBlendAnim(animationTickView(this,call.receiver),mesh,sequenceName,rate,tweenTime,slot,log);
    }
    if(call.index===264){
      if(call.argumentCount>6)throw new Error('PlaySound accepts at most six arguments');
      // A null Sound leaves the caller's result storage untouched.
      const result=execActorPlaySound(call,this.soundServices(call));
      return result.resultWritten?result.result:undefined;
    }
    if(call.index===1013)return execGetMeshTexture(call,this.meshTextureServices());
    if(call.index===266)return execMove(call,this.moveServices(call));
    if([500,502,504,506,508,510,527].includes(call.index))return this.pawnLocomotion(call);
    if(call.index===512)return execMakeNoise(call,this.noiseServices(call));
    // Pawn perception natives share the recovered services block
    // (docs/script-pawn-perception.md): LOS worker, target pickers, AICanSee.
    if(call.index===514)return execLineOfSightTo(call,this.perceptionServices(call));
    if(call.index===533)return execCanSee(call,this.perceptionServices(call));
    if(call.index===532)return execPlayerCanSeeMe(call,this.perceptionServices(call));
    if(call.index===531)return execPickTarget(call,this.perceptionServices(call));
    if(call.index===534)return execPickAnyTarget(call,this.perceptionServices(call));
    if(call.index===700)return execAIGetLightLevel(call,this.perceptionServices(call));
    if(call.index===701)return execAIVisibility(call,this.perceptionServices(call));
    if(call.index===705)return execAICanSee(call,this.perceptionServices(call));
    if(call.index===709){
      // execAIPickRandomDestination 0x103c86f0: nine evaluated slots; the
      // first eight are values, `dest` keeps its reference so the out-vector
      // write reaches the caller (a non-reference temp discards it).
      if(call.argumentCount!==9)throw new Error('AIPickRandomDestination requires nine arguments');
      const args=[];
      for(let i=0;i<8;i++)args.push(refValue(call.evaluateArgument(i)));
      // Validation (nav-trace.mjs): a traced pawn's pick logs its arguments, its test moves (the wrapped services) and the destination it wrote.
      const dest=call.evaluateArgument(8);
      const traced=this.navTrace?.begin(call.receiver,'aiPick',args,this.readNamed(call.receiver,'Location'));
      let written=null;
      const out=traced&&dest&&typeof dest.set==='function'?{set:value=>{written=[...value];dest.set(value);}}:dest;
      const found=execAiPickRandomDestination(call.receiver,args,out,this.pawnNavServices(call.receiver));
      traced?.end(found,{dest:Array.isArray(dest)?[...dest]:written});
      return found;
    }
    if(call.index===708){
      // execAIDirectionReachable 0x103c8560 (docs/script-pawn-nav.md): six
      // slots evaluated in declaration order, then APawn::AIDirectionReachable
      // 0x103c78a0 (the band search 709 uses) with the literal 15.0f. The exec
      // has no receiver check of its own; bestDest keeps its reference
      // (P_GET_VECTOR_REF's GPropAddr) so the body writes the caller's vector.
      if(call.argumentCount!==6)throw new Error('AIDirectionReachable requires six arguments');
      const [focus,yaw,pitch,minDist,maxDist]=[0,1,2,3,4].map(i=>refValue(call.evaluateArgument(i)));
      const dest=call.evaluateArgument(5);
      if(!Array.isArray(focus)||focus.length!==3)throw new Error('AIDirectionReachable requires an FVector focus');
      return execAiDirectionReachable(call.receiver,focus,yaw|0,pitch|0,Math.fround(minDist),Math.fround(maxDist),
        dest,this.pawnNavServices(call.receiver));
    }
    if(call.index===717){
      // execRandomBiasedRotation 0x1036dc90 evaluates (int centralYaw, float
      // yawDistribution, int centralPitch, float pitchDistribution) and calls
      // AActor::RandomBiasedRotation 0x1036d030, the same direction helper
      // native 709 uses (aiDirection, bit-exact in validate-pawn-nav). Its draws are
      // appFrand's retained x87 product, never stored as a float (0x1036d0d8 call
      // [0x10599cb8], then fadd st0,st0 on ST0; docs/rng.md), as 709's services pass
      // it: a float32 copy here moved a strafing Terrorist's sprint direction by one
      // sine-table step in Stage 5 captures cmb6 and cmb7.
      if(call.argumentCount!==4)throw new Error('RandomBiasedRotation requires four arguments');
      const [yaw,yawDist,pitch,pitchDist]=[0,1,2,3].map(i=>refValue(call.evaluateArgument(i)));
      if(typeof this.rng?.frand!=='function')throw new Error('RandomBiasedRotation requires the shared original RNG stream');
      return aiDirection(()=>this.rng.frand(),yaw|0,Math.fround(yawDist),pitch|0,Math.fround(pitchDist));
    }
    if(call.index===520){
      // execActorReachable 0x103bc1a0 (docs/script-pawn-nav.md): one object
      // slot; a None target writes 0; NavigationPoint fast path, then the
      // actor worker 0x103c0630. Bit-exact ports; this is the VM dispatch.
      if(call.argumentCount!==1)throw new Error('actorReachable requires one actor argument');
      const target=refValue(call.evaluateArgument(0))??null;
      return Boolean(actorReachable(call.receiver,target,this.pawnNavServices(call.receiver)));
    }
    if(call.index===521){
      // execPointReachable 0x103bc710: reads the vector slot and calls the
      // point worker 0x103c0d30 with arg14=0 (the eye FastLineCheck runs).
      if(call.argumentCount!==1)throw new Error('pointReachable requires one vector argument');
      const point=refValue(call.evaluateArgument(0));
      if(!Array.isArray(point)||point.length!==3)throw new Error('pointReachable requires an FVector');
      return Boolean(pointWorker(call.receiver,point.map(Math.fround),0,this.pawnNavServices(call.receiver)));
    }
    if(call.index===517){
      // execFindPathToward 0x103bc9c0: three evaluated slots (target,
      // bSinglePath=0, bClearPaths=1); the result slot receives the found
      // actor only when the worker succeeds — matching the native tail.
      const target=call.argumentCount>0?refValue(call.evaluateArgument(0)):null;
      const singleArgument=call.argumentCount>1?refValue(call.evaluateArgument(1)):undefined;
      const clearArgument=call.argumentCount>2?refValue(call.evaluateArgument(2)):undefined;
      // EX_Nothing leaves the native's pre-seeded slot untouched, just as
      // an omitted tail does (bClearPaths = 1 at Engine.dll 0x103bca11).
      const bSingle=singleArgument===undefined?0:singleArgument|0;
      const bClear=clearArgument===undefined?1:clearArgument|0;
      const traced=this.navTrace?.begin(call.receiver,'findPathToward',target,this.readNamed(call.receiver,'Location'));
      const found=execFindPathToward(call.receiver,target,bSingle,bClear,
        this.pawnNavServices(call.receiver));
      traced?.end(found);
      return found;
    }
    if(call.index===518){
      // execFindPathTo 0x103bc800: (point, bSinglePath=0, bClearPaths=1);
      // EX_Nothing keeps the pre-stored defaults, as for 517.
      const point=call.argumentCount>0?refValue(call.evaluateArgument(0)):undefined;
      if(!Array.isArray(point)||point.length!==3)throw new Error('FindPathTo requires an FVector');
      const singleArgument=call.argumentCount>1?refValue(call.evaluateArgument(1)):undefined;
      const clearArgument=call.argumentCount>2?refValue(call.evaluateArgument(2)):undefined;
      return execFindPathTo(call.receiver,point.map(Math.fround),
        singleArgument===undefined?0:singleArgument|0,clearArgument===undefined?1:clearArgument|0,
        this.pawnNavServices(call.receiver));
    }
    if(call.index===524){
      // execFindStairRotation 0x103bb880: the DeltaTime float, then the exec's inline body (script-pawn-stair-rotation.mjs,
      // docs/pawn-stair-rotation.md): up to four ULevel::SingleLineCheck calls from the pawn, the pitch to ease towards, and the
      // pitch normalisation store into ViewRotation.
      const receiver=call.receiver,level=this.levelFor(receiver);
      if(typeof level?.hash?.lineCheck!=='function')throw new Error('FindStairRotation requires the live level collision hash');
      const deltaTime=call.argumentCount>0?refValue(call.evaluateArgument(0)):0;
      const rotation=this.namedReference(receiver,'ViewRotation'),viewRotation=rotation.get();
      const state={location:this.readNamed(receiver,'Location'),viewRotation:[...viewRotation],eyeHeight:this.readNamed(receiver,'EyeHeight'),
        radius:this.readNamed(receiver,'CollisionRadius'),height:this.readNamed(receiver,'CollisionHeight')};
      const times=this.observeStairRotation?[]:null;   // a validator replays the live answers through the original exec
      const result=findStairRotation(state,deltaTime,
        {setPitch:pitch=>rotation.set([pitch,viewRotation[1],viewRotation[2]]),
          lineCheck:(start,end,extent,flags,extra)=>{
            const hit=level.hash.lineCheck(start,end,extent,flags,extra,receiver);
            times?.push(hit.time);return hit;}});
      this.observeStairRotation?.({state,deltaTime,times,result});
      return result;
    }
    if(call.index===523){
      // execEAdjustJump 0x103bc110: no parameters; SuggestJumpVelocity from
      // the pawn's Destination over a copy of its Velocity.
      return execEAdjustJump(call.receiver,this.pawnNavServices(call.receiver));
    }
    const aiEvents=this.scriptVm?.aiEvents;
    if(call.index===650&&aiEvents){
      // execInitEventManager 0x103023b0 -> 0x10384a90: the manager (aievent.rs, docs/ai-event-manager.md) for this level.
      aiEvents.init(this.levelFor(call.receiver)?.actors?.[0]??call.receiver);
      call.receiver.aiEventManager??=new Map();   // the legacy gate of the JavaScript VM below
      return;
    }
    if(aiEvents?.owns(call.receiver)&&(call.index===710||call.index===711||(call.index>=713&&call.index<=716)))
      return this.aiEventNative(aiEvents,call);
    if(call.index===650){
      // execInitEventManager 0x103023b0 -> 0x10384a90: the lazy +0x550
      // UEventManager creator LevelInfo.PreBeginPlay invokes. The Map is the
      // callback registry 710/711 populate; its presence alone gates 713-716.
      call.receiver.aiEventManager??=new Map();
      return;
    }
    if(call.index===710||call.index===711){
      // execAISetEventCallback 0x1036d440 / execAIClearEventCallback
      // 0x1036d660: both gate on XLevel->LevelInfo->+0x550, the level AI
      // event manager. The original creates that object lazily through an
      // exec-time getter (0x10384a90); until it exists the natives silently
      // return — which is also the state during LoadMap PreBeginPlay.
      // Registration is a find-or-insert keyed by (reactor, eventName) into
      // the manager's hash-bucket list (worker 0x10382990), removal the same
      // find + unlink (0x10382b90); a Map preserves the observable contract.
      const levelForManager=this.levelFor(call.receiver);
      const manager=(levelForManager?.levelInfo??levelForManager?.actors?.[0])?.aiEventManager;
      if(!manager)return;
      const eventName=refValue(call.evaluateArgument(0));
      if(call.index===711){manager.get(call.receiver)?.delete(eventName);return;}
      const callback=refValue(call.evaluateArgument(1));
      const scoreCallback=call.argumentCount>2?refValue(call.evaluateArgument(2)):'';
      // Recovered exec defaults (0x1036d4b9): visibility=1, dir=1, cylinder=0, LOS=1.
      const checks=[true,true,false,true].map((initial,index)=>
        call.argumentCount>index+3?Boolean(refValue(call.evaluateArgument(index+3))):initial);
      let callbacks=manager.get(call.receiver);
      if(!callbacks){callbacks=new Map();manager.set(call.receiver,callbacks);}
      callbacks.set(eventName,{callback,scoreCallback,checks});
      return;
    }
    if(call.index===713||call.index===714||call.index===715||call.index===716){
      // execAISendEvent 0x1036d750 / AIStartEvent 0x1036d8e0 / AIEndEvent
      // 0x1036da70 / AIClearEvent 0x1036dba0 all gate on the same lazily
      // created XLevel->LevelInfo->+0x550 manager as the callback natives
      // above; while it is absent — the LoadMap/startup state — the natives
      // silently return. Manager methods are a separate recovered boundary.
      const levelForManager=this.levelFor(call.receiver);
      const manager=(levelForManager?.levelInfo??levelForManager?.actors?.[0])?.aiEventManager;
      if(!manager)return;
      // A present manager makes the UEventManager::AI*Event methods the
      // propagation boundary; the host owns them (deferred recording now).
      if(!this.native)throw new Error('Original AI event manager is not implemented');
      return this.native({...call,runtime:this,eventManager:manager});
    }
    if(call.index===723){
      // execLastRendered 0x1036de30: fld f32 LastRenderTime (+0x34),
      // fsubr qword XLevel->TimeSeconds (+0xdc) — st0 is the x87 double
      // clock minus the float field — then fcom 0.0f keeps st0 unless the
      // C0 branch fires, so the f32 result is max(delta, 0) and NaN clamps
      // to 0 like any unordered compare.
      const clock=this.soundField(call.receiver,'TimeSeconds');
      const last=Math.fround(this.readNamed(call.receiver,'LastRenderTime'));
      const delta=clock-last;
      return delta<0||Number.isNaN(delta)?0:Math.fround(delta);
    }
    if(call.index===2100||call.index===2101||call.index===2102){
      if(call.argumentCount!==0)throw new Error('ConBindEvents accepts no arguments');
      return this.bindConversationEvents(call.receiver);
    }
    if(call.index>=2105&&call.index<=2107)return execPawnAlliance(call,this.allianceServices());
    if(call.index===2108||call.index===2109)
      return execPawnCarcass(call,{read:(actor,name)=>this.readNamed(actor,name),write:(actor,name,value)=>this.writeNamed(actor,name,value)});
    if(call.index===113){
      if(call.argumentCount>2)throw new Error('GotoState accepts at most two name arguments');
      // Core.dll execGotoState 0x1013dd00: before either Stack.Step the state
      // slot holds the current state's name (StateFrame->StateNode->Name when
      // that node is not the class, else None) and the label slot None, which
      // GotoLabel reads as Begin. EX_Nothing keeps them, so Mover's
      // MakeGroupReturn `GotoState( , 'Close' )` stays in its state.
      const current=this.instance(call.receiver).state?.stateNode?.record.name??'None';
      const stateArgument=call.argumentCount?refValue(call.evaluateArgument(0)):undefined;
      const labelArgument=call.argumentCount>1?refValue(call.evaluateArgument(1)):undefined;
      const name=stateArgument===undefined?current:stateArgument;
      const label=labelArgument===undefined?'None':labelArgument;
      this.gotoState(call.receiver,name,label);return;
    }
    if(call.index===281||call.index===284){
      if(call.argumentCount!==(call.index===281?1:0))throw new Error('Invalid state-query argument count');
      // Evaluate the argument before reading the receiver's current state.
      const name=call.index===281?refValue(call.evaluateArgument(0)):null;
      const instance=this.instance(call.receiver);
      const node=instance.state?(instance.state.stateNode??instance.cls):null;
      return call.index===281?scriptIsInState(node,name):scriptGetStateName(node);
    }
    if(call.index===117||call.index===118){
      if(call.argumentCount!==1)throw new Error('Enable/Disable require one probe-name argument');
      const name=lower(refValue(call.evaluateArgument(0))||'None'),ename=probeNames.get(name);
      const instance=this.instance(call.receiver),state=instance.state;
      if(ename===undefined||!state){
        this.warning?.({type:'InvalidProbe',native:call.index,name});return;
      }
      const bit=ename-0x12c,word=bit>>>5,mask=1<<(bit&31);
      if(call.index===118)state.probeMask=state.probeMask.with(word,(state.probeMask[word]&~mask)>>>0);
      else{
        const metadata=state.stateNode?.script??instance.cls.metadata;
        const allowed=(instance.cls.metadata.probeMask[word]|metadata.probeMask[word])&metadata.ignoreMask[word];
        state.probeMask=state.probeMask.with(word,(state.probeMask[word]|(mask&allowed))>>>0);
      }
      return;
    }
    if(call.index===303){
      if(call.argumentCount!==1)throw new Error('IsA requires one class-name argument');
      const name=lower(refValue(call.evaluateArgument(0))||'None');
      for(let cls=this.instance(call.receiver).cls;cls;cls=cls.base)if(lower(cls.record.name)===name)return true;
      return false;
    }
    if(call.index===258){
      // ClassIsChildOf(TestClass, ParentClass): walk the test class's linked
      // ancestry for the parent class record (pure Core ancestry test).
      if(call.argumentCount!==2)throw new Error('ClassIsChildOf requires two class arguments');
      const child=refValue(call.evaluateArgument(0)),parent=refValue(call.evaluateArgument(1));
      if(!child||!parent)return false;
      for(let cls=child.linkedClass;cls;cls=cls.base)if(cls.record===parent)return true;
      return false;
    }
    if(call.index===256){
      if(call.argumentCount!==1)throw new Error('Sleep requires one duration argument');
      const seconds=refValue(call.evaluateArgument(0));
      return sleepActor(this.latentFloat(call.receiver),this.instance(call.receiver).state,seconds);
    }
    if(call.index===280){
      if(call.argumentCount!==2)throw new Error('SetTimer requires rate and loop arguments');
      const rate=refValue(call.evaluateArgument(0)),loop=refValue(call.evaluateArgument(1));
      return setActorTimer(this.timerState(call.receiver),rate,loop);
    }
    if(call.index===536){
      // execSaveConfig 0x1013e6e0: P_FINISH, then SaveConfig(CPF_Config, NULL).
      if(call.argumentCount!==0)throw new Error('SaveConfig accepts no arguments');
      return this.saveObjectConfig(call.receiver);
    }
    if(call.index===3016){
      // DeusExPlayer.UnloadTexture (DeusEx.dll exec 0x10014c90): for a
      // non-null texture, Unload() the lazy DataArray (+0x10) of each 0x28-byte
      // FMipmap in Mips (GOTY UTexture +0xa4 data, +0xa8 count; the SDK
      // header's +0xa8 is 4 bytes off). The runtime keeps no loaded mip data on
      // texture objects: pixels are decoded from the package bytes at each use,
      // so no resident array exists to release (docs/script-window-checkbox.md).
      if(call.argumentCount!==1)throw new Error('UnloadTexture requires one texture argument');
      refValue(call.evaluateArgument(0));
      return undefined;
    }
    // Extension window/GC natives owned by the installed window host
    // (src/runtime/script-window-host.mjs); unhandled indices fall through.
    const windowNative=this.windowLifecycle?.handleNative?.(call);
    if(windowNative?.handled)return windowNative.value;
    if(!this.native)throw new Error(`Unimplemented original native ${call.index}`);
    return this.native({...call,runtime:this});
  }
  timerState(receiver) {
    if(!this.actorClass)throw new Error('Actor timer fields are not linked');
    const state={};this.instance(receiver);
    for(const [key,name] of [['timerRate','TimerRate'],['timerCounter','TimerCounter'],['timerLoop','bTimerLoop']]){
      const field=this.lookupMember(this.actorClass,'fields',name);
      Object.defineProperty(state,key,{get:()=>this.readField(receiver,field),
        set:value=>this.writeField(receiver,field,value),enumerable:true});
    }
    return state;
  }
  /** Original animation phase, before the script Tick/ProcessState phases.
   * Caller owns Actor.Tick admission/order and prepares reachable callbacks. */
  processActorAnimation(receiver,seconds) {
    const animation=this.animationTick(receiver);
    return tickActorAnimation(animation,seconds,{
      mesh:()=>this.meshPayload(receiver),simulatedPawn:animation.simulatedPawn,
      findFunction:(name,checked)=>this.animationFunction(receiver,name,checked),
      processEvent:record=>this.animationEvent(receiver,record),
    });
  }
  /** The animation phase's view of an attached actor. It only forwards to
   * the actor's fields, and the phase writes through its accessors alone,
   * so one view serves every tick of an instance. */
  animationTick(receiver) {
    const instance=this.instance(receiver);
    let animation=animationTickViews.get(instance);
    if(!animation)animationTickViews.set(instance,animation=animationTickView(this,receiver));
    return animation;
  }
  /** The animation phase's FindFunction (checked: FindFunctionChecked). */
  animationFunction(receiver,name,checked) {
    const record=this.lookup(receiver,name);
    if(!record&&checked)throw new Error(`Original animation event was not found: ${name}`);
    return record;
  }
  /** The animation phase's ProcessEvent of a found function. */
  animationEvent(receiver,record) {
    return this.processEvent(receiver,record.name,[],null,record);
  }
  /** Recovered standalone per-actor Tick. The level scheduler supplies its
   * clock/tag/deferred list and reached native physics/input/visibility services.
   * Startup and world actor iteration are not invented by this entry point. */
  processActorTick(receiver,seconds,options) {
    // processLevelTick passes one options object per tick type for every
    // actor; its services are the same for each, so build them once.
    const shared=this.levelTickActorOptions?.has(options)===true;
    let entry=shared?this.levelTickActorServices?.get(options):undefined;
    if(!entry){
      entry=this.actorTickServices(options);
      if(shared)(this.levelTickActorServices??=new WeakMap()).set(options,entry);
    }
    // R3-d: the Rust interpreter runs the body on the actor's image
    // (actor-tick-kernel.mjs), AScriptedPawn::Tick included for a ScriptedPawn;
    // undefined hands the tick to JavaScript.
    const kernel=this.scriptVm?.actorTick;
    if(kernel?.enabled){
      const result=kernel.run(receiver,seconds,entry);
      if(result!==undefined)return result;
    }
    // DeusEx.dll's AScriptedPawn::Tick (0x100195a0) is the Tick virtual of every ScriptedPawn: its native timers and bookkeeping
    // run first, then AActor::Tick (below), unless it destroyed the pawn.
    if(this.isScriptedPawn(receiver)&&!scriptedPawnTick(receiver,seconds,entry.tickType,this.scriptedPawnTickServices(entry.services)))return 1;
    return tickStandaloneActor(receiver,seconds,entry.tickType,entry.services);
  }
  /** Whether the actor's class is DeusEx.ScriptedPawn or derives from it (cached by class). */
  isScriptedPawn(receiver) {
    const cls=(receiver?.[this.instanceKey]??this.instances.get(receiver))?.cls;
    if(!cls)return false;
    const cache=this.scriptedPawnClasses??=new WeakMap();
    let known=cache.get(cls);
    if(known===undefined){
      known=false;
      for(let c=cls;c;c=c.base)if(c.record?.key==='deusex.scriptedpawn'){known=true;break;}
      cache.set(cls,known);
    }
    return known;
  }
  /** The services scripted-pawn-tick.mjs takes: the tick's own, with the original's FindFunctionChecked and InStasis. */
  scriptedPawnTickServices(services) {
    return (services.scriptedPawn??=Object.freeze({
      read:services.read,write:services.write,level:services.level,processEvent:services.processEvent,
      destroyActor:services.destroyActor,
      findFunction:(actor,name)=>this.lookup(actor,name)?.function??null,
      inStasis:actor=>actorInStasis(actor,services),
    }));
  }
  actorTickServices({tickType=2,...nativeServices}) {
    return {tickType,services:{
      showSelf:actor=>this.showPawnSelf(actor,nativeServices),
      checkEnemyVisible:actor=>this.checkPawnEnemyVisible(actor,nativeServices),
      ...nativeServices,
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
      isA:(actor,key)=>{
        for(let cls=this.instance(actor).cls;cls;cls=cls.base)if(cls.record.key===key)return true;
        return false;
      },
      isProbing:(actor,name)=>this.isProbing(actor,name),
      advanceAnimation:(actor,delta)=>this.processActorAnimation(actor,delta),
      processState:(actor,delta)=>this.instance(actor).state.process(delta),
      processEvent:(actor,name,args)=>this.processEvent(actor,name,args),
      destroyActor:(actor,force)=>this.destroyActor(actor,Boolean(force)),
      performPhysics:(actor,delta)=>this.processActorPhysics(actor,delta),
      // processEvent above is this runtime's own: the Rust actor tick may
      // dispatch its events in Rust (dispatch.rs).
      runtimeEvents:true,
    }};
  }
  /** Paused ULevel.Tick's derived-to-base FloatProperty/CPF_Input traversal.
   * Original writes one DWORD even when the property has multiple elements. */
  resetActorInput(receiver) {
    for(let cls=this.instance(receiver).cls;cls;cls=cls.base)for(const field of cls.propertyOrder) {
      if(field.metadata.type!=='float'||!(field.metadata.flags&4))continue;
      const ref=this.fieldReference(receiver,field);
      (field.metadata.arrayDim>1?arrayReference(0,ref,this.warning):ref).set(0);
    }
  }
  /** Original standalone world scheduling over an already prepared actor array.
   * Native entry/exit memory/counters, calendar, viewport, physics/visibility,
   * event manager and exact FString allocation count remain explicit services. */
  processLevelTick(level,seconds,{tickType=2,...nativeServices}) {
    // Released image ranges become reusable before any actor runs.
    this.reclaimReleased();
    // Every actor of this scheduler tick receives the same nativeServices
    // snapshot; one options object per tick type replaces a copy per actor.
    const actorOptions=new Map();
    return tickStandaloneLevel(level,seconds,tickType,{
      ...nativeServices,
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
      isA:(actor,key)=>{
        for(let cls=this.instance(actor).cls;cls;cls=cls.base)if(cls.record.key===key)return true;
        return false;
      },
      tickActor:(actor,delta,type)=>{
        let options=actorOptions.get(type);
        if(!options){
          actorOptions.set(type,options={...nativeServices,level,tickType:type});
          (this.levelTickActorOptions??=new WeakSet()).add(options);
        }
        const run=()=>this.processActorTick(actor,delta,options);
        return nativeServices.aroundActorTick?nativeServices.aroundActorTick(actor,run):run();
      },
      processEvent:(actor,name,args)=>this.processEvent(actor,name,args),
      resetInputProperties:actor=>this.resetActorInput(actor),
      cleanupDestroyed:(world,force)=>this.cleanupDestroyed(world,Boolean(force)),
      playerDistances:this.scriptVm?.render?(actors,start,origin,reference)=>
        this.scriptVm.render.playerDistances(actors,start,origin,reference):null,
    });
  }
  /** Caller supplies Actor.Tick eligibility and ordering. This is only its
   * ProcessState → timer phase, before the separate physics implementation. */
  processActorScript(receiver,seconds) {
    this.instance(receiver).state.process(seconds);
    return updateActorTimer(this.timerState(receiver),seconds,()=>this.processEvent(receiver,'Timer'));
  }
  /** Original APawn::performPhysics (Engine.dll 0x103c9a70) for a
   * script-attached map pawn: physWalking/physFalling dispatch, the
   * physicsRotation gate, MoveTimer decay and AvgPhysicsTime averaging. World
   * queries come from the live level hash; the synchronous move path never
   * populates the original PendingTouch tail. Physics modes outside
   * {Walking=1,Falling=2,Swimming=3,Flying=4}, non-Pawn actors and the unsupported zone-event
   * branches stay explicit boundaries. */
  /** Shared live-level services for the script-attached pawn consumers:
   * performPhysics (processActorPhysics) and the native-709 pick chain. Field
   * reads route through namedReference bindings; world queries come from the
   * level collision hash; zone events dispatch through processEvent. */
  pawnPhysicsServices(receiver) {
    const level=this.levelFor(receiver),that=this;
    if(!level?.hash)throw new Error('Pawn physics requires the level collision hash');
    return {
      field:(actor,name)=>this.namedReference(actor,name),
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
      // The class default object's value (UClass::Defaults), e.g. physPathing's
      // FovAngle scale.
      classDefault:(actor,name)=>{
        const cls=this.instance(actor).cls;
        return this.classDefaultReference(cls,this.lookupMember(cls,'fields',name)).get();
      },
      isA:(actor,key)=>{
        for(let cls=this.instance(actor).cls;cls;cls=cls.base)if(cls.record.key===key)return true;
        return false;
      },
      level,worldActor:level.hash.levelInfo,
      // ZoneInfo fields on an attached zone read through namedReference (live
      // store); the hash levelInfo's values carry the same serialized slots.
      zoneFields:zone=>{
        const read=name=>{try{return this.readNamed(zone,name);}catch{return zone?.values?.[name];}};
        return {get ZoneGravity(){return read('ZoneGravity');},get ZoneVelocity(){return read('ZoneVelocity');},
          get ZoneTerminalVelocity(){return read('ZoneTerminalVelocity');},get ZoneGroundFriction(){return read('ZoneGroundFriction');},
          get ZoneFluidFriction(){return read('ZoneFluidFriction');},get bWaterZone(){return read('bWaterZone');}};
      },
      dispatch:(target,name,args=[])=>{
        const record=this.lookup(target,name);
        if(!record)return undefined;
        if(!record.function)throw new Error(`Original event is not prepared: ${record.key}`);
        // A native caller of a value-returning event (CheckEncroachment's EncroachingOn) passes ProcessEvent a result block, as dispatchSpawnedEvent does.
        if(record.function.result)return this.dispatchSpawnedEvent(target,name,args);
        return this.processEvent(target,name,args);
      },
      isProbing:(actor,name)=>this.isProbing(actor,name),
      // SetActorZone's common case in Rust (zone-kernel.mjs): whether it
      // completed there; otherwise the JavaScript body runs.
      zoneUpdate:(actor,test,force)=>this.scriptVm?.zone?.update(actor,level,test,force)??false,
      // The MoveActor based-rider section recurses into MoveActor for each
      // based child; only spawned collision-view actors are admitted there.
      moveRider:(other,delta,rotation)=>this.moveSpawnedActor(other,delta,rotation),
      // The pawn's MoveActor body in Rust (move-pawn-kernel.mjs, B4): the
      // result, or undefined when the JavaScript body must run.
      movePawn:(pawn,delta,rotation,ignoreBases,ops)=>this.scriptVm?.movePawn?.move(pawn,delta,rotation,ignoreBases,ops),
      // The dry walking loop in Rust (walk-loop-kernel.mjs, B5): whether it
      // ran there; otherwise the JavaScript body runs.
      walkLoop:(pawn,seconds,iterations,ops)=>this.scriptVm?.walkLoop?.walk(pawn,seconds,iterations,ops)??false,
      // Validation (nav-trace.mjs): a traced pawn's physics moves are logged; undefined (no cost) otherwise.
      get moveTrace(){return that.navTrace?.physicsMove(receiver);},
      // appFrand's x87 result, not stored as a float32: processLanded (0x103cf52d) multiplies, subtracts and adds on ST0 and stores once into Velocity
      // (landing.mjs). The product of the 15-bit integer and the float32 1/32767 is exact in binary64, and so are the steps after it; rounding it here
      // moved a landing's random velocity by one float32 ulp (Stage 5 led1: the original's Velocity.X -15.166173 against Play's -15.1661739).
      random:()=>{
        if(typeof this.rng?.frand!=='function')throw new Error('Pawn physics requires the shared original RNG stream');
        return this.rng.frand();
      },
    };
  }
  processActorPhysics(receiver,seconds) {
    // Actor.Tick dispatches vtable +0x8c: APawn::performPhysics for pawns, the
    // non-Pawn AActor::performPhysics (actor-physics.mjs) otherwise, whose
    // movement services the Play host links (this.actorPhysics).
    let pawn=false;
    for(let cls=this.instance(receiver).cls;cls;cls=cls.base)if(cls.record.key==='engine.pawn'){pawn=true;break;}
    if(!pawn){
      if(typeof this.actorPhysics!=='function')throw new Error('Non-Pawn AActor::performPhysics is not linked');
      return this.actorPhysics(receiver,seconds);
    }
    return runScriptPawnPhysics(receiver,seconds,this.pawnPhysicsServices(receiver));
  }
  /** Native 709 AIPickRandomDestination services (docs/script-pawn-nav.md):
   * the oracle-validated direction/search/worker chain drives the live pawn
   * through the pawnPhysicsView — Location/Velocity bindings, the Region and
   * FootRegion zone reads, MoveActor(bTest=1,bIgnorePawns=1) probes through
   * the recovered test-move, and FarMoveActor(test=1,noCheck=1) restores. The
   * +0xd0 CollideFlag byte is Region.ZoneNumber; +0x444 is ReducedDamageType.
   * Water zones run the recovered swimMove/swimReachable over the same seam;
   * findWaterLine reads pointRegion and Region.Zone below. A bCanJump pawn's
   * walkReach runs the recovered FindBestJump, whose jumpLanding reads the
   * Region zone's ZoneGravity/ZoneVelocity/ZoneFluidFriction and whose
   * "FAILING FBJ" debugf goes to the GLog device as NAME_Log (0x2f8). */
  pawnNavServices(receiver) {
    const base=this.pawnPhysicsServices(receiver),level=base.level;
    const view=pawnPhysicsView(receiver,base);
    const navZone=zone=>{
      if(!zone)return {water:false,pain:false,damageType:'None',gravityZ:undefined};
      const read=name=>{try{return this.readNamed(zone,name);}catch{return zone?.values?.[name];}};
      const vector=name=>{const v=read(name);return v&&v.length===3?Array.from(v,Math.fround):undefined;};
      const friction=read('ZoneFluidFriction');
      return {water:Boolean(read('bWaterZone')),pain:Boolean(read('bPainZone')),
        damageType:read('DamageType')??'None',gravityZ:read('ZoneGravity')?.[2],
        gravity:vector('ZoneGravity'),velocity:vector('ZoneVelocity'),
        fluidFriction:typeof friction==='number'?Math.fround(friction):undefined};
    };
    const zoneOf=(actor,name)=>this.readNamed(actor,name)?.['engine.actor.pointregion.zone']
      ??level.pointRegion(view.position).zone;
    /* The native reach workers read packed bool words directly. Bind the
     * consumed masks at Actor +0x1dc, Pawn +0x318 and Mover +0x4ec to their
     * named VM fields (docs/script-pawn-nav.md). Actor's collision word is
     * distinct from its +0x28 flags: bNoDelete must never stand in for
     * bBlockActors. Only verified bits are exposed for the partial words. */
    const flagWords={
      Flags318:[['bBehindView',0x1],['bIsPlayer',0x2],['bJustLanded',0x4],['bUpAndOut',0x8],
        ['bIsWalking',0x10],['bHitSlopedWall',0x20],['bNeverSwitchOnPickup',0x40],['bWarping',0x80],
        ['bUpdatingDisplay',0x100],['bCanStrafe',0x200],['bFixedStart',0x400],['bReducedSpeed',0x800],
        ['bCanJump',0x1000],['bCanWalk',0x2000],['bCanSwim',0x4000],['bCanFly',0x8000],
        ['bCanOpenDoors',0x10000],['bCanDoSpecial',0x20000],['bDrowning',0x40000],['bLOSflag',0x80000],
        ['bFromWall',0x100000],['bHunting',0x200000],['bAvoidLedges',0x400000],['bStopAtLedges',0x800000],
        ['bJumpOffPawn',0x1000000],['bShootSpecial',0x2000000],['bAutoActivate',0x4000000],['bIsHuman',0x8000000],
        ['bIsFemale',0x10000000],['bIsMultiSkinned',0x20000000],['bCountJumps',0x40000000],['bAdvancedTactics',0x80000000]],
      // actorWorker tests bit2 at 0x103c0b26. These low collision bits are
      // also recovered by AActor::SetCollision; no upper bits are consumed.
      Flags1dc:[['bCollideActors',0x1],['bCollideWorld',0x2],
        ['bBlockActors',0x4],['bBlockPlayers',0x8]],
      // +0x4ec bit3 is the only Mover flag the nav workers read (scoutD/
      // directReach): bPlayerOnly. The word's other bits are unverified.
      Flags4ec:[['bPlayerOnly',0x8]],
    };
    const flagRead=(actor,name)=>flagWords[name].reduce((w,[field,mask])=>{
      let set=false;
      try{set=Boolean(this.readNamed(actor,field));}catch{set=false;}
      return w|(set?mask:0);
    },0)>>>0;
    const flagWrite=(actor,name,v)=>{
      for(const [field,mask] of flagWords[name]){
        try{this.writeNamed(actor,field,Boolean(v&mask));}catch{/* field absent on this class */}
      }
    };
    const ref=(actor,name)=>this.namedReference(actor,name);
    const services={
      read:(actor,name)=>name==='CollideFlag'
        ?(this.regionValue(actor).zoneNumber??0)&0xff      // pawn+0xd0 byte
        :name in flagWords?flagRead(actor,name)
        :ref(actor,name).get(),
      write:(actor,name,v)=>name in flagWords?flagWrite(actor,name,v):ref(actor,name).set(v),
      level:actor=>this.levelFor(actor),
      model:lvl=>lvl?.model,
      // ULevel nav surface: LevelInfo.NavigationPointList (+0x548), the
      // +0x42c nextNavigationPoint chain, the spec index arrays (+0x360
      // Paths / +0x3a0 PrunedPaths / +0x320 upstreamPaths) and the level
      // ReachSpec table resolved to live actors by the scene.
      navListHead:actor=>{
        const lvl=this.levelFor(actor);
        return ref(lvl?.actors?.[0],'NavigationPointList')?.get()??null;
      },
      nextNav:nav=>ref(nav,'nextNavigationPoint').get()??null,
      paths:nav=>ref(nav,'Paths').get(),
      upstreamPaths:nav=>ref(nav,'upstreamPaths').get(),
      prunedPaths:nav=>ref(nav,'PrunedPaths').get(),
      reachSpecTable:actor=>this.levelFor(actor)?.reachSpecs??[],
      pointRegion:point=>navZone(level.pointRegion(point)?.zone),
      fastLineCheck:(model,first,second)=>fastLineCheck(model,first,second),
      // ULevel::SingleLineCheck (&hit, source, end, start, flags, extent,
      // extra): the level-queries port returns {time, actor} with actor null
      // on a clear trace.
      singleLineCheck:(source,end,start,flags,extent,extra)=>{
        const lvl=this.levelFor(source);
        if(!lvl?.hash?.lineCheck)throw new Error('FindPathToward requires the live level collision hash');
        return lvl.hash.lineCheck(start,end,extent,flags,extra,source);
      },
      // SpecialCost (NavigationPoint event, int) and SpecialHandling (Actor
      // event, actor) are script dispatches with declared return values.
      specialCost:(nav,pawn)=>this.dispatchSpawnedEvent(nav,'SpecialCost',[pawn])|0,
      specialHandling:(node,pawn)=>this.dispatchSpawnedEvent(node,'SpecialHandling',[pawn])??null,
      isProbing:(actor,name)=>this.isProbing(actor,name),
      location:actor=>this.readNamed(actor,'Location'),
      velocity:actor=>{
        // The workers restore Velocity by mutating the returned vector. A map
        // actor's velocity member is its image field (actor-mirror-fields.mjs),
        // whose element-writable view stores each component; otherwise bind
        // it to a live host array (a field read copies).
        const live=liveVector(actor,'velocity');
        if(live)return live;
        if(!Array.isArray(actor.velocity))actor.velocity=this.readNamed(actor,'Velocity');
        return actor.velocity;
      },
      regionZone:actor=>navZone(zoneOf(actor,'Region')),
      footZone:actor=>navZone(zoneOf(actor,'FootRegion')),
      zoneGravity:actor=>Math.fround(navZone(zoneOf(actor,'Region')).gravityZ??-950),
      isA:(actor,key)=>{
        // 'NavPoint' is the native's ANavigationPoint key (scoutA/exec gates).
        let tail=lower(String(key).split('.').pop());
        if(tail==='navpoint')tail='navigationpoint';
        for(let cls=this.instance(actor)?.cls;cls;cls=cls.base)if(lower(cls.record.name)===tail)return true;
        return false;
      },
      gIsEditor:()=>false,
      // GLog->Logf (Core 0x101453e0) serializes with NAME_Log, index 0x2f8
      // (Core's name registration at 0x1014cd9d). The %f/%d text is JS
      // formatting of the exact arguments, not MSVCRT's printf.
      logf:event=>{
        const device=typeof this.logDevice==='function'?this.logDevice
          :typeof this.logDevice?.log==='function'?entry=>this.logDevice.log(entry):null;
        if(!device)throw new Error(`${event.source} requires the original synchronous GLog output device`);
        let next=0;
        const text=event.format.replace(/%[fd]/g,spec=>{const v=event.args[next++];return spec==='%d'?String(v|0):v.toFixed(6);});
        device(Object.freeze({text,tag:'Log',tagIndex:0x2f8,source:event.source,args:Object.freeze([...event.args])}));
      },
      frand:()=>{
        if(typeof this.rng?.frand!=='function')throw new Error('AIPickRandomDestination requires the shared original RNG stream');
        return this.rng.frand();
      },
      moveActor:(actor,delta,rotation,flags)=>{
        if(actor!==receiver)throw new Error('AIPickRandomDestination MoveActor on a non-receiver actor is unlinked');
        return view.testMove(delta,rotation,flags);
      },
      farMoveActor:(actor,dest,test,noCheck)=>{
        if(actor!==receiver)throw new Error('AIPickRandomDestination FarMoveActor on a non-receiver actor is unlinked');
        return view.farMove(dest,test,noCheck);
      },
      // A native member call on another actor (FindPathToward's falling
      // target runs target->jumpLanding) moves that actor: its own services.
      forActor:actor=>actor===receiver?services:this.pawnNavServices(actor),
    };
    // Validation (nav-trace.mjs): the boundary calls of a traced pawn's natives are logged.
    return this.navTrace?this.navTrace.wrap(services,receiver):services;
  }
  createIterator(call) {
    if(call.index===309||call.index===1000||call.index===1003){
      // execTraceActors/execTraceTexture/execTraceVisibleActors run one
      // MultiLineCheck at IteratorStart and publish each hit list node in
      // order; see docs/script-trace.md.
      const create=call.index===309?createTraceActorsIterator
        :call.index===1003?createTraceVisibleActorsIterator:createTraceTextureIterator;
      return create({...call,levelFor:this.levelFor,readActor:(actor,name)=>this.readNamed(actor,name)});
    }
    if(call.index===310||call.index===311||call.index===312||call.index===306||call.index===1002){
      // execRadiusActors/execVisibleActors/execBasedActors/execCycleActors
      // scan Level->Actors in native order; the candidate Class->+0x28
      // ancestry walk is the attached instance's cls chain, same as
      // AllActors. See docs/script-actor-queries.md.
      if(!this.actorClass||!this.levelFor)throw new Error('Actor iterators require a linked original actor array');
      const isA=(actor,base)=>this.classIsA(this.instance(actor).cls,base);
      if(call.index===306){
        // The native compares candidate->+0xc4 (the Base property) to the
        // receiver; fieldReference reads the attached field storage.
        const baseField=this.lookupMember(this.actorClass,'fields','Base');
        return createBasedActorsIterator({...call,actorClass:this.actorClass.record,
          levelFor:this.levelFor,isA,baseOf:actor=>this.fieldReference(actor,baseField).get()});
      }
      if(call.index===1002){
        // The scan loop runs in the Rust core when the script VM has it.
        const render=this.scriptVm?.render;
        return createCycleActorsIterator({...call,actorClass:this.actorClass.record,levelFor:this.levelFor,isA,
          scan:render?(array,cursor,steps,bound,base)=>render.cycleScan(array,cursor,steps,bound,base):null});
      }
      if(call.index===310)return createRadiusActorsIterator({...call,actorClass:this.actorClass.record,levelFor:this.levelFor,isA});
      // execVisibleCollidingActors 0x103e55b0: the list is the collision hash's ActorRadiusCheck 0x103589e0
      // (collision-hash-radius.mjs), filtered by class, bHidden and Model->FastLineCheck.
      if(call.index===312)return createVisibleCollidingActorsIterator({...call,actorClass:this.actorClass.record,levelFor:this.levelFor,isA,
        actorWord:actor=>actorWordOf(this.instance(actor)),
        radiusActors:(level,query)=>{
          const hash=level?.hash?.hash;
          if(typeof hash?.cellCandidates!=='function')throw new Error('VisibleCollidingActors requires the level collision hash');
          return actorRadiusCheck(hash,query,actor=>actor.position);
        }});
      // VisibleActors tests the candidate's whole +0x28 word for bHidden.
      return createVisibleActorsIterator({...call,actorClass:this.actorClass.record,levelFor:this.levelFor,isA,
        actorWord:actor=>actorWordOf(this.instance(actor))});
    }
    if(call.index===1004){
      // execReachablePathnodes 0x103c8bb0 over APawn::GetPathnodeList
      // 0x103c6490, with the receiver's pawn-nav seam; see
      // docs/script-pawn-nav.md.
      return createReachablePathnodesIterator({...call,services:this.pawnNavServices(call.receiver)});
    }
    if(call.index!==304)throw new Error(`Original iterator native is not implemented: ${call.index}`);
    if(!this.actorClass||!this.levelFor)throw new Error('AllActors requires a linked original actor array');
    const tag=this.lookupMember(this.actorClass,'fields','Tag');
    return createAllActorsIterator({...call,actorClass:this.actorClass.record,levelFor:this.levelFor,
      isA:(actor,base)=>this.classIsA(this.instance(actor).cls,base),
      tagOf:actor=>this.fieldReference(actor,tag).get(),
    });
  }
  /** processEvent's Level gate, after GIsScriptable: false when the event
   * is not dispatched. (The Rust event dispatch, dispatch.rs, runs both.) */
  eventLevelGate(receiver,instance) {
    // AActor::ProcessEvent 0x10369100 precedes Core's body on world actors:
    // actor.Level (+0xa8), LevelInfo flags (+0x4f0), mask bBegunPlay (2).
    // Standalone Core-event fixtures have no linked world/Actor.Level slot.
    if(this.levelFor(receiver)&&reachesActor(instance.cls)) {
      const info=this.readNamed(receiver,'Level');
      if(info && !this.readNamed(info,'bBegunPlay'))return false;
    }
    return true;
  }
  /** Core ProcessEvent's ordinary script/typed parameter path. The supplied
   * argument array represents the caller's parameter block: every parameter
   * is copied back, including those without OutParm. A declared ReturnParm
   * uses an explicit caller-owned result reference. Native object hooks remain
   * an unsupported boundary. */
  processEvent(receiver,name,args=[],resultReference=null,selectedRecord=null) {
    if(!this.scriptability())return false;
    // The recovered table covers every reserved probe index. Any other valid
    // loaded function name is outside that interval and bypasses its mask gate.
    const instance=this.instance(receiver),ename=probeNames.get(lowerName(name))??-1;
    if(!this.eventLevelGate(receiver,instance))return false;
    if(instance.state&&!instance.state.isProbing(ename))return false;
    const record=selectedRecord??this.lookup(receiver,name),fn=record?.function;
    if(!fn)throw new Error(`Original event is not prepared: ${record?.key??name}`);
    // 1013f850 first rejects any nonzero IsPendingKill result. Only then does
    // 1013f858 compare its zero low word with iNative.
    if(instance.pendingKill||(fn.script.nativeIndex&0xffff)!==0)return false;
    if(fn.script.functionFlags&0x400){
      // 1013f862: a FUNC_Native function first goes to ProcessRemoteFunction
      // (vtable +0x18), which absorbs it when nonzero; otherwise 1013f936
      // calls UFunction::Func with the copied parameter block.
      if(this.processRemoteFunction(receiver,fn.script.functionFlags))return false;
      const body=NATIVE_EVENT_BODIES[record.key];
      if(!body)throw new Error(`Native ProcessEvent hook is not implemented: ${record.key}`);
      if(fn.result||args.length!==fn.parameters.length)throw new Error(`Native ProcessEvent parameter block mismatch: ${record.key}`);
      body.call(this,receiver,args.map((value,index)=>copyValue(fn.parameters[index],value)));
      return true;
    }
    if(fn.result&&(!resultReference?.reference||typeof resultReference.get!=='function'||typeof resultReference.set!=='function'))
      throw new Error(`Return-value ProcessEvent requires a caller result reference: ${record.key}`);
    if(args.length!==fn.parameters.length)throw new Error(`Incomplete ProcessEvent parameter block: ${record.key}`);
    const stack=this.classLoader?this.frameStack():null,stackIndex=stack?.index,stackTop=stack?.top;
    try{
    const locals=createFrameLocals(fn,this.classLoader,stack),parameters=fn.parameters;
    for(let index=0;index<parameters.length;index++)locals.set(parameters[index].key,copyValue(parameters[index],args[index]));
    if(fn.result)locals.set(fn.result.key,copyValue(fn.result,resultReference.get()));
    const suppressed=Boolean((fn.script.functionFlags&0x20)&&instance.singular);
    const result=this.executeScript(fn,receiver,locals);
    // ProcessInternal's return expression writes into Locals+ReturnValueOffset.
    // Singular suppression (and a void Return expression) leaves that slot as
    // copied from the caller rather than fabricating a zero return value.
    if(fn.result&&!suppressed&&result!==undefined)locals.set(fn.result.key,copyValue(fn.result,result));
    for(let index=0;index<parameters.length;index++)args[index]=copyValue(parameters[index],locals.get(parameters[index].key));
    if(fn.result)resultReference.set(copyValue(fn.result,locals.get(fn.result.key)));
    this.destroyFunctionLocals(fn,locals,{parameters:false});
    return true;
    }finally{stack?.restore(stackIndex,stackTop);}
  }
  /** The linked class whose default object a class-context receiver names. */
  defaultObjectClass(receiver) {
    if(!receiver.linkedClass)throw new Error(`Class-context call requires a linked class: ${receiver.key}`);
    return receiver.linkedClass;
  }
  executeScript(fn,receiver,locals) {
    // A class-context call runs on the class default object; its singular
    // guard is that object's own flag, kept per class.
    const instance=receiver?.kind==='Class'&&!this.instances.has(receiver)
      ?((this.defaultObjectStates??=new WeakMap()).get(receiver)
        ??this.defaultObjectStates.set(receiver,{singular:false}).get(receiver))
      :this.instance(receiver),singular=Boolean(fn.script.functionFlags&0x20);
    if(singular&&instance.singular)return fn.result?zeroValue(fn.result):undefined;
    if(singular)instance.singular=true;
    try{return fn.compiled.run(receiver,locals,this.services);}
    finally{if(singular)instance.singular=false;}
  }
  callFunction(record,receiver,argumentCount=0,evaluateArgument=()=>undefined,context={}) {
    const boundary=this.boundaryFunctions.get(record.key);
    if(boundary)return boundary({...context,record,receiver,argumentCount,evaluateArgument});
    const fn=record.function;
    if(!fn)throw new Error(`Original function is not prepared: ${record.key}`);
    if(fn.script.nativeIndex||fn.script.functionFlags&0x400)return this.invokeNative({...context,index:fn.script.nativeIndex,record,receiver,argumentCount,evaluateArgument});
    if(argumentCount>fn.parameters.length)throw new Error(`Unsupported extra script arguments: ${record.key}`);
    // R2a: the frame block comes from the runtime's FrameStack and is
    // released when this call ends, as CallFunction's FMemMark is.
    const stack=this.classLoader?this.frameStack():null,stackIndex=stack?.index,stackTop=stack?.top;
    try{
    const locals=createFrameLocals(fn,this.classLoader,stack),out=[];
    // A non-out parameter only needs the argument's value: the VM's
    // evaluateArgumentValue is refValue(evaluateArgument) without an lvalue
    // (linked reads never yield undefined, so the skip test is unchanged).
    const byValue=typeof context.evaluateArgumentValue==='function';
    for(const [index,field] of fn.parameters.entries()){
      if(index>=argumentCount)break;
      if(byValue&&!field.metadata.out){
        const value=context.evaluateArgumentValue(index);
        if(value!==undefined)locals.set(field.key,copyValue(field,value));
        continue;
      }
      const value=evaluateArgument(index);
      if(value!==undefined)locals.set(field.key,copyValue(field,refValue(value)));
      if(field.metadata.out&&value?.reference)out.push({field,reference:value});
    }
    // UObject::ProcessInternal (Core 0x1013f690, 0x1013f6c6-0x1013f6fe): a script function whose name is one of the 64 probe names does not
    // run when its object's StateFrame ProbeMask lacks that bit, whoever called it; CallFunction already evaluated the arguments and
    // still copies the out parameters back and destroys the frame afterwards (Disable('Trigger') silences `A.Trigger()` as well as the
    // engine's Trigger event: the club doors, docs/visual-acceptance.md).
    const ename=probeIndex(record);
    const masked=ename!==0xffffffff&&this.instance(receiver).state?.isProbing(ename)===false;
    const value=masked?undefined:this.executeScript(fn,receiver,locals);
    // ProcessInternal writes the caller's result before returning to the out
    // copyback/destruction loops. Preserve that value outside the local frame.
    const result=fn.result?copyValue(fn.result,value):value;
    for(const entry of out.reverse())entry.reference.set(copyValue(entry.field,locals.get(entry.field.key)));
    this.destroyFunctionLocals(fn,locals);
    return result;
    }finally{stack?.restore(stackIndex,stackTop);}
  }
  /** The FMemStack of function frame blocks (script-frame-locals.mjs). */
  frameStack(){return this.frameBlocks??=new FrameStack(this.objectArena());}
}
// The methods the Rust event dispatch (dispatch.rs) and the Rust latent
// polls (tick.rs, loco.rs) run in place of, as this module defines them: a
// host or validator that wraps one on the prototype or on a runtime keeps
// those events or polls in JavaScript (script-vm-events.mjs `allowed`).
ScriptRuntime.originalMethods=Object.freeze({
  processEvent:ScriptRuntime.prototype.processEvent,
  executeScript:ScriptRuntime.prototype.executeScript,
  eventLevelGate:ScriptRuntime.prototype.eventLevelGate,
  lookup:ScriptRuntime.prototype.lookup,
  isProbing:ScriptRuntime.prototype.isProbing,
  pollPawnLocomotion:ScriptRuntime.prototype.pollPawnLocomotion,
  pawnView:ScriptRuntime.prototype.pawnView,
  locomotionServices:ScriptRuntime.prototype.locomotionServices,
  latentFloat:ScriptRuntime.prototype.latentFloat,
  readNamed:ScriptRuntime.prototype.readNamed,
  writeNamed:ScriptRuntime.prototype.writeNamed,
});
