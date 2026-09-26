/**
 * Native storage layout of the Extension window classes, derived from the
 * installed Extension.u declaration order and cross-checked against every
 * offset independently recovered from Extension.dll instructions.
 *
 * The Extension window classes are `native noexport`: their C++ members are
 * hand-declared in the same order as the script `var` declarations and the
 * DLL registration passes the C++ `sizeof` to the UClass constructor (see
 * docs/script-window-native-layout.md for the registration size pushes).
 * MSVC packs those members with natural alignment: BYTE/enum members are
 * byte aligned, INT/FLOAT/pointers/FString/TArray/FPlane are dword aligned,
 * FColor (four BYTEs) is byte aligned, and consecutive `BITFIELD b:1`
 * members share one dword. This is the C++ layout, not the script linker's
 * struct alignment (the script linker would align a Color to four bytes,
 * which puts Window.TextColor at +0x40; the native Init/SetTextColor bodies
 * store it at +0x3d). The derivation below reproduces every recovered
 * offset (scripts/validate-object-layout.mjs) and every registration
 * size, and is used only for native Extension window classes.
 */

const freeze = Object.freeze;
const lower = value => String(value).toLowerCase();

/** Registration sizes pushed to the UClass constructor by Extension.dll. */
export const NATIVE_WINDOW_CLASS_SIZES = freeze({
  'extension.window': 0x14c,
  'extension.textwindow': 0x174,
  'extension.buttonwindow': 0x1ec,
  'extension.togglewindow': 0x1f4,
  'extension.checkboxwindow': 0x214,
  'extension.tilewindow': 0x174,
  'extension.tabgroupwindow': 0x174,
  'extension.radioboxwindow': 0x188,
  'extension.modalwindow': 0x588,
  'extension.rootwindow': 0x744,
  'extension.textlogwindow': 0x188,
  'extension.computerwindow': 0x218,
  'extension.editwindow': 0x28c,
  'extension.largetextwindow': 0x1d0,
  'extension.listwindow': 0x1d0,
  'extension.clipwindow': 0x1a0,
  'extension.borderwindow': 0x1c8,
  'extension.scalewindow': 0x274,
  'extension.scalemanagerwindow': 0x174,
  'extension.scrollareawindow': 0x180,
  'extension.viewportwindow': 0x1b4,
});

/** Byte sizes and MSVC alignments of the struct members used by windows. */
const STRUCTS = freeze({
  'core.object.color': {size: 4, align: 1},
  'core.object.plane': {size: 16, align: 4},
  'core.object.vector': {size: 12, align: 4},
  'core.object.rotator': {size: 12, align: 4},
  'extension.extensionobject.cliprect': {size: 24, align: 4},
  'extension.extensionobject.dynamicarray': {size: 12, align: 4},
  // struct ButtonDisplayInfo {texture tx; color tlColor; color txColor;}:
  // XButtonWindow::Init writes the six entries with a 12-byte stride at
  // +0x1a4 (tx +0, tlColor +4, txColor +8).
  'extension.buttonwindow.buttondisplayinfo': {size: 12, align: 4},
});

function scalarLayout(field) {
  switch (field.kind) {
    case 'ByteProperty': return {size: 1, align: 1, kind: 'u8'};
    case 'IntProperty': return {size: 4, align: 4, kind: 'i32'};
    case 'FloatProperty': return {size: 4, align: 4, kind: 'f32'};
    case 'ObjectProperty': case 'ClassProperty': return {size: 4, align: 4, kind: 'ptr'};
    case 'NameProperty': return {size: 4, align: 4, kind: 'name'};
    case 'StrProperty': return {size: 12, align: 4, kind: 'string'};
    case 'StructProperty': {
      const key = field.metadata?.structKey;
      const struct = STRUCTS[key];
      if (!struct) throw new Error(`Native window layout has no struct size for ${key} (${field.key})`);
      return {size: struct.size, align: struct.align, kind: 'struct', struct: key};
    }
    default:
      throw new Error(`Native window layout does not support ${field.kind} (${field.key})`);
  }
}

const align = (value, to) => (value + to - 1) & ~(to - 1);

/**
 * Lay out one native class's own declared fields starting at `start`, with
 * `previousBool` carrying an open bitfield dword from the superclass tail
 * (never used: every superclass here ends on a non-bool or a full dword).
 */
function layoutOwnFields(cls, start) {
  const entries = [];
  let offset = start, openBool = null;
  for (const field of cls.propertyOrder ?? []) {
    if (!field.key.startsWith(`${cls.record.key}.`)) continue;
    const arrayDim = field.metadata?.arrayDim ?? 1;
    if (field.kind === 'BoolProperty') {
      if (openBool && openBool.bit < 31) {
        openBool.bit++;
        entries.push(freeze({field, name: field.name, offset: openBool.offset, kind: 'bool',
          mask: (1 << openBool.bit) >>> 0, size: 4}));
      } else {
        offset = align(offset, 4);
        openBool = {offset, bit: 0};
        entries.push(freeze({field, name: field.name, offset, kind: 'bool', mask: 1, size: 4}));
        offset += 4;
      }
      continue;
    }
    openBool = null;
    const layout = scalarLayout(field);
    offset = align(offset, layout.align);
    entries.push(freeze({field, name: field.name, offset, kind: layout.kind, struct: layout.struct ?? null,
      size: layout.size, arrayDim}));
    offset += layout.size * arrayDim;
  }
  return {entries, end: align(offset, 4)};
}

/**
 * Compute the native layout for a linked runtime class whose chain is made of
 * native Extension window classes (Window and its native descendants). Script
 * subclasses (HUDObjectSlot, DeusExHUD, ...) add no native storage; their own
 * fields stay in VM storage.
 */
export function nativeWindowLayout(cls) {
  const chain = [];
  for (let node = cls; node; node = node.base) chain.unshift(node);
  const windowIndex = chain.findIndex(node => node.record.key === 'extension.window');
  if (windowIndex < 0) throw new Error(`Native window layout requires Extension.Window ancestry: ${cls.record.key}`);
  const fields = new Map();
  let offset = 0x28, nativeClass = null;
  for (const node of chain.slice(windowIndex)) {
    const size = NATIVE_WINDOW_CLASS_SIZES[node.record.key];
    if (size === undefined) break; // first script subclass: no further native members
    const {entries, end} = layoutOwnFields(node, offset);
    for (const entry of entries) fields.set(entry.field.key, entry);
    if (end !== size)
      throw new Error(`Native window layout ${node.record.key} ends at 0x${end.toString(16)}, registration size is 0x${size.toString(16)}`);
    offset = end;
    nativeClass = node;
  }
  return freeze({nativeClass, size: offset, fields});
}

/** Look up one field's native entry by (case-insensitive) name. */
export function nativeWindowField(layout, name) {
  const wanted = lower(name);
  for (const entry of layout.fields.values()) if (lower(entry.name) === wanted) return entry;
  return null;
}

/**
 * Offsets the derivation reproduces. Each value is independently recovered
 * from instructions in the named module/doc; the validator asserts equality.
 */
export const RECOVERED_WINDOW_OFFSETS = freeze([
  ['extension.window', 'windowType', 0x28, 'XWindow::Init 0x1004bb56'],
  ['extension.window', 'parentOwner', 0x2c, 'XWindow::Init parent store'],
  ['extension.window', 'bIsVisible', 0x30, 'getter 0x100031eb', 0x01],
  ['extension.window', 'bIsSensitive', 0x30, 'getter 0x1000324b', 0x02],
  ['extension.window', 'bIsSelectable', 0x30, 'SetSelectability 0x1004c390', 0x04],
  ['extension.window', 'bIsInitialized', 0x30, 'InvokeWindowReady 0x1003bd6f', 0x08],
  ['extension.window', 'bBeingDestroyed', 0x30, 'InvokeTimers 0x1005136a', 0x10],
  ['extension.window', 'lockCount', 0x34, 'LockWindow 0x1004c140'],
  ['extension.window', 'bDrawRawBackground', 0x38, 'XWindow::Init', 0x01],
  ['extension.window', 'bStretchBackground', 0x38, 'DrawTree 0x10051553', 0x02],
  ['extension.window', 'backgroundStyle', 0x3c, 'getter 0x10003280'],
  ['extension.window', 'TextColor', 0x3d, 'SetTextColor 0x1004d9e0'],
  ['extension.window', 'textPlane', 0x44, 'SetTextColor 0x1004d9e0'],
  ['extension.window', 'normalFont', 0x54, 'SetFonts 0x1004d7d6'],
  ['extension.window', 'boldFont', 0x58, 'SetFonts 0x1004d7db'],
  ['extension.window', 'textVSpacing', 0x5c, 'XWindow::Init float 1'],
  ['extension.window', 'tileColor', 0x60, 'SetTileColor 0x1004dae0'],
  ['extension.window', 'tilePlane', 0x64, 'SetTileColor 0x1004dae0'],
  ['extension.window', 'bSpecialText', 0x74, 'getter 0x100032e0', 0x01],
  ['extension.window', 'bTextTranslucent', 0x74, 'getter 0x100032d0', 0x02],
  ['extension.window', 'x', 0x78, 'ConfigureChild 0x1004ec50'],
  ['extension.window', 'y', 0x7c, 'ConfigureChild 0x1004ec50'],
  ['extension.window', 'width', 0x80, 'ConfigureChild 0x1004ec50'],
  ['extension.window', 'height', 0x84, 'ConfigureChild 0x1004ec50'],
  ['extension.window', 'winHAlign', 0x88, 'ResizeChild 0x1004eb06'],
  ['extension.window', 'winVAlign', 0x89, 'ResizeChild 0x1004eb29'],
  ['extension.window', 'hMargin0', 0x8c, 'ResizeChild 0x1004eb18'],
  ['extension.window', 'hMargin1', 0x90, 'ResizeChild 0x1004eb12'],
  ['extension.window', 'vMargin0', 0x94, 'ResizeChild 0x1004eb37'],
  ['extension.window', 'vMargin1', 0x98, 'ResizeChild 0x1004eb31'],
  ['extension.window', 'hardcodedWidth', 0x9c, 'QueryPreferredSize helper 0x1004e790'],
  ['extension.window', 'hardcodedHeight', 0xa0, 'QueryPreferredSize helper 0x1004e790'],
  ['extension.window', 'bNeedsReconfigure', 0xb8, 'AskParentForReconfigure 0x1004e060', 0x01],
  ['extension.window', 'bNeedsQuery', 0xb8, 'QueryPreferredSize dirty bit', 0x02],
  ['extension.window', 'bConfigured', 0xb8, 'ConfigureChild reconfiguring bit', 0x04],
  ['extension.window', 'bLastWidthSpecified', 0xb8, 'QueryPreferredSize provided flag', 0x08],
  ['extension.window', 'bLastHeightSpecified', 0xb8, 'QueryPreferredSize provided flag', 0x10],
  ['extension.window', 'lastSpecifiedWidth', 0xbc, 'QueryPreferredSize cache'],
  ['extension.window', 'lastSpecifiedHeight', 0xc0, 'QueryPreferredSize cache'],
  ['extension.window', 'lastQueryWidth', 0xc4, 'QueryPreferredSize cache'],
  ['extension.window', 'lastQueryHeight', 0xc8, 'QueryPreferredSize cache'],
  ['extension.window', 'bTickEnabled', 0xcc, 'TickTree 0x1003c02d', 0x01],
  ['extension.window', 'maxClicks', 0xd0, 'XWindow::Init zero'],
  ['extension.window', 'winClipRect', 0xd4, 'ClipTree 0x10051160'],
  ['extension.window', 'background', 0xec, 'SetBackground 0x1004d5e0'],
  ['extension.window', 'defaultHotX', 0xf8, 'XWindow::Init -1'],
  ['extension.window', 'defaultHotY', 0xfc, 'XWindow::Init -1'],
  ['extension.window', 'defaultCursorColor', 0x100, 'XWindow::Init packed color'],
  ['extension.window', 'visibleSound', 0x10c, 'InvokeVisibilityChange 0x10050e74'],
  ['extension.window', 'invisibleSound', 0x110, 'InvokeVisibilityChange 0x10050e7d'],
  ['extension.window', 'rowMajorIndex', 0x11c, 'ResortWindowTables 0x10045140'],
  ['extension.window', 'colMajorIndex', 0x120, 'ResortWindowTables 0x10045140'],
  ['extension.window', 'firstTimer', 0x128, 'InvokeTimers 0x10051379'],
  ['extension.window', 'wGc', 0x130, 'XWindow::Init first XGC (native order gGc)'],
  ['extension.window', 'gGc', 0x134, 'XWindow::Init second XGC (native order wGc)'],
  ['extension.window', 'winParent', 0x138, 'AddChild 0x10050a80'],
  ['extension.window', 'firstChild', 0x13c, 'AddChild 0x10050a80'],
  ['extension.window', 'lastChild', 0x140, 'AddChild 0x10050a80'],
  ['extension.window', 'prevSibling', 0x144, 'AddChild 0x10050a80'],
  ['extension.window', 'nextSibling', 0x148, 'AddChild 0x10050a80'],
  ['extension.textwindow', 'hAlign', 0x14c, 'SetTextAlignments 0x10046050'],
  ['extension.textwindow', 'vAlign', 0x14d, 'SetTextAlignments 0x10046050'],
  ['extension.textwindow', 'bWordWrap', 0x150, 'XTextWindow::Init', 0x01],
  ['extension.textwindow', 'bTextIsAccelerator', 0x150, 'XTextWindow::Init', 0x02],
  ['extension.textwindow', 'hMargin', 0x154, 'SetTextMargins 0x10046070'],
  ['extension.textwindow', 'vMargin', 0x158, 'SetTextMargins 0x10046070'],
  ['extension.textwindow', 'minLines', 0x15c, 'XTextWindow::Init'],
  ['extension.textwindow', 'maxLines', 0x160, 'XTextWindow::Init'],
  ['extension.textwindow', 'minWidth', 0x164, 'XTextWindow::Init'],
  ['extension.textwindow', 'text', 0x168, 'SetText 0x10045d50'],
  ['extension.buttonwindow', 'bButtonPressed', 0x174, 'ChangeToggle 0x10049910', 0x01],
  ['extension.buttonwindow', 'bAutoRepeat', 0x174, 'EnableAutoRepeat', 0x04],
  ['extension.buttonwindow', 'bEnableRightMouseClick', 0x174, 'EnableRightMouseClick', 0x08],
  ['extension.buttonwindow', 'activateDelay', 0x178, 'SetActivateDelay'],
  ['extension.buttonwindow', 'initialDelay', 0x17c, 'EnableAutoRepeat'],
  ['extension.buttonwindow', 'repeatRate', 0x180, 'EnableAutoRepeat'],
  ['extension.buttonwindow', 'curTexture', 0x184, 'ChangeButtonAppearance 0x10008380'],
  ['extension.buttonwindow', 'curTileColor', 0x188, 'ChangeButtonAppearance 0x10008380'],
  ['extension.buttonwindow', 'curTextColor', 0x18c, 'ChangeButtonAppearance 0x10008380'],
  ['extension.buttonwindow', 'pressSound', 0x190, 'SetButtonSounds'],
  ['extension.buttonwindow', 'clickSound', 0x194, 'SetButtonSounds'],
  ['extension.buttonwindow', 'info', 0x1a4, 'SetButtonTextures/Colors'],
  ['extension.togglewindow', 'enableSound', 0x1ec, 'SetToggleSounds'],
  ['extension.togglewindow', 'disableSound', 0x1f0, 'SetToggleSounds'],
  ['extension.tilewindow', 'orientation', 0x14c, 'SetOrder/ComputeChildSizes'],
  ['extension.tilewindow', 'hDirection', 0x14d, 'SetOrder'],
  ['extension.tilewindow', 'vDirection', 0x14e, 'SetOrder'],
  ['extension.tilewindow', 'hMargin', 0x150, 'SetMargins'],
  ['extension.tilewindow', 'vMargin', 0x154, 'SetMargins'],
  ['extension.tilewindow', 'minorSpacing', 0x158, 'SetMinorSpacing'],
  ['extension.tilewindow', 'majorSpacing', 0x15c, 'SetMajorSpacing'],
  ['extension.tilewindow', 'hChildAlign', 0x160, 'SetChildAlignments'],
  ['extension.tilewindow', 'vChildAlign', 0x161, 'SetChildAlignments'],
  ['extension.tilewindow', 'bWrap', 0x164, 'EnableWrapping', 0x01],
  ['extension.tilewindow', 'bFillParent', 0x164, 'FillParent', 0x02],
  ['extension.tilewindow', 'bEqualWidth', 0x164, 'MakeWidthsEqual', 0x04],
  ['extension.tilewindow', 'bEqualHeight', 0x164, 'MakeHeightsEqual', 0x08],
  ['extension.tilewindow', 'rowArray', 0x168, 'XTileWindow ctor zeroes'],
  ['extension.tabgroupwindow', 'rowMajorWindowList', 0x14c, 'XTabGroupWindow::Init 0x10044dc5'],
  ['extension.tabgroupwindow', 'colMajorWindowList', 0x158, 'XTabGroupWindow::Init 0x10044de5'],
  ['extension.tabgroupwindow', 'bSizeParentToChildren', 0x164, 'XTabGroupWindow::Init', 0x01],
  ['extension.tabgroupwindow', 'bSizeChildrenToParent', 0x164, 'XTabGroupWindow::Init', 0x02],
  ['extension.tabgroupwindow', 'tabGroupIndex', 0x168, 'XTabGroupWindow::Init -1'],
  ['extension.tabgroupwindow', 'firstAbsX', 0x16c, 'XTabGroupWindow::Init'],
  ['extension.tabgroupwindow', 'firstAbsY', 0x170, 'XTabGroupWindow::Init'],
  ['extension.radioboxwindow', 'bOneCheck', 0x174, 'XRadioBoxWindow::Init', 0x01],
  ['extension.radioboxwindow', 'toggleButtons', 0x178, 'XRadioBoxWindow::Init'],
  ['extension.radioboxwindow', 'currentSelection', 0x184, 'XRadioBoxWindow::Init'],
  ['extension.modalwindow', 'focusMode', 0x174, 'XModalWindow::Init byte 2'],
  ['extension.modalwindow', 'preferredFocus', 0x178, 'XRootWindow::Tick 0x1003a5a8'],
  ['extension.modalwindow', 'tabGroupWindowList', 0x17c, 'XModalWindow::Init'],
  ['extension.modalwindow', 'acceleratorTable', 0x188, 'XModalWindow layout'],
  ['extension.modalwindow', 'bDirtyAccelerators', 0x584, 'MakeAcceleratorTableDirty 0x1004c201', 0x01],
  ['extension.rootwindow', 'parentPawn', 0x588, 'XRootWindow::Init 0x100391e5'],
  ['extension.rootwindow', 'nextRootWindow', 0x58c, 'TickWindows 0x1003a4ef'],
  ['extension.rootwindow', 'mouseX', 0x590, 'ClampMousePosition 0x1003bde0'],
  ['extension.rootwindow', 'mouseY', 0x594, 'ClampMousePosition 0x1003bde0'],
  ['extension.rootwindow', 'bCursorVisible', 0x5a4, 'PaintWindows 0x1003ac18', 0x08],
  ['extension.rootwindow', 'grabbedWindow', 0x5c4, 'CheckGrabbedWindow 0x10050cc3'],
  ['extension.rootwindow', 'focusWindow', 0x5c8, 'SetFocusWindow / CheckFocusWindow'],
  ['extension.rootwindow', 'handleMouseRef', 0x5cc, 'PaintWindows 0x1003ac0a'],
  ['extension.rootwindow', 'initCount', 0x5d4, 'RecomputeInitTree 0x10050dac'],
  ['extension.rootwindow', 'bRender', 0x5d8, 'PreRender 0x1003a7dd', 0x01],
  ['extension.rootwindow', 'bClipRender', 0x5d8, 'PreRender 0x1003a7fa', 0x02],
  ['extension.rootwindow', 'renderX', 0x5dc, 'PreRender 0x1003a813'],
  ['extension.rootwindow', 'rawBackground', 0x5ec, 'PaintWindows 0x1003ab68'],
  ['extension.rootwindow', 'rawColor', 0x5f8, 'PaintWindows 0x1003ab62'],
  ['extension.rootwindow', 'tickCycles', 0x5fc, 'RootTick 0x1003bebf'],
  ['extension.rootwindow', 'paintCycles', 0x600, 'PaintWindows 0x1003ab02'],
  ['extension.rootwindow', 'bShowStats', 0x604, 'PaintWindows 0x1003acde', 0x01],
  ['extension.rootwindow', 'bShowFrames', 0x604, 'PaintWindows 0x1003ab7e', 0x02],
  ['extension.rootwindow', 'debugTexture', 0x608, 'PaintWindows 0x1003ab87'],
  ['extension.rootwindow', 'frameTimer', 0x60c, 'PaintWindows 0x1003ab91'],
  ['extension.rootwindow', 'multiClickTimeout', 0x610, 'XRootWindow::Init 0.5'],
  ['extension.rootwindow', 'lastButtonPress', 0x620, 'XRootWindow::Tick 0x1003a5de'],
  ['extension.rootwindow', 'keyDownMap', 0x630, 'IsKeyDown 0x1004c980'],
  ['extension.rootwindow', 'hMultiplier', 0x730, 'ResizeRoot 0x1003aeae'],
  ['extension.rootwindow', 'vMultiplier', 0x734, 'ResizeRoot 0x1003ae7e'],
  ['extension.rootwindow', 'rootFrame', 0x740, 'PostRender 0x1003aa0b'],
  ['extension.textlogwindow', 'textTimeout', 0x174, 'XTextLogWindow::Init 5.0'],
  ['extension.textlogwindow', 'lines', 0x178, 'XTextLogWindow::Init'],
  ['extension.textlogwindow', 'bTooTall', 0x184, 'XTextLogWindow::Init', 0x01],
]);
