/** Validate XEditWindow::SetInsertionPoint (native 1881) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-insertion-point.mjs'),
  metaExport: 'EDIT_SET_INSERTION_POINT_NATIVE',
  entry: 'editWindowSetInsertionPoint',
  oracleFile: 'native-edit-set-insertion-point-oracle.py',
  section: 'setInsertionPoint',
  resultKind: 'void',
  metadataParams: ['NewPos:int', 'bDrag:bool'],
  mutations: [
    {file: 'model',
     find: "  L.write(L.base + EDIT_WINDOW.insertionPoint, 'i32', p);\n  if (!bExtend) L.write(L.base + EDIT_WINDOW.anchor, 'i32', p);\n  updateSelection(L);\n  updateCaret(L, 1);",
     replace: "  L.write(L.base + EDIT_WINDOW.insertionPoint, 'i32', p);\n  if (bExtend) L.write(L.base + EDIT_WINDOW.anchor, 'i32', p);\n  updateSelection(L);\n  updateCaret(L, 1);",
     note: 'invert the extend test so dragging resets the anchor'},
    {file: 'model',
     find: '  if (p < 0) p = 0;\n  if (p > len) p = len;',
     replace: '  if (p < 0) p = -1;\n  if (p > len) p = len;',
     note: 'low clamp stores -1 instead of 0'},
    {file: 'model',
     find: '  updateCaret(L, 1);\n  resetBlink(L);\n}',
     replace: '  updateCaret(L, 0);\n  resetBlink(L);\n}',
     note: 'caret update loses the sticky=1 flag'},
  ],
});
