/** Original native Decal construction and admission gates.
 * Evidence and explicit surface-attachment boundary: docs/script-decal-startup.md. */
import {refValue} from './script-vm.mjs';
import {traceRay} from './ray.mjs';
import {getAxes} from './camera.mjs';

export class DecalBoundaryError extends Error {
  constructor(operation,message){
    super(message);this.name='DecalBoundaryError';this.code='DECAL_BOUNDARY';this.operation=operation;
  }
}

const f=Math.fround;
const dot3=(a,b)=>f(f(f(a[0]*b[0])+f(a[1]*b[1]))+f(a[2]*b[2]));
const sub3=(a,b)=>[f(a[0]-b[0]),f(a[1]-b[1]),f(a[2]-b[2])];
const cross3=(a,b)=>[f(a[1]*b[2]-a[2]*b[1]),f(a[2]*b[0]-a[0]*b[2]),f(a[0]*b[1]-a[1]*b[0])];
const norm3=v=>{const q=dot3(v,v);if(!(q>=1e-8))return null;const inverse=1/Math.sqrt(q);return v.map(n=>f(n*inverse));};

/** Convex containment of a point projected onto a BSP node's polygon, the
 * recovered per-node test of the 0x103e9090 surface iterator: consecutive
 * edge-side signs against the polygon normal must agree. */
function polygonContainsPoint(model,node,point){
  const surface=model.surfaces[node.surface];
  const normal=model.vectors[surface.normal],base=model.points[surface.base];
  const projected=sub3(point,normal.map(v=>f(v*dot3(sub3(point,base),normal))));
  let side=0;
  for(let i=0;i<node.vertexCount;i++){
    const a=model.points[model.vertices[node.vertexPool+i].point];
    const b=model.points[model.vertices[node.vertexPool+(i+1)%node.vertexCount].point];
    const cross=dot3(cross3(sub3(b,a),sub3(projected,a)),normal);
    if(cross===0)continue;
    const sign=Math.sign(cross);
    if(side===0)side=sign;
    else if(sign!==side)return false;
  }
  return true;
}

/** The 0x103e9090 surface iterator: walks the coplanar chain from the hit
 * node (recursion target node+0x28 = iCoplanar) and returns the first node
 * whose polygon contains the probe point, -1 when the chain is exhausted. */
function findCoplanarSurface(model,startNode,point){
  for(let index=startNode,guard=0;index!==-1&&index!=null;index=model.nodes[index].coplanar){
    if(++guard>model.nodes.length)throw new DecalBoundaryError('AttachDecal.chain','Invalid cyclic decal surface chain');
    const node=model.nodes[index];
    if(!node||!node.vertexCount)continue;
    if(polygonContainsPoint(model,node,point))return node.surface;
  }
  return -1;
}

/** ADecal::execAttachDecal surface path, Engine.dll 0x103e734b-0x103e898e.
 * Recovered contract implemented here:
 *  - swept point check Location -> Location - XAxis*distance (flags 6);
 *  - D1 = -direction; a zero direction arg builds a normalized random
 *    direction (2*FRand()-1 components, rejected while |v|^2 > 1 — the
 *    original's VRand-style sphere acceptance at 0x103e74fd-0x103e7568);
 *  - probe = Location + D1*(dist(Location,surfPlane)/dot(D1,normal));
 *  - the 0x103e9090 iterator returns the first coplanar-chain node whose
 *    polygon contains the probe; -1 -> return false;
 *  - gates on the returned surface: dot(XAxis,normal)==0 -> false,
 *    |dot(vBase-probe,normal)|>0.001 -> false, PolyFlags&0x600 -> false;
 *  - the model keeps one texture-keyed decal record per texture, owned by
 *    the first decal that registered it; SurfList += iSurf;
 *  - return value follows the original: false on any gate, true after
 *    registration (0x103e897d writes Result=1 unconditionally).
 * Explicit boundaries:
 *  - the MultiDecalLevel^2 footprint grid (0x103e7f32-0x103e8902) sweeps
 *    sample cells and appends further coplanar surfaces under the decal;
 *    those extra SurfList entries are not yet produced. The only consumer
 *    of additional entries is DetachDecal's facet-record removal, and the
 *    facet records themselves are renderer-internal (not generated here).
 *  - the span/facet vertex geometry for the software renderer
 *    (0x103e7c40-0x103e8964) is not produced; no renderer here consumes it. */
export function attachDecalSurfaces(actor,distance,direction,{model,read,write,frand}){
  if(!model?.nodes?.length||!model?.surfaces?.length)
    throw new DecalBoundaryError('AttachDecal.model','AttachDecal requires the original compiled BSP model');
  const rotation=read(actor,'Rotation'),location=read(actor,'Location').map(f);
  const xAxis=getAxes(rotation)[0];
  const end=location.map((v,i)=>f(v-f(xAxis[i]*distance)));
  const hit=traceRay(model,location,end,6);
  if(!hit||hit.node==null||hit.node===-1)return false;
  const hitNode=model.nodes[hit.node];
  if(!hitNode)return false;
  const surface=model.surfaces[hitNode.surface];
  const normal=model.vectors[surface.normal],base=model.points[surface.base];
  let d1;
  if(direction.some(v=>v!==0))d1=direction.map(v=>f(-v));
  else{
    if(typeof frand!=='function')
      throw new DecalBoundaryError('AttachDecal.direction','AttachDecal random direction requires the original RNG stream');
    let v;
    do{v=[f(frand()*2-1),f(frand()*2-1),f(frand()*2-1)];}while(dot3(v,v)>1);
    const unit=norm3(v);
    if(!unit)return false;
    d1=unit.map(n=>f(-n));
  }
  // probe = Location + D1 * (dot(vBase-Location, n) / dot(D1, n)). The raw
  // division is preserved: a near-parallel D1 produces an infinite probe
  // that no polygon contains, matching the original's -1 -> false result.
  const reach=dot3(sub3(base,location),normal),denominator=dot3(d1,normal);
  const probe=location.map((v,i)=>f(v+f(d1[i]*f(reach/denominator))));
  const iSurf=findCoplanarSurface(model,hit.node,probe);
  if(iSurf===-1)return false;
  const selected=model.surfaces[iSurf];
  const selectedNormal=model.vectors[selected.normal],selectedBase=model.points[selected.base];
  if(dot3(xAxis,selectedNormal)===0)return false;
  if(Math.abs(dot3(sub3(selectedBase,probe),selectedNormal))>0.001)return false;
  if(selected.flags&0x600)return false;
  const texture=read(actor,'Texture');
  const records=model.decalRecords??(model.decalRecords=new Map());
  if(!records.has(texture))records.set(texture,actor);
  write(actor,'SurfList',[...read(actor,'SurfList'),iSurf]);
  return true;
}

/** ADecal::execDetachDecal surface release. The original walks SurfList
 * removing this decal's facet record per surface; the browser renderer does
 * not generate those records, so the script-visible result is the drained
 * SurfList and the released texture-keyed record. */
export function detachDecalSurfaces(actor,{model,read,write}){
  write(actor,'SurfList',[]);
  const records=model?.decalRecords;
  if(records)for(const [key,owner] of records)if(owner===actor)records.delete(key);
}

export function execAttachDecal(call,{read,write,clientFor,warning,attachSurfaces}){
  if(call.argumentCount<1||call.argumentCount>2)throw new Error('AttachDecal requires distance and optional direction');
  const distance=Math.fround(refValue(call.evaluateArgument(0)));
  const supplied=call.argumentCount>1?refValue(call.evaluateArgument(1)):undefined;
  const direction=supplied===undefined?[0,0,0]:supplied.map(Math.fround);
  if(direction.length!==3)throw new Error('AttachDecal requires a three-component direction');
  const client=clientFor(call.receiver);
  if(client===null)return false;
  if(!client||!Number.isInteger(client.decals)&&typeof client.decals!=='boolean')
    throw new DecalBoundaryError('Client.Decals','AttachDecal requires the original Client.Decals setting');
  if(!client.decals)return false;
  if(read(call.receiver,'Texture')===null){
    warning?.({type:'DecalMissingTexture',actor:call.receiver});return false;
  }
  const depth=read(call.receiver,'MultiDecalLevel')|0;
  write(call.receiver,'MultiDecalLevel',Math.min(depth,4));
  if(typeof attachSurfaces!=='function')
    throw new DecalBoundaryError('AttachDecal.surfaces','Original decal BSP surface attachment is not implemented');
  return attachSurfaces(call.receiver,distance,direction);
}

export function execDetachDecal(call,{read,detachSurfaces}){
  if(call.argumentCount!==0)throw new Error('DetachDecal accepts no arguments');
  if(read(call.receiver,'SurfList').length===0)return;
  if(typeof detachSurfaces!=='function')
    throw new DecalBoundaryError('DetachDecal.surfaces','Original decal BSP surface detachment is not implemented');
  return detachSurfaces(call.receiver);
}

/** Admit the actually researched Shadow lifecycle; other Decal subclasses
 * still require their own original event/dependency preparation. This does
 * not spawn anything or run NPC lifecycle on the already populated world. */
export async function prepareShadowStartup(runtime,assets,level){
  const dx=await assets.get('DeusEx'),engine=await assets.get('Engine');
  const cls=await runtime.loadClass(dx,dx.exportsByPath.get('shadow'));
  const chain=[];for(let current=cls;current;current=current.base)chain.push(current.record.key);
  if(chain.join('/')!=='deusex.shadow/engine.decal/engine.actor/core.object'||cls.metadata.classFlags!==0x32)
    throw new Error('Shadow native constructor inheritance differs from the original contract');
  for(const field of cls.propertyLink)await runtime.field(field);
  const surfaceField=runtime.lookupMember(cls,'fields','SurfList');
  if(surfaceField.key!=='engine.decal.surflist'||surfaceField.metadata.innerMetadata?.type!=='int')
    throw new Error('Decal.SurfList does not have the recovered integer-array layout');
  for(const name of ['Spawned','PreBeginPlay','BeginPlay','PostBeginPlay','SetInitialState',
    'PostPostBeginPlay','EndState','Destroyed','GainedChild','LostChild']){
    const record=runtime.lookupMember(cls,'methods',name);
    if(record)await runtime.prepareFunction(record.asset,record.index);
  }
  for(const path of ['decal.attachdecal','decal.detachdecal','actor.destroyed'])
    await runtime.prepareFunction(engine,engine.exportsByPath.get(path));
  const lifecycle=runtime.actorLifecycle,construction=lifecycle?.construction;
  if(!construction)throw new Error('Decal startup requires the original world construction services');
  const isDecal=objectClass=>{for(let node=objectClass;node;node=node.base)if(node.record.key==='engine.decal')return true;return false;};
  lifecycle.construction={...construction,
    initNativeProperties:(object,template)=>{
      construction.initNativeProperties(object,template);
      // ADecal's constructor clears its native SurfList header (the one
      // member write in the Actor constructor family); every Decal-ancestry
      // product binds the reflected SurfList to that native list.
      if(!isDecal(object.objectClass))return;
      // ADecal inherits AActor's native Destroy slot (+0x24 = 10301f8c).
      // This is ConditionalDestroy, not the distinct C++ final destructor.
      object.destroy=receiver=>runtime.destroyActorBase(receiver);
      object.decalSurfaces=runtime.namedReference(object.identity,'SurfList').get();
      runtime.bindProperty(object.identity,surfaceField,{
        get:()=>object.decalSurfaces,set:value=>{object.decalSurfaces=value;},
      });
    },
  };
  return cls;
}
