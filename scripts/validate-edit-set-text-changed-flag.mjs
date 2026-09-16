/** Validate XEditWindow::SetTextChangedFlag (native 1891) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-text-changed-flag.mjs'),
  metaExport: 'EDIT_SET_TEXT_CHANGED_FLAG_NATIVE',
  entry: 'editWindowSetTextChangedFlag',
  oracleFile: 'native-edit-set-text-changed-flag-oracle.py',
  section: 'setTextChangedFlag',
  resultKind: 'void',
  metadataParams: ['bSet:bool'],
  mutations: [
    {file: 'model',
     find: "  const saved = bSet !== 0 ? -1 : L.read(L.base + EDIT_WINDOW.undoPos, 'i32');",
     replace: "  const saved = bSet !== 0 ? 0 : L.read(L.base + EDIT_WINDOW.undoPos, 'i32');",
     note: 'set stores 0 instead of the -1 sentinel'},
    {file: 'model',
     find: "  const saved = bSet !== 0 ? -1 : L.read(L.base + EDIT_WINDOW.undoPos, 'i32');",
     replace: "  const saved = bSet !== 0 ? -1 : L.read(L.base + EDIT_WINDOW.savedUndoPos, 'i32');",
     note: 'clear re-stores savedUndoPos instead of undoPos'},
  ],
});
