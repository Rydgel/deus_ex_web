/**
 * Recovered Extension.dll XEditWindow::EnableUppercaseOnly translation
 * (method body 0x1001d7d0, exec stub 0x10021f10).
 *
 * Compares flag bit2 (+0x1d0) against the full argument dword — an equal
 * value returns immediately.  Otherwise stores
 * (flags & ~4) | ((arg & 1) << 2).  `test cl, 4` on the new low byte gates
 * the enable path: disabling returns with no further work.  Enabling copies
 * the text FString into a stack temp and invokes the virtual SetText(+0x11c)
 * with it (or the shared L""), re-running the content through filterText
 * whose FilterChar maps a-z to A-Z while the flag is set.  Unlike
 * EnableSingleLineEditing no word-wrap state is touched.  The export is void.
 */
import {
  EDIT_FLAGS,
  EDIT_WINDOW,
  EDIT_WINDOW_DLL,
  EditWindowModelBoundaryError,
  editMemory,
  setTextVirtual,
  tempFStringTeardown,
} from './script-edit-model.mjs';
import {farrayRealloc, moveBytes} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const EDIT_ENABLE_UPPERCASE_ONLY_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.EnableUppercaseOnly',
  packageExport: 1165,
  nativeIndex: 1889,
  functionFlags: 0x401,
  serialSize: 31,
  ...EDIT_WINDOW_DLL,
  execBody: 0x10021f10,
  execEnd: 0x10021f56,
  execSha256: '0499fa5eb72f8732d1edd42140be64e981c8619b53f6e06a0918f184bdb29ff2',
  methodBody: 0x1001d7d0,
  methodEnd: 0x1001d95b,
  methodSha256: '8b56da2b79e785366c1f12723169c03d1ab6d4f8470680429320ed961bafefe7',
});

export class EditWindowEnableUppercaseOnlyBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowEnableUppercaseOnlyBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowEnableUppercaseOnlyBoundaryError(message);
};

export function editWindowEnableUppercaseOnly(object, bUppercase, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.EnableUppercaseOnly requires a canonical window object');
  }
  if (typeof bUppercase !== 'number' || !Number.isInteger(bUppercase)) {
    fail('EditWindow.EnableUppercaseOnly requires an integer flag');
  }
  const L = editMemory(object, services);
  const arg = bUppercase | 0;
  const flags = L.read(L.base + EDIT_WINDOW.flags, 'u32');
  if (((flags >>> 2) & 1) === arg) return;
  const next = ((flags & ~EDIT_FLAGS.uppercase) | ((arg & 1) << 2)) >>> 0;
  L.write(L.base + EDIT_WINDOW.flags, 'u32', next);
  if ((next & EDIT_FLAGS.uppercase) === 0) return;
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
  tempFStringTeardown(L, tmp);
}

export const execEditWindowEnableUppercaseOnly = editWindowEnableUppercaseOnly;
