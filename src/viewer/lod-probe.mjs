/** Validation only (scripts/validate-lodmesh-lod-play.mjs): the actor mesh
 * layer's DrawLodMesh LOD state on the simulation side, per binding updated
 * in the last frame: the frame's inputs (Frame->Coords, FX, FovAngle and its
 * tangent float), the actor's (Location, DrawScale, LODBias), the selection
 * (detail bits, requested count, flags), GetFrame's returned count, the
 * final flags and morph start, and the admitted faces and their distinct
 * vertices. Floats are returned with their bit patterns. */
const bits=value=>{const v=new DataView(new ArrayBuffer(4));v.setFloat32(0,value,true);return v.getUint32(0,true);};

export function lodProbe(actorSim,{all=false,list=false}={}){
  if(!actorSim)return null;
  // `list`: every binding's actor, mesh and Location (to aim views).
  if(list)return actorSim.all().map(binding=>{let location=null;try{location=binding.location;}catch{}
    return {id:binding.id,actor:binding.actor?.name??null,mesh:binding.mesh?.key??null,path:binding.path,location};});
  const rows=[];
  for(const binding of actorSim.all()){
    const state=binding.lodState?.();
    if(!state||(!all&&!state.updated))continue;
    const {frame,inputs,selection}=state;
    rows.push({id:binding.id,actor:state.actor,mesh:state.mesh,meshPackage:state.meshPackage,meshIndex:state.meshIndex,path:state.path,drawn:state.drawn,
      frame:{coordsBits:frame.coords.map(bits),fxBits:bits(frame.fx),fovBits:bits(frame.fov),tanBits:bits(frame.tanFactor),
        settings:{...frame.settings}},
      inputs:{locationBits:inputs.location.map(bits),drawScaleBits:bits(inputs.drawScale),lodBiasBits:bits(inputs.lodBias)},
      selection:{detailBits:bits(selection.detail),requested:selection.requested,active:selection.active,morph:selection.morph},
      returned:state.returned,state:state.state,admitted:state.admitted,vertices:state.vertices});
  }
  return rows;
}
