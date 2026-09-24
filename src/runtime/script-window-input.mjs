/**
 * Recovered Extension.dll modal input grabs: XModalWindow::VisibilityChanged
 * 0x10037330 and the XRootWindow grab counters GrabKeyboardEvents 0x1003a110,
 * UngrabKeyboardEvents 0x1003a1b0, GrabMouseEvents 0x1003a1d0,
 * UngrabMouseEvents 0x1003a270 with IsMouseButton 0x1003a2c0.
 *
 * The root keeps a mouse grab count at +0x5cc, a keyboard grab count at +0x5d0
 * and one key-down byte per EInputKey at +0x630+key. The first grab of either
 * kind (count <= 0) clears the held state of its keys, 0 <= key < 0xff.
 * W: the tree-natives world (u8/i32/ptr and setters), W.processScript and a
 * getRootWindow(W, win) service. Evidence and oracle:
 * docs/script-window-input.md, scripts/native-window-grab-oracle.py,
 * scripts/validate-window-grab-diff.mjs.
 */
import {x87load, x87add, x87neg, x87store} from './script-vm.mjs';

export const ROOT_INPUT = Object.freeze({mouseGrab: 0x5cc, keyboardGrab: 0x5d0, keyDown: 0x630, parent: 0x138});
const R = ROOT_INPUT;
// IsMouseButton: IK_LeftMouse/RightMouse/MiddleMouse (1,2,4), IK_MouseX..W
// (0xe4-0xe7) and IK_MouseWheelUp/Down (0xec,0xed).
const MOUSE_KEYS = new Set([0xe4, 0xe5, 0xe6, 0xe7, 1, 2, 4, 0xec, 0xed]);
export const isMouseButton = key => MOUSE_KEYS.has(key >>> 0) ? 1 : 0;

function grab(W, root, count, mouse) {
  if (W.i32(root, count) <= 0)
    for (let key = 0; key < 0xff; key++) if (Boolean(isMouseButton(key)) === mouse) W.setU8(root, R.keyDown + key, 0);
  W.setI32(root, count, W.i32(root, count) + 1);
}
function ungrab(W, root, count) {
  const value = W.i32(root, count);
  if (value > 0) W.setI32(root, count, value - 1);
}
export const grabKeyboardEvents = (W, root) => grab(W, root, R.keyboardGrab, false);
export const ungrabKeyboardEvents = (W, root) => ungrab(W, root, R.keyboardGrab);
export const grabMouseEvents = (W, root) => grab(W, root, R.mouseGrab, true);
export const ungrabMouseEvents = (W, root) => ungrab(W, root, R.mouseGrab);

/** XModalWindow::VisibilityChanged 0x10037330(bNewVisibility). */
export function modalVisibilityChanged(W, win, visible, getRootWindow) {
  W.processScript(win, 'VisibilityChanged', [Boolean(visible)]);
  if (!W.ptr(win, R.parent)) return;
  const root = getRootWindow(W, win);
  if (!root) return;
  if (visible) { grabKeyboardEvents(W, root); grabMouseEvents(W, root); }
  else { ungrabKeyboardEvents(W, root); ungrabMouseEvents(W, root); }
}

// ---------------------------------------------------------------------------
// Root key routing: XRootWindow::Process 0x1003b3e0 and HandleVirtualKeyboard
// 0x1003b820, with the XWindow RawKeyPressed 0x10003750 / VirtualKeyPressed
// 0x10003a40 bridges reached through W.v. Actions are EInputAction values
// (IST_Press 1, IST_Hold 2, IST_Release 3, IST_Axis 4).
// ---------------------------------------------------------------------------
export const IST = Object.freeze({press: 1, hold: 2, release: 3, axis: 4});
// The parent pawn's input bytes at +0x4b6/+0x4b7 are the linked Pawn.bFire and
// Pawn.bAltFire properties (Engine.u UProperty offsets).
const PAWN_MOUSE_FIELDS = ['bFire', 'bAltFire'];

/** XRootWindow::Process 0x1003b3e0(key, action, delta) -> 1 when consumed. */
export function rootProcess(W, root, key, action, delta = 0) {
  key &= 0xff;
  let repeat = 0, skip = 0;
  if (action === IST.press) {
    if (W.u8(root, R.keyDown + key)) repeat = 1;
    W.setU8(root, R.keyDown + key, 1);
  } else if (action === IST.release) {
    if (!W.u8(root, R.keyDown + key)) skip = 1;
    W.setU8(root, R.keyDown + key, 0);
  }
  if (isMouseButton(key)) {
    if (!W.i32(root, R.mouseGrab)) return 0;
    const pawn = W.ptr(root, 0x588);
    if (pawn) for (const name of PAWN_MOUSE_FIELDS) W.setPawnField(pawn, name, 0);
    if (!skip) W.v.handleButtons(root, key, action);
    return 1;
  }
  if (!W.i32(root, R.keyboardGrab)) return 0;
  if (!skip) W.v.handleVirtualKeyboard(root, key, action, repeat);
  return 1;
}

/** XRootWindow::HandleVirtualKeyboard 0x1003b820(key, action, repeat). */
export function handleVirtualKeyboard(W, root, key, action, repeat, {topChild, lowerSibling}) {
  let target = W.ptr(root, 0x5c8);
  if (!target) {
    target = topChild(W, root, 1);
    while (target && W.u8(target, 0x28) < 2) target = lowerSibling(W, target, 1);
    target ??= root;
  }
  let result = 0;
  const assertLive = (win, line) => {
    if (W.u8(win, 0x30) & 0x10) throw new Error(`XRootWindow::HandleVirtualKeyboard assertion (line 0x${line.toString(16)}): window is being destroyed`);
  };
  for (let win = target; win; win = W.ptr(win, R.parent)) {
    if (!repeat) result = W.v.rawKeyPressed(win, key, action, 0) ? 1 : 0;
    if (result) break;
    assertLive(win, 0x680);
    if (action === IST.press) {
      result = W.v.virtualKeyPressed(win, key, repeat) ? 1 : 0;
      if (result) break;
    }
    assertLive(win, 0x68b);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Root mouse routing: XRootWindow::HandleButtons 0x1003b960, GrabMouse
// 0x1004cac0 / UngrabMouse 0x1004cb60 and the reached XButtonWindow overrides.
// ---------------------------------------------------------------------------
const f = Math.fround;
const B = Object.freeze({
  mouseX:0x590,mouseY:0x594,mouseFlags:0x5a4,grabbed:0x5c4,
  multiClickTime:0x610,multiClickDistance:0x614,clickIndex:0x618,lastKey:0x61c,
  clickDeadline:0x620,lastWindow:0x624,lastX:0x628,lastY:0x62c,
  parent:0x138,destroyFlags:0x30,maxClickCount:0xd0,focusMode:0x174,
  buttonFlags:0x174,repeatDelay:0x17c,repeatAt:0x19c,inputKey:0x1a0,
  pressSound:0x190,clickSound:0x194,
});
function order(a,b){
  if(a.nan!==undefined||b.nan!==undefined)return NaN;
  if(a.inf||b.inf){const av=a.inf?(a.neg?-1:1):0,bv=b.inf?(b.neg?-1:1):0;return av<bv?-1:av>bv?1:0;}
  const low=Math.min(a.exp,b.exp),av=(a.neg?-1n:1n)*(a.sig<<BigInt(a.exp-low)),bv=(b.neg?-1n:1n)*(b.sig<<BigInt(b.exp-low));
  return av<bv?-1:av>bv?1:0;
}
const sub=(a,b)=>x87add(a,x87neg(b));
const positive=value=>order(value,x87load(0))>0;
const notAbove=(value,limit)=>{const compared=order(value,limit);return compared<=0||Number.isNaN(compared);};
const absDiff=(a,b)=>{let value=sub(x87load(a),x87load(b));if(order(value,x87load(0))<0||Number.isNaN(order(value,x87load(0))))value=x87neg(value);return value;};

export function grabMouse(W,win,{getRootWindow}){
  const root=getRootWindow(W,win);if(!root)return;
  const old=W.ptr(root,B.grabbed);if(old===win)return;
  if(old)W.v.mouseGrabLost(old,win);
  W.setPtr(root,B.grabbed,win);
}
export function ungrabMouse(W,win,{getRootWindow}){
  const root=getRootWindow(W,win);if(root&&W.ptr(root,B.grabbed)===win)W.setPtr(root,B.grabbed,null);
}

/** XRootWindow::HandleButtons(key, action). `tickOffset` is the original
 * GetTickOffset float32 result and the virtual table supplies the three mouse
 * event stages. */
export function handleButtons(W,root,key,action,{topChild,lowerSibling,getMouseWindow,convertCoordinates,
  setFocusWindow,getRootWindow,tickOffset}){
  if(W.u8(root,B.mouseFlags)&4)return 1;
  let modal=topChild(W,root,1);
  while(modal&&W.u8(modal,0x28)<2)modal=lowerSibling(W,modal,1);
  modal??=root;
  const mouse=getMouseWindow(root,modal),target=mouse?.win??null;
  if(target&&action===IST.press){
    grabMouse(W,target,{getRootWindow});
    if(W.u8(modal,B.focusMode)>=1)setFocusWindow(root,target);
  }else if(target&&action===IST.release)ungrabMouse(W,target,{getRootWindow});

  let roundedElapsed=0;
  if(action===IST.press||action===IST.release){
    const offset=f(tickOffset()),dx=absDiff(W.f32(root,B.mouseX),W.f32(root,B.lastX));
    const dy=x87store(absDiff(W.f32(root,B.mouseY),W.f32(root,B.lastY)));
    const elapsed=sub(x87load(W.f32(root,B.clickDeadline)),x87load(offset));
    roundedElapsed=x87store(elapsed);
    const sameSequence=positive(elapsed)&&target===W.ptr(root,B.lastWindow)
      &&notAbove(dx,x87load(W.f32(root,B.multiClickDistance)))
      &&notAbove(x87load(dy),x87load(W.f32(root,B.multiClickDistance)))
      &&(key|0)===W.i32(root,B.lastKey);
    if(!sameSequence){
      W.mouseClickLog?.(target);
      W.setF32(root,B.clickDeadline,0);W.setI32(root,B.lastKey,key|0);
      W.setPtr(root,B.lastWindow,target);W.setI32(root,B.clickIndex,0);roundedElapsed=0;
    }
    if(action===IST.press){
      if(roundedElapsed>0)W.setI32(root,B.clickIndex,(W.i32(root,B.clickIndex)+1)|0);
      W.setF32(root,B.clickDeadline,x87store(x87add(x87load(offset),x87load(W.f32(root,B.multiClickTime)))));
      if(W.i32(root,B.clickIndex)<1){W.setU32(root,B.lastX,W.u32(root,B.mouseX));W.setU32(root,B.lastY,W.u32(root,B.mouseY));}
    }
  }
  if(!target)return 0;
  for(let win=target;win;){
    const parent=W.ptr(win,B.parent),point=convertCoordinates(root,W.f32(root,B.mouseX),W.f32(root,B.mouseY),win);
    let handled=W.v.rawMouseButtonPressed(win,point.x,point.y,key,action)?1:0;
    if(!handled&&(W.u8(win,B.destroyFlags)&0x10))throw new Error('XRootWindow::HandleButtons assertion (line 0x704): window is being destroyed');
    let count=W.i32(root,B.clickIndex),maximum=W.i32(win,B.maxClickCount);
    if(maximum>0)count=(count%maximum)|0;
    count=(count+1)|0;
    if(!handled&&action===IST.press)handled=W.v.mouseButtonPressed(win,point.x,point.y,key,count)?1:0;
    else if(!handled&&action===IST.release)handled=W.v.mouseButtonReleased(win,point.x,point.y,key,count)?1:0;
    if(handled)return handled;
    if(W.u8(win,B.destroyFlags)&0x10)throw new Error('XRootWindow::HandleButtons assertion (line 0x71b): window is being destroyed');
    win=parent;
  }
  return 0;
}

export function buttonMousePressed(W,win,x,y,key,count,{processScript,changeButtonAppearance,tickOffset,activateButton}){
  let result=processScript(win,'MouseButtonPressed',[x,y,key&0xff,count],{result:false})?1:0;
  if((key|0)!==1&&((key|0)!==2||!(W.u8(win,B.buttonFlags)&8)))return result;
  W.setU32(win,B.buttonFlags,W.u32(win,B.buttonFlags)|3);changeButtonAppearance(win);
  if(W.u8(win,B.buttonFlags)&4){
    W.setF32(win,B.repeatAt,x87store(x87add(x87load(f(tickOffset())),x87load(W.f32(win,B.repeatDelay)))));
    W.native.playSound(win,W.ptr(win,B.clickSound),-1,1);W.setU8(win,B.inputKey,key);activateButton(win,key&0xff);
  }else W.native.playSound(win,W.ptr(win,B.pressSound),-1,1);
  return 1;
}

export function buttonMouseReleased(W,win,x,y,key,count,{processScript,changeButtonAppearance,activateButton,isPointInWindow}){
  let result=processScript(win,'MouseButtonReleased',[x,y,key&0xff,count],{result:false})?1:0;
  if((key|0)!==1&&((key|0)!==2||!(W.u8(win,B.buttonFlags)&8)))return result;
  W.setU32(win,B.buttonFlags,W.u32(win,B.buttonFlags)&0xfffffffc);W.setF32(win,B.repeatAt,0);W.setU8(win,B.inputKey,0);
  changeButtonAppearance(win);
  if(isPointInWindow(win,x,y)&&!(W.u8(win,B.buttonFlags)&4)){
    W.native.playSound(win,W.ptr(win,B.clickSound),-1,1);activateButton(win,key&0xff);
  }
  return 1;
}

/** XButtonWindow::PressButton 0x10007b20(key), the Button family's +0x124. */
export function buttonPressButton(W, win, key, {changeButtonAppearance, addActivateTimer, activateButton}) {
  W.setU32(win, 0x174, W.u32(win, 0x174) | 1);
  changeButtonAppearance(win);
  addActivateTimer(W, win);
  W.native.playSound(win, W.ptr(win, 0x194), -1, 1);
  W.setU8(win, 0x1a0, key);
  activateButton(win, key & 0xff);
}
