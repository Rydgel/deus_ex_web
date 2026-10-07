/**
 * The typed-character route (WM_CHAR) into the Extension window system,
 * recovered from the installed binaries (docs/script-window-typed-keys.md):
 *
 *   WinDrv UWindowsViewport::ViewportWndProc 0x11109b30, WM_CHAR/WM_SYSCHAR
 *   case 0x1110a447: a character other than 0x0d goes to Client->Engine->Key
 *   (vtable +0x70; DDeusExGameEngine's slot is XGameEngineExt::Key)
 *     -> XGameEngineExt::Key 0x10026650: UEngine::Key, else XInputExt::Key
 *     -> UEngine::Key (Engine 0x103813d0): Console.KeyType(BYTE key)
 *     -> XInputExt::Key 0x1002d2b0: a PlayerPawnExt's root window (+0x894)
 *     -> XRootWindow::Key 0x1003b520 -> HandleKeyboard 0x1003b720
 *     -> each window's KeyPressed (vtable +0xc8) up the parent chain.
 *
 * This module holds the window-side bodies. They read the tree-natives world
 * W (u8/i32/ptr) and dispatch the family virtuals through W.v:
 * W.v.handleKeyboard (root +0x128), W.v.keyPressed (+0xc8) and
 * W.v.acceleratorKeyPressed (+0xd0). Every reached KeyPressed reads only the
 * low word of the key (`mov ax, word ptr [ebp+8]` / `test si, si`), so the
 * route hands each one `key & 0xffff`.
 */
import {ROOT_INPUT} from './script-window-input.mjs';

const O = Object.freeze({type: 0x28, flags: 0x30, parent: 0x138, focus: 0x5c8, keyDown: 0x630,
  acceleratorDirty: 0x584, acceleratorTable: 0x188});
export const TYPED_KEY_ADDRESSES = Object.freeze({
  viewportWndProcChar: 0x1110a447, gameEngineExtKey: 0x10026650, engineKey: 0x103813d0, inputExtKey: 0x1002d2b0,
  rootKey: 0x1003b520, handleKeyboard: 0x1003b720, windowKeyPressed: 0x10003830, modalKeyPressed: 0x10037510,
  windowAcceleratorKeyPressed: 0x10003a80, isCurrentModal: 0x10036e20, getAcceleratorWindow: 0x100372a0,
});
const IK_ALT = 0x12;

/** The body in each admitted family's KeyPressed slot (vtable +0xc8), read
 * from Extension.dll's class vftables; every other family has the XWindow
 * bridge. AcceleratorKeyPressed (+0xd0) is the XWindow bridge in all of
 * them, and only XRootWindow fills HandleKeyboard (+0x128). Checked against
 * the DLL by validate-window-typed-key-diff.mjs. */
export const KEY_PRESSED_BODIES = Object.freeze({
  'extension.editwindow': 'XEditWindow::KeyPressed',     // 0x10021290
  'extension.listwindow': 'XListWindow::KeyPressed',     // 0x10033ae0
  'extension.modalwindow': 'XModalWindow::KeyPressed',   // 0x10037510
  'extension.rootwindow': 'XModalWindow::KeyPressed',
});
export const keyPressedBody = family => KEY_PRESSED_BODIES[family] ?? 'XWindow::KeyPressed';

/** One UTF-16 unit as the one-character FString the bridges build
 * ({key, 0}: appStrlen + 1 = 2 units), or the empty FString for 0. */
export const keyString = key => (key & 0xffff) ? String.fromCharCode(key & 0xffff) : '';

/** XWindow::IsKeyDown 0x1004c980: the root's key byte for 0 <= key < 0xff. */
function isKeyDown(W, win, key, getRootWindow) {
  const root = getRootWindow(W, win);
  return root && key >= 0 && key < 0xff ? W.u8(root, O.keyDown + key) : 0;
}

/** XRootWindow::Key 0x1003b520(EInputKey): with a nonzero keyboard grab count
 * (+0x5d0, IsKeyboardGrabbed) HandleKeyboard (vtable +0x128) runs and the key
 * is consumed whatever it returned; otherwise 0. */
export function rootKey(W, root, key) {
  if (!W.i32(root, ROOT_INPUT.keyboardGrab)) return 0;
  W.v.handleKeyboard(root, key);
  return 1;
}

/** XRootWindow::HandleKeyboard 0x1003b720(TCHAR): the focus window (+0x5c8),
 * else the topmost visible child of type >= 2, else the root; from there up
 * the parent chain each window's KeyPressed (+0xc8), skipping a window of
 * type < 2 while the root holds IK_Alt; the first nonzero result ends it.
 * A window being destroyed after its call is the assertion at line 0x648. */
export function handleKeyboard(W, root, key, {topChild, lowerSibling, getRootWindow}) {
  let target = W.ptr(root, O.focus);
  if (!target) {
    let child = topChild(W, root, 1);
    while (child && W.u8(child, O.type) < 2) child = lowerSibling(W, child, 1);
    target = child || root;
  }
  let result = 0;
  for (let win = target; win; win = W.ptr(win, O.parent)) {
    if (W.u8(win, O.type) >= 2 || !isKeyDown(W, root, IK_ALT, getRootWindow)) result = W.v.keyPressed(win, key & 0xffff);
    if (result) break;
    if (W.u8(win, O.flags) & 0x10)
      throw new Error('XRootWindow::HandleKeyboard assertion (line 0x648): window is being destroyed');
  }
  return result;
}

/** XWindow::KeyPressed 0x10003830(TCHAR): ProcessScript(KeyPressed) with the
 * one-character string and a zeroed bool result. */
export const windowKeyPressed = (processScript, win, key) =>
  processScript(win, 'KeyPressed', [keyString(key)], {result: false}) ? 1 : 0;

/** XWindow::AcceleratorKeyPressed 0x10003a80(TCHAR): the same bridge for
 * EXTENSION_AcceleratorKeyPressed (ButtonWindow.uc presses the button). */
export const windowAcceleratorKeyPressed = (processScript, win, key) =>
  processScript(win, 'AcceleratorKeyPressed', [keyString(key)], {result: false}) ? 1 : 0;

/** XModalWindow::IsCurrentModal 0x10036e20: the root's topmost visible child
 * of type >= 2 (else the root itself) is this window. */
export function isCurrentModal(W, win, {getRootWindow, topChild, lowerSibling}) {
  const root = getRootWindow(W, win);
  if (!root) return 0;
  let child = topChild(W, root, 1);
  while (child && W.u8(child, O.type) < 2) child = lowerSibling(W, child, 1);
  return (child || root) === win ? 1 : 0;
}

/** XModalWindow::GetAcceleratorWindow 0x100372a0(TCHAR): for 0 < key < 0xff,
 * BuildAcceleratorTable then the window at +0x188 + 4*key. */
export function getAcceleratorWindow(W, modal, key, buildAcceleratorTable) {
  key &= 0xffff;
  if (!key || key >= 0xff) return 0;
  buildAcceleratorTable(W, modal);
  return W.ptr(modal, O.acceleratorTable + 4 * key);
}

/** XModalWindow::KeyPressed 0x10037510(TCHAR) (also the root's +0xc8): the
 * script event first; an unhandled key with IK_Alt down on the current modal
 * goes to its accelerator window's AcceleratorKeyPressed (+0xd0). */
export function modalKeyPressed(W, win, key, {processScript, buildAcceleratorTable, ...tree}) {
  let result = windowKeyPressed(processScript, win, key);
  if (!result && isCurrentModal(W, win, tree) && isKeyDown(W, win, IK_ALT, tree.getRootWindow)) {
    const accelerator = getAcceleratorWindow(W, win, key, buildAcceleratorTable);
    if (accelerator) result = W.v.acceleratorKeyPressed(accelerator, key & 0xffff);
  }
  return result;
}

/** XGameEngineExt::Key 0x10026650(Viewport, Key), the DDeusExGameEngine
 * vtable +0x70 slot: UEngine::Key (Engine 0x103813d0) offers the key to the
 * viewport's Console (+0x34) as ProcessEvent(FindFunctionChecked(NAME_KeyType
 * 820), {BYTE Key, UBOOL ReturnValue}) and a nonzero result is returned;
 * otherwise a viewport Input (+0x60) that IsA XInputExt takes it in
 * XInputExt::Key 0x1002d2b0: its viewport's (+0xea0) Actor (+0x30), when it
 * IsA APlayerPawnExt with a root window (+0x894), gets XRootWindow::Key, and
 * a nonzero result is 1. S: the object reads and the two leaves (keyType,
 * rootKey); the IsA tests walk Class (+0x24) / SuperField (+0x28). */
export function gameEngineKey(viewport, key, S) {
  const console = S.console(viewport);
  if (console && S.keyType(console, key & 0xff)) return 1;
  const input = S.input(viewport);
  return input && S.isInputExt(input) ? inputExtKey(input, key, S) : 0;
}

/** XInputExt::Key 0x1002d2b0(Key): the Actor (+0x30) of this input's
 * viewport (+0xea0); 1 when it IsA APlayerPawnExt whose root window (+0x894)
 * consumed the key in XRootWindow::Key, else 0. */
export function inputExtKey(input, key, S) {
  const actor = S.actor(input);
  if (!actor || !S.isPlayerPawnExt(actor)) return 0;
  const root = S.rootWindow(actor);
  return root && S.rootKey(root, key) ? 1 : 0;
}
