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

/** XButtonWindow::PressButton 0x10007b20(key), the Button family's +0x124. */
export function buttonPressButton(W, win, key, {changeButtonAppearance, addActivateTimer, activateButton}) {
  W.setU32(win, 0x174, W.u32(win, 0x174) | 1);
  changeButtonAppearance(win);
  addActivateTimer(W, win);
  W.native.playSound(win, W.ptr(win, 0x194), -1, 1);
  W.setU8(win, 0x1a0, key);
  activateButton(win, key & 0xff);
}
