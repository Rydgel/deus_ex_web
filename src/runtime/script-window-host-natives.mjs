/** Window host leaves recovered from the shipped Extension.dll.
 * This dispatcher supplies the native memory/services to existing translations.
 * It does not replace script methods. See docs/script-window-host.md. */
import {refValue} from './script-vm.mjs';
import * as T from './script-window-tree-natives.mjs';
import {addLog,clearLog} from './script-window-text-log.mjs';
import {gcEnableTranslucentText} from './script-gc-enable-translucent-text.mjs';
import {enableTextAsAcceleratorNative} from './script-window-text.mjs';

const packed = c => ['r','g','b','a'].reduce((word,k,i)=>word|((c?.[`core.object.color.${k}`]??0)&255)<<(8*i),0)>>>0;
export function dispatchWindowHostNative(W, call) {
  const win=call.receiver;
  const arg=(i,fallback)=>i<call.argumentCount?(refValue(call.evaluateArgument(i))??fallback):fallback;
  const out=(i,v)=>{const a=call.evaluateArgument(i);if(a?.reference)a.set(v);};
  // One-bit field update: dword = (dword & ~mask) | (flag & 1 ? mask : 0).
  const bits=(offset,mask,flag)=>W.setU32(win,offset,(W.u32(win,offset)&~mask)|(flag?mask:0));
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
    case 1489: {const vector=arg(0,null),r=W.v.convertVectorToCoordinates(win,Array.isArray(vector)?vector:['x','y','z'].map(k=>vector[`core.object.vector.${k}`]));out(1,r.x);out(2,r.y);value=r.visible;break;}
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
    // Leaf setters/getters; each exec body tail-calls the cited method.
    // Verified with scripts/validate-window-native-diff.mjs.
    case 1424: bits(0x38,2,arg(0,false));break;                   // SetBackgroundStretching, inline in exec 0x10051e30
    case 1474: W.setF32(win,0x114,arg(0,0));break;                // SetSoundVolume 0x100502c0
    case 1495: W.setPtr(win,0x104,arg(0,null));W.setPtr(win,0x108,arg(1,null));break; // SetFocusSounds 0x100502d0
    case 1500: W.setU8(win,0x174,arg(0,0));break;                 // ModalWindow.SetMouseFocusMode, inline in exec 0x100376d0
    case 1512: bits(0x5d8,1,arg(0,true));break;                   // RootWindow.EnableRendering 0x10039e20
    case 1513: value=W.u32(win,0x5d8)&1;break;                    // IsRenderingEnabled, inline in exec 0x1003ca80
    case 1514: // SetRenderViewport 0x10039e50
      W.setU32(win,0x5d8,W.u32(win,0x5d8)|2);
      for(let i=0;i<4;i++)W.setF32(win,0x5dc+4*i,arg(i,0));break;
    case 1515: W.setU32(win,0x5d8,W.u32(win,0x5d8)&~2);W.setU32(win,0x5dc,0);W.setU32(win,0x5e0,0);break; // ResetRenderViewport 0x10039e90
    case 1516: { // SetRawBackground 0x10039eb0; the omitted color's alpha byte
      // is the stale high byte of the caller's FFrame pointer slot (exec
      // 0x1003cc0d stores only R/G/B), 0 for a game stack below 16 MB.
      const color=arg(1,null);W.setPtr(win,0x5ec,arg(0,null));W.setU32(win,0x5f8,color?packed(color):0x00ffffff);break;
    }
    case 1517: W.setF32(win,0x5f0,arg(0,0));W.setF32(win,0x5f4,arg(1,0));break; // SetRawBackgroundSize 0x10039ed0
    case 1518: bits(0x5d8,4,arg(0,true));break;                   // StretchRawBackground 0x10039ef0
    case 1521: // LockMouse 0x1003a290
      W.setU32(win,0x5a4,(W.u32(win,0x5a4)&~6)|((arg(0,true)?1:0)<<1)|((arg(1,true)?1:0)<<2));break;
    case 1522: bits(0x5a4,8,arg(0,true));break;                   // ShowCursor 0x1003a310
    case 1595: // ButtonWindow.EnableAutoRepeat 0x10007aa0; float defaults at 0x10059df8/0x10059dfc
      bits(0x174,4,arg(0,true));W.setF32(win,0x17c,arg(1,0.5));W.setF32(win,0x180,arg(2,Math.fround(0.1)));break;
    case 1596: bits(0x174,8,arg(0,true));break;                   // EnableRightMouseClick 0x10007ae0
    case 1597: W.setPtr(win,0x190,arg(0,null));W.setPtr(win,0x194,arg(1,null));break; // SetButtonSounds 0x10007b00
    case 1564: // TextWindow.EnableTextAsAccelerator 0x100464e0 (exec 0x10047370, default TRUE)
      value=undefined;enableTextAsAcceleratorNative(win,arg(0,true)?1:0,{
        read:(object,offset,kind)=>W.heap.read(object,offset,kind),
        write:(object,offset,kind,raw)=>W.heap.write(object,offset,kind,raw),
        makeAcceleratorTableDirty:({object})=>W.native.makeAcceleratorTableDirty(object)});break;
    case 1843: W.setU8(win,0x20c,arg(0,0));break;                 // CheckboxWindow.SetCheckboxStyle 0x1000a9a0
    case 1844: { // SetCheckboxColor 0x1000a9b0: one unaligned dword at +0x20d
      const color=packed(arg(0,null));for(let i=0;i<4;i++)W.setU8(win,0x20d+i,color>>>(8*i));break;
    }
    default: return {handled:false};
  }
  return {handled:true,value};
}
