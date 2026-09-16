/** Validate XEditWindow::EnableEditing (native 1885) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-enable-editing.mjs'),
  metaExport: 'EDIT_ENABLE_EDITING_NATIVE',
  entry: 'editWindowEnableEditing',
  oracleFile: 'native-edit-enable-editing-oracle.py',
  section: 'enableEditing',
  resultKind: 'void',
  metadataParams: ['bEdit:bool'],
  mutations: [
    {file: 'module',
     find: '  const next = (flags ^ ((flags ^ arg) & EDIT_FLAGS.editing)) >>> 0;',
     replace: '  const next = (flags ^ ((flags ^ arg) & EDIT_FLAGS.singleLine)) >>> 0;',
     note: 'flag store masks bit1 instead of bit0'},
    {file: 'module',
     find: '  L.write(L.base + EDIT_WINDOW.flags, \'u32\', next);',
     replace: '  L.write(L.base + EDIT_WINDOW.ipType, \'u32\', next);',
     note: 'store lands on the insertion-point-type field'},
  ],
});
