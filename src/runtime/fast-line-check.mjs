const f=Math.fround;
const bits=new DataView(new ArrayBuffer(4));
const distance=(point,plane)=>f((point[2]*plane[2]+point[1]*plane[1])+point[0]*plane[0]-plane[3]);
function side(value) {
  bits.setFloat32(0,value,true);
  return Number(bits.getInt32(0,true)>=0);
}
function vector(value) {
  if(!Array.isArray(value)||value.length!==3||!value.every(Number.isFinite))
    throw new Error('FastLineCheck requires a finite vector');
  const result=value.map(f);
  if(!result.every(Number.isFinite))throw new Error('FastLineCheck vector exceeds float32');
  return result;
}

/** UModel.FastLineCheck 103f3280 -> 103f33a0, not the general LineCheck ray.
 * Original reference cases, branches and precision scope: docs/fast-line-check.md.
 */
export function fastLineCheck(model,first,second) {
  if(!Array.isArray(model?.nodes)||model.rootOutside===undefined)
    throw new Error('FastLineCheck requires the original compiled BSP');
  first=vector(first);second=vector(second);
  if(!model.nodes.length)return Boolean(model.rootOutside);
  const stack=[{index:0,first,second,outside:Number(Boolean(model.rootOutside))}];
  let visits=0;
  while(stack.length){
    let {index,first:a,second:b,outside}=stack.pop();
    while(index!==-1){
      if(++visits>model.nodes.length*8+8)throw new Error('Invalid cyclic FastLineCheck BSP');
      const node=model.nodes[index];
      if(!node)throw new Error('Invalid FastLineCheck node index');
      const endDistance=distance(b,node.plane),startDistance=distance(a,node.plane);
      if(!Number.isFinite(endDistance)||!Number.isFinite(startDistance))
        throw new Error('Nonfinite FastLineCheck plane distance is unsupported');
      const endSide=side(endDistance),startSide=side(startDistance);
      const nextOutside=s=>s^((s^outside)&(node.flags&1));
      if(endSide===startSide){
        outside=nextOutside(endSide);index=endSide?node.front:node.back;
      }else{
        const fraction=endDistance/(endDistance-startDistance);
        const middle=a.map((value,axis)=>f((value-b[axis])*fraction+b[axis]));
        stack.push({index:endSide?node.front:node.back,first:middle,second:b,outside:nextOutside(endSide)});
        outside=nextOutside(startSide);index=startSide?node.front:node.back;
        b=a;a=middle;
      }
    }
    if(!outside)return false;
  }
  return true;
}
