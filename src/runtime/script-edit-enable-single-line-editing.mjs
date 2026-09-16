/**
 * Recovered Extension.dll XEditWindow::EnableSingleLineEditing translation
 * (method body 0x1001d620, exec stub 0x10021e60).
 *
 * Compares flag bit1 (+0x1d0) against the full argument dword — an equal
 * value returns immediately.  Otherwise stores
 * (flags & ~2) | ((arg & 1) << 2... no: <<1).  When the new state DISABLES
 * single-line mode the body calls EnableWordWrap(1) and returns.  When it
 * ENABLES it copies the text FString into a stack temp ({data=0,num,max=num}
 * then Realloc(2) + memcpy num*2 bytes), invokes the virtual SetText(+0x11c)
 * with the copy (or the shared L"" when the text is empty) — which re-runs
 * the content through filterText, dropping newline characters — then calls
 * EnableWordWrap(0).  The temp is torn down with reset(,0) + Remove(0,0,2) +
 * Free-if-data.  The export is void.
 */
import {
  EDIT_FLAGS,
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  EditWindowModelBoundaryError,
  editMemory,
  enableWordWrap,
  setTextVirtual,
  tempFStringTeardown,
} from './script-edit-model.mjs';
import {farrayRealloc, moveBytes} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const EDIT_ENABLE_SINGLE_LINE_EDITING_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.EnableSingleLineEditing',
  packageExport: 920,
  nativeIndex: 1887,
  functionFlags: 0x401,
  serialSize: 31,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021e60,
  execEnd: 0x10021ea6,
  execSha256: 'd8dd4e15aa26d2f435d6b0974a51e524405caea768e63e514640142fe564db8b',
  methodBody: 0x1001d620,
  methodEnd: 0x1001d7cd,
  methodSha256: '1cf3fd73bcce819b1c85354059d04351f87c8d2bf4636e2fe29e7e4bc6a6417b',
});

export class EditWindowEnableSingleLineEditingBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowEnableSingleLineEditingBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowEnableSingleLineEditingBoundaryError(message);
};

export function editWindowEnableSingleLineEditing(object, bSingle, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.EnableSingleLineEditing requires a canonical window object');
  }
  if (typeof bSingle !== 'number' || !Number.isInteger(bSingle)) {
    fail('EditWindow.EnableSingleLineEditing requires an integer flag');
  }
  const L = editMemory(object, services);
  const arg = bSingle | 0;
  const flags = L.read(L.base + EDIT_WINDOW.flags, 'u32');
  if (((flags >>> 1) & 1) === arg) return;
  const next = ((flags & ~EDIT_FLAGS.singleLine) | ((arg & 1) << 1)) >>> 0;
  L.write(L.base + EDIT_WINDOW.flags, 'u32', next);
  if ((next & EDIT_FLAGS.singleLine) === 0) {
    enableWordWrap(L, 1);
    return;
  }
  const num = L.read(L.base + EDIT_WINDOW.textNum, 'i32');
  const tmp = L.mem.scratchCopy;
  if (!Number.isInteger(tmp)) {
    throw new EditWindowModelBoundaryError('memory service lacks scratchCopy');
  }
  L.write(tmp, 'u32', 0);
  L.write(tmp + 4, 'i32', num);
  L.write(tmp + 8, 'i32', num);
  farrayRealloc(L, tmp, 2);
  if (num !== 0) {
    moveBytes(L, L.read(tmp, 'u32'), L.read(L.base + EDIT_WINDOW.text, 'u32'), num * 2);
  }
  const src = num !== 0 ? L.read(tmp, 'u32') : L.mem.emptyWString;
  setTextVirtual(L, src);
  enableWordWrap(L, 0);
  tempFStringTeardown(L, tmp);
}

export const execEditWindowEnableSingleLineEditing = editWindowEnableSingleLineEditing;
