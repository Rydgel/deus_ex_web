/** Scatter the original DrawLodMesh face colors into a draw group's reflected
 * corner order (0,2,1). Both arrays are Uint32 views of Float32 color buffers.
 * Equal words already reside in the GPU attribute, so only a changed group
 * needs a buffer upload. Lighting itself still runs on every drawn frame. */
export function copyMeshLightColors(target,source,faces) {
  let first=0;
  for(;first<faces.length;first++){
    const s=faces[first]*9,d=first*9;
    if(target[d]!==source[s]||target[d+1]!==source[s+1]||target[d+2]!==source[s+2]
      ||target[d+3]!==source[s+6]||target[d+4]!==source[s+7]||target[d+5]!==source[s+8]
      ||target[d+6]!==source[s+3]||target[d+7]!==source[s+4]||target[d+8]!==source[s+5])break;
  }
  if(first===faces.length)return false;
  for(let k=first;k<faces.length;k++){
    const s=faces[k]*9,d=k*9;
    target[d]=source[s];target[d+1]=source[s+1];target[d+2]=source[s+2];
    target[d+3]=source[s+6];target[d+4]=source[s+7];target[d+5]=source[s+8];
    target[d+6]=source[s+3];target[d+7]=source[s+4];target[d+8]=source[s+5];
  }
  return true;
}
