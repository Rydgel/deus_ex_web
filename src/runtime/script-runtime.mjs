import {setWindowHeightNative} from './script-window-size.mjs';
import {setTileWindow} from './script-window-tile.mjs';
import {setWindowConfigurationNative} from './script-window-configuration.mjs';
import { readClass } from '../unreal/classes.mjs';
import { readFieldLinks, readFunctionMetadata, readPropertyMetadata, readStateMetadata, readStructMetadata } from '../unreal/script-metadata.mjs';
import { ScriptObjects } from './script-objects.mjs';
import { ScriptClassLoader } from './script-class-loader.mjs';
import { compileFunction, refValue } from './script-vm.mjs';
import { ScriptState } from './script-state.mjs';
import {execAttachDecal,execDetachDecal,DecalBoundaryError,attachDecalSurfaces,detachDecalSurfaces} from './script-decal.mjs';
import {
  zeroValue, copyValue, propertyReference, storageReference, arrayReference, propertyCodec,
} from './script-values.mjs';
import { objectImageCells, createImage, copyImage, readCell, writeCell } from './script-object-image.mjs';
import { destroyScriptProperty } from './script-property-destroy.mjs';
import { createAllActorsIterator, createTraceActorsIterator, createTraceTextureIterator, createRadiusActorsIterator, createVisibleActorsIterator, createBasedActorsIterator, createCycleActorsIterator } from './script-iterators.mjs';
import { scriptTrace, scriptFastTrace } from './script-trace.mjs';
import { setActorTimer, updateActorTimer } from './script-timers.mjs';
import { sleepActor, pollActorSleep } from './script-sleep.mjs';
import { probeNames } from '../unreal/probe-names.mjs';
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
import { saveConfig, configRoot, loadConfig as loadObjectConfig, defaultsObject } from './script-config.mjs';
import {
  installActorCollisionView, findActorBase, setCollisionArguments,
  setActorCollision, setActorCollisionSize, setActorPhysics,
} from './script-actor-collision.mjs';
import { execPlayAnim, execLoopAnim, execTweenAnim, execPlayBlendAnim, execTweenBlendAnim } from './play-anim.mjs';
import { execGetAnimGroup } from './script-get-anim-group.mjs';
import { animationView, animationTickView } from './script-anim.mjs';
import { tickActorAnimation } from './animation-tick.mjs';
import { createLodMeshFrameCache, getLodMeshFrame } from './lodmesh-frame.mjs';
import { getActorSkin, getMeshTexture, execGetMeshTexture, readLodMeshSurfaces } from './lodmesh-materials.mjs';
import { tickStandaloneActor, actorInStasis } from './actor-tick.mjs';
import { tickStandaloneLevel } from './level-tick.mjs';
import { dispatchFinishAnim, pollFinishAnim } from './finish-anim.mjs';
import { ScriptResourceRegistry } from './script-resources.mjs';
import { execActorPlaySound } from './script-sound.mjs';
import { execMove } from './script-move.mjs';
import {
  dispatchMoveTo, dispatchMoveToward, dispatchTurnTo, dispatchTurnToward,
  dispatchWaitForLanding, pollMoveTo, pollMoveToward, pollTurnTo,
  pollTurnToward, pollWaitForLanding,
} from './script-pawn-locomotion.mjs';
import { runScriptPawnPhysics, pawnPhysicsView } from './script-pawn-physics.mjs';
import { execAiPickRandomDestination, execFindPathToward } from './script-pawn-nav.mjs';
import { actorLightLevelExtended, execAIGetLightLevel, execAIVisibility } from './script-ai-visibility.mjs';
import { execMakeNoise } from './script-noise.mjs';
import { execPawnAlliance } from './script-pawn-alliance.mjs';
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
import { setActorZone } from './zone.mjs';
import { prepareContextResults, zeroContextResult } from './script-context-results.mjs';
import { cleanupScriptReferences, cleanupLevelDestroyed } from './script-cleanup.mjs';
import { destructScriptObject, freeScriptObject, releaseScriptCameraPoint } from './script-object-release.mjs';
import { TEXT_PARSER_NATIVE } from './script-text-parser.mjs';
import { constructTextParserObject, dispatchTextParserNative, releaseTextParserObject } from './script-text-parser-natives.mjs';
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
import { configureChildNative } from './script-window-configure-child.mjs';
import { setWindowPositionNative } from './script-window-position.mjs';
import { setWindowAlignmentsNative } from './script-window-alignments.mjs';
import { setBackgroundStyleNative } from './script-window-background-style.mjs';
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

const lower=name=>String(name).toLowerCase();
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
  constructor(runtime,cls,slots,state,storage,sleepTimeLeft){
    // The slot fallback's defaults as of attachment. An object whose every
    // property has an image cell never reads a slot, so it keeps no copy.
    this.runtime=runtime;this.cls=cls;this.fieldTable=fieldTable(cls);
    this.defaultsSnapshot=storage.complete?undefined:new Map(cls.defaults);
    this.slots=slots;this.bindings=new Map();this.state=state;this.singular=false;this.sleepTimeLeft=sleepTimeLeft;
    this.cells=storage.cells;this.image=storage.image;this.refs=storage.refs;
    this.poison=storage.poison?.size?storage.poison:null;this.imageSource=storage.source;
    this.nativeObject=undefined;this.globalIndex=undefined;this.textParser=undefined;this.randomLabels=undefined;
    this.receiver=null;this.deleteMe=null;this.pendingKillValue=false;
  }
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
    return entry?entry.read():readCell(this.cell,instance.image,instance.refs);
  }
  set(value){
    const instance=this.instance,entry=instance.poison?.get(this.field.key);
    if(entry?.write)entry.read();
    writeCell(this.cell,instance.image,instance.refs,value);
    if(entry)this.runtime.clearPoison(instance,this.field.key);
  }
}
// Stage 1d: each class's default image, rebuilt when a class default changes.
const classImages=new WeakMap();
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
export class ScriptRuntime {
  constructor(assets,{native,warning,levelFor,actorLifecycle,rng,nameServices,conversationObjects,conversationLifecycle,windowLifecycle,logDevice,relocation,nativeClassLoading=false,boundaryNatives=[],boundaryFunctions=[]}={}) {
    this.objects=new ScriptObjects(assets);this.classes=new Map();this.functions=new Map();
    // GLazyLoad for a client launch (docs/script-font-load.md). The mesh
    // archive keeps Play's separately documented deferred policy below.
    this.lazyLoad=CLIENT_LAZY_LOAD;this.loadLifecycle=[];
    this.classLoader=nativeClassLoading?new ScriptClassLoader({assets,objects:this.objects,
      resources:()=>this.resourceRegistry(),
      // Retain Play's explicit deferred mesh policy on the shared archive.
      meshLoadServices:{getLazyLoad:()=>1},
      // Texture/Palette/Sound/Font constructors and serializers. The clock is
      // the host's appSeconds; the mip bias is UBitmap::__Client's
      // TextureLODSet from the installed WindowsClient config.
      resourceServices:{
        seconds:()=>globalThis.performance.now()/1000,
        getLazyLoad:()=>this.lazyLoad,setLazyLoad:value=>{this.lazyLoad=value;},
        mipBias:(texture,lodSet)=>{
          const config=this.classLoader.graph.config;
          if(!config)throw new Error('Texture mip bias requires the prepared GConfig');
          return clientTextureLodSet(config)[lodSet]??0;
        },
      },
      lifecycle:{logReceiver:{kind:'GWarn'},
        logEndLoad:event=>this.loadLifecycle.push({op:'Logf',...event}),
        reallocLoaded:event=>this.loadLifecycle.push({op:'FArrayRealloc',num:event.num,max:event.max})},
    }):null;
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
    // Linked classes in link order: the loaded UClass objects SaveConfig's
    // GObjObjects walk reloads (script-config.mjs).
    this.linkedClasses=new Set();
    this.states=new Map();this.structs=new Map();this.structLayouts=new Map();this.instances=new WeakMap();this.native=native;this.warning=warning;this.logDevice=logDevice;
    this.eventsEnabled=true;
    this.conversationLists=new Map();
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
    this.boundaryFunctions=boundaryFunctions instanceof Map?boundaryFunctions:new Map(boundaryFunctions);
    this.levelFor=receiver=>{
      const object=this.instances.get(receiver)?.nativeObject;
      return object&&Object.hasOwn(object,'xLevel')?object.xLevel:levelFor?.(receiver);
    };
    this.actorClass=null;this.actorLifecycle=actorLifecycle;
    this.rng=rng;
    this.nameServices=nameServices;
    this.relocation=relocation;
    this.contextResults=new WeakMap();
    this.services={
      invoke:call=>this.invoke(call),invokeNative:call=>this.invokeNative(call),
      iterator:call=>this.createIterator(call),
      objectReference:(script,index,node)=>this.objects.operand(script,node),
      castObject:(value,target,kind)=>this.castObject(value,target,kind),
      objectToString:value=>scriptObjectToString(value,object=>this.instances.get(object)?.nativeObject??object),
      zeroContextResult:(script,node,size)=>zeroContextResult(this.contextResults.get(script),node,size),
      localReference:(locals,script,node)=>{
        const field=this.objects.operand(script,node);
        if(!field)throw new Error('Local bytecode property reference was cleared');
        if(!locals.has(field.key))throw new Error(`Local is outside the function: ${field.key}`);
        return propertyReference(field,()=>locals.get(field.key),value=>locals.set(field.key,value));
      },
      fieldReference:(receiver,script,node)=>this.fieldReference(receiver,this.objects.operand(script,node)),
      defaultReference:(receiver,script,node)=>this.defaultReference(receiver,this.objects.operand(script,node)),
      arrayReference:(index,ref)=>arrayReference(index,ref,this.warning),
      structReference:(ref,script,node)=>this.structReference(ref,this.objects.operand(script,node)),
      warning:message=>this.warning?.(message),
      newObject:request=>this.newObject(request),
      dispatchStateEvent:(receiver,name)=>this.processEvent(receiver,name),
      gotoLabel:(receiver,name)=>this.instance(receiver).state.gotoLabel(name),
      pollLatent:call=>{
        if(call.index===384)return pollActorSleep(this.instance(call.receiver),call.state,call.seconds);
        if(call.index===0x181)return pollFinishAnim({
          animation:animationView(this,call.receiver),state:call.state,
        });
        if([501,503,509,511,528].includes(call.index))
          return this.pollPawnLocomotion(call);
        if(!this.pollLatent)throw new Error(`Unimplemented original latent action ${call.index}`);
        return this.pollLatent(call);
      },
    };
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
          this.actorClass=cls;
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
    record.function={script,compiled,fields,parameters:fields.filter(field=>field.metadata.parameter&&!field.metadata.return),
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
      writeCell(cell,storage.image,storage.refs,copyValue(field,value));
      storage.poison?.delete(key);
    }
    this.instances.set(instance,new ScriptInstance(this,cls,slots,state,storage,0));
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
    let image=classImages.get(cls);
    if(image&&sameDefaults(image.defaults,cls.defaults))return image;
    const defaults=new Map(cls.defaults),view=createImage(layout.size),refs=new Array(layout.refCount).fill(null);
    let poison=null;
    for(const [key,cell] of layout.cells){
      const field=layout.fields.get(key);
      let value;
      try{value=this.defaultValue(cls,field,defaults);}
      catch{(poison??=new Map()).set(key,{read:()=>this.defaultValue(cls,field,defaults),write:true,lazy:false});continue;}
      writeCell(cell,view,refs,value);
    }
    image={layout,defaults,view,refs,poison};
    classImages.set(cls,image);
    return image;
  }
  /** Fresh storage for one object of `cls`: a copy of the class image. */
  objectStorage(cls) {
    const source=this.classImage(cls);
    if(!source)return {cells:null,image:null,refs:null,poison:null,source:null,complete:false};
    return {cells:source.layout.cells,image:copyImage(source.view),refs:source.refs.slice(),
      poison:source.poison&&new Map(source.poison),source,complete:source.layout.cells.size===cls.propertyLink.length};
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
    if (!object || !services) throw new Error('CriticalDelete requires native object and release bindings');
    const release = {...services, conditionalDestroy: item => this.conditionalDestroy(item.identity), warning: this.warning};
    if (object.nativeVtable === TEXT_PARSER_NATIVE.vtable) releaseTextParserObject(object, 1, release);
    else if (object.nativeVtable === 0x10179dfc) {
      // UObject's deleting destructor 0x1015dd00: ~UObject, then operator delete.
      destructScriptObject(object, release);
      freeScriptObject(object, release);
    } else throw new Error(`CriticalDelete deleting destructor is not recovered for native vtable 0x${(object.nativeVtable >>> 0).toString(16)}`);
    return undefined;
  }
  playerNativeObject(player) {
    const instance = this.instance(player);
    if (Number.isInteger(instance.nativeObject?.index)) return instance.nativeObject;
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
      linker: null, linkerIndex: -1, auxiliary: null, outer: packageOuter, flags: 0,
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
          writeCell(cell,storage.image,storage.refs,copyValue(field,value));
          storage.poison?.delete(field.key);
        }
        this.instances.set(object.identity,new ScriptInstance(this,cls,slots,null,storage,undefined));
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
    const fields=fn.fields.filter(field=>(field.metadata.flags&0x00400000)&&
      (parameters||!field.metadata.parameter));
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
  destroyActorBase(receiver) {
    const object=this.instance(receiver).nativeObject;
    if(!object||!Object.hasOwn(object,'auxiliary'))throw new Error('AActor.Destroy requires its native auxiliary-object binding');
    if(object.auxiliary){this.conditionalDestroy(object.auxiliary);object.auxiliary=null;}
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
    return this.instances.get(receiver)?.nativeObject?.released===true;
  }
  instance(receiver) {
    const instance=this.instances.get(receiver);
    if(!instance)throw new Error(`Object is not attached to script runtime: ${receiver?.key??receiver?.name??'None'}`);
    if(instance.nativeObject?.released)throw new Error('Script object allocation has been released');
    return instance;
  }
  /** Core.IsProbing0x10115670 against the actor's live state-frame probe mask.
   * A no-state actor probes everything (the recovered init mask is all ones);
   * a name outside the reserved probe interval is always probed. */
  isProbing(receiver,name){return this.instance(receiver).state?.isProbing(probeNames.get(lower(name))??-1)??true;}
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
    return propertyReference(field,()=>instance.slots.get(field.key),value=>instance.slots.set(field.key,value));
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
    const binding=instance.bindings.get(field.key);
    if(binding)return codec.read(binding.get());
    return this.readStorage(instance,field,codec,cell);
  }
  /** The object's own storage for a property: its image cell, or the logical
   * slot of a property without one. A cell read is the codec's copy of the
   * stored value; a slot is filled with its default on first access. */
  readStorage(instance,field,codec,cell) {
    if(cell){
      const poisoned=instance.poison?.get(field.key);
      return poisoned?codec.read(poisoned.read()):readCell(cell,instance.image,instance.refs);
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
    const binding=instance.bindings.get(field.key);
    if(binding)binding.set(codec.store(value,binding.get()));
    else this.writeStorage(instance,field,value,codec,cell);
    return codec.copy(value);
  }
  writeStorage(instance,field,value,codec,cell) {
    if(cell){
      const poisoned=instance.poison?.get(field.key);
      if(poisoned?.write)poisoned.read();
      writeCell(cell,instance.image,instance.refs,codec.copy(value));
      if(poisoned)this.clearPoison(instance,field.key);
      return;
    }
    let raw=instance.slots.get(field.key);
    if(raw===undefined&&!instance.slots.has(field.key))
      instance.slots.set(field.key,raw=this.defaultValue(instance.cls,field,instance.defaultsSnapshot));
    instance.slots.set(field.key,codec.store(value,raw));
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
    if(source!==instance.imageSource)this.copyStorage(instance,{bytes:source.view.buffer,refs:source.refs,poison:source.poison});
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
      writeCell(cell,instance.image,instance.refs,logical);
      if(instance.poison?.has(field.key))this.clearPoison(instance,field.key);
    }
  }
  /** The object's storage, to restore with restoreStorage (a mover reset). */
  snapshotStorage(receiver) {
    const instance=this.instance(receiver);
    if(!instance.image)return null;
    return {bytes:instance.image.buffer.slice(0),refs:instance.refs.slice(),poison:instance.poison&&new Map(instance.poison)};
  }
  restoreStorage(receiver,snapshot) {
    if(snapshot)this.copyStorage(this.instance(receiver),snapshot);
  }
  /** Overwrite in place: live references hold the image and refs arrays. */
  copyStorage(instance,{bytes,refs,poison}) {
    new Uint8Array(instance.image.buffer).set(new Uint8Array(bytes));
    for(let index=0;index<refs.length;index++)instance.refs[index]=refs[index];
    instance.poison=poison?.size?new Map(poison):null;
  }
  poisonField(instance,key,entry) {
    (instance.poison??=new Map()).set(key,entry);
  }
  clearPoison(instance,key) {
    instance.poison.delete(key);
    if(!instance.poison.size)instance.poison=null;
  }
  async prepareResource(reference) {
    if(!reference)return null;
    return this.resourceRegistry().materialize(reference.asset,reference.index);
  }
  resourceRegistry() {
    return this.resources??=new ScriptResourceRegistry({assets:this.objects.assets,objects:this.objects,
      indexProvider:this.originalObjectIndex,loader:this.classLoader});
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
    else if(this.dynamicLoadGraph?.ownsPackage(packageName))object=this.dynamicLoadGraph.load(request);
    else if(this.classLoader?.graph.packageAssets.has(packageName))object=this.loadGraphDynamicObject(request);
    else throw new DynamicLoadObjectBoundaryError(
      `DynamicLoadObject package linker is not prepared: ${request.name}`,
      'DYNAMIC_LOAD_OBJECT_FIRST_LOAD',{path:request.name});
    if(object!==null&&this.castObject(object,request.classRef,'dynamic')===null)
      throw new DynamicLoadObjectBoundaryError(`DynamicLoadObject class mismatch for ${request.name}`,
        'DYNAMIC_LOAD_OBJECT_CLASS_MISMATCH',{path:request.name,classRef:request.classRef});
    return object;
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
      if(name?.op!=='literal'||typeof name.value!=='string'||!name.value.includes('.'))continue;
      const packageName=name.value.split('.')[0];
      if(this.classLoader.graph.packageAssets.has(lower(packageName)))continue;
      let asset;
      try{asset=await this.objects.assets.get(packageName);}catch{continue;} // absent: the call reaches file lookup
      await this.classLoader.prepare(asset);
    }
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
    const reference=this.readNamed(receiver,'Mesh');
    if(!reference||!['LodMesh','Mesh'].includes(reference.kind))return null;
    const resource=await this.prepareResource(reference);
    if(resource.payloadStatus!=='decoded-lodmesh')
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
    if(!resource||this.resources.pending.has(reference.key)||resource.payloadStatus!=='decoded-lodmesh')
      throw new Error(`Original mesh resource is not prepared: ${reference.key}`);
    return resource;
  }
  /** Original ULodMesh::GetFrame over the same prepared resource and reflected
   * animation fields as PlayAnim/Tick. Callers supply original FCoords and a
   * measured or modeled global UObject identity, not a package export index.
   * This pose boundary does not select triangles, materials or lighting. */
  getActorMeshFrame(receiver,coords,options={}) {
    const mesh=this.meshPayload(receiver);
    if(!mesh)throw new Error('Original GetFrame requires a prepared LodMesh');
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
  getActorMeshSurfaces(receiver,options={}) {
    const mesh=this.meshPayload(receiver);
    if(!mesh)throw new Error('Original surface decoding requires a prepared LodMesh');
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
      bAdvancedTactics:'bAdvancedTactics',bCanGlide:'bCanGlide',
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
    const dispatch={500:dispatchMoveTo,502:dispatchMoveToward,508:dispatchTurnTo,
      510:dispatchTurnToward,527:dispatchWaitForLanding}[call.index];
    const args=[];
    for(let i=0;i<call.argumentCount;i++)args.push(refValue(call.evaluateArgument(i)));
    return dispatch({pawn:this.pawnView(call.receiver),state:this.instance(call.receiver).state,
      args,services:this.locomotionServices()});
  }
  pollPawnLocomotion(call) {
    const poll={501:pollMoveTo,503:pollMoveToward,509:pollTurnTo,
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
  /** Native Actor/Pawn perception services (514/531/532/533/534/700/701/705) per
   * docs/script-pawn-perception.md: the shared LOS worker, the two target
   * pickers and the AICanSee visibility worker. Field reads come through the
   * soundField level graph; the trace primitives are the BSP FastLineCheck
   * and the SingleLineCheck (MultiLineCheck) wrapper — no navigation graph is
   * consulted by any of these bodies. */
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
  /** Prepare canonical reflected fields for a mission list and its source
   * nodes. This does not perform native StaticLoadObject/PostLoad ownership. */
  async prepareConversations(missionNumber=0,packageName='DeusExConText') {
    if(!Number.isInteger(missionNumber)||missionNumber<0)throw new Error('Invalid conversation mission');
    const path=`ConList_Mission${String(missionNumber).padStart(2,'0')}`;
    const key=lower(`${packageName}.${path}`);
    if(this.conversationLists.has(key))return this.conversationLists.get(key);
    const asset=await this.objects.assets.get(packageName);
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
    const conSys=await this.objects.assets.get('ConSys');
    this.conversationItemClass=await this.loadClass(conSys,conSys.exportsByPath.get('conlistitem'));
    this.conversationLists.set(key,list);
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
      throw new Error(`Original sound native graph field is not bound: ${name}`);
    }
    const value=reflected(name);
    if(value===undefined)throw new Error(`Original sound field is not linked: ${name}`);
    return value;
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
      }else if(field.metadata.type==='object'&&rest===''){
        // UObjectProperty::ImportText 0x10166e20: ReadToken yields an empty
        // token, which is not "None", and StaticFindObject finds nothing, so
        // the value is None and ImportText returns NULL.
        args[index]=null;imported=false;
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
          createFlagBase({defaultExpiration:contract.defaultExpiration})));
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
        actors:level.actors,
        baseOf:other=>other.base!==undefined?other.base:this.readNamed(other,'Base'),
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
    if(!isMapMoveHost(actor))throw new Error(`${what} for a pawn, brush or non-colliding map actor is not linked`);
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
  movePawn(actor,delta,rotation) {
    if(!this.isMapPawn(actor))throw new Error('Map pawn MoveActor requires a serialized map pawn');
    return (actor._pawnPhysics??pawnPhysicsView(actor,this.pawnPhysicsServices(actor))).moveActor(delta,rotation);
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
    if(this.collisionViewActors.has(actor))return this.relocateSpawnedActor(actor,destination,test,noCheck);
    if(this.isMapPawn(actor))
      return (actor._pawnPhysics??pawnPhysicsView(actor,this.pawnPhysicsServices(actor))).farMove(destination,test,noCheck);
    return this.relocateMapActor(actor,destination,test,noCheck);
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
        // vtable's Destroy slot. That is AActor::Destroy (auxiliary object slot
        // empty) -> UObject::Destroy, as on map exports, except for the player
        // chain's own overrides (script-player-destroy.mjs).
        const object=this.instance(identity).nativeObject;
        if(object){object.auxiliary=null;object.destroy=this.actorDestroyHook(object);}
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
          worldActor:level.actors[0],lineage});
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
  cleanupReferences(receiver,{editor=false}={}) {
    const services=this.actorLifecycle?.references;
    if(!services)throw new Error('CleanupDestroyed requires native reference validity and pending-kill services');
    return cleanupScriptReferences(this.instance(receiver).cls.propertyLink,
      field=>this.fieldReference(receiver,field),services,{editor});
  }
  /** Reflected reference traversal only. A native class Serialize override
   * must separately route its UObject header, native members and base hook. */
  serializeReferences(receiver,archive,options={}) {
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
    return cleanupLevelDestroyed(level,{
      read:(actor,name)=>this.readNamed(actor,name),
      cleanupReferences:(actor,options)=>this.cleanupReferences(actor,options),
      release:(actor,flags)=>{
        if(typeof lifecycle.release==='function')lifecycle.release(actor,flags);
        else this.releaseObject(actor,flags);
      },
      destroyActorEvents:lifecycle.destroyActorEvents,
      recordArrayRemoval:lifecycle.recordArrayRemoval,
      warning:this.warning,
    },force);
  }
  bindProperty(receiver,field,binding) {
    if(!field.metadata)throw new Error(`Property is not prepared: ${field.key}`);
    if(typeof binding.get!=='function'||typeof binding.set!=='function')throw new Error('Native property binding requires getter and setter');
    this.instance(receiver).bindings.set(field.key,binding);
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
    if(field.key.startsWith('core.object.'))
      throw new Error('Native class-default header storage is not bound');
    return propertyReference(field,()=>this.defaultValue(cls,field),value=>{
      const values=field.metadata.arrayDim>1
        ?new Map(value.map((item,index)=>[index,item])):new Map([[0,value]]);
      if(cls.loadRecord)this.classLoader.writeDefault(cls,field,values);
      cls.defaults.set(field.key,values);
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
  lookup(receiver,name,global=false) {
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
        model:this.levelFor(actor)?.model,level:this.levelFor(actor),
        read:(a,n)=>this.readNamed(a,n),
        write:(a,n,v)=>this.writeNamed(a,n,v),
        frand:()=>{if(typeof this.rng?.frand!=='function')throw new DecalBoundaryError('AttachDecal.rng','AttachDecal requires the original RNG stream');return Math.fround(this.rng.frand());},
      }),
    });
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
    if(call.index===231)return execObjectLog(call,{logDevice:this.logDevice});
    if(call.index===751)return this.criticalDelete(call);
    if(call.index>=TEXT_PARSER_NATIVE.indices.openText&&call.index<=TEXT_PARSER_NATIVE.indices.setPlayerName){
      const result=dispatchTextParserNative(call,{
        state:receiver=>this.instance(receiver).textParser,
        loadText:path=>{
          if(typeof this.textSource?.loadText!=='function')
            throw new Error('DeusExTextParser.OpenText requires the XExtString source');
          return this.textSource.loadText(path);
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
      const name=extensionStringToName(refValue(call.evaluateArgument(0)),this.nameServices);
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
            if(c.record.key==='engine.mover')return false;
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
    if(call.index===282){
      // AActor::IsAnimating/execIsAnimating 0x103e15c0: AnimSequence != None
      // && (AnimFrame<0 ? TweenRate==0 : AnimRate!=0) — +0x54/+0x58/+0x5c/+0x60
      // fields, both compares against double 0.0.
      const view=animationView(this,call.receiver);
      if(lower(view.AnimSequence)==='none')return 0;
      return (view.AnimFrame<0?view.TweenRate===0:view.AnimRate!==0)?1:0;
    }
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
      return execActorPlaySound(call,this.soundServices(call));
    }
    if(call.index===1013)return execGetMeshTexture(call,this.meshTextureServices());
    if(call.index===266)return execMove(call,this.moveServices(call));
    if([500,502,508,510,527].includes(call.index))return this.pawnLocomotion(call);
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
      return execAiPickRandomDestination(call.receiver,args,call.evaluateArgument(8),
        this.pawnNavServices(call.receiver));
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
      return execFindPathToward(call.receiver,target,bSingle,bClear,
        this.pawnNavServices(call.receiver));
    }
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
    if(call.index>=2105&&call.index<=2107)return execPawnAlliance(call,{
      read:(actor,name)=>this.readNamed(actor,name),
      isA:(actor,key)=>{
        for(let cls=this.instance(actor).cls;cls;cls=cls.base)
          if(cls.record.key===key)return true;
        return false;
      },
    });
    if(call.index===113){
      if(call.argumentCount>2)throw new Error('GotoState accepts at most two name arguments');
      const name=call.argumentCount?refValue(call.evaluateArgument(0)):'None';
      const label=call.argumentCount>1?refValue(call.evaluateArgument(1)):'Begin';
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
      if(call.index===118)state.probeMask[word]=(state.probeMask[word]&~mask)>>>0;
      else{
        const metadata=state.stateNode?.script??instance.cls.metadata;
        const allowed=(instance.cls.metadata.probeMask[word]|metadata.probeMask[word])&metadata.ignoreMask[word];
        state.probeMask[word]=(state.probeMask[word]|(mask&allowed))>>>0;
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
      const instance=this.instance(call.receiver);
      return sleepActor(instance,instance.state,refValue(call.evaluateArgument(0)));
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
    // The tick view only forwards to the actor's fields, and this phase
    // writes through its accessors alone, so one view serves every tick of
    // an attached instance.
    const instance=this.instance(receiver);
    let animation=animationTickViews.get(instance);
    if(!animation)animationTickViews.set(instance,animation=animationTickView(this,receiver));
    return tickActorAnimation(animation,seconds,{
      mesh:()=>this.meshPayload(receiver),simulatedPawn:animation.simulatedPawn,
      findFunction:(name,checked)=>{
        const record=this.lookup(receiver,name);
        if(!record&&checked)throw new Error(`Original animation event was not found: ${name}`);
        return record;
      },
      processEvent:record=>this.processEvent(receiver,record.name,[],null,record),
    });
  }
  /** Recovered standalone per-actor Tick. The level scheduler supplies its
   * clock/tag/deferred list and reached native physics/input/visibility services.
   * Startup and world actor iteration are not invented by this entry point. */
  processActorTick(receiver,seconds,{tickType=2,...nativeServices}) {
    return tickStandaloneActor(receiver,seconds,tickType,{
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
    });
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
    return tickStandaloneLevel(level,seconds,tickType,{
      ...nativeServices,
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
      isA:(actor,key)=>{
        for(let cls=this.instance(actor).cls;cls;cls=cls.base)if(cls.record.key===key)return true;
        return false;
      },
      tickActor:(actor,delta,type)=>{
        const run=()=>this.processActorTick(actor,delta,{...nativeServices,level,tickType:type});
        return nativeServices.aroundActorTick?nativeServices.aroundActorTick(actor,run):run();
      },
      processEvent:(actor,name,args)=>this.processEvent(actor,name,args),
      resetInputProperties:actor=>this.resetActorInput(actor),
      cleanupDestroyed:(world,force)=>this.cleanupDestroyed(world,Boolean(force)),
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
   * {Walking=1,Falling=2}, non-Pawn actors and the unsupported zone-event
   * branches stay explicit boundaries. */
  /** Shared live-level services for the script-attached pawn consumers:
   * performPhysics (processActorPhysics) and the native-709 pick chain. Field
   * reads route through namedReference bindings; world queries come from the
   * level collision hash; zone events dispatch through processEvent. */
  pawnPhysicsServices(receiver) {
    const level=this.levelFor(receiver);
    if(!level?.hash)throw new Error('Pawn physics requires the level collision hash');
    return {
      field:(actor,name)=>this.namedReference(actor,name),
      read:(actor,name)=>this.readNamed(actor,name),
      write:(actor,name,value)=>this.writeNamed(actor,name,value),
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
          get ZoneFluidFriction(){return read('ZoneFluidFriction');}};
      },
      dispatch:(target,name,args=[])=>{
        const record=this.lookup(target,name);
        if(!record)return undefined;
        if(!record.function)throw new Error(`Original event is not prepared: ${record.key}`);
        return this.processEvent(target,name,args);
      },
      isProbing:(actor,name)=>this.isProbing(actor,name),
      // The MoveActor based-rider section recurses into MoveActor for each
      // based child; only spawned collision-view actors are admitted there.
      moveRider:(other,delta,rotation)=>this.moveSpawnedActor(other,delta,rotation),
      random:()=>{
        if(typeof this.rng?.frand!=='function')throw new Error('Pawn physics requires the shared original RNG stream');
        return Math.fround(this.rng.frand());
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
   * Water zones reach the unported swimMove boundary explicitly. */
  pawnNavServices(receiver) {
    const base=this.pawnPhysicsServices(receiver),level=base.level;
    const view=pawnPhysicsView(receiver,base);
    const navZone=zone=>{
      if(!zone)return {water:false,pain:false,damageType:'None',gravityZ:undefined};
      const read=name=>{try{return this.readNamed(zone,name);}catch{return zone?.values?.[name];}};
      return {water:Boolean(read('bWaterZone')),pain:Boolean(read('bPainZone')),
        damageType:read('DamageType')??'None',gravityZ:read('ZoneGravity')?.[2]};
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
    return {
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
        // The workers restore Velocity by mutating the returned vector; bind
        // it to a live host array (the field binding's get copies).
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
    };
  }
  createIterator(call) {
    if(call.index===309||call.index===1000){
      // execTraceActors/execTraceTexture run one MultiLineCheck at
      // IteratorStart and publish each hit list node in order; see
      // docs/script-trace.md.
      const create=call.index===309?createTraceActorsIterator:createTraceTextureIterator;
      return create({...call,levelFor:this.levelFor,readActor:(actor,name)=>this.readNamed(actor,name)});
    }
    if(call.index===310||call.index===311||call.index===306||call.index===1002){
      // execRadiusActors/execVisibleActors/execBasedActors/execCycleActors
      // scan Level->Actors in native order; the candidate Class->+0x28
      // ancestry walk is the attached instance's cls chain, same as
      // AllActors. See docs/script-actor-queries.md.
      if(!this.actorClass||!this.levelFor)throw new Error('Actor iterators require a linked original actor array');
      const isA=(actor,base)=>{
        for(let cls=this.instance(actor).cls;cls;cls=cls.base)if(cls.record===base)return true;
        return false;
      };
      if(call.index===306){
        // The native compares candidate->+0xc4 (the Base property) to the
        // receiver; fieldReference reads the attached field storage.
        const baseField=this.lookupMember(this.actorClass,'fields','Base');
        return createBasedActorsIterator({...call,actorClass:this.actorClass.record,
          levelFor:this.levelFor,isA,baseOf:actor=>this.fieldReference(actor,baseField).get()});
      }
      if(call.index===1002)return createCycleActorsIterator({...call,actorClass:this.actorClass.record,levelFor:this.levelFor,isA});
      const create=call.index===310?createRadiusActorsIterator:createVisibleActorsIterator;
      return create({...call,actorClass:this.actorClass.record,levelFor:this.levelFor,isA});
    }
    if(call.index!==304)throw new Error(`Original iterator native is not implemented: ${call.index}`);
    if(!this.actorClass||!this.levelFor)throw new Error('AllActors requires a linked original actor array');
    const tag=this.lookupMember(this.actorClass,'fields','Tag');
    return createAllActorsIterator({...call,actorClass:this.actorClass.record,levelFor:this.levelFor,
      isA:(actor,base)=>{
        for(let cls=this.instance(actor).cls;cls;cls=cls.base)if(cls.record===base)return true;
        return false;
      },tagOf:actor=>this.fieldReference(actor,tag).get(),
    });
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
    const instance=this.instance(receiver),ename=probeNames.get(lower(name))??-1;
    // AActor::ProcessEvent 0x10369100 precedes Core's body on world actors:
    // actor.Level (+0xa8), LevelInfo flags (+0x4f0), mask bBegunPlay (2).
    // Standalone Core-event fixtures have no linked world/Actor.Level slot.
    if(this.levelFor(receiver)) {
      for(let cls=instance.cls;cls;cls=cls.base)if(cls.record.key==='engine.actor'){
        const info=this.readNamed(receiver,'Level');
        if(info && !this.readNamed(info,'bBegunPlay'))return false;
        break;
      }
    }
    if(instance.state&&!instance.state.isProbing(ename))return false;
    const record=selectedRecord??this.lookup(receiver,name),fn=record?.function;
    if(!fn)throw new Error(`Original event is not prepared: ${record?.key??name}`);
    // 1013f850 first rejects any nonzero IsPendingKill result. Only then does
    // 1013f858 compare its zero low word with iNative.
    if(instance.pendingKill||(fn.script.nativeIndex&0xffff)!==0)return false;
    if(fn.script.functionFlags&0x400)throw new Error(`Native ProcessEvent hook is not implemented: ${record.key}`);
    if(fn.result&&(!resultReference?.reference||typeof resultReference.get!=='function'||typeof resultReference.set!=='function'))
      throw new Error(`Return-value ProcessEvent requires a caller result reference: ${record.key}`);
    if(args.length!==fn.parameters.length)throw new Error(`Incomplete ProcessEvent parameter block: ${record.key}`);
    const locals=new Map(fn.fields.map(field=>[field.key,zeroValue(field)]));
    for(const [index,field] of fn.parameters.entries())locals.set(field.key,copyValue(field,args[index]));
    if(fn.result)locals.set(fn.result.key,copyValue(fn.result,resultReference.get()));
    const suppressed=Boolean((fn.script.functionFlags&0x20)&&instance.singular);
    const result=this.executeScript(fn,receiver,locals);
    // ProcessInternal's return expression writes into Locals+ReturnValueOffset.
    // Singular suppression (and a void Return expression) leaves that slot as
    // copied from the caller rather than fabricating a zero return value.
    if(fn.result&&!suppressed&&result!==undefined)locals.set(fn.result.key,copyValue(fn.result,result));
    for(const [index,field] of fn.parameters.entries())args[index]=copyValue(field,locals.get(field.key));
    if(fn.result)resultReference.set(copyValue(fn.result,locals.get(fn.result.key)));
    this.destroyFunctionLocals(fn,locals,{parameters:false});
    return true;
  }
  executeScript(fn,receiver,locals) {
    const instance=this.instance(receiver),singular=Boolean(fn.script.functionFlags&0x20);
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
    const locals=new Map(fn.fields.map(field=>[field.key,zeroValue(field)])),out=[];
    for(const [index,field] of fn.parameters.entries()){
      if(index>=argumentCount)break;
      const value=evaluateArgument(index);
      if(value!==undefined)locals.set(field.key,copyValue(field,refValue(value)));
      if(field.metadata.out&&value?.reference)out.push({field,reference:value});
    }
    const value=this.executeScript(fn,receiver,locals);
    // ProcessInternal writes the caller's result before returning to the out
    // copyback/destruction loops. Preserve that value outside the local frame.
    const result=fn.result?copyValue(fn.result,value):value;
    for(const entry of out.reverse())entry.reference.set(copyValue(entry.field,locals.get(entry.field.key)));
    this.destroyFunctionLocals(fn,locals);
    return result;
  }
}
