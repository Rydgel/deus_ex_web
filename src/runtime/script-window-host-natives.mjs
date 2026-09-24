/** Window host leaves recovered from the shipped Extension.dll.
 * This dispatcher supplies the native memory/services to existing translations.
 * It does not replace script methods. See docs/script-window-host.md. */
import {setButtonTexturesNative} from './script-window-set-button-textures.mjs';
import {setButtonColorsNative} from './script-window-set-button-colors.mjs';
import * as S from './script-window-scroll-children.mjs';
import {enableScrollAreaScrolling,setScrollAreaDistance,setScrollAreaMargins,autoHideScrollAreaBars} from './script-window-scroll-area.mjs';
import {refValue} from './script-vm.mjs';
import * as T from './script-window-tree-natives.mjs';
import {addLog,clearLog} from './script-window-text-log.mjs';
import {gcSetBaselineData} from './script-gc-set-baseline-data.mjs';
import {gcEnableTranslucentText} from './script-gc-enable-translucent-text.mjs';
import {convertScriptString,enableTextAsAcceleratorNative,setAcceleratorTextNative} from './script-window-text.mjs';
import {addTimer,removeTimer} from './script-window-timers.mjs';
import {setCursorPos} from './script-window-mouse.mjs';
import {pressButtonNative} from './script-window-press-button.mjs';
import {isKeyDownNative} from './script-window-is-key-down.mjs';

const packed = c => ['r','g','b','a'].reduce((word,k,i)=>word|((c?.[`core.object.color.${k}`]??0)&255)<<(8*i),0)>>>0;
export function dispatchWindowHostNative(W, call) {
  const win=call.receiver;
  const arg=(i,fallback)=>i<call.argumentCount?(refValue(call.evaluateArgument(i))??fallback):fallback;
  const out=(i,v)=>{const a=call.evaluateArgument(i);if(a?.reference)a.set(v);};
  // One-bit field update: dword = (dword & ~mask) | (flag & 1 ? mask : 0).
  const bits=(offset,mask,flag)=>W.setU32(win,offset,(W.u32(win,offset)&~mask)|(flag?mask:0));
  // The +0x00 vtable word holds the original Extension.dll table address.
  const vtableRead=(object,offset,kind)=>W.heap.read(object,offset,offset===0&&kind==='ptr'?'u32':kind);
  let value;
  switch(call.index){
    case 1420: T.setSelectability(W,win,arg(0,false));break;
    case 1426: value=T.getModalWindow(W,win);break;
    case 1427: value=T.getTabGroupWindow(W,win);break;
    case 1429: {const root=T.getRootWindow(W,win);value=root?W.ptr(root,T.ROOT.parentPawn):null;break;}
    case 1439: // exec 0x100524a0 passes the FString directly, without pipe conversion.
      setAcceleratorTextNative(win,arg(0,''),{
        read:(object,offset,kind)=>W.heap.read(object,offset,kind),
        write:(object,offset,kind,raw)=>W.heap.write(object,offset,kind,raw),
        makeAcceleratorTableDirty:({object})=>W.native.makeAcceleratorTableDirty(object)});break;
    case 1454: { // XWindow::SetDefaultCursor 0x1004fab0; exec 0x10052c20.
      W.setPtr(win,0xf0,arg(0,null));W.setPtr(win,0xf4,arg(1,null));
      W.setF32(win,0xf8,arg(2,-1));W.setF32(win,0xfc,arg(3,-1));
      const color=arg(4,null);W.setU32(win,0x100,color?packed(color):0x00ffffff);break;
    }
    case 1469: value=convertScriptString(arg(0,''));break; // 10050710
    case 1482: value='\n';break; // CarriageReturn exec 0x10053e70 assigns L"\n" (0x10098e58)
    case 1462: T.resizeChild(W,win);break;
    case 1463: value=T.queryPreferredWidth(W,win,arg(0,0));break;
    case 1464: value=T.queryPreferredHeight(W,win,arg(0,0));break;
    case 1465: {const size=T.queryPreferredSize(W,win,0,0,0,0);out(0,size.width);out(1,size.height);break;}
    case 1466: {const size=T.queryGranularity(W,win);out(0,size.h);out(1,size.v);break;}
    case 1483: { // 1004dc90, exec default true at 10053f18.
      const enabled=arg(0,true)?1:0,old=W.u32(win,0x74);
      if(((old>>>1)&1)!==enabled){W.setU32(win,0x74,(old&~2)|(enabled<<1));const gc=W.ptr(win,0x130);if(gc)gcEnableTranslucentText(gc,enabled,W.gc.services);}break;
    }
    case 1484: { // exec 0x10053de0 -> XWindow::SetBaselineData 0x1004dd30.
      // Evaluate both arguments before the method reads its existing GC.
      const baseline=arg(0,2),underline=arg(1,1),gc=W.ptr(win,0x130);
      if(gc)gcSetBaselineData(gc,baseline,underline,W.gc.services);break;
    }
    case 1485: value=W.gc.get(win);break;
    case 1486: W.gc.release(win,arg(0,null));break;
    case 1487: W.setPtr(win,0x118,arg(0,null));break; // XWindow::SetClientObject 0x10003390
    case 1489: {const vector=arg(0,null),r=W.v.convertVectorToCoordinates(win,Array.isArray(vector)?vector:['x','y','z'].map(k=>vector[`core.object.vector.${k}`]));out(1,r.x);out(2,r.y);value=r.visible;break;}
    // execAddTimer 0x10054130: four zero-initialized parameters (timeout,
    // bLoop, clientData, timer function name); returns the node address.
    case 1490: value=addTimer(W,win,arg(0,0),arg(1,false)?1:0,arg(2,0),arg(3,'None')||'None');break;
    case 1491: removeTimer(W,win,arg(0,0));break; // execRemoveTimer 0x10054220
    case 1453: setCursorPos(W,win,arg(0,0),arg(1,0));break; // execSetCursorPos 0x10052b90 -> 0x1004cca0
    // ButtonWindow.PressButton (exec 0x10008c90, byte default IK_Space) and
    // ActivateButton (exec 0x100085b0, byte default 0).
    case 1598: pressButtonNative(win,arg(0,0x20)&0xff,{read:vtableRead,
      buttonPressed:({object,key})=>W.v.pressButton(object,key)});break;
    case 1590: W.native.activateButton(win,arg(0,0)&0xff);break;
    // Window.IsKeyDown (exec 0x100535f0): the root's +0x630+key byte as the bool result.
    case 1470: value=Boolean(isKeyDownNative(win,arg(0,0)&0xff,{read:(object,offset,kind)=>W.heap.read(object,offset,kind)}));break;
    case 1492: value=W.tickOffset();break;
    case 1510: W.setPtr(win,0x5a8,arg(0,null));break; // 0x10039390
    case 1511: for(let i=0;i<5;i++)W.setPtr(win,0x5ac+4*i,arg(i,null));break; // 0x100393a0
    case 1558: { // XTextWindow::SetLines 0x10046120
      let min=Math.max(0,arg(0,0)|0),max=Math.max(0,arg(1,0)|0);if(min>max)min=max;
      if(W.i32(win,0x15c)!==min||W.i32(win,0x160)!==max){W.setI32(win,0x15c,min);W.setI32(win,0x160,max);W.native.askParentForReconfigure(win);}break;
    }
    // XTextWindow line/width/word-wrap leaves; each changed value asks the
    // parent to reconfigure. Verified with scripts/validate-window-native-diff.mjs.
    case 1555: { // SetWordWrap 0x10045fb0 compares bit0 with the raw UBOOL
      const flags=W.u32(win,0x150),wrap=arg(0,false)?1:0;
      if((flags&1)!==wrap){W.setU32(win,0x150,(((flags^wrap)&1)^flags)>>>0);W.native.askParentForReconfigure(win);}break;
    }
    case 1559: { // SetMinLines 0x100461d0: clamp to [0, maxLines]
      let lines=arg(0,0)|0;if(lines<0)lines=0;const max=W.i32(win,0x160);if(lines>max)lines=max;
      if(W.i32(win,0x15c)!==lines){W.setI32(win,0x15c,lines);W.native.askParentForReconfigure(win);}break;
    }
    case 1560: { // SetMaxLines 0x10046270: clamp to [max(0), minLines..]
      let lines=arg(0,0)|0;if(lines<0)lines=0;const min=W.i32(win,0x15c);if(lines<min)lines=min;
      if(W.i32(win,0x160)!==lines){W.setI32(win,0x160,lines);W.native.askParentForReconfigure(win);}break;
    }
    case 1561: // ResetLines 0x10046310: both -1 unless both are already negative
      if(W.i32(win,0x15c)>=0||W.i32(win,0x160)>=0){W.setI32(win,0x15c,-1);W.setI32(win,0x160,-1);W.native.askParentForReconfigure(win);}break;
    case 1562: { // SetMinWidth 0x100463b0: fcomp 0.0 C0 (less or NaN) -> +0; C3 skips the store
      let width=Math.fround(arg(0,0));if(!(width>=0))width=0;const old=W.f32(win,0x164);
      if(!(old===width||Number.isNaN(old))){W.setF32(win,0x164,width);W.native.askParentForReconfigure(win);}break;
    }
    case 1563: // ResetMinWidth 0x10046450: only a width above 0.0 is reset
      if(W.f32(win,0x164)>0){W.setU32(win,0x164,0);W.native.askParentForReconfigure(win);}break;
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
    case 1592: setButtonTexturesNative(win,...Array.from({length:6},(_,i)=>arg(i,null)),{
      read:(o,off,kind)=>W.heap.read(o,off,kind),write:(o,off,kind,v)=>W.heap.write(o,off,kind,v)});break;
    case 1593: {
      const colors=Array.from({length:6},(_,i)=>arg(i,null));
      if(colors.some(v=>v===null))W.boundary('SetButtonColors omitted-color stack alpha is not modeled');
      setButtonColorsNative(win,...colors.map(packed),{
        read:(o,off,kind)=>W.heap.read(o,off,kind),write:(o,off,kind,v)=>W.heap.write(o,off,kind,v)});break;
    }
    case 1595: // ButtonWindow.EnableAutoRepeat 0x10007aa0; float defaults at 0x10059df8/0x10059dfc
      bits(0x174,4,arg(0,true));W.setF32(win,0x17c,arg(1,0.5));W.setF32(win,0x180,arg(2,Math.fround(0.1)));break;
    case 1596: bits(0x174,8,arg(0,true));break;                   // EnableRightMouseClick 0x10007ae0
    case 1597: W.setPtr(win,0x190,arg(0,null));W.setPtr(win,0x194,arg(1,null));break; // SetButtonSounds 0x10007b00
    case 1564: // TextWindow.EnableTextAsAccelerator 0x100464e0 (exec 0x10047370, default TRUE)
      value=undefined;enableTextAsAcceleratorNative(win,arg(0,true)?1:0,{
        read:(object,offset,kind)=>W.heap.read(object,offset,kind),
        write:(object,offset,kind,raw)=>W.heap.write(object,offset,kind,raw),
        makeAcceleratorTableDirty:({object})=>W.native.makeAcceleratorTableDirty(object)});break;
    case 1620: S.scaleOrientation(W,win,arg(0,0));break;
    case 1621: S.scaleTexture(W,win,arg(0,null),arg(1,0),arg(2,0),arg(3,0),arg(4,0));break;
    case 1622: S.thumbTexture(W,win,arg(0,null),arg(1,0),arg(2,0));break;
    case 1624: S.thumbCaps(W,win,arg(0,null),arg(1,null),arg(2,0),arg(3,0),arg(4,0),arg(5,0));break;
    case 1625: S.stretchScale(W,win,arg(0,true)?1:0);break;
    case 1629: case 1630: case 1631: W.setU8(win,0x17c+call.index-1629,arg(0,0));break;
    case 1632: case 1633: case 1634: W.setU32(win,0x17f+4*(call.index-1632),packed(arg(0,null)));break;
    case 1635: S.scaleMargins(W,win,arg(0,0),arg(1,0));break;
    case 1636: S.scaleNumTicks(W,win,arg(0,0));break;
    case 1637: value=W.i32(win,0x1c4);break;
    case 1638: S.scaleThumbSpan(W,win,arg(0,1));break;
    case 1640: W.native.setTickPosition(win,arg(0,0)|0);break;
    case 1641: value=W.i32(win,0x1c8);break;
    case 1650: W.native.moveThumb(win,arg(0,0)&255);break;
    case 1651: W.setI32(win,0x1d0,Math.max(1,arg(0,0)|0));break;
    case 1652: {const sounds=[arg(0,null),arg(1,null),arg(2,null)];sounds.forEach((v,i)=>W.setPtr(win,0x1f4+4*i,v));break;}
    case 1680: W.native.setClipPosition(win,arg(0,0)|0,arg(1,0)|0);break;
    case 1681: {
      // Both lvalues are captured before writing. The first write may alias
      // the receiver's row; read that row only afterward (original b5e0).
      const col=call.evaluateArgument(0),row=call.evaluateArgument(1);
      if(col?.reference)col.set(W.i32(win,0x174));
      if(row?.reference)row.set(W.i32(win,0x178));
      break;
    }
    case 1700: enableScrollAreaScrolling(W,win,arg(0,true)?1:0,arg(1,true)?1:0);break;
    case 1701: setScrollAreaDistance(W,win,arg(0,0));break; // exec 0x10043ec0
    case 1702: setScrollAreaMargins(W,win,arg(0,0),arg(1,0));break; // exec 0x10043f40
    case 1703: autoHideScrollAreaBars(W,win,arg(0,true)?1:0);break; // exec 0x10044000
    case 1843: W.setU8(win,0x20c,arg(0,0));break;                 // CheckboxWindow.SetCheckboxStyle 0x1000a9a0
    case 1844: { // SetCheckboxColor 0x1000a9b0: one unaligned dword at +0x20d
      const color=packed(arg(0,null));for(let i=0;i<4;i++)W.setU8(win,0x20d+i,color>>>(8*i));break;
    }
    default: return {handled:false};
  }
  return {handled:true,value};
}
