/**
 * Recovered Extension.dll XListWindow::EnableMultiSelect translation (body
 * 0x10031040).
 *
 * Reads flag bit2 and compares it against the full argument dword — an equal
 * value is a complete no-op.  Otherwise the flag word is rewritten to
 * (flags & ~4) | ((arg & 1) << 2) and stored.  When the new state disables
 * multi-select (`test cl, 4` on the new low byte) and numSelected > 0, the
 * rows array is walked from the last index down: each selected row is passed
 * to the deselect helper 0x10032dc0(index, 0, &changed) only while
 * numSelected > 1, so a single surviving selection is kept.  Any actual
 * change sets the local out flag and triggers the selection broadcast
 * 0x100331a0.  The export is void.
 */
import {
  LIST_WINDOW,
  LIST_ROW,
  LIST_FLAGS,
  LIST_WINDOW_DLL,
  ROW_SELECTED,
  broadcastSelection,
  listMemory,
  selectRowAt,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_ENABLE_MULTI_SELECT_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.EnableMultiSelect',
  packageExport: 1704,
  nativeIndex: 1794,
  functionFlags: 0x401,
  serialSize: 31,
  ...LIST_WINDOW_DLL,
  execBody: 0x10035fa0,
  execEnd: 0x10035fe6,
  execSha256: 'ec2b15dc7a2c6a67d6f626a7fe6689f0c27eef0d3eec381a2580bf401923740d',
  methodBody: 0x10031040,
  methodEnd: 0x10031127,
  methodSha256: '2188801dcbd7d7be2f3b3404123f33d5fda312129fb88f03b8531f2f4fb0ed55',
});

export class ListWindowEnableMultiSelectBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowEnableMultiSelectBoundaryError';
    this.code = `LIST_ENABLE_MULTI_SELECT_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowEnableMultiSelectBoundaryError(message, details);
};

export function listWindowEnableMultiSelect(object, bEnableMultiSelect, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.EnableMultiSelect requires a canonical window object',
      {kind: 'REFERENCE', value: object});
  if (typeof bEnableMultiSelect !== 'number' || !Number.isInteger(bEnableMultiSelect))
    fail('ListWindow.EnableMultiSelect requires an integer flag',
      {kind: 'VALUE', value: bEnableMultiSelect});
  const L = listMemory(object, services);
  const arg = bEnableMultiSelect | 0;
  const flags = L.read(L.base + LIST_WINDOW.flags, 'u32');
  if (((flags >>> 2) & 1) === arg) return;
  const next = ((flags & ~LIST_FLAGS.multiSelect) | ((arg & 1) << 2)) >>> 0;
  L.write(L.base + LIST_WINDOW.flags, 'u32', next);
  if ((next & LIST_FLAGS.multiSelect)
      || L.read(L.base + LIST_WINDOW.numSelected, 'i32') <= 0) return;
  let changed = 0;
  const rdata = L.read(L.base + LIST_WINDOW.rowsData, 'u32');
  for (let i = L.read(L.base + LIST_WINDOW.rowsCount, 'i32') - 1; i >= 0; i--) {
    const node = L.read(rdata + 4 * i, 'u32');
    if (!(L.read(node + LIST_ROW.flags, 'u32') & ROW_SELECTED)) continue;
    if (L.read(L.base + LIST_WINDOW.numSelected, 'i32') <= 1) continue;
    changed |= selectRowAt(L, i, 0);
  }
  if (changed) broadcastSelection(L);
}

export const execListWindowEnableMultiSelect = listWindowEnableMultiSelect;
