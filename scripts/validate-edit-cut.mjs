/** Validate XEditWindow::Cut (native 1916) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-cut.mjs'),
  metaExport: 'EDIT_CUT_NATIVE',
  entry: 'editWindowCut',
  oracleFile: 'native-edit-cut-oracle.py',
  section: 'cut',
  resultKind: 'void',
  metadataParams: [],
  mutations: [
    {file: 'module',
     find: '  copyOrCut(L, 1, 1);',
     replace: '  copyOrCut(L, 0, 1);',
     note: 'Cut never deletes the selection'},
    {file: 'module',
     find: '  copyOrCut(L, 1, 1);',
     replace: '  copyOrCut(L, 1, 0);',
     note: 'Cut passes bKeepUndo=0 so the delete clears undo history'},
    {file: 'model',
     find: '  if (selEnd <= selStart) return;\n  const clip = L.mem.clipboard;',
     replace: '  if (selEnd < selStart) return;\n  const clip = L.mem.clipboard;',
     note: 'empty (-1,-1) selection no longer early-returns'},
  ],
});
