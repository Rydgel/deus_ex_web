/** Script and mesh preparation for the hit-effect, fragment and contents
 * classes a crate reaches, before synchronous Play events spawn them through
 * the general SpawnActor. docs/script-crate-destruction.md. */
export async function prepareCrateLifecycle({runtime,assets,decorations,prepareClass,prepareItemMeshes}) {
  const prepared=new Set();
  async function prepare(cls) {
    if(prepared.has(cls))return;
    prepared.add(cls);
    await prepareClass(cls);
    await prepareItemMeshes(cls);
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
    const cls=runtime.instance(actor).cls;
    await prepare(cls);
    for(const name of ['fragType','Contents','Content2','Content3']){
      // Engine.Decoration has contents, but fragType is introduced by
      // DeusExDecoration. Other original Decoration subclasses lack it.
      if(!runtime.lookupMember(cls,'fields',name))continue;
      const reference=runtime.readNamed(actor,name);
      if(reference)await prepare(await runtime.loadClass(reference.asset,reference.index));
    }
  }
  return {prepared};
}
