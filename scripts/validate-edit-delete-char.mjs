/** Validate XEditWindow::DeleteChar (native 1901) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-delete-char.mjs'),
  metaExport: 'EDIT_DELETE_CHAR_NATIVE',
  entry: 'editWindowDeleteChar',
  oracleFile: 'native-edit-delete-char-oracle.py',
  section: 'deleteChar',
  resultKind: 'void',
  metadataParams: ['bBefore:bool', 'bUndo:bool'],
  mutations: [
    {file: 'model',
     find: 'export function deleteCharVirtual(L, bBackspace, bKeepUndo) {\n  if (bKeepUndo === 0) {',
     replace: 'export function deleteCharVirtual(L, bBackspace, bKeepUndo) {\n  if (bKeepUndo !== 0) {',
     note: 'undo clear gated on the inverted bKeepUndo flag'},
    {file: 'model',
     find: '    if (bBackspace !== 0) {\n      if (p <= 0) {',
     replace: '    if (bBackspace === 0) {\n      if (p <= 0) {',
     note: 'backspace/forward roles swapped'},
    {file: 'model',
     find: "    L.write(L.base + EDIT_WINDOW.selEnd, 'i32', p + 1);",
     replace: "    L.write(L.base + EDIT_WINDOW.selEnd, 'i32', p + 2);",
     note: 'delete selects two chars instead of one'},
  ],
});
