/** Original Extension preferred-sizing chain. See docs/script-window-scroll-layout.md. */
import * as T from './script-window-tree-natives.mjs';
import {textureSize} from './script-window-scroll-children.mjs';
import {x87load as X,x87int32 as I,x87add as A,x87neg as N,x87mul as M,x87store as S} from './script-vm.mjs';
const f=Math.fround,sub=(a,b)=>A(a,N(b)),sum=(...v)=>S(v.map(X).reduce(A));
const twice=v=>M(X(v),I(2));

export function scalePreferredSize(W,win){
  let width=0,height=0;
  for(const [tex,w,h,border] of [[0x150,0x18c,0x190,0x16c],[0x154,0x194,0x198,0x170],[0x158,0x19c,0x1a0,null]]){
    const size=textureSize(W,W.ptr(win,tex),W.f32(win,w),W.f32(win,h),border===null?0:W.f32(win,border));
    if(tex===0x150||T.c0(width,size[0]))width=size[0];
    if(tex===0x150||T.c0(height,size[1]))height=size[1];
  }
  return {width:S(A(twice(W.f32(win,0x1bc)),X(width))),height:S(A(twice(W.f32(win,0x1c0)),X(height)))};
}
export function managerPreferredSize(W,win){
  let width=0,height=0,spacing=0;
  for(let child=T.bottomChild(W,win,1);child;child=T.higherSibling(W,child,1)){
    const size=T.queryPreferredSize(W,child,0,0,0,0);
    if(W.i32(win,0x15c)===1){height=sum(size.height,height,spacing);if(T.c0(width,size.width))width=size.width;}
    else{width=sum(size.width,width,spacing);if(T.c0(height,size.height))height=size.height;}
    spacing=W.f32(win,0x16c);
  }
  return {width:S(A(twice(W.f32(win,0x164)),X(width))),height:S(A(twice(W.f32(win,0x168)),X(height)))};
}
export function clipChild(W,win){
  let child=T.topChild(W,win,0);
  if(child&&!(W.u8(child,0x30)&1)){
    // bb7e passes the clip, not the previous child, on every iteration.
    child=T.lowerSibling(W,win,0);
    if(child&&!(W.u8(child,0x30)&1))W.boundary('Clip.GetChild original hidden-sibling loop does not terminate');
  }
  return child;
}
export function clipChildPreferredSize(W,win,child,bW,w,bH,h){
  if(!child)return;
  const forceW=Boolean(bW&&(W.u8(win,0x184)&1)),forceH=Boolean(bH&&(W.u8(win,0x184)&2));
  W.setF32(child,0xa4,forceW?0:f(W.i32(win,0x174)));
  W.setF32(child,0xa8,forceH?0:f(W.i32(win,0x178)));
  if(forceW){
    W.setF32(child,0xac,w);
    W.setF32(child,0xb0,forceH?h:T.queryPreferredHeight(W,child,w));
  }else if(forceH){
    const width=T.queryPreferredWidth(W,child,h);
    W.setF32(child,0xac,width);W.setF32(child,0xb0,h);
  }else{
    const size=T.queryPreferredSize(W,child,0,0,0,0);
    W.setF32(child,0xac,size.width);W.setF32(child,0xb0,size.height);
  }
}
export function clipPreferredForChild(W,win,child,bW,w,bH,h){
  if(!child)return W.native.tabGroupPreferredSize(win,bW,w,bH,h);
  const units=W.u8(win,0x184)&4?T.queryGranularity(W,child):{h:1,v:1};
  const cols=W.i32(win,0x17c),rows=W.i32(win,0x180);
  if(cols>=0&&!bW){bW=1;w=S(M(I(cols),X(units.h)));}
  if(rows>=0&&!bH){bH=1;h=S(M(I(rows),X(units.v)));}
  clipChildPreferredSize(W,win,child,bW,w,bH,h);
  return {width:bW?w:W.f32(child,0xac),height:bH?h:W.f32(child,0xb0)};
}
export const clipPreferredSize=(W,win,bW,w,bH,h)=>clipPreferredForChild(W,win,clipChild(W,win),bW,w,bH,h);
export function queryClipPreferredSize(W,win,bW,w,bH,h){
  if(!bW&&W.f32(win,0x9c)>=0){bW=1;w=W.f32(win,0x9c);}
  if(!bH&&W.f32(win,0xa0)>=0){bH=1;h=W.f32(win,0xa0);}
  const child=clipChild(W,win),size=clipPreferredForChild(W,win,child,bW,bW?w:10,bH,bH?h:10);
  return {width:bW?w:size.width,height:bH?h:size.height,
    overflowW:child&&T.c0(size.width,W.f32(child,0xac))?1:0,
    overflowH:child&&T.c0(size.height,W.f32(child,0xb0))?1:0};
}
export function scrollAreaPreferredSize(W,win,bW,w,bH,h){
  const visible=off=>{const c=W.ptr(win,off);return c&&(W.u8(c,0x30)&1)?c:null;};
  const horizontal=visible(0x14c),vertical=visible(0x150),clip=visible(0x16c);
  if(!clip){
    for(const c of [horizontal,vertical])if(c)for(let off=0xa4;off<=0xb0;off+=4)W.setF32(c,off,0);
    return {width:10,height:10};
  }
  let ht=0,vt=0,hd=0,vd=0,showH=0,showV=0,autoH=0,autoV=0;
  if(horizontal){ht=T.queryPreferredSize(W,horizontal,0,0,0,0).height;hd=sum(ht,W.f32(win,0x178));showH=1;}
  if(vertical){vt=T.queryPreferredSize(W,vertical,0,0,0,0).width;vd=sum(vt,W.f32(win,0x178));showV=1;}
  if(W.u8(win,0x17c)&1){
    if(horizontal){autoH=1;showH=(W.u32(win,0x17c)>>>1)&1;}
    if(vertical){autoV=1;showV=(W.u32(win,0x17c)>>>2)&1;}
  }
  const innerW=bW?S(sub(X(w),twice(W.f32(win,0x170)))):0;
  const innerH=bH?S(sub(X(h),twice(W.f32(win,0x174)))):0;
  const trials=(autoH?2:1)*(autoV?2:1);let size;
  for(let trial=1;;trial++){
    if(trial>trials){if(autoH)showH=1;if(autoV)showV=1;}
    size=queryClipPreferredSize(W,clip,bW,sum(innerW,-(showV&&bW?vd:0)),bH,sum(innerH,-(showH&&bH?hd:0)));
    if(trial>trials)break;
    if(autoH&&size.overflowW&&!showH){showH=1;continue;}
    if(autoV&&size.overflowH&&!showV){showV=1;continue;}
    if(autoH&&!size.overflowW&&showH){showH=0;continue;}
    if(autoV&&!size.overflowH&&showV){showV=0;continue;}
    break;
  }
  W.setU32(win,0x17c,(W.u32(win,0x17c)&~6)|(showH<<1)|(showV<<2));
  const x=W.f32(win,0x170),y=W.f32(win,0x174);
  W.setF32(clip,0xa4,x);W.setF32(clip,0xa8,y);W.setF32(clip,0xac,size.width);W.setF32(clip,0xb0,size.height);
  if(horizontal){
    W.setF32(horizontal,0xa4,W.f32(clip,0xa4));
    W.setF32(horizontal,0xa8,sum(W.f32(win,0x178),W.f32(clip,0xb0),W.f32(clip,0xa8)));
    W.setF32(horizontal,0xac,W.f32(clip,0xac));W.setF32(horizontal,0xb0,showH?ht:0);
  }
  if(vertical){
    W.setF32(vertical,0xa4,sum(W.f32(win,0x178),W.f32(clip,0xac),W.f32(clip,0xa4)));
    W.setF32(vertical,0xa8,W.f32(clip,0xa8));W.setF32(vertical,0xb0,W.f32(clip,0xb0));W.setF32(vertical,0xac,showV?vt:0);
  }
  const margin=twice(W.f32(win,0x170));
  let width=A(margin,X(W.f32(clip,0xac)));if(showV)width=A(width,X(vd));
  let height=S(A(X(S(margin)),X(W.f32(clip,0xb0))));if(showH)height=sum(height,hd);
  return {width:S(width),height};
}

/** Tile's granularity dependency, 0x10048860. Script runs before child lookup. */
export function tileGranularity(W,win,h,v){
  const args=[f(h),f(v)];W.processScript(win,'ParentRequestedGranularity',args);
  const child=T.topChild(W,win,1);
  if(child){
    if(W.u8(win,0x164)&4)args[0]=sum(W.f32(win,W.u8(win,0x14c)===1?0x15c:0x158),W.f32(child,0x80));
    if(W.u8(win,0x164)&8)args[1]=sum(W.f32(win,W.u8(win,0x14c)===1?0x158:0x15c),W.f32(child,0x84));
  }
  return {h:f(args[0]),v:f(args[1])};
}
