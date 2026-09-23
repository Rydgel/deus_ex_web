/** Extension.dll root native Tick and MoveTabGroup. Evidence, offsets and
 * call order: docs/script-window-root-tick.md. Services are the shared tree
 * and window-family translations, with SetFocusWindow as the host boundary. */
import {x87load,x87neg,x87add,x87store} from './script-vm.mjs';
function topModal(W,root,S) {
  for(let child=S.topChild(W,root,1);child;child=S.lowerSibling(W,child,1))
    if(W.u8(child,0x28)>=2)return child;
  return root;
}

export function moveTabGroupNative(W,win,direction,S) {
  const root=S.getRootWindow(W,win);
  if(!root)return null;
  const modal=topModal(W,root,S);
  if(!modal)return null;
  let changed=false;
  for(let i=0;i<W.farray.num(modal,0x17c);i++)
    if(S.computeTabGroupLocation(W,W.farray.ptr(modal,0x17c,i)))changed=true;
  if(changed)S.resortTabGroupTable(W,modal);
  const count=W.farray.num(modal,0x17c),focus=W.ptr(root,0x5c8);
  const step=index=>direction===0||direction===2?(index>0?index-1:count-1):(index+1<count?index+1:0);
  let first=null;
  if(focus&&S.getModalWindow(W,focus)===modal){
    const group=S.getTabGroupWindow(W,focus);
    if(group)first=W.farray.ptr(modal,0x17c,step(W.i32(group,0x168)));
  }
  if(!first&&count>0)first=W.farray.ptr(modal,0x17c,0);
  if(first){
    const start=W.i32(first,0x168);
    let index=start,candidate=null;
    do {
      const group=W.farray.ptr(modal,0x17c,index);
      for(let row=0;row<W.farray.num(group,0x14c);row++){
        const child=W.farray.ptr(group,0x14c,row);
        if(S.isTraversable(W,child,0)){candidate=child;break;}
      }
      if(candidate)break;
      index=step(index);
    }while(index!==start);
    if(candidate)S.setFocusWindow(root,candidate);
  }
  return W.ptr(root,0x5c8);
}

export function rootTickNative(W,root,seconds,S) {
  if(!W.ptr(root,0x5c8)){
    const modal=topModal(W,root,S);
    if(modal&&W.u8(modal,0x174)<3){
      const preferred=W.ptr(modal,0x178);
      if(preferred&&S.isTraversable(W,preferred,1))S.setFocusWindow(root,preferred);
      if(!W.ptr(root,0x5c8))moveTabGroupNative(W,root,3,S);
    }
  }
  // Compare the still-extended result after the float32 store (fst/fcomp).
  const remaining=x87add(x87load(W.f32(root,0x620)),x87neg(x87load(Math.fround(seconds))));
  W.setF32(root,0x620,x87store(remaining));
  if(remaining.nan!==undefined||(remaining.neg&&(remaining.inf||remaining.sig!==0n)))W.setF32(root,0x620,0);
  S.buildAcceleratorTable(W,root);
}
