/**
 * Native constructors, Init bodies and tab-group/modal tables of the
 * Extension window classes that the DeusEx root/HUD tree instantiates:
 * TextWindow, ButtonWindow, ToggleWindow, TabGroupWindow, RadioBoxWindow,
 * TextLogWindow, ModalWindow and RootWindow. XWindow/XTextWindow::Init,
 * XTileWindow and XComputerWindow keep their existing translations.
 *
 * Operates on the window world `W` of src/runtime/script-window-host.mjs
 * (raw heap loads/stores, FArray helpers, vtable dispatch). Addresses are
 * Extension.dll preferred-base (0x10000000), SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c.
 * Evidence: docs/script-window-host.md "Class families".
 */
import {O, ROOT, getModalWindow, getTabGroupWindow, getRootWindow, isTraversable, c0, c3, lowerSibling,
  topChild, bottomChild, higherSibling} from './script-window-tree-natives.mjs';

const f = Math.fround;
export const FAMILY_ADDRESSES = Object.freeze({
  textCtor: 0x10008e70, buttonCtor: 0x10009300, toggleCtor: 0x10009980, tabGroupCtor: 0x10004cc0,
  radioBoxCtor: 0x10015910, textLogCtor: 0x10014840, modalCtor: 0x100053a0, rootCtor: 0x10005c10,
  buttonInit: 0x10007640, toggleInit: 0x10049820, tabGroupInit: 0x10044d90, radioBoxInit: 0x10038660,
  textLogInit: 0x100474b0, modalInit: 0x10036c00, rootInit: 0x10039050,
  addWindowToTables: 0x10045350, removeWindowFromTables: 0x10045450, resortWindowTables: 0x10045140,
  computeTabGroupLocation: 0x10045000, addTabGroupToTable: 0x10037000, removeTabGroupFromTable: 0x100370c0,
  resortTabGroupTable: 0x10036ed0, clearAcceleratorTable: 0x100371f0, buildAcceleratorTable: 0x10037210,
  setAcceleratorWindows: 0x10036a50,
});
export const VTABLES = Object.freeze({
  window: 0x10059930, textwindow: 0x1005a458, buttonwindow: 0x1005a324, togglewindow: 0x1005a7c8,
  tilewindow: 0x1005b760, tabgroupwindow: 0x10059a8c, radioboxwindow: 0x1005b87c, textlogwindow: 0x1005b63c,
  modalwindow: 0x10059ba8, rootwindow: 0x10059cc4, computerwindow: 0x1005b2c8, extensionobject: 0x10059888,
});

// --------------------------------------------------------------------------
// Constructors. Each begins with the Core UObject::UObject() import
// (0x1005907c), a host leaf, and ends by installing the class vtable.
// FString(ENoInit) at +0x168 (button/toggle) performs no stores.
// --------------------------------------------------------------------------
const zeroClip = (W, win) => { for (let o = 0xd4; o <= 0xe8; o += 4) W.setU32(win, o, 0); };
export function constructTextWindow(W, win) {           // 0x10008e70
  W.uobjectConstructor(win); zeroClip(W, win); W.setU32(win, 0, VTABLES.textwindow);
}
export function constructButtonWindow(W, win) {         // 0x10009300
  W.uobjectConstructor(win); W.setU32(win, 0, VTABLES.extensionobject);
  zeroClip(W, win); W.setU32(win, 0, VTABLES.window); W.setU32(win, 0, VTABLES.buttonwindow);
}
export function constructToggleWindow(W, win) {         // 0x10009980 (XExtensionObject ctor 0x10002780 first)
  W.uobjectConstructor(win); W.setU32(win, 0, VTABLES.extensionobject);
  zeroClip(W, win); W.setU32(win, 0, VTABLES.window); W.setU32(win, 0, VTABLES.togglewindow);
}
export function constructTabGroupWindow(W, win) {       // 0x10004cc0
  W.uobjectConstructor(win); zeroClip(W, win);
  for (let o = 0x14c; o <= 0x160; o += 4) W.setU32(win, o, 0);
  W.setU32(win, 0, VTABLES.tabgroupwindow);
}
export function constructRadioBoxWindow(W, win) {       // 0x10015910
  W.uobjectConstructor(win); W.setU32(win, 0, VTABLES.extensionobject); zeroClip(W, win);
  for (let o = 0x14c; o <= 0x160; o += 4) W.setU32(win, o, 0);
  for (const o of [0x178, 0x17c, 0x180]) W.setU32(win, o, 0);
  W.setU32(win, 0, VTABLES.radioboxwindow);
}
export function constructTextLogWindow(W, win) {        // 0x10014840
  W.uobjectConstructor(win); zeroClip(W, win);
  for (const o of [0x178, 0x17c, 0x180]) W.setU32(win, o, 0);
  W.setU32(win, 0, VTABLES.textlogwindow);
}
export function constructModalWindow(W, win) {          // 0x100053a0
  W.uobjectConstructor(win); W.setU32(win, 0, VTABLES.extensionobject); zeroClip(W, win);
  for (let o = 0x14c; o <= 0x160; o += 4) W.setU32(win, o, 0);
  for (const o of [0x17c, 0x180, 0x184]) W.setU32(win, o, 0);
  W.setU32(win, 0, VTABLES.modalwindow);
}
export function constructRootWindow(W, win) {           // 0x10005c10
  W.uobjectConstructor(win); W.setU32(win, 0, VTABLES.extensionobject); zeroClip(W, win);
  W.setU32(win, 0, VTABLES.window);
  W.farray.construct(win, 0x14c);                        // FArray ctor (Core import 0x100590ac)
  W.farray.construct(win, 0x158);                        // 0x10012620: inlined FArray ctor
  for (const o of [0x17c, 0x180, 0x184]) W.setU32(win, o, 0);
  W.setU32(win, 0, VTABLES.rootwindow);
}

// --------------------------------------------------------------------------
// Init bodies.
// --------------------------------------------------------------------------
/** XButtonWindow::Init 0x10007640. `residue` is the uninitialized high byte
 * of the local colour at [ebp-0x14] (never written by the body; the host
 * supplies 0 and records the assumption). */
export function initButtonWindow(W, win, parent, residue = 0) {
  W.initText(win, parent);
  W.setU32(win, 0x174, (W.u32(win, 0x174) & 0xfffffff8) >>> 0);
  W.setF32(win, 0x178, f(0.30000001192092896));         // float 0x10059df4
  W.setF32(win, 0x17c, f(0.5));                           // float 0x10059df8
  W.setF32(win, 0x180, f(0.10000000149011612));          // float 0x10059dfc
  W.setU8(win, 0x1a0, 0);
  for (const o of [0x190, 0x194, 0x198, 0x19c]) W.setU32(win, o, 0);
  // Local colours: [ebp+8] bytes 0..2 = 0xff over the parent argument word
  // (its high byte survives); [ebp-0x14] = {0, 0xff, 0, residue}.
  const high = (W.addressOf(parent) >>> 24) & 0xff;
  const white = ((high << 24) | 0x00ffffff) >>> 0;
  const green = (((residue & 0xff) << 24) | 0x0000ff00) >>> 0;
  for (let i = 0; i < 6; i++) {
    const entry = win + 0;
    void entry;
    W.setU32(win, 0x1a4 + 12 * i, 0);
    W.setU32(win, 0x1a8 + 12 * i, white);
    W.setU32(win, 0x1ac + 12 * i, green);
  }
  W.setU32(win, 0x18c, white);
  W.setU32(win, 0x184, 0);
  W.setU32(win, 0x188, white);
  W.native.setSelectability(win, 1);
}
/** XToggleWindow::Init 0x10049820. */
export function initToggleWindow(W, win, parent) {
  initButtonWindow(W, win, parent);
  W.setU32(win, 0x1ec, 0);
  W.setU32(win, 0x1f0, 0);
}
/** XTabGroupWindow::Init 0x10044d90. */
export function initTabGroupWindow(W, win, parent) {
  W.initWindow(win, parent);
  W.setU8(win, O.type, 1);
  W.farray.empty(win, 0x14c, 4);
  W.farray.empty(win, 0x158, 4);
  W.setI32(win, 0x168, -1);
  W.setU32(win, 0x16c, 0);
  W.setU32(win, 0x170, 0);
  W.setU32(win, 0x164, ((W.u32(win, 0x164) & 0xfffffffd) | 5) >>> 0);
  if (!W.isA(win, 'extension.modalwindow')) {
    const modal = getModalWindow(W, win);
    if (modal) addTabGroupToTable(W, modal, win);
  }
}
/** XRadioBoxWindow::Init 0x10038660. */
export function initRadioBoxWindow(W, win, parent) {
  initTabGroupWindow(W, win, parent);
  W.farray.empty(win, 0x178, 4);
  W.setU32(win, 0x184, 0);
  W.setU32(win, 0x174, (W.u32(win, 0x174) | 1) >>> 0);
}
/** XTextLogWindow::Init 0x100474b0 (textTimeout 5.0; lines cleared). */
export function initTextLogWindow(W, win, parent) {
  W.initText(win, parent);
  W.setU8(win, 0x14c, 0);
  W.setU8(win, 0x14d, 0);
  W.setU32(win, 0x174, 0x40a00000);
  if (W.i32(win, 0x17c) !== 0) W.boundary('XTextLogWindow::Init with a non-empty lines array');
  W.farray.empty(win, 0x178, 0x14);
  W.setU32(win, 0x184, (W.u32(win, 0x184) & 0xfffffffe) >>> 0);
}
/** XModalWindow::Init 0x10036c00. */
export function initModalWindow(W, win, parent) {
  initTabGroupWindow(W, win, parent);
  if (!parent || W.u8(parent, O.type) === 3) W.setU8(win, O.type, 2);
  else W.boundary('XModalWindow::Init: "Modal window must be a child of Root!" (GLog)');
  W.setU8(win, 0x174, 2);
  W.setU32(win, 0x178, 0);
  W.farray.empty(win, 0x17c, 4);
  clearAcceleratorTable(W, win);
  W.setU32(win, 0x584, (W.u32(win, 0x584) | 1) >>> 0);
  addTabGroupToTable(W, win, win);
}
/** XRootWindow::Init(APlayerPawnExt*) 0x10039050. */
export function initRootWindow(W, root, pawn, residue = 0) {
  initModalWindow(W, root, null);
  W.addToRoot(root);                                       // UObject::AddToRoot (Core import 0x10059158)
  W.setU8(root, O.type, 3);
  W.setI32(root, ROOT.initCount, 0);
  W.setF32(root, ROOT.mouseX, 0); W.setF32(root, ROOT.mouseY, 0);
  W.setF32(root, 0x598, f(-1)); W.setF32(root, 0x59c, f(-1));
  W.setU32(root, 0x5a0, 0);
  W.setU32(root, 0x5a4, ((W.u32(root, 0x5a4) & 0xfffffff9) | 9) >>> 0);
  W.setU32(root, 0x5c0, (W.u32(root, 0x5c0) | 1) >>> 0);
  W.setU32(root, 0x5ac, 0); W.setU32(root, 0x5b0, 0);
  W.setU32(root, 0x5d8, ((W.u32(root, 0x5d8) & 0xfffffffd) | 1) >>> 0);
  W.setU32(root, 0x5f8, ((residue & 0xff) << 24) >>> 0);   // [ebp-0x14]: bytes 0..2 zero, byte 3 uninitialized
  W.setF32(root, 0x628, f(-1)); W.setF32(root, 0x62c, f(-1));
  for (const o of [0x5b4, 0x5b8, 0x5bc, 0x5c4, 0x5c8, 0x5d0, 0x5cc, 0x5dc, 0x5e0, 0x5e4, 0x5e8])
    W.setU32(root, o, 0);
  W.setU32(root, O.tick, (W.u32(root, O.tick) | 1) >>> 0);
  W.setU32(root, 0x5fc, 0); W.setU32(root, 0x600, 0);
  W.setU32(root, 0x604, (W.u32(root, 0x604) & 0xfffffffc) >>> 0);
  W.setU32(root, 0x60c, 0);
  W.setF32(root, 0x610, f(0.5)); W.setF32(root, 0x614, f(10));
  for (const o of [0x618, 0x61c, 0x620, 0x624, 0x738, 0x73c]) W.setU32(root, o, 0);
  for (let i = 0; i < 0xff; i++) W.setU8(root, 0x630 + i, 0);
  W.setU32(root, ROOT.rootFrame, 0);
  if (pawn) W.setPawnRootWindow(pawn, root);               // APlayerPawnExt+0x894 = this
  W.setPtr(root, ROOT.parentPawn, pawn);
  W.setPtr(root, ROOT.nextRoot, W.global('rootWindowList'));
  W.setGlobal('rootWindowList', root);
}

// --------------------------------------------------------------------------
// Tab-group and modal tables.
// --------------------------------------------------------------------------
export function clearAcceleratorTable(W, modal) {           // 0x100371f0
  for (let i = 0; i < 0xff; i++) W.setU32(modal, 0x188 + 4 * i, 0);
}
export function addTabGroupToTable(W, modal, tabGroup) {    // 0x10037000
  if (!tabGroup) return;
  const index = W.farray.add(modal, 0x17c, 1, 4);
  W.farray.setPtr(modal, 0x17c, index, tabGroup);
  resortTabGroupTable(W, modal);
}
export function removeTabGroupFromTable(W, modal, tabGroup) { // 0x100370c0
  if (!tabGroup) return;
  const index = W.i32(tabGroup, 0x168);
  if (index < 0 || index + 1 > W.farray.num(modal, 0x17c)) W.boundary('XModalWindow::RemoveTabGroupFromTable appFailAssert');
  W.farray.remove(modal, 0x17c, index, 1, 4);
  for (let i = W.i32(tabGroup, 0x168); i < W.farray.num(modal, 0x17c); i++)
    W.setI32(W.farray.ptr(modal, 0x17c, i), 0x168, i);
  W.setI32(tabGroup, 0x168, -1);
}
/** 0x10036ed0: appQsort by (firstAbsY, firstAbsX, pointer), then reindex +0x168. */
export function resortTabGroupTable(W, modal) {
  const count = W.farray.num(modal, 0x17c);
  if (count > 1) W.farray.qsort(modal, 0x17c, (a, b) => compareRowMajor(W, a, b, 0x170, 0x16c));
  for (let i = 0; i < W.farray.num(modal, 0x17c); i++) W.setI32(W.farray.ptr(modal, 0x17c, i), 0x168, i);
}
/** Comparator shape shared by 0x10036f80/0x10045250/0x100452d0: fcomp C0
 * then (C0|C3) on the primary, then the secondary, then the pointer. */
function compareRowMajor(W, a, b, primary, secondary) {
  const ap = W.f32(a, primary), bp = W.f32(b, primary);
  if (c0(ap, bp)) return -1;
  if (!(c0(ap, bp) || c3(ap, bp))) return 1;
  const as = W.f32(a, secondary), bs = W.f32(b, secondary);
  if (c0(as, bs)) return -1;
  if (!(c0(as, bs) || c3(as, bs))) return 1;
  const pa = W.addressOf(a), pb = W.addressOf(b);
  return pb > pa ? -1 : (pb < pa ? 1 : 0);
}
export function addWindowToTables(W, tabGroup, win) {       // 0x10045350
  if (!win) return;
  const row = W.farray.add(tabGroup, 0x14c, 1, 4);
  W.farray.setPtr(tabGroup, 0x14c, row, win);
  const col = W.farray.add(tabGroup, 0x158, 1, 4);
  W.farray.setPtr(tabGroup, 0x158, col, win);
  resortWindowTables(W, tabGroup);
}
export function removeWindowFromTables(W, tabGroup, win) {  // 0x10045450
  if (!win) return;
  for (const [list, indexOffset] of [[0x14c, O.rowMajorIndex], [0x158, O.colMajorIndex]]) {
    const index = W.i32(win, indexOffset);
    if (index < 0 || index + 1 > W.farray.num(tabGroup, list))
      W.boundary('XTabGroupWindow::RemoveWindowFromTables appFailAssert');
    W.farray.remove(tabGroup, list, index, 1, 4);
  }
  for (let i = W.i32(win, O.rowMajorIndex); i < W.farray.num(tabGroup, 0x14c); i++)
    W.setI32(W.farray.ptr(tabGroup, 0x14c, i), O.rowMajorIndex, i);
  for (let i = W.i32(win, O.colMajorIndex); i < W.farray.num(tabGroup, 0x158); i++)
    W.setI32(W.farray.ptr(tabGroup, 0x158, i), O.colMajorIndex, i);
  W.setI32(win, O.rowMajorIndex, -1);
  W.setI32(win, O.colMajorIndex, -1);
}
export function resortWindowTables(W, tabGroup) {           // 0x10045140
  if (W.farray.num(tabGroup, 0x14c) > 1)
    W.farray.qsort(tabGroup, 0x14c, (a, b) => compareRowMajor(W, a, b, 0xd8, 0xd4));
  for (let i = 0; i < W.farray.num(tabGroup, 0x14c); i++) W.setI32(W.farray.ptr(tabGroup, 0x14c, i), O.rowMajorIndex, i);
  if (W.farray.num(tabGroup, 0x158) > 1)
    W.farray.qsort(tabGroup, 0x158, (a, b) => compareRowMajor(W, a, b, 0xd4, 0xd8));
  for (let i = 0; i < W.farray.num(tabGroup, 0x158); i++) W.setI32(W.farray.ptr(tabGroup, 0x158, i), O.colMajorIndex, i);
  if (computeTabGroupLocation(W, tabGroup)) {
    const modal = getModalWindow(W, tabGroup);
    if (modal) resortTabGroupTable(W, modal);
  }
}
/** 0x10045000: first traversable row-major window with a non-empty clip. */
export function computeTabGroupLocation(W, tabGroup) {
  let x = f(0), y = f(0);
  for (let i = 0; i < W.farray.num(tabGroup, 0x14c); i++) {
    const win = W.farray.ptr(tabGroup, 0x14c, i);
    const cw = W.f32(win, O.clipW), ch = W.f32(win, O.clipH);
    if (c0(cw, 0) || c3(cw, 0) || c0(ch, 0) || c3(ch, 0)) continue;
    if (!isTraversable(W, win, 0)) continue;
    x = f(W.f32(win, 0xdc) + W.f32(win, 0xd4));
    y = f(W.f32(win, 0xe0) + W.f32(win, 0xd8));
    break;
  }
  if (c3(x, W.f32(tabGroup, 0x16c)) && c3(W.f32(tabGroup, 0x170), y)) return 0;
  W.setF32(tabGroup, 0x16c, x);
  W.setF32(tabGroup, 0x170, y);
  return 1;
}
/** XModalWindow::BuildAcceleratorTable 0x10037210 / SetAcceleratorWindows 0x10036a50. */
export function buildAcceleratorTable(W, modal) {
  if (!(W.u8(modal, 0x584) & 1)) return;
  clearAcceleratorTable(W, modal);
  setAcceleratorWindows(W, modal, modal);
  W.setU32(modal, 0x584, (W.u32(modal, 0x584) & 0xfffffffe) >>> 0);
}
function chainHas(W, win, bit) {
  let w = win;
  while (w && (W.u8(w, O.flags) & bit)) w = W.ptr(w, O.parent);
  return !w;
}
export function setAcceleratorWindows(W, modal, win) {
  let key = W.u16(win, O.acceleratorKey);
  if (key > 0 && key < 0xff && chainHas(W, win, 1) && chainHas(W, win, 2) && (W.u8(win, O.flags) & 4)) {
    if (key >= 0x61 && key <= 0x7a) key = (key + 0xffe0) & 0xffff;
    if (!W.u32(modal, 0x188 + 4 * key)) W.setPtr(modal, 0x188 + 4 * key, win);
    const lowerKey = key >= 0x41 && key <= 0x5a ? key + 0x20 : key;
    if (!W.u32(modal, 0x188 + 4 * lowerKey)) W.setPtr(modal, 0x188 + 4 * lowerKey, win);
  }
  for (let child = bottomChild(W, win, 1); child; child = higherSibling(W, child, 1))
    if (W.u8(child, O.type) < 2 && chainHas(W, child, 2)) setAcceleratorWindows(W, modal, child);
}
export {getTabGroupWindow, getRootWindow, topChild, lowerSibling};
