/** Validate XEditWindow::IsEditingEnabled (native 1886) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-is-editing-enabled.mjs'),
  metaExport: 'EDIT_IS_EDITING_ENABLED_NATIVE',
  entry: 'editWindowIsEditingEnabled',
  oracleFile: 'native-edit-is-editing-enabled-oracle.py',
  section: 'isEditingEnabled',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:bool'],
  mutations: [
    {file: 'module',
     find: "  return L.read(L.base + EDIT_WINDOW.flags, 'u32') & EDIT_FLAGS.editing;",
     replace: "  return L.read(L.base + EDIT_WINDOW.flags, 'u32') & EDIT_FLAGS.singleLine;",
     note: 'getter returns bit1 instead of bit0'},
    {file: 'module',
     find: "  return L.read(L.base + EDIT_WINDOW.flags, 'u32') & EDIT_FLAGS.editing;",
     replace: "  return L.read(L.base + EDIT_WINDOW.selStart, 'u32') & EDIT_FLAGS.editing;",
     note: 'getter reads the selection-start field'},
  ],
});
