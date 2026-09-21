/** Recovered Extension TileWindow storage/initialization and setters.
 * Addresses and scope: docs/script-instructor-conversation.md. */
export function constructTileWindow(object,{write,coreObjectConstructor}) {
  coreObjectConstructor({object});
  for(const offset of [0xd4,0xd8,0xdc,0xe0,0xe4,0xe8,0x168,0x16c,0x170])write(object,offset,'u32',0);
  write(object,0,'u32',0x1005b760);
}
export function initTileWindow(object,parent,{read,write,initWindow}) {
  initWindow({window:object,parent});
  for(const offset of [0x14c,0x14d,0x14e])write(object,offset,'u8',0);
  for(const offset of [0x150,0x154])write(object,offset,'f32',3);
  for(const offset of [0x158,0x15c])write(object,offset,'f32',1);
  for(const offset of [0x160,0x161])write(object,offset,'u8',3);
  write(object,0x164,'u32',(read(object,0x164,'u32')&~4)|11);
}
export function setTileWindow(object,index,args,{read,write,askParentForReconfigure}) {
  const byte=(at,value)=>write(object,at,'u8',value&255);
  const float=(at,value)=>write(object,at,'f32',Math.fround(value));
  const bit=(mask,value)=>write(object,0x164,'u32',(read(object,0x164,'u32')&~mask)|((value&1)?mask:0));
  switch(index){
    case 1535:float(0x150,args[0]??0);float(0x154,args[1]??0);break;
    case 1536:byte(0x14c,args[0]??0);break;
    case 1537:byte(0x14d,args[0]??0);byte(0x14e,args[1]??0);break;
    case 1538:{
      const orders=[[0,0,0,0],[0,1,0,0],[1,0,0,0],[1,0,1,0],[0,0,0,1],
        [0,0,1,1],[0,1,0,1],[0,1,1,1],[1,0,0,1],[1,1,0,1],[1,0,1,1],[1,1,1,1]];
      const [o,h,v,w]=orders[args[0]&255]??orders[4];
      byte(0x14c,o);byte(0x14d,h);byte(0x14e,v);bit(1,w);break;
    }
    case 1539:float(0x158,args[0]??0);break;
    case 1540:float(0x15c,args[0]??0);break;
    case 1541:byte(0x160,args[0]??0);byte(0x161,args[1]??0);break;
    case 1542:case 1543:case 1544:case 1545:bit(1<<(index-1542),args[0]??0);break;
    default:throw new Error(`Unsupported TileWindow setter ${index}`);
  }
  askParentForReconfigure({object});
}

/** ComputeChildSizes selected ORDER_Down / FillParent / no wrapping branch.
 * Child heights are QueryPreferredHeight(innerWidth) results. */
export function layoutTileDown(width,heights,{horizontalMargin=20,verticalMargin=10,spacing=1}={}){
  const f=Math.fround,inner=f(Math.max(0,f(width)-2*f(horizontalMargin)));
  let rowHeight=0,y=f(verticalMargin);
  for(const h of heights)rowHeight=Math.trunc(rowHeight+f(spacing)+f(h));
  if(heights.length)rowHeight=Math.trunc(rowHeight-f(spacing));
  const rects=heights.map(h=>{
    const rect={x:f(horizontalMargin),y,width:Math.trunc(inner),height:f(h)};
    y=f(y+f(spacing)+f(h));return rect;
  });
  return {height:f(rowHeight+2*f(verticalMargin)),rects,innerWidth:inner};
}
