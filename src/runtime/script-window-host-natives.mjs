/** Window host leaves recovered from the shipped Extension.dll.
 * This dispatcher supplies the native memory/services to existing translations.
 * It does not replace script methods. See docs/script-window-host.md. */
import {refValue} from './script-vm.mjs';
import * as T from './script-window-tree-natives.mjs';
import {addLog,clearLog} from './script-window-text-log.mjs';
import {gcEnableTranslucentText} from './script-gc-enable-translucent-text.mjs';

const packed = c => ['r','g','b','a'].reduce((word,k,i)=>word|((c?.[`core.object.color.${k}`]??0)&255)<<(8*i),0)>>>0;
export function dispatchWindowHostNative(W, call) {
  const win=call.receiver;
  const arg=(i,fallback)=>i<call.argumentCount?(refValue(call.evaluateArgument(i))??fallback):fallback;
  const out=(i,v)=>{const a=call.evaluateArgument(i);if(a?.reference)a.set(v);};
  let value;
  switch(call.index){
    case 1420: T.setSelectability(W,win,arg(0,false));break;
    case 1426: value=T.getModalWindow(W,win);break;
    case 1427: value=T.getTabGroupWindow(W,win);break;
    case 1429: {const root=T.getRootWindow(W,win);value=root?W.ptr(root,T.ROOT.parentPawn):null;break;}
    case 1454: { // XWindow::SetDefaultCursor 0x1004fab0; exec 0x10052c20.
      W.setPtr(win,0xf0,arg(0,null));W.setPtr(win,0xf4,arg(1,null));
      W.setF32(win,0xf8,arg(2,-1));W.setF32(win,0xfc,arg(3,-1));
      const color=arg(4,null);W.setU32(win,0x100,color?packed(color):0x00ffffff);break;
    }
    case 1469: { // 10050710 scans pairs: |n becomes LF; other | pairs stay literal.
      const text=String(arg(0,'')).split('\0',1)[0];value='';
      for(let i=0;i<text.length;i++){const c=text[i];if(c!=='|'){value+=c;continue;}const next=text[++i];value+=next==='n'?'\n':('|'+(next??''));}break;
    }
    case 1462: T.resizeChild(W,win);break;
    case 1463: value=T.queryPreferredWidth(W,win,arg(0,0));break;
    case 1464: value=T.queryPreferredHeight(W,win,arg(0,0));break;
    case 1465: {const size=T.queryPreferredSize(W,win,0,0,0,0);out(0,size.width);out(1,size.height);break;}
    case 1466: {const size=T.queryGranularity(W,win);out(0,size.h);out(1,size.v);break;}
    case 1483: { // 1004dc90, exec default true at 10053f18.
      const enabled=arg(0,true)?1:0,old=W.u32(win,0x74);
      if(((old>>>1)&1)!==enabled){W.setU32(win,0x74,(old&~2)|(enabled<<1));const gc=W.ptr(win,0x130);if(gc)gcEnableTranslucentText(gc,enabled,W.gc.services);}break;
    }
    case 1485: value=W.gc.get(win);break;
    case 1486: W.gc.release(win,arg(0,null));break;
    case 1487: W.setPtr(win,0x118,arg(0,null));break; // XWindow::SetClientObject 0x10003390
    case 1489: {const vector=arg(0,null),r=W.v.convertVectorToCoordinates(win,['x','y','z'].map(k=>vector[`core.object.vector.${k}`]));out(1,r.x);out(2,r.y);value=r.visible;break;}
    case 1492: value=W.tickOffset();break;
    case 1510: W.setPtr(win,0x5a8,arg(0,null));break; // 0x10039390
    case 1511: for(let i=0;i<5;i++)W.setPtr(win,0x5ac+4*i,arg(i,null));break; // 0x100393a0
    case 1558: { // XTextWindow::SetLines 0x10046120
      let min=Math.max(0,arg(0,0)|0),max=Math.max(0,arg(1,0)|0);if(min>max)min=max;
      if(W.i32(win,0x15c)!==min||W.i32(win,0x160)!==max){W.setI32(win,0x15c,min);W.setI32(win,0x160,max);W.native.askParentForReconfigure(win);}break;
    }
    case 1572: W.setF32(win,0x174,arg(0,0));break; // 0x100478e0
    case 1570: addLog(W,win,arg(0,''),packed(arg(1,null)));break;
    case 1571: clearLog(W,win);break;
    case 1573: W.setU32(win,0x184,(W.u32(win,0x184)&~4)|((arg(0,false)?1:0)<<2));break; // 0x100478f0
    default: return {handled:false};
  }
  return {handled:true,value};
}
