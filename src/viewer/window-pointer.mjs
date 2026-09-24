/** Browser PointerEvent -> original root-window input units.
 * HUD layout uses WebGL drawing-buffer pixels, so CSS coordinates and locked
 * relative motion both need the canvas' current pixel ratio. */
export const pointerButtonKey=button=>button===0?1:button===2?2:button===1?4:-1;

export function windowPointerSample(event,rect,width,height,relative=false){
  const sx=width/Math.max(1,rect.width),sy=height/Math.max(1,rect.height);
  if(relative)return {relative:true,dx:event.movementX*sx,dy:event.movementY*sy};
  return {relative:false,x:(event.clientX-rect.left)*sx,y:(event.clientY-rect.top)*sy};
}
