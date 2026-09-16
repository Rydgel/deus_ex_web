/** Validate XEditWindow::IsSingleLineEditingEnabled (native 1888) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-is-single-line-editing-enabled.mjs'),
  metaExport: 'EDIT_IS_SINGLE_LINE_EDITING_ENABLED_NATIVE',
  entry: 'editWindowIsSingleLineEditingEnabled',
  oracleFile: 'native-edit-is-single-line-editing-enabled-oracle.py',
  section: 'isSingleLineEditingEnabled',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:bool'],
  mutations: [
    {file: 'module',
     find: "  return (L.read(L.base + EDIT_WINDOW.flags, 'u32') >>> 1) & 1;",
     replace: "  return (L.read(L.base + EDIT_WINDOW.flags, 'u32') >>> 2) & 1;",
     note: 'getter returns bit2 instead of bit1'},
    {file: 'module',
     find: "  return (L.read(L.base + EDIT_WINDOW.flags, 'u32') >>> 1) & 1;",
     replace: "  return (L.read(L.base + EDIT_WINDOW.selStart, 'u32') >>> 1) & 1;",
     note: 'getter reads the selection-start field'},
  ],
});
