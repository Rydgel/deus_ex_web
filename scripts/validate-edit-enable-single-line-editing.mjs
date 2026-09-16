/** Validate XEditWindow::EnableSingleLineEditing (native 1887) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-enable-single-line-editing.mjs'),
  metaExport: 'EDIT_ENABLE_SINGLE_LINE_EDITING_NATIVE',
  entry: 'editWindowEnableSingleLineEditing',
  oracleFile: 'native-edit-enable-single-line-editing-oracle.py',
  section: 'enableSingleLineEditing',
  resultKind: 'void',
  metadataParams: ['bSingle:bool'],
  mutations: [
    {file: 'module',
     find: '  if (((flags >>> 1) & 1) === arg) return;',
     replace: '  if (((flags >>> 1) & 1) === (arg & 1)) return;',
     note: 'unchanged-compare masks the argument to one bit'},
    {file: 'module',
     find: '    enableWordWrap(L, 1);',
     replace: '    enableWordWrap(L, 0);',
     note: 'disable path clears word wrap instead of setting it'},
    {file: 'model',
     find: 'if ((flags & EDIT_FLAGS.singleLine) !== 0 && ch === 0xa) continue;',
     replace: 'if ((flags & EDIT_FLAGS.singleLine) !== 0 && ch === 0xd) continue;',
     note: 'filterText skips CR instead of LF'},
  ],
});
