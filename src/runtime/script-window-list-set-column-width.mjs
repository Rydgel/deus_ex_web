/**
 * Recovered Extension.dll XListWindow::SetColumnWidth translation (body
 * 0x1002fed0).
 *
 * The column index is validated (0x10033240); then fcomp compares the stored
 * f32 width with the f32 argument — `test ah, 0x40` skips the write when C3
 * is set, i.e. when the values are equal or the compare is unordered (NaN).
 * On a difference the raw f32 argument bits are stored, the auto-expand
 * driver 0x1002fc40 runs when flag bit1 is set (it emits its own
 * reconfigure), and AskParentForReconfigure 0x1004e060 always follows a
 * write.  The export is void.
 */
import {
  LIST_WINDOW,
  LIST_COL,
  LIST_FLAGS,
  LIST_WINDOW_DLL,
  askParentReconfigure,
  autoExpandColumns,
  colIndexValid,
  listMemory,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;
const f = Math.fround;

export const WINDOW_LIST_SET_COLUMN_WIDTH_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.SetColumnWidth',
  packageExport: 1642,
  nativeIndex: 1767,
  functionFlags: 0x401,
  serialSize: 34,
  ...LIST_WINDOW_DLL,
  execBody: 0x10035340,
  execEnd: 0x100353af,
  execSha256: 'f20b0806ab633e9f98e3de3aa972d5ae38c1597aa44ad99b04434327415581bd',
  methodBody: 0x1002fed0,
  methodEnd: 0x1002ff8a,
  methodSha256: '08b6dac089303887f3ed8e37fbf1ffcf7cc08cbaee0de3eb708a6297d80e13a9',
});

export class ListWindowSetColumnWidthBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowSetColumnWidthBoundaryError';
    this.code = `LIST_SET_COLUMN_WIDTH_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowSetColumnWidthBoundaryError(message, details);
};

export function listWindowSetColumnWidth(object, colIndex, newWidth, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.SetColumnWidth requires a canonical window object',
      {kind: 'REFERENCE', value: object});
  if (typeof colIndex !== 'number' || !Number.isInteger(colIndex))
    fail('ListWindow.SetColumnWidth requires an integer column index',
      {kind: 'VALUE', value: colIndex});
  if (typeof newWidth !== 'number')
    fail('ListWindow.SetColumnWidth requires a numeric width',
      {kind: 'VALUE', value: newWidth});
  const L = listMemory(object, services);
  const col = colIndex | 0;
  if (!colIndexValid(L, col)) return;
  const colW = L.read(L.base + LIST_WINDOW.colsData, 'u32')
    + col * LIST_COL.size + LIST_COL.width;
  const cur = L.read(colW, 'f32');
  const next = f(newWidth);
  // fcomp + test ah,0x40: skip on equal or unordered (NaN either side).
  if (cur === next || Number.isNaN(cur) || Number.isNaN(next)) return;
  L.write(colW, 'f32', next);
  if (L.read(L.base + LIST_WINDOW.flags, 'u32') & LIST_FLAGS.autoExpand)
    autoExpandColumns(L, 1);
  askParentReconfigure(L);
}

export const execListWindowSetColumnWidth = listWindowSetColumnWidth;
