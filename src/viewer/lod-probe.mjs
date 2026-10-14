/** Validation only (scripts/validate-lodmesh-lod-play.mjs): the actor mesh
 * layer's DrawLodMesh LOD state on the simulation side, per binding updated
 * in the last frame: the frame's inputs (Frame->Coords, FX, FovAngle and its
 * tangent float), the actor's (Location, DrawScale, LODBias), the selection
 * (detail bits, requested count, flags), GetFrame's returned count, the
 * final flags and morph start, and the admitted faces and their distinct
 * vertices. Floats are returned with their bit patterns. */
const bits=value=>{const v=new DataView(new ArrayBuffer(4));v.setFloat32(0,value,true);return v.getUint32(0,true);};

export function lodProbe(actorSim,{all=false,list=false,settings=null}={},weaponSim=null){
  if(!actorSim)return null;
  // `settings`: URender's MLOD/MLMODE/MLFIX for the next frames (an object
  // as setLodSettings takes it), or false for the shipped ones.
  if(settings===false)actorSim.resetLodSettings();
  else if(settings)actorSim.setLodSettings(settings);
  // `list`: every binding's actor, mesh and Location (to aim views).
  if(list)return actorSim.all().map(binding=>{let location=null;try{location=binding.location;}catch{}
    return {id:binding.id,actor:binding.actor?.name??null,mesh:binding.mesh?.key??null,path:binding.path,location};});
  const rows=[];
  // The first-person weapon's bindings join the rows (`weapon`): Canvas.DrawActor selects its LOD in the master frame.
  const weapon=new Set(weaponSim?.all?.()??[]);
  for(const binding of [...actorSim.all(),...weapon]){
    const state=binding.lodState?.();
    if(!state||(!all&&!state.updated))continue;
    const {frame,inputs,selection}=state;
    rows.push({id:weapon.has(binding)?`weapon${binding.id}`:binding.id,weapon:weapon.has(binding),actor:state.actor,mesh:state.mesh,meshPackage:state.meshPackage,meshIndex:state.meshIndex,path:state.path,drawn:state.drawn,
      frame:{coordsBits:frame.coords.map(bits),fxBits:bits(frame.fx),fovBits:bits(frame.fov),tanBits:bits(frame.tanFactor),
        settings:{...frame.settings}},
      inputs:{locationBits:inputs.location.map(bits),drawScaleBits:bits(inputs.drawScale),lodBiasBits:bits(inputs.lodBias)},
      selection:{detailBits:bits(selection.detail),requested:selection.requested,active:selection.active,morph:selection.morph},
      returned:state.returned,state:state.state,admitted:state.admitted,vertices:state.vertices,
      // Child frames that drew it: their own selection, and whether it draws
      // what the main frame's does.
      frames:(state.frames??[]).map(entry=>({index:entry.index,same:entry.same,main:entry.main,here:entry.here,returned:entry.returned,state:entry.state,admitted:entry.admitted,vertices:entry.vertices,
        coordsBits:entry.frame.coords.map(bits),fxBits:bits(entry.frame.fx),
        selection:{detailBits:bits(entry.selection.detail),requested:entry.selection.requested,active:entry.selection.active,
          morph:entry.selection.morph}}))});
  }
  return rows;
}
