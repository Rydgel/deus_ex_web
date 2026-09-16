/**
 * Recovered Extension.dll XEditWindow::Copy translation (exec body
 * 0x100229d0 -> method 0x1001df20 -> copyOrCut core 0x1001e5f0(0, 1)).
 * No args.  Copies text[selStart, selEnd) into the process-global
 * clipboard FString; a no-op without a selection.
 */
import {
  EDIT_WINDOW_DLL,
  editMemory,
  copyOrCut,
} from './script-edit-model.mjs';

const freeze = Object.freeze;

export const EDIT_COPY_NATIVE = freeze({
  package: 'Extension',
  function: 'EditWindow.Copy',
  packageExport: 965,
  nativeIndex: 1915,
  functionFlags: 0x401,
  serialSize: 27,
  ...EDIT_WINDOW_DLL,
  execBody: 0x100229d0,
  execEnd: 0x100229df,
  execSha256: '6bc113cb5f1f944a9abf23b93f43e8c0ab5a88fd23b7bffc4265353173300c0d',
  methodBody: 0x1001df20,
  methodEnd: 0x1001df92,
  methodSha256: '3715df27e0de41e94a083c997a5dc15fafb6c02a7d2c4317c8962bb5d1b083f9',
});

export class EditWindowCopyBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditWindowCopyBoundaryError';
  }
}

const fail = message => {
  throw new EditWindowCopyBoundaryError(message);
};

export function editWindowCopy(object, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) {
    fail('EditWindow.Copy requires a canonical window object');
  }
  const L = editMemory(object, services);
  copyOrCut(L, 0, 1);
}

export const execEditWindowCopy = editWindowCopy;
