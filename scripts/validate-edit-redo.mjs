/** Validate XEditWindow::Redo (native 1911) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-redo.mjs'),
  metaExport: 'EDIT_REDO_NATIVE',
  entry: 'editWindowRedo',
  oracleFile: 'native-edit-redo-oracle.py',
  section: 'redo',
  resultKind: 'void',
  metadataParams: [],
  mutations: [
    {file: 'model',
     find: '  if (pos > count) return;',
     replace: '  if (pos >= count) return;',
     note: 'redo rejects the last available record'},
    {file: 'model',
     find: "  L.write(L.base + EDIT_WINDOW.undoPos, 'i32', pos + 1);\n  L.write(L.base + EDIT_WINDOW.selEnd, 'i32', start + oldLen);",
     replace: "  L.write(L.base + EDIT_WINDOW.undoPos, 'i32', pos);\n  L.write(L.base + EDIT_WINDOW.selEnd, 'i32', start + oldLen);",
     note: 'undoPos never advances'},
    {file: 'model',
     find: '  const newNum = L.read(rec + EDIT_UNDO.newText + 4, \'i32\');\n  const src = newNum !== 0 ? L.read(rec + EDIT_UNDO.newText, \'u32\') : emptyWString(L);\n  replaceSelection(L, src, 0, 1);',
     replace: '  const newNum = L.read(rec + EDIT_UNDO.newText + 4, \'i32\');\n  const src = newNum !== 0 ? L.read(rec + EDIT_UNDO.oldText, \'u32\') : emptyWString(L);\n  replaceSelection(L, src, 0, 1);',
     note: 'redo replays the old text instead of the new text'},
  ],
});
