/**
 * Recovered Extension.dll XListWindow::EnableAutoExpandColumns translation
 * (body 0x10030fa0).
 *
 * Reads flag bit1 and compares it against the full argument dword — an equal
 * value is a complete no-op.  Otherwise the flag word is rewritten to
 * (flags & ~2) | ((arg & 1) << 1) and stored before the driver decision:
 * `test al, 2` on the new low byte invokes the auto-expand driver
 * 0x1002fc40(1) only when the bit is now set.  The export is void.
 */
import {
  LIST_WINDOW,
  LIST_FLAGS,
  LIST_WINDOW_DLL,
  autoExpandColumns,
  listMemory,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_ENABLE_AUTO_EXPAND_COLUMNS_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.EnableAutoExpandColumns',
  packageExport: 1700,
  nativeIndex: 1792,
  functionFlags: 0x401,
  serialSize: 31,
  ...LIST_WINDOW_DLL,
  execBody: 0x10035ef0,
  execEnd: 0x10035f36,
  execSha256: '700953cfa0af9c3dec87e6065d3e78eaa44e60cbf9bb3b182beeb77610af901c',
  methodBody: 0x10030fa0,
  methodEnd: 0x1003103a,
  methodSha256: 'b9d61effd08e13ab9ec05c7e7f5869d8db3e8e54c3baae2562517f5efe26cf5b',
});

export class ListWindowEnableAutoExpandColumnsBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowEnableAutoExpandColumnsBoundaryError';
    this.code = `LIST_ENABLE_AUTO_EXPAND_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowEnableAutoExpandColumnsBoundaryError(message, details);
};

export function listWindowEnableAutoExpandColumns(object, bAutoExpandColumns, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.EnableAutoExpandColumns requires a canonical window object',
      {kind: 'REFERENCE', value: object});
  if (typeof bAutoExpandColumns !== 'number' || !Number.isInteger(bAutoExpandColumns))
    fail('ListWindow.EnableAutoExpandColumns requires an integer flag',
      {kind: 'VALUE', value: bAutoExpandColumns});
  const L = listMemory(object, services);
  const arg = bAutoExpandColumns | 0;
  const flags = L.read(L.base + LIST_WINDOW.flags, 'u32');
  if (((flags >>> 1) & 1) === arg) return;
  const next = ((flags & ~LIST_FLAGS.autoExpand) | ((arg & 1) << 1)) >>> 0;
  L.write(L.base + LIST_WINDOW.flags, 'u32', next);
  if (next & LIST_FLAGS.autoExpand) autoExpandColumns(L, 1);
}

export const execListWindowEnableAutoExpandColumns = listWindowEnableAutoExpandColumns;
