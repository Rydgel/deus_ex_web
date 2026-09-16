/** Validate XEditWindow::HasTextChanged (native 1892) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-has-text-changed.mjs'),
  metaExport: 'EDIT_HAS_TEXT_CHANGED_NATIVE',
  entry: 'editWindowHasTextChanged',
  oracleFile: 'native-edit-has-text-changed-oracle.py',
  section: 'hasTextChanged',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:bool'],
  mutations: [
    {file: 'module',
     find: '    !== L.read(L.base + EDIT_WINDOW.savedUndoPos, \'i32\') ? 1 : 0;',
     replace: '    === L.read(L.base + EDIT_WINDOW.savedUndoPos, \'i32\') ? 1 : 0;',
     note: 'comparison inverted'},
    {file: 'module',
     find: "  return L.read(L.base + EDIT_WINDOW.undoPos, 'i32')",
     replace: "  return L.read(L.base + EDIT_WINDOW.maxUndos, 'i32')",
     note: 'getter compares maxUndos instead of undoPos'},
  ],
});
