/** Validate XEditWindow::SetEditCursor (native 1909) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-edit-cursor.mjs'),
  metaExport: 'EDIT_SET_EDIT_CURSOR_NATIVE',
  entry: 'editWindowSetEditCursor',
  oracleFile: 'native-edit-set-edit-cursor-oracle.py',
  section: 'setEditCursor',
  resultKind: 'void',
  metadataParams: ['newCursor:object', 'newCursorShadow:object', 'NewColor:struct'],
  mutations: [
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.cursor0, 'u32', newCursor | 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.cursor2, 'u32', newCursor | 0);",
     note: 'cursor object stored into the colour field'},
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.cursor1, 'u32', newCursorShadow | 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.cursor1, 'u32', newCursor | 0);",
     note: 'shadow field receives the cursor argument'},
  ],
});
