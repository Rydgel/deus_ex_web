/**
 * Recovered Extension.dll XListWindow::AddRow translation (body
 * 0x1002ed80).  Runs createNode 0x10032420 (GMalloc Malloc of the 24-byte
 * node, fields TArray grown to the column count and zero-filled, then
 * parseRow 0x100322a0 fills each field through setFieldText/measureField
 * under the acquired measure context), then insert 0x10032b50 appends or
 * binary-search-inserts the node and renumbers row ids, and finally
 * AskParentForReconfigure 0x1004e060.  When the row allocation fails the
 * insert and reconfigure are skipped and 0 is returned.
 *
 * The text argument is the wide-string payload the exec trampoline marshals
 * (FString data or the shared empty wstring), so the translation takes the
 * decoded JS string directly.
 */
import {
  LIST_WINDOW_DLL,
  askParentReconfigure,
  createRowNode,
  insertRowNode,
  listMemory,
} from './script-window-list-model.mjs';

const freeze = Object.freeze;

export const WINDOW_LIST_ADD_ROW_NATIVE = freeze({
  package: 'Extension',
  function: 'ListWindow.AddRow',
  packageExport: 1567,
  nativeIndex: 1730,
  functionFlags: 0x401,
  serialSize: 34,
  ...LIST_WINDOW_DLL,
  execBody: 0x10034170,
  execEnd: 0x100342c9,
  execSha256: '996d2545baae4328589d223b2331a33610214c058f5d6efe53123dc544c94fdb',
  methodBody: 0x1002ed80,
  methodEnd: 0x1002ee13,
  methodSha256: '7c13a29cc3fe36fe299d24c0875b1e32b195facbf87d62517cdd0fb25239869f',
});

export class ListWindowAddRowBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'ListWindowAddRowBoundaryError';
    this.code = `LIST_ADD_ROW_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const fail = (message, details) => {
  throw new ListWindowAddRowBoundaryError(message, details);
};

export function listWindowAddRow(object, rowStr, clientData, services = {}) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    fail('ListWindow.AddRow requires a canonical window object', {kind: 'REFERENCE', value: object});
  if (typeof rowStr !== 'string')
    fail('ListWindow.AddRow requires the marshaled row string', {kind: 'VALUE', value: rowStr});
  const L = listMemory(object, services);
  const node = createRowNode(L, rowStr, clientData | 0);
  if (node) {
    insertRowNode(L, node);
    askParentReconfigure(L);
  }
  return node;
}

export const execListWindowAddRow = listWindowAddRow;
