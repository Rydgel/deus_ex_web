/** Original Core fresh-object helpers. These require an explicitly populated
 * native registry and linked native-constructor services. They do not imply
 * ULevel.SpawnActor, loading/replacement, config, or final collection support.
 * Source addresses and supported branches: docs/script-construction.md. */
export class ScriptObjectRegistry {
  constructor({objects=[],freeIndices=[],buckets=Array(4096).fill(null)}={}) {
    if(!Array.isArray(objects)||!Array.isArray(freeIndices)||buckets.length!==4096)
      throw new Error('Invalid original object registry storage');
    this.objects=objects;this.freeIndices=freeIndices;this.buckets=buckets;
    // The original's own slot space (original-object-index.mjs), when seeded:
    // this registry's indices are the host's, an object created after the
    // seed also gets `originalIndex` from AddObject's rule.
    this.original=null;
  }
  add(object) {
    if(object.index!==-1||!Number.isInteger(object.nameIndex)||object.nameIndex<0)
      throw new Error('Fresh registration requires an unregistered object and resolved FName index');
    // A pre-placed map actor is not in Play's registry; its measured
    // GObjObjects index (hashIndex) stands in for the name hash.
    const outerIndex=object.outer?(Number.isInteger(object.outer.index)?object.outer.index:object.outer.hashIndex):0;
    if(object.outer&&!Number.isInteger(outerIndex))throw new Error('Object Outer has no native index');
    const index=this.freeIndices.length?this.freeIndices.at(-1):this.objects.length;
    if(!Number.isInteger(index)||index<0||index>this.objects.length||this.objects[index]!=null)
      throw new Error('Invalid original free object index');
    if(this.freeIndices.length)this.freeIndices.pop();
    this.objects[index]=object;object.index=index;
    if(this.original)this.original.take(object,object.objectClass?.name??object.identity?.name??null,object.name??null);
    const hash=(outerIndex^object.nameIndex)&0xfff;
    object.hashNext=this.buckets[hash];this.buckets[hash]=object;
    return index;
  }
  /** Core UnhashObject10157760 uses the retained Outer index from +0x14,
   * after Destroy detached the linker. The removed next pointer is retained. */
  unhash(object,outerIndex,warning) {
    if(!Number.isInteger(object.nameIndex)||!Number.isInteger(outerIndex))
      throw new Error('UnhashObject requires native FName and retained Outer indices');
    const hash=(object.nameIndex^outerIndex)&0xfff;
    let previous=null,count=0;
    const seen=new Set();
    for(let entry=this.buckets[hash];entry!==null;entry=entry.hashNext){
      if(!entry||seen.has(entry))throw new Error('Invalid original object hash chain');
      seen.add(entry);
      if(entry===object){
        count++;
        if(previous)previous.hashNext=entry.hashNext;
        else this.buckets[hash]=entry.hashNext;
      }else previous=entry;
    }
    if(count!==1)warning?.({type:'UnhashObjectCount',object:object.identity,count});
  }
}

/** Seed a registry at a measured GObjObjects state so runtime spawns continue
 * the original construction order. `count` is the live high-water mark (Core.dll
 * +0x19e62c); the objects array is that long with holes for the freed slots, so
 * AddObject appends at `count` when the free list is empty. `freeIndices` are the
 * freed slots still on GObjAvailable (LIFO; the last is reused first). This does
 * not repopulate the loaded objects — the load-time indices are measured evidence
 * (the live capture), while forward allocation is the recovered rule
 * (docs/boot-replay.md, docs/script-object-release.md). */
export function seedScriptObjectRegistry({count, freeIndices = []} = {}) {
  if(!Number.isInteger(count)||count<0)throw new Error('Registry seed requires a non-negative object count');
  if(!Array.isArray(freeIndices))throw new Error('Registry seed requires a freeIndices array');
  const objects=new Array(count);            // sparse: length is the high-water mark
  const free=[],seen=new Set();
  for(const index of freeIndices){
    if(!Number.isInteger(index)||index<0||index>=count)
      throw new Error(`Registry seed free index ${index} is outside 0..${count - 1}`);
    if(seen.has(index))throw new Error(`Registry seed free index ${index} is occupied twice`);
    seen.add(index);
    free.push(index);
  }
  return new ScriptObjectRegistry({objects, freeIndices: free});
}

/** Name lookup and FName interning are explicit host boundaries, shared with
 * loaded objects. Never use only a list of spawned actors for collision checks. */
export function makeUniqueScriptObjectName(cls,outer,{findObject,internName,counterSeed=null}) {
  if(typeof findObject!=='function'||typeof internName!=='function'||!Number.isInteger(cls.nameCounter))
    throw new Error('Unique naming requires the original class counter, object lookup and name table');
  // a live replay's measured counter for the class, once (script-runtime.mjs applyClassCounterSeed)
  counterSeed?.(cls);
  const prefix=cls.record.name.replace(/[0-9]+$/,'');
  for(;;){
    const suffix=String(cls.nameCounter|0);
    cls.nameCounter=(cls.nameCounter+1)|0;
    const candidate=prefix.slice(0,62-suffix.length)+suffix;
    if(!findObject(outer,candidate))return internName(candidate);
  }
}

/** Accepted fresh StaticAllocateObject -> class native constructor sequence.
 * validate establishes loaded-class/Outer/native-template eligibility before
 * mutation. Existing-name replacement and config/localization are unsupported. */
export function allocateFreshScriptObject({cls,outer,name='None',flags=0,template=null},services) {
  const {validate,findObject,internName,registry,initProperties}=services;
  if(typeof validate!=='function'||validate({cls,outer,name,flags,template})!==true)
    throw new Error('Fresh construction requires verified native class and Outer bindings');
  if(cls.metadata.classFlags&1)throw new Error('Abstract class construction is outside the accepted fresh path');
  if(cls.metadata.classFlags&0x400)throw new Error('Object config/localization loading is not implemented');
  if(!(registry instanceof ScriptObjectRegistry)||typeof initProperties!=='function'
    ||typeof findObject!=='function'||typeof internName!=='function')
    throw new Error('Fresh construction services are incomplete');
  // `uniqueFindObject`: the lookup a generated name is checked with when it must also see objects outside this registry (the map's exports)
  const resolved=String(name).toLowerCase()==='none'
    ?makeUniqueScriptObjectName(cls,outer,{...services,findObject:services.uniqueFindObject??findObject}):internName(name);
  if(!resolved||typeof resolved.name!=='string'||!Number.isInteger(resolved.index))
    throw new Error('Construction requires a resolved original FName');
  if(findObject(outer,resolved.name))throw new Error('Existing-name object replacement is not implemented');
  const object={identity:{},index:-1,hashNext:null,stateFrame:null,linker:null,linkerIndex:-1,
    outer,flags:(flags|(cls.metadata.classFlags&8?0x4000:0))>>>0,
    name:resolved.name,nameIndex:resolved.index,objectClass:cls};
  initProperties(object,template);
  registry.add(object);
  // The observed IsValid boundary verifies registration before constructor
  // dispatch. No caller-visible script event occurs between these operations.
  if(registry.objects[object.index]!==object)throw new Error('Constructed object is not registered');
  return object;
}

/** StaticConstructObject adds the class-selected constructor after allocation.
 * C++ class operator new callers use allocateFreshScriptObject directly. */
export function constructFreshScriptObject(args,services) {
  if(typeof services.nativeConstructor!=='function')throw new Error('Fresh construction requires native constructor dispatch');
  const object=allocateFreshScriptObject(args,services);
  services.nativeConstructor(object);
  return object;
}

/** AActor's verified constructor only changes the virtual table. Its UObject
 * base writes the Core vtable first; FName/FPlane default constructors do not
 * change the template-copied member bytes. Select this only for a native Actor
 * constructor proven from the class metadata, never for an arbitrary subclass. */
export function constructActorBase(object) {
  object.nativeVtable=0x10179dfc;
  object.nativeVtable=0x104268dc;
}

/** Engine CameraPoint registration selects 103033af -> 10331930 ->
 * 10331950. Despite the serialized Keypoint base, this native body directly
 * invokes AActor's constructor and then changes only its own vtable. */
export function constructCameraPoint(object) {
  constructActorBase(object);
  object.nativeVtable=0x10427178;
}

/** Engine AInventory registration selects 1030299b -> 10341730. The body
 * first runs the inlined AActor member construction (the intermediate
 * 0x104268dc store), then the Inventory member constructors, then installs
 * the final AInventory vtable 0x104286f8. Select this only for the
 * DataVaultImage/Image02 chain, whose script-only classes inherit this
 * ClassConstructor through UClass::Bind. */
export function constructInventory(object) {
  constructActorBase(object);
  object.nativeVtable=0x104286f8;
}

/** Engine AWeapon registration selects 10302ef5 -> 10342a70 (null-this guard)
 * -> 10303fb7 -> body 10342a90. The body calls ??0AActor@@QAE@XZ
 * (0x10303431, at 0x10342aad), runs the eight ENoInit/FStringNoInit member
 * constructions at +0x320/+0x32c/+0x338/+0x3c8/+0x3d4/+0x3e0/+0x41c/+0x428 —
 * which write no member bytes — then installs the final AWeapon vtable
 * 0x104287a4 (store at 0x10342b43). Select this only for the DeusExWeapon
 * chain, whose script-only classes inherit this ClassConstructor through
 * UClass::Bind. See docs/script-npc-weapon-startup.md. */
export function constructWeapon(object) {
  constructActorBase(object);
  object.nativeVtable=0x104287a4;
}

/** AProjectile body 0x103442e0: UObject then the final vtable; all inline
 * FName/FPlane/FString ENoInit constructors preserve default-copied bytes. */
export function constructProjectile(object) {
  object.nativeVtable=0x10179dfc;
  object.nativeVtable=0x10428850;
}

/** ADecal's original ctor 10331090 clears only its native SurfList header
 * beyond the inherited construction, then installs vtable 10426f74.
 * decalSurfaces is bound to the same reflected SurfList by the spawn host.
 * See docs/script-decal-startup.md. */
export function constructDecal(object) {
  constructActorBase(object);
  object.decalSurfaces=[];
  object.nativeVtable=0x10426f74;
}

/** Map a SpawnActor constructor selection (script-spawn.mjs
 * nativeActorConstruction) to this host's native body. The selection carries
 * the oracle-generated row of the bound ClassConstructor
 * (script-native-actor-constructors.mjs): a body that writes nothing but its
 * vtable runs the AActor base and installs that final vtable; the only body
 * with member writes, ADecal's SurfList header clear, has its translation. */
export function nativeConstructorFor(selection,{constructFlagBase}={}){
  if(!Number.isInteger(selection?.nativeVtable))throw new Error('Original constructor selection is not implemented');
  if(selection.memberBytes){
    if(selection.nativeClass==='engine.decal'&&selection.nativeVtable===0x10426f74)return constructDecal;
    throw new Error(`Native constructor member writes are not translated for ${selection.nativeClass}`);
  }
  const vtable=selection.nativeVtable;
  if(selection.conditionalFlagBase&&typeof constructFlagBase!=='function')
    throw new Error('PlayerPawnExt constructor requires its conditional FlagBase allocation service');
  return object=>{
    constructActorBase(object);object.nativeVtable=vtable;
    if(selection.conditionalFlagBase)constructFlagBase(object,selection.conditionalFlagBase);
  };
}
