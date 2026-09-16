/** Validate XEditWindow::SetInsertionPointType (native 1906) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-insertion-point-type.mjs'),
  metaExport: 'EDIT_SET_INSERTION_POINT_TYPE_NATIVE',
  entry: 'editWindowSetInsertionPointType',
  oracleFile: 'native-edit-set-insertion-point-type-oracle.py',
  section: 'setInsertionPointType',
  resultKind: 'void',
  metadataParams: ['newType:byte', 'prefWidth:float', 'prefHeight:float'],
  mutations: [
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.prefWidth, 'f32', prefWidth);",
     replace: "  L.write(L.base + EDIT_WINDOW.prefHeight, 'f32', prefWidth);",
     note: 'prefWidth stored into the prefHeight field'},
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.ipType, 'u8', newType & 0xff);",
     replace: "  L.write(L.base + EDIT_WINDOW.selStart, 'u8', newType & 0xff);",
     note: 'insertion-point type stored into selStart'},
    {file: 'model',
     find: "    requireService(L, 'updateCaret')(L.object, L.base, sticky | 0), 'updateCaret') | 0;",
     replace: "    requireService(L, 'updateCaret')(L.object, L.base, (sticky | 0) + 1), 'updateCaret') | 0;",
     note: 'updateCaret invoked with sticky+1'},
  ],
});
