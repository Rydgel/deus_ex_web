/** Original Extension ScrollAreaWindow construction/setup.
 * See docs/script-window-scroll-area.md. Child-family services are required;
 * the host admits setup and explicitly guards unrecovered layout/input slots. */
export const SCROLL_AREA = Object.freeze({constructor:0x100186e0,init:0x10042d80,
  enableScrolling:0x10043160,vtable:0x1005bcec,size:0x180});

export function constructScrollAreaWindow(W,win){
  W.uobjectConstructor(win);
  for(let off=0xd4;off<=0xe8;off+=4)W.setU32(win,off,0);
  W.setU32(win,0,SCROLL_AREA.vtable);
}

export function enableScrollAreaScrolling(W,win,horizontal,vertical){
  let child=W.ptr(win,0x14c);
  if(child)W.native.setVisibility(child,horizontal);
  child=W.ptr(win,0x150);
  if(child)W.native.setVisibility(child,vertical);
  child=W.ptr(win,0x16c);
  if(child)W.native.forceChildSize(child,horizontal?0:1,vertical?0:1);
}

export function initScrollAreaWindow(W,win,parent){
  W.initWindow(win,parent);
  for(const off of [0x170,0x174,0x178])W.setF32(win,off,3);
  W.setU32(win,0x17c,((W.u32(win,0x17c)&~6)|1)>>>0);
  const create=(className,parent,flag,off)=>W.setPtr(win,off,W.createNewWindow(className,parent,flag));
  create('ScaleManagerWindow',win,0,0x14c);
  create('ScaleManagerWindow',win,0,0x150);
  create('ClipWindow',win,1,0x16c);
  create('ButtonWindow',W.ptr(win,0x14c),1,0x15c);
  create('ScaleWindow',W.ptr(win,0x14c),1,0x154);
  create('ButtonWindow',W.ptr(win,0x14c),1,0x160);
  create('ButtonWindow',W.ptr(win,0x150),1,0x164);
  create('ScaleWindow',W.ptr(win,0x150),1,0x158);
  create('ButtonWindow',W.ptr(win,0x150),1,0x168);
  for(const [managerOff,orientation,startOff,endOff,scaleOff] of
    [[0x14c,0,0x15c,0x160,0x154],[0x150,1,0x164,0x168,0x158]]){
    let manager=W.ptr(win,managerOff);
    W.setU32(manager,0x15c,orientation);
    W.native.askParentForReconfigure(manager);
    W.native.setScaleButtons(W.ptr(win,managerOff),W.ptr(win,startOff),W.ptr(win,endOff));
    W.native.setScale(W.ptr(win,managerOff),W.ptr(win,scaleOff));
    manager=W.ptr(win,managerOff);
    W.setU32(manager,0x160,(W.u32(manager,0x160)|1)>>>0);
    W.native.askParentForReconfigure(manager);
  }
  for(const [off,orientation] of [[0x154,0],[0x158,1]]){
    W.native.setOrientation(W.ptr(win,off),orientation);
    W.native.setSelectability(W.ptr(win,off),0);
    W.native.setNumTicks(W.ptr(win,off),1);
    W.native.setThumbSpan(W.ptr(win,off),1);
    W.native.enableStretchedScale(W.ptr(win,off),1);
  }
  for(const off of [0x15c,0x160,0x164,0x168]){
    W.native.setSelectability(W.ptr(win,off),0);
    W.native.enableAutoRepeat(W.ptr(win,off),1,0.5,Math.fround(0.1));
  }
  enableScrollAreaScrolling(W,win,0,1);
  W.native.setSelectability(win,0);
}

// x87 C3 is set for equal AND unordered (NaN). Only ordered inequality
// requests a change; signed zero compares equal and preserves the old bits.
const differs=(a,b)=>!Number.isNaN(a)&&!Number.isNaN(b)&&a!==b;
export function setScrollAreaDistance(W,win,value){
  const next=Math.fround(value);
  if(differs(W.f32(win,0x178),next)){
    W.setF32(win,0x178,next);W.native.askParentForReconfigure(win);
  }
}
export function setScrollAreaMargins(W,win,width,height){
  width=Math.fround(width);height=Math.fround(height);
  if(differs(W.f32(win,0x170),width)||differs(W.f32(win,0x174),height)){
    W.setF32(win,0x170,width);W.setF32(win,0x174,height);
    W.native.askParentForReconfigure(win);
  }
}
export function autoHideScrollAreaBars(W,win,enabled){
  const flags=W.u32(win,0x17c);
  if((flags&1)!==enabled){
    W.setU32(win,0x17c,((flags&~1)|(enabled&1))>>>0);
    W.native.askParentForReconfigure(win);
  }
}
