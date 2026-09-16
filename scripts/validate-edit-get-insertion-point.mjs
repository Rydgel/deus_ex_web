/** Validate XEditWindow::GetInsertionPoint (native 1882) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-get-insertion-point.mjs'),
  metaExport: 'EDIT_GET_INSERTION_POINT_NATIVE',
  entry: 'editWindowGetInsertionPoint',
  oracleFile: 'native-edit-get-insertion-point-oracle.py',
  section: 'getInsertionPoint',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:int'],
  mutations: [
    {file: 'module',
     find: "  return L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32');",
     replace: "  return L.read(L.base + EDIT_WINDOW.anchor, 'i32');",
     note: 'getter reads the anchor field instead of the insertion point'},
    {file: 'module',
     find: "  return L.read(L.base + EDIT_WINDOW.insertionPoint, 'i32');",
     replace: "  return L.read(L.base + EDIT_WINDOW.selStart, 'i32');",
     note: 'getter reads the selection-start field'},
  ],
});
