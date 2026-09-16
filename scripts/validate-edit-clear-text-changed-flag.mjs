/** Validate XEditWindow::ClearTextChangedFlag (native 1890) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-clear-text-changed-flag.mjs'),
  metaExport: 'EDIT_CLEAR_TEXT_CHANGED_FLAG_NATIVE',
  entry: 'editWindowClearTextChangedFlag',
  oracleFile: 'native-edit-clear-text-changed-flag-oracle.py',
  section: 'clearTextChangedFlag',
  resultKind: 'void',
  metadataParams: [],
  mutations: [
    {file: 'module',
     find: '  setTextChangedFlag(L, 0);',
     replace: '  setTextChangedFlag(L, 1);',
     note: 'clear delegates with a set argument'},
    {file: 'model',
     find: "  const saved = bSet !== 0 ? -1 : L.read(L.base + EDIT_WINDOW.undoPos, 'i32');",
     replace: "  const saved = bSet !== 0 ? -1 : L.read(L.base + EDIT_WINDOW.maxUndos, 'i32');",
     note: 'clear stores maxUndos instead of undoPos'},
  ],
});
