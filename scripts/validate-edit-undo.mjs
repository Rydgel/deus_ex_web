/** Validate XEditWindow::Undo (native 1910) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-undo.mjs'),
  metaExport: 'EDIT_UNDO_NATIVE',
  entry: 'editWindowUndo',
  oracleFile: 'native-edit-undo-oracle.py',
  section: 'undo',
  resultKind: 'void',
  metadataParams: [],
  mutations: [
    {file: 'model',
     find: '  const pos = L.read(L.base + EDIT_WINDOW.undoPos, \'i32\');\n  if (pos <= 0) return;\n  const np = pos - 1;',
     replace: '  const pos = L.read(L.base + EDIT_WINDOW.undoPos, \'i32\');\n  if (pos < 0) return;\n  const np = pos - 1;',
     note: 'undo allowed at position 0 (walks off the stack)'},
    {file: 'model',
     find: '  const newNum = L.read(rec + EDIT_UNDO.newText + 4, \'i32\');\n  const newLen = newNum !== 0 ? newNum - 1 : 0;\n  L.write(L.base + EDIT_WINDOW.selEnd, \'i32\', start + newLen);',
     replace: '  const newNum = L.read(rec + EDIT_UNDO.oldText + 4, \'i32\');\n  const newLen = newNum !== 0 ? newNum - 1 : 0;\n  L.write(L.base + EDIT_WINDOW.selEnd, \'i32\', start + newLen);',
     note: 'selection end uses oldLen instead of newLen'},
    {file: 'model',
     find: '  const oldNum = L.read(rec + EDIT_UNDO.oldText + 4, \'i32\');\n  const src = oldNum !== 0 ? L.read(rec + EDIT_UNDO.oldText, \'u32\') : emptyWString(L);\n  replaceSelection(L, src, 0, 1);',
     replace: '  const oldNum = L.read(rec + EDIT_UNDO.oldText + 4, \'i32\');\n  const src = oldNum !== 0 ? L.read(rec + EDIT_UNDO.newText, \'u32\') : emptyWString(L);\n  replaceSelection(L, src, 0, 1);',
     note: 'undo restores the new text instead of the old text'},
  ],
});
