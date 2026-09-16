/** Validate XEditWindow::SetMaxSize (native 1895) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-max-size.mjs'),
  metaExport: 'EDIT_SET_MAX_SIZE_NATIVE',
  entry: 'editWindowSetMaxSize',
  oracleFile: 'native-edit-set-max-size-oracle.py',
  section: 'setMaxSize',
  resultKind: 'void',
  metadataParams: ['newMaxSize:int'],
  mutations: [
    {file: 'module',
     find: '  if (n <= 0) return;',
     replace: '  if (n < 0) return;',
     note: 'zero limit falls through to the truncation path'},
    {file: 'module',
     find: '  if (len <= n) return;',
     replace: '  if (len < n) return;',
     note: 'exact-length text is still routed through InsertText'},
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.maxSize, 'i32', n);",
     replace: "  L.write(L.base + EDIT_WINDOW.savedUndoPos, 'i32', n);",
     note: 'new limit lands on savedUndoPos instead of maxSize'},
  ],
});
