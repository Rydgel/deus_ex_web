import {spawnScriptActor, spawnScriptProjectileActor} from './script-spawn.mjs';
import {projectileConstructorChain, projectileSelection} from './script-projectile-construction.mjs';
import {SCRIPTED_ACTOR_CONSTRUCTION} from './script-scripted-actor-construction.mjs';

/** Original hit-effect and fragment construction, with script/mesh preparation
 * before synchronous Play events. docs/script-crate-destruction.md. */
export async function prepareCrateLifecycle({runtime,assets,level,decorations,prepareClass,prepareItemMeshes}) {
  const selections=new Map(),projectiles=new Set(),prepared=new Set();
  const size=cls=>runtime.classLoader.graph.slotOf(cls.loadRecord,0x3c);
  const traceChain=cls=>{
    let trace=false;
    for(let node=cls;node;node=node.base){
      trace ||= node.record.key==='deusex.tracehitspawner';
      if((node.metadata?.entry?.flags??0)&0x04000000)
        return trace&&node.record.key==='engine.actor'&&node.base?.record.key==='core.object';
    }
    return false;
  };
  async function prepare(cls) {
    if(prepared.has(cls))return;
    prepared.add(cls);
    await prepareClass(cls);
    await prepareItemMeshes(cls);
    if(projectileConstructorChain(cls)){
      selections.set(cls,projectileSelection(cls,size(cls)));projectiles.add(cls);
    }else if(traceChain(cls)){
      const actor=SCRIPTED_ACTOR_CONSTRUCTION.engineActor;
      selections.set(cls,{classKey:cls.record.key,inherited:true,
        constructor:actor.internalConstructor,constructorBody:actor.constructorBody,
        nativeVtable:actor.vtable,propertiesSize:size(cls)});
    }
    // Fragment.Flying.BeginState chooses from the authored Fragments array.
    const fragments=runtime.lookupMember(cls,'fields','Fragments');
    if(fragments)for(const mesh of runtime.defaultValue(cls,fragments)??[])
      if(mesh)await runtime.prepareResource(mesh);
    for(const name of ['fragType','Contents','Content2','Content3','AmmoName']){
      const field=runtime.lookupMember(cls,'fields',name);
      const reference=field?runtime.defaultValue(cls,field):null;
      if(reference)await prepare(await runtime.loadClass(reference.asset,reference.index));
    }
  }
  const dx=await assets.get('DeusEx');
  for(const [path,index] of dx.exportsByPath)
    if(path.startsWith('tracehit')&&dx.pkg.exports[index-1].className==='Class')
      await prepare(await runtime.loadClass(dx,index));
  for(const actor of decorations){
    await prepare(runtime.instance(actor).cls);
    for(const name of ['fragType','Contents','Content2','Content3']){
      const reference=runtime.namedReference(actor,name).get();
      if(reference)await prepare(await runtime.loadClass(reference.asset,reference.index));
    }
  }
  const previous=runtime.actorLifecycle;
  runtime.actorLifecycle={...previous,
    validateSpawn:args=>selections.has(args.cls)?args.level===level:previous.validateSpawn(args),
    construction:{...previous.construction,validate:args=>selections.has(args.cls)
      ?args.outer===level.nativeObject.outer&&args.template===null:previous.construction.validate(args)},
    resolveConstructor:cls=>selections.get(cls)??previous.resolveConstructor(cls),
    spawnActor:(args,services)=>{
      const selection=selections.get(args.cls);
      if(!selection)return previous.spawnActor(args,services);
      if(projectiles.has(args.cls))return spawnScriptProjectileActor(args,services);
      return spawnScriptActor(args,services,{kind:'TraceHitSpawner',key:args.cls.record.key,
        nativeConstructorSelection:selection});
    },
  };
  return {prepared,selections};
}
