/** Validate XEditWindow::Copy (native 1915) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-copy.mjs'),
  metaExport: 'EDIT_COPY_NATIVE',
  entry: 'editWindowCopy',
  oracleFile: 'native-edit-copy-oracle.py',
  section: 'copy',
  resultKind: 'void',
  metadataParams: [],
  mutations: [
    {file: 'model',
     find: '  if (selEnd <= selStart) return;',
     replace: '  if (selEnd < selStart) return;',
     note: 'zero-width selection copies instead of returning'},
    {file: 'model',
     find: '  assignString(L, clip, data + selStart * 2, selEnd - selStart);',
     replace: '  assignString(L, clip, data + selStart * 2, selEnd - selStart + 1);',
     note: 'clipboard copy runs one char past the selection'},
    {file: 'module',
     find: '  copyOrCut(L, 0, 1);',
     replace: '  copyOrCut(L, 1, 1);',
     note: 'Copy deletes the selection like Cut'},
  ],
});
