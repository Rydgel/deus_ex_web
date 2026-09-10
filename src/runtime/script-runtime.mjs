import { readClass } from '../unreal/classes.mjs';
import { readFieldLinks, readFunctionMetadata, readPropertyMetadata, readStateMetadata, readStructMetadata } from '../unreal/script-metadata.mjs';
import { ScriptObjects } from './script-objects.mjs';
import { compileFunction, refValue } from './script-vm.mjs';
import { ScriptState } from './script-state.mjs';
import { zeroValue, copyValue, propertyReference, arrayReference } from './script-values.mjs';
import { createAllActorsIterator } from './script-iterators.mjs';
import { setActorTimer, updateActorTimer } from './script-timers.mjs';
import { sleepActor, pollActorSleep } from './script-sleep.mjs';
import { probeNames } from '../unreal/probe-names.mjs';
import { conditionalDestroyScriptObject, destroyScriptObject } from './script-object-lifecycle.mjs';
import { setScriptOwner } from './script-owner.mjs';
import { destroyScriptActor } from './script-destroy.mjs';
import { constructFreshScriptObject } from './script-object-construction.mjs';
import { setScriptRotation } from './script-set-rotation.mjs';
import { execScriptSpawn, spawnScriptCameraPoint } from './script-spawn.mjs';
import { setActorZone } from './zone.mjs';
import { prepareContextResults, zeroContextResult } from './script-context-results.mjs';
import { cleanupScriptReferences, cleanupLevelDestroyed } from './script-cleanup.mjs';
import { releaseScriptCameraPoint } from './script-object-release.mjs';
import { serializeScriptReferences } from './script-reference-serialization.mjs';
import { serializeRuntimeActor } from './script-runtime-serialization.mjs';

const lower=name=>String(name).toLowerCase();

/** Linked, synchronous original script calls. Loading/linking remains async;
 * an event never suspends halfway through an original call to fetch an asset.
 * A prepared function/state subset fails explicitly on an unprepared target. */
export class ScriptRuntime {
  constructor(assets,{native,warning,levelFor,actorLifecycle,rng}={}) {
    this.objects=new ScriptObjects(assets);this.classes=new Map();this.functions=new Map();
    this.states=new Map();this.structs=new Map();this.instances=new WeakMap();this.native=native;this.warning=warning;
    this.eventsEnabled=true;
    this.levelFor=receiver=>{
      const object=this.instances.get(receiver)?.nativeObject;
      return object&&Object.hasOwn(object,'xLevel')?object.xLevel:levelFor?.(receiver);
    };
    this.actorClass=null;this.actorLifecycle=actorLifecycle;
    this.rng=rng;
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
        if(!['core.object.vector','core.object.rotator'].includes(struct.key))
          record.metadata.structFields=await this.structFields(struct,ancestry);
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
          if(!property.decoded)value={unsupported:`Undecoded default ${record.key}.${property.name}`};
          else if([5,8].includes(property.type))value=await this.objects.resolve(record.asset,value);
          else if(property.type===10)value=this.authoredStructValue(field,value);
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
    if(typeof services.initNativeProperties!=='function')
      throw new Error('Construction requires explicit native template storage');
    const object=constructFreshScriptObject({...options,cls},{...services,
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
    if(object.identity!==receiver||!Number.isInteger(object.index))throw new Error('Invalid native object identity record');
    instance.nativeObject=object;
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
    for(const field of fields)if(field.metadata.type!=='string')throw new Error(`Original property destructor is unsupported: ${field.key}`);
    for(const field of fields)this.fieldReference(receiver,field).set(zeroValue(field));
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
    if(!keys)return value;
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
    return spawnScriptCameraPoint({...args,cls},{
      read:(actor,name)=>this.namedReference(actor,name).get(),
      write:(actor,name,value)=>this.namedReference(actor,name).set(value),
      defaultRead:(cls,name)=>this.defaultValue(cls,this.lookupMember(cls,'fields',name)),
      isActorClass:cls=>{for(;cls;cls=cls.base)if(cls===this.actorClass)return true;return false;},
      validate:input=>lifecycle?.validateSpawn?.(input),
      construct:(cls,options)=>this.constructObject(cls,options,lifecycle.construction),
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
      warning:this.warning,
    });
  }
  destroyActor(receiver,netForce=false) {
    if(!this.actorLifecycle)throw new Error('Actor.Destroy requires linked world lifecycle services');
    return destroyScriptActor(receiver,{
      ...this.actorLifecycle,
      levelFor:this.actorLifecycle.levelFor??this.levelFor,
      read:(actor,name)=>this.namedReference(actor,name).get(),
      write:(actor,name,value)=>this.namedReference(actor,name).set(value),
      processEvent:(actor,name,args)=>this.processEvent(actor,name,args),
      isProbing:(actor,name)=>this.instance(actor).state?.isProbing(probeNames.get(lower(name))??-1)??true,
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
    if(call.index===195){
      if(call.argumentCount!==0)throw new Error('FRand accepts no arguments');
      if(typeof this.rng?.frand!=='function')throw new Error('FRand requires the shared original RNG stream');
      return Math.fround(this.rng.frand());
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
    if(call.index===113){
      if(call.argumentCount>2)throw new Error('GotoState accepts at most two name arguments');
      const name=call.argumentCount?refValue(call.evaluateArgument(0)):'None';
      const label=call.argumentCount>1?refValue(call.evaluateArgument(1)):'Begin';
      this.gotoState(call.receiver,name,label);return;
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
  /** Core ProcessEvent's ordinary script/POD parameter path. The supplied
   * argument array represents the caller's parameter block: every parameter
   * is copied back, including those without OutParm. Return-value events and
   * native object hooks remain explicit unsupported boundaries. */
  processEvent(receiver,name,args=[]) {
    if(!this.eventsEnabled)return false;
    // The recovered table covers every reserved probe index. Any other valid
    // loaded function name is outside that interval and bypasses its mask gate.
    const instance=this.instance(receiver),ename=probeNames.get(lower(name))??-1;
    if(instance.state&&!instance.state.isProbing(ename))return false;
    const record=this.lookup(receiver,name),fn=record?.function;
    if(!fn)throw new Error(`Original event is not prepared: ${record?.key??name}`);
    // The DLL compares the low word of virtual IsPendingKill with iNative;
    // this is an equality test, including for unusual native event records.
    if((Number(instance.pendingKill)&0xffff)!==(fn.script.nativeIndex&0xffff))return false;
    if(fn.script.functionFlags&0x400)throw new Error(`Native ProcessEvent hook is not implemented: ${record.key}`);
    if(fn.result)throw new Error(`Return-value ProcessEvent parameter layout is not implemented: ${record.key}`);
    if(args.length!==fn.parameters.length)throw new Error(`Incomplete ProcessEvent parameter block: ${record.key}`);
    for(const field of fn.fields)if(['string','array','map','fixedArray'].includes(field.metadata.type)){
      throw new Error(`ProcessEvent temporary ownership is not implemented: ${field.key}`);
    }
    const locals=new Map(fn.fields.map(field=>[field.key,zeroValue(field)]));
    for(const [index,field] of fn.parameters.entries())locals.set(field.key,copyValue(field,args[index]));
    this.executeScript(fn,receiver,locals);
    for(const [index,field] of fn.parameters.entries())args[index]=copyValue(field,locals.get(field.key));
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
    const result=this.executeScript(fn,receiver,locals);
    for(const entry of out.reverse())entry.reference.set(copyValue(entry.field,locals.get(entry.field.key)));
    return fn.result?copyValue(fn.result,result):result;
  }
}
