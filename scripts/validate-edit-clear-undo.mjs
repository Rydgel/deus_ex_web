/** Validate XEditWindow::ClearUndo (native 1912) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-clear-undo.mjs'),
  metaExport: 'EDIT_CLEAR_UNDO_NATIVE',
  entry: 'editWindowClearUndo',
  oracleFile: 'native-edit-clear-undo-oracle.py',
  section: 'clearUndo',
  resultKind: 'void',
  metadataParams: [],
  mutations: [
    {file: 'model',
     find: "L.write(L.base + EDIT_WINDOW.savedUndoPos, 'i32', undoPos - saved !== 0 ? -1 : 0);",
     replace: "L.write(L.base + EDIT_WINDOW.savedUndoPos, 'i32', undoPos - saved !== 0 ? 0 : -1);",
     note: 'saved-marker rule inverted (-1 vs 0 swapped)'},
    {file: 'model',
     find: "  L.write(L.base + EDIT_WINDOW.undoPos, 'i32', 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.undoPos, 'i32', 1);",
     note: 'undoPos reset to 1 instead of 0'},
    {file: 'model',
     find: '  for (let i = 0; i < num; i += 1) {\n    destroyUndoRecordClear(L, data + i * EDIT_UNDO.size);',
     replace: '  for (let i = 1; i < num; i += 1) {\n    destroyUndoRecordClear(L, data + i * EDIT_UNDO.size);',
     note: 'record 0 left undestroyed (loop starts at 1)'},
  ],
});
