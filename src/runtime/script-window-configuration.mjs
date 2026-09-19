/** Extension.dll Window.SetConfiguration (1430): exec 10051fe0 -> 1004cd40.
 * 1004cd40..1004ce4b clamps sizes, compares alignment/x/y/w/h in order,
 * stores all six fields, then calls AskParentForReconfigure once. NaN sets
 * x87 C0/C3, so it clamps sizes to zero and compares equal to any operand.
 */
export function setWindowConfigurationNative(object,x,y,width,height,{read,write,askParentForReconfigure}={}){
  if(!object||![read,write,askParentForReconfigure].every(fn=>typeof fn==='function'))
    throw new TypeError('SetConfiguration requires raw storage and reconfiguration services');
  if(![x,y,width,height].every(value=>typeof value==='number'))throw new TypeError('SetConfiguration requires numeric arguments');
  [x,y,width,height]=[x,y,width,height].map(Math.fround);
  if(Number.isNaN(width)||width<0)width=0;if(Number.isNaN(height)||height<0)height=0;
  const equal=(a,b)=>a===b||Number.isNaN(a)||Number.isNaN(b);
  const values=[[0x8c,x],[0x94,y],[0x9c,width],[0xa0,height]];
  if(!read(object,0x88,'u8')&&!read(object,0x89,'u8')&&
    values.every(([offset,value])=>equal(value,read(object,offset,'f32'))))return false;
  write(object,0x88,'u8',0);write(object,0x89,'u8',0);
  for(const [offset,value] of values)write(object,offset,'f32',value);
  askParentForReconfigure({object});return true;
}
