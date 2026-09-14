import { readClass } from '../unreal/classes.mjs';
import { readFieldLinks, readFunctionMetadata, readPropertyMetadata, readStateMetadata, readStructMetadata } from '../unreal/script-metadata.mjs';
import { ScriptObjects } from './script-objects.mjs';
import { compileFunction, refValue } from './script-vm.mjs';
import { ScriptState } from './script-state.mjs';
import { zeroValue, copyValue, propertyReference, arrayReference } from './script-values.mjs';
import { destroyScriptProperty } from './script-property-destroy.mjs';
import { createAllActorsIterator, createTraceActorsIterator, createTraceTextureIterator, createRadiusActorsIterator, createVisibleActorsIterator, createBasedActorsIterator } from './script-iterators.mjs';
import { scriptTrace, scriptFastTrace } from './script-trace.mjs';
import { setActorTimer, updateActorTimer } from './script-timers.mjs';
import { sleepActor, pollActorSleep } from './script-sleep.mjs';
import { probeNames } from '../unreal/probe-names.mjs';
import { conditionalDestroyScriptObject, destroyScriptObject } from './script-object-lifecycle.mjs';
import { setScriptOwner } from './script-owner.mjs';
import { destroyScriptActor } from './script-destroy.mjs';
import { constructFreshScriptObject, allocateFreshScriptObject, constructActorBase, nativeConstructorFor } from './script-object-construction.mjs';
import { checkActorEncroachment } from './check-encroachment.mjs';
import { setBase } from './walking-callbacks.mjs';
import {
  installActorCollisionView, findActorBase, setCollisionArguments,
  setActorCollision, setActorCollisionSize, setActorPhysics,
} from './script-actor-collision.mjs';
import { execPlayAnim } from './play-anim.mjs';
import { animationView } from './script-anim.mjs';
import { dispatchFinishAnim, pollFinishAnim } from './finish-anim.mjs';
import { ScriptResourceRegistry } from './script-resources.mjs';
import { execActorPlaySound } from './script-sound.mjs';
import { execMove } from './script-move.mjs';
import { execMakeNoise } from './script-noise.mjs';
import { fastLineCheck } from './fast-line-check.mjs';
import { isOverlapping } from './actor-touch.mjs';
import { setScriptRotation } from './script-set-rotation.mjs';
import { execSetLocation } from './script-set-location.mjs';
import { bindActorConversations } from './script-conversation-wrapper.mjs';
import { bindConversationsNative } from './script-native-conversation-list.mjs';
import { constructConversationItem, releaseConversationItem } from './script-conversation-item-lifecycle.mjs';
import { execScriptSpawn, inventoryImageChain, spawnActorRejectedByGates, spawnScriptCameraPoint, spawnScriptDataLinkPlay, spawnScriptInventoryActor } from './script-spawn.mjs';
import { setActorZone } from './zone.mjs';
import { prepareContextResults, zeroContextResult } from './script-context-results.mjs';
import { cleanupScriptReferences, cleanupLevelDestroyed } from './script-cleanup.mjs';
import { releaseScriptCameraPoint } from './script-object-release.mjs';
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
import { askParentForReconfigureNative } from './script-window-reconfigure.mjs';
import { setWindowSizeNative } from './script-window-size.mjs';
import { setChildVisibilityNative, showWindowNative, isWindowVisibleNative } from './script-window-visibility.mjs';
import {
  setSensitivityNative, enableWindowNative, disableWindowNative, isWindowSensitiveNative,
  getTopChildNative, getBottomChildNative, getHigherSiblingNative, getLowerSiblingNative,
  getClientObjectNative, windowSensitivityOptionalDefault,
} from './script-window-sensitivity.mjs';
import { setWindowPositionNative } from './script-window-position.mjs';
import { setBackgroundStyleNative } from './script-window-background-style.mjs';
import { raiseWindowNative, hideWindowNative } from './script-window-order.mjs';
import { setWindowBackgroundNative, setWindowTileColorNative } from './script-window-surface.mjs';
import { safeDestroyWindowNative } from './script-window-destroy.mjs';
import {
  setWindowFontNative, setWindowTextColorNative, setTextNative,
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
import {execObjectLog} from './script-log.mjs';
import {execVRand} from './script-vrand.mjs';

const lower=name=>String(name).toLowerCase();
/** exec bodies resolve each out expression to a raw address; a non-assignable
 * expression lands in a private temporary whose writes never escape. */
const writeSlot=value=>value?.reference&&typeof value.set==='function'?value:{set(){}};

/** Linked, synchronous original script calls. Loading/linking remains async;
 * an event never suspends halfway through an original call to fetch an asset.
 * A prepared function/state subset fails explicitly on an unprepared target. */
export class ScriptRuntime {
  constructor(assets,{native,warning,levelFor,actorLifecycle,rng,nameServices,conversationObjects,conversationLifecycle,windowLifecycle,logDevice,relocation,boundaryNatives=[],boundaryFunctions=[]}={}) {
    this.objects=new ScriptObjects(assets);this.classes=new Map();this.functions=new Map();
    this.states=new Map();this.structs=new Map();this.structLayouts=new Map();this.instances=new WeakMap();this.native=native;this.warning=warning;this.logDevice=logDevice;
    this.eventsEnabled=true;
    this.conversationLists=new Map();
    this.conversationLifecycle=conversationLifecycle;
    this.windowLifecycle=windowLifecycle;
    this.conversationEventNative=createConversationEventsNativeService({
      objects:conversationObjects,
      read:(object,key)=>this.namedReference(object,key).get(),
      write:(object,key,value)=>this.namedReference(object,key).set(value),
      reference:object=>{this.instance(object);return object;},
      isA:(object,name)=>{
        for(let cls=this.instance(object).cls;cls;cls=cls.base)
          if(cls.record.key===`engine.${name.toLowerCase()}`)return true;
        return false;
      },
      bindActor:args=>{
        const key=this.instance(args.event).cls.record.key;
        if(key==='consys.coneventspeech')return bindSpeechActor({...args,
          read:(object,key)=>this.namedReference(object,key).get(),
          write:(object,key,value)=>this.namedReference(object,key).set(value),
        });
        if(key==='consys.coneventanimation'||key==='consys.coneventtrade')
          return bindConversationAction({...args,
            read:(object,key)=>this.namedReference(object,key).get(),
            write:(object,key,value)=>this.namedReference(object,key).set(value),
          });
        if(isConversationCheckObjectBindClass(key)){
          const services=this.conversationLifecycle?.checkObject;
          return bindConversationCheckObjectActor({...args,
            read:(object,key)=>this.namedReference(object,key).get(),
            write:(object,key,value)=>this.namedReference(object,key).set(value),
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
            read:(object,key)=>this.namedReference(object,key).get(),
            write:(object,key,value)=>this.namedReference(object,key).set(value),
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
      dispatchStateEvent:(receiver,name)=>this.processEvent(receiver,name),
      pollLatent:call=>{
        if(call.index===384)return pollActorSleep(this.instance(call.receiver),call.state,call.seconds);
        if(call.index===0x181)return pollFinishAnim({
          animation:animationView(this,call.receiver),state:call.state,
        });
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
        const metadata=readClass(record.asset,record.index);
        const base=metadata.base?await this.loadClass(record.asset,metadata.base):null;
        const cls={record,metadata,base,nameCounter:0,...await this.members(record),
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
          else if([5,8].includes(property.type))value=await this.objects.resolve(record.asset,value);
          values.set(property.arrayIndex,value);cls.defaults.set(field.key,values);
        }
        if(record.key==='core.object')await this.field(this.lookupMember(cls,'fields','ObjectFlags'));
        if(record.key==='engine.actor'){
          this.actorClass=cls;
          for(const name of ['Tag','TimerRate','TimerCounter','bTimerLoop'])await this.field(this.lookupMember(cls,'fields',name));
        }
        record.linkedClass=cls;
        return cls;
      })();
      this.classes.set(record.key,pending);pending.catch(()=>this.classes.delete(record.key));
    }
    return this.classes.get(record.key);
  }
  lookupMember(node,table,name) {
    for(;node;node=node.base){const member=node[table]?.get(lower(name));if(member)return member;}
    return null;
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
    this.instances.set(instance,{cls,defaultsSnapshot:new Map(cls.defaults),slots:new Map(overrides),bindings:new Map(),state,pendingKill:false,singular:false,sleepTimeLeft:0});
    state.transition(null,cls.metadata);
    return state;
  }
  /** Construct fresh script storage using the class-default/template values,
   * followed by registry insertion and a verified class-native constructor.
   * This deliberately does not run the separate SpawnActor startup sequence. */
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
        const slots=new Map();
        // Core.Object declares only the five native UObject header properties;
        // InitProperties starts after that header, at original offset +0x28.
        for(const field of cls.propertyLink)if(!field.key.startsWith('core.object.')){
          const value=template?this.fieldReference(template,field).get():this.defaultValue(cls,field);
          slots.set(field.key,copyValue(field,value));
        }
        this.instances.set(object.identity,{cls,defaultsSnapshot:new Map(cls.defaults),slots,bindings:new Map(),state:null,pendingKill:false,singular:false});
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
      Object.defineProperty(instance,'pendingKill',{get:()=>Boolean(this.fieldReference(receiver,this.lookupMember(cls,'fields','bDeleteMe')).get()),configurable:true});
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
  releaseObject(receiver,flags=1) {
    const object=this.instance(receiver).nativeObject,services=this.actorLifecycle?.finalRelease;
    if(!object||!services)throw new Error('Final release requires native object and allocator bindings');
    return releaseScriptCameraPoint(object,flags,{
      ...services,conditionalDestroy:object=>this.conditionalDestroy(object.identity),warning:this.warning,
    });
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
  async authoredStructProperty(asset,field,property,initialValue,resolveObject=(asset,index)=>this.objects.resolve(asset,index)) {
    const key=field.metadata.structKey;
    if(!key||lower(property.struct)!==key.split('.').at(-1))
      throw new Error(`Authored struct tag does not match linked property: ${field.key}`);
    return readScriptStructValue(asset,field,property.data,{initialValue,resolveObject});
  }
  fieldReference(receiver,field) {
    const instance=this.instance(receiver);
    const binding=instance.bindings.get(field.key);
    if(binding)return propertyReference(field,binding.get,binding.set);
    if(!instance.slots.has(field.key))instance.slots.set(field.key,this.defaultValue(instance.cls,field,instance.defaultsSnapshot));
    return propertyReference(field,()=>instance.slots.get(field.key),value=>instance.slots.set(field.key,value));
  }
  namedReference(receiver,name) {
    const field=this.lookupMember(this.instance(receiver).cls,'fields',name);
    if(!field)throw new Error(`Original property was not found: ${name}`);
    return this.fieldReference(receiver,field);
  }
  async prepareResource(reference) {
    if(!reference)return null;
    this.resources??=new ScriptResourceRegistry({assets:this.objects.assets,objects:this.objects,
      indexProvider:this.originalObjectIndex});
    return this.resources.materialize(reference.asset,reference.index);
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
  /** Synchronous recovered StaticLoadObject linker/hash path reached by the wrapper. */
  loadPreparedDynamicObject(request){
    if(!this.dynamicLoadGraph)throw new DynamicLoadObjectBoundaryError(
      `DynamicLoadObject package linker is not prepared: ${request.name}`,
      'DYNAMIC_LOAD_OBJECT_FIRST_LOAD',{path:request.name});
    const object=this.dynamicLoadGraph.load(request);
    if(object!==null&&this.castObject(object,request.classRef,'dynamic')===null)
      throw new DynamicLoadObjectBoundaryError(`DynamicLoadObject class mismatch for ${request.name}`,
        'DYNAMIC_LOAD_OBJECT_CLASS_MISMATCH',{path:request.name,classRef:request.classRef});
    return object;
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
      if(stored.reader.offset!==entry.serialSize)
        throw new Error(`Loaded object has an unsupported native payload: ${reference.key}`);
      const initial=await prepareMapProperties(this,asset,{...reference,properties:stored.properties},cls,new Map());
      const slots=new Map();
      for(const field of cls.propertyLink)if(!field.key.startsWith('core.object.'))
        slots.set(field.key,copyValue(field,initial(field)));
      const resource=await this.prepareResource(reference);
      this.attach(reference,cls,slots);
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
    const reference=this.namedReference(receiver,'Mesh').get();
    if(!reference||!['LodMesh','Mesh'].includes(reference.kind))return null;
    const resource=await this.prepareResource(reference);
    if(resource.payloadStatus!=='decoded-eager-prefix')
      throw new Error(`Original mesh payload is unsupported: ${reference.key}`);
    return resource.payload;
  }
  /** Original AActor::execPlayAnim reads Actor.Mesh (+0x174) and calls the
   * mesh's sequence lookup. Package/resource preparation must finish before
   * this synchronous script boundary. */
  meshPayload(receiver) {
    const reference=this.namedReference(receiver,'Mesh').get();
    if(!reference||!['LodMesh','Mesh'].includes(reference.kind))return null;
    const resource=this.resources?.resources.get(reference.key);
    if(!resource||this.resources.pending.has(reference.key)||resource.payloadStatus!=='decoded-eager-prefix')
      throw new Error(`Original mesh resource is not prepared: ${reference.key}`);
    return resource.payload;
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
  /** Native MakeNoise512 services: the PlaySound level graph plus field
   * writes (instigator noise slots, listener Stimulus), probe-mask queries,
   * the bidirectional class test and appWarnf warnings (0xf1/0xf2). */
  noiseServices(call) {
    const services=this.soundServices(call);
    services.write=(actor,name,value)=>this.namedReference(actor,name).set(value);
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
    try{objectName=this.namedReference(receiver,'Name').get();}
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
    for(let item=this.namedReference(list,'conversations').get();item!==null;item=this.namedReference(item,'Next').get()){
      if(!item||seen.has(item))throw new Error('Invalid conversation source chain');
      seen.add(item);await this.prepareObject(item);
      await this.prepareObject(this.namedReference(item,'ConObject').get());
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
      read:(object,key)=>this.namedReference(object,key).get(),
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
    const read=(object,key)=>this.namedReference(object,key).get();
    const write=(object,key,value)=>this.namedReference(object,key).set(value);
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
      try{return this.namedReference(actor,name).get();}
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
      read:(actor,name)=>this.namedReference(actor,name).get(),
      write:(actor,name,value)=>this.namedReference(actor,name).set(value),
      processEvent:(actor,name,args)=>this.processEvent(actor,name,args),
    });
  }
  regionValue(receiver) {
    const value=this.namedReference(receiver,'Region').get();
    return {zone:value['engine.actor.pointregion.zone'],leaf:value['engine.actor.pointregion.ileaf'],
      zoneNumber:value['engine.actor.pointregion.zonenumber']};
  }
  setRegion(receiver,zone,leaf,zoneNumber) {
    this.namedReference(receiver,'Region').set({'engine.actor.pointregion.zone':zone,
      'engine.actor.pointregion.ileaf':leaf,'engine.actor.pointregion.zonenumber':zoneNumber});
  }
  /** Bridge the existing recovered ordinary Actor zone path to script fields.
   * Spawn's accepted CameraPoint path has no Pawn head/foot regions. */
  setSpawnActorZone(receiver,test,force) {
    const level=this.levelFor(receiver);
    if(typeof level?.pointRegion!=='function')throw new Error('SpawnActor requires the original BSP PointRegion service');
    const actor={isPawn:false};
    Object.defineProperties(actor,{
      deleted:{get:()=>this.namedReference(receiver,'bDeleteMe').get()},
      position:{get:()=>this.namedReference(receiver,'Location').get()},
      region:{get:()=>this.regionValue(receiver),set:value=>this.setRegion(receiver,value.zone,value.leaf,value.zoneNumber)},
    });
    setActorZone(actor,{levelInfo:level.actors[0],pointRegion:position=>level.pointRegion(position),
      actorLeaving:zone=>this.processEvent(zone,'ActorLeaving',[receiver]),
      zoneChange:(_,zone)=>this.processEvent(receiver,'ZoneChange',[zone]),
      actorEntered:zone=>this.processEvent(zone,'ActorEntered',[receiver]),
    },test,force);
  }
  spawnActor(args) {
    const cls=args.cls?.linkedClass;
    if(!cls)throw new Error('Spawn class is not linked');
    const lifecycle=this.actorLifecycle;
    const level=args.level;
    const key=cls.record.key;
    // BSP world hits arrive as the collision query's $world sentinel; the
    // script-visible Level actor is the attached LevelInfo at actors[0], the
    // identity the original dispatch would target (Actor.SupportActor runs
    // on LevelInfo). Map it before the script-event dispatch.
    const levelActor=target=>target===level?.hash?.levelInfo?level.actors[0]:target;
    const services={
      read:(actor,name)=>this.namedReference(actor,name).get(),
      write:(actor,name,value)=>this.namedReference(actor,name).set(value),
      defaultRead:(cls,name)=>this.defaultValue(cls,this.lookupMember(cls,'fields',name)),
      isActorClass:cls=>{for(;cls;cls=cls.base)if(cls===this.actorClass)return true;return false;},
      validate:input=>lifecycle?.validateSpawn?.(input),
      resolveConstructor:cls=>lifecycle?.resolveConstructor?.(cls),
      construct:(cls,options,context)=>this.constructObject(cls,options,
        context?.constructorSelection
          ?{...lifecycle.construction,nativeConstructor:nativeConstructorFor(context.constructorSelection)}
          :lifecycle.construction),
      setRegion:(...values)=>this.setRegion(...values),
      setNativeLevel:(actor,level)=>{this.instance(actor).nativeObject.xLevel=level;},
      setOwner:(actor,owner)=>this.setOwner(actor,owner),
      initExecution:actor=>{
        const state=this.initExecution(actor),level=this.levelFor(actor);
        if(!state||!level?.actors||level.actors[0]!==this.namedReference(actor,'Level').get())
          this.warning?.({type:'ActorInitExecution',actor});
      },
      processEvent:(actor,name)=>this.processEvent(actor,name),
      setActorZone:(actor,test,force)=>this.setSpawnActorZone(actor,test,force),
      // The collision-carrying subclasses (currently the admitted Inventory
      // chain) run the recovered pre-startup hash gate, the real
      // CheckEncroachment and the FindBase tail instead of the bounded
      // no-collision path. The view reads and writes the object's own field
      // storage, so natives dispatched later see the same state.
      installCollisionView:actor=>{
        const lineage=[];
        for(let entry=cls;entry;entry=entry.base)lineage.push(entry.record.key);
        installActorCollisionView(actor,{
          read:(a,name)=>this.namedReference(a,name).get(),
          write:(a,name,value)=>this.namedReference(a,name).set(value),
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
    // The original prologue gates reject null/abstract/non-Actor/static
    // classes before any class-specific behaviour, so they precede this
    // runtime's subclass-startup admission gate.
    if(spawnActorRejectedByGates({...args,cls},services))return null;
    const spawn=key==='deusex.datalinkplay'?spawnScriptDataLinkPlay
      // Admitted by linked DataVaultImage -> Engine.Inventory ancestry, which is
      // what UClass::Bind's constructor copy-down actually depends on, rather
      // than by class name.
      :inventoryImageChain(cls)?spawnScriptInventoryActor
      :key==='engine.camerapoint'?spawnScriptCameraPoint
      :typeof lifecycle?.spawnActor==='function'
        ?(spawnArgs,spawnServices)=>lifecycle.spawnActor(spawnArgs,spawnServices)
        :null;
    if(!spawn)throw new Error(`SpawnActor ${key} subclass startup is not implemented`);
    return spawn({...args,cls},services);
  }
  destroyActor(receiver,netForce=false) {
    if(!this.actorLifecycle)throw new Error('Actor.Destroy requires linked world lifecycle services');
    return destroyScriptActor(receiver,{
      ...this.actorLifecycle,
      levelFor:this.actorLifecycle.levelFor??this.levelFor,
      read:(actor,name)=>this.namedReference(actor,name).get(),
      write:(actor,name,value)=>this.namedReference(actor,name).set(value),
      processEvent:(actor,name,args)=>this.processEvent(actor,name,args),
      isProbing:(actor,name)=>this.isProbing(actor,name),
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
      read:(actor,name)=>this.namedReference(actor,name).get(),
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
    return this.classDefaultReference(this.instance(receiver).cls,field);
  }
  classDefaultReference(cls,field) {
    if(!cls.propertyLink.includes(field))throw new Error('Class default property is not linked to this class');
    if(field.key.startsWith('core.object.'))
      throw new Error('Native class-default header storage is not bound');
    return propertyReference(field,()=>this.defaultValue(cls,field),value=>{
      const values=field.metadata.arrayDim>1
        ?new Map(value.map((item,index)=>[index,item])):new Map([[0,value]]);
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
  invoke(call) {
    const record=call.kind==='final'?this.objects.operand(call.script,call.node):this.lookup(call.receiver,call.name,call.kind==='global');
    if(!record)throw new Error(`Original function was not found: ${call.name}`);
    return this.callFunction(record,call.receiver,call.argumentCount,call.evaluateArgument,call);
  }
  invokeNative(call) {
    // A host may claim specific natives as external boundaries (see constructor);
    // those are delegated to the `native` callback before any built-in body runs.
    if(this.boundaryNatives.has(call.index)){
      if(!this.native)throw new Error(`Original native ${call.index} is declared a host boundary but no native handler is set`);
      return this.native({...call,runtime:this});
    }
    if(call.index===0&&call.record?.key==='core.object.dynamicloadobject')
      return execDynamicLoadObject(call,{staticLoadObject:request=>this.loadPreparedDynamicObject(request)});
    if(call.index===231)return execObjectLog(call,{logDevice:this.logDevice});
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
    if(call.index===1409){
      if(call.argumentCount!==0)throw new Error('Window.Destroy accepts no arguments');
      return safeDestroyWindowNative(call.receiver,this.windowLifecycle?.destroy??{});
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
    if(call.index===1425){
      if(call.argumentCount!==0)throw new Error('Window.GetRootWindow accepts no arguments');
      return getRootWindowNative(call.receiver,this.windowLifecycle?.hierarchy);
    }
    if(call.index===1460){
      if(call.argumentCount!==0)throw new Error('Window.AskParentForReconfigure accepts no arguments');
      return askParentForReconfigureNative(call.receiver,this.windowLifecycle?.reconfiguration);
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
    if(call.index===1432){
      if(call.argumentCount!==2)throw new Error('Window.SetPos requires x and y');
      const x=refValue(call.evaluateArgument(0)),y=refValue(call.evaluateArgument(1));
      const position=this.windowLifecycle?.position??{};
      return setWindowPositionNative(call.receiver,x,y,{...position,
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
    if(call.index===1550){
      if(call.argumentCount!==1)throw new Error('TextWindow.SetText requires one string argument');
      const value=refValue(call.evaluateArgument(0));
      const text=this.windowLifecycle?.text??{};
      return setTextNative(call.receiver,value,{...text,
        askParentForReconfigure:text.askParentForReconfigure??
          (request=>askParentForReconfigureNative(request.object,this.windowLifecycle?.reconfiguration)),
      });
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
    if(call.index===2054){
      if(call.argumentCount!==0)throw new Error('ClearBindEvents accepts no arguments');
      return clearConversationEvents(call.receiver,{read:(object,key)=>this.namedReference(object,key).get()});
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
      if(call.argumentCount!==6)throw new Error('Trace takes six arguments');
      const outLocation=call.evaluateArgument(0),outNormal=call.evaluateArgument(1);
      const end=refValue(call.evaluateArgument(2)),source=call.receiver;
      const startDefault=source.position;
      const start=refValue(call.evaluateArgument(3))??startDefault;
      const traceDefault=Boolean(source.flags&1);
      const traceActors=refValue(call.evaluateArgument(4))??traceDefault;
      const extent=refValue(call.evaluateArgument(5))??[0,0,0];
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
      if(call.argumentCount!==2)throw new Error('FastTrace takes two arguments');
      const source=call.receiver,end=refValue(call.evaluateArgument(0));
      const startDefault=source.position;
      const start=refValue(call.evaluateArgument(1))??startDefault;
      const level=this.levelFor(source),model=level?.model;
      if(!model)throw new Error('FastTrace requires the live level BSP model');
      return scriptFastTrace(model,source,end,start,level.fastLineCheck);
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
      read:(actor,name)=>this.namedReference(actor,name).get(),
      write:(actor,name,value)=>this.namedReference(actor,name).set(value),
      levelFor:this.levelFor,spawnActor:args=>this.spawnActor(args),
    });
    if(call.index===299){
      if(call.argumentCount!==1)throw new Error('SetRotation requires one rotator argument');
      const rotation=refValue(call.evaluateArgument(0));
      return setScriptRotation(call.receiver,rotation,{
        levelFor:this.levelFor,
        read:(actor,name)=>this.namedReference(actor,name).get(),
        write:(actor,name,value)=>this.namedReference(actor,name).set(value),
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
    // Other receivers keep their host-native paths.
    if(this.collisionViewActors.has(call.receiver)&&(call.index===262||call.index===283||call.index===298||call.index===3970)){
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
    if(call.index===259){
      if(call.argumentCount>3)throw new Error('PlayAnim accepts at most three arguments');
      const sequenceName=refValue(call.evaluateArgument(0));
      // UnrealScript encodes a skipped optional argument as EX_Nothing even
      // when a later optional argument is present (`PlayAnim('HitTorso',,
      // 0.1)`). The native P_GET_FLOAT_OPTX wrappers retain their declared
      // defaults for that hole; do the same after evaluating each expression.
      const rateArgument=call.argumentCount>1?refValue(call.evaluateArgument(1)):undefined;
      const tweenArgument=call.argumentCount>2?refValue(call.evaluateArgument(2)):undefined;
      const rate=rateArgument===undefined?1:rateArgument;
      const tweenTime=tweenArgument===undefined?-1:tweenArgument;
      const mesh=this.meshPayload(call.receiver);
      if(!mesh){
        // Original guard logs through 0x10599a68 and returns with no state write.
        this.warning?.({type:'PlayAnimNoMesh',receiver:call.receiver,sequence:sequenceName});
        return;
      }
      return execPlayAnim(animationView(this,call.receiver),mesh,sequenceName,rate,tweenTime,
        (kind,details)=>this.warning?.({type:'PlayAnim',kind,...details}));
    }
    if(call.index===264){
      if(call.argumentCount>6)throw new Error('PlaySound accepts at most six arguments');
      return execActorPlaySound(call,this.soundServices(call));
    }
    if(call.index===266)return execMove(call,this.moveServices(call));
    if(call.index===512)return execMakeNoise(call,this.noiseServices(call));
    if(call.index===2100||call.index===2101||call.index===2102){
      if(call.argumentCount!==0)throw new Error('ConBindEvents accepts no arguments');
      return this.bindConversationEvents(call.receiver);
    }
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
    if(!this.native)throw new Error(`Unimplemented original native ${call.index}`);
    return this.native({...call,runtime:this});
  }
  timerState(receiver) {
    if(!this.actorClass)throw new Error('Actor timer fields are not linked');
    const state={};
    for(const [key,name] of [['timerRate','TimerRate'],['timerCounter','TimerCounter'],['timerLoop','bTimerLoop']]){
      const ref=this.fieldReference(receiver,this.lookupMember(this.actorClass,'fields',name));
      Object.defineProperty(state,key,{get:ref.get,set:ref.set,enumerable:true});
    }
    return state;
  }
  /** Caller supplies Actor.Tick eligibility and ordering. This is only its
   * ProcessState → timer phase, before the separate physics implementation. */
  processActorScript(receiver,seconds) {
    this.instance(receiver).state.process(seconds);
    return updateActorTimer(this.timerState(receiver),seconds,()=>this.processEvent(receiver,'Timer'));
  }
  createIterator(call) {
    if(call.index===309||call.index===1000){
      // execTraceActors/execTraceTexture run one MultiLineCheck at
      // IteratorStart and publish each hit list node in order; see
      // docs/script-trace.md.
      const create=call.index===309?createTraceActorsIterator:createTraceTextureIterator;
      return create({...call,levelFor:this.levelFor});
    }
    if(call.index===310||call.index===311||call.index===306){
      // execRadiusActors/execVisibleActors/execBasedActors scan
      // Level->Actors in native order; the candidate Class->+0x28 ancestry
      // walk is the attached instance's cls chain, same as AllActors. See
      // docs/script-actor-queries.md.
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
