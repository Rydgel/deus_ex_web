/** Validate XEditWindow::SetSelectedArea (native 1883) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-selected-area.mjs'),
  metaExport: 'EDIT_SET_SELECTED_AREA_NATIVE',
  entry: 'editWindowSetSelectedArea',
  oracleFile: 'native-edit-set-selected-area-oracle.py',
  section: 'setSelectedArea',
  resultKind: 'void',
  metadataParams: ['startPos:int', 'Count:int'],
  mutations: [
    {file: 'module',
     find: "    L.read(L.base + EDIT_WINDOW.stateFlags, 'i32') & ~4);",
     replace: "    L.read(L.base + EDIT_WINDOW.stateFlags, 'i32') & ~2);",
     note: 'clears the wrong state bit (caret-visible instead of word-select)'},
    {file: 'module',
     find: '  setInsertionPointCore(L, (startPos | 0) + (count | 0), 1);',
     replace: '  setInsertionPointCore(L, (startPos | 0) + (count | 0), 0);',
     note: 'second call does not extend, so the selection never forms'},
    {file: 'module',
     find: '  setInsertionPointCore(L, (startPos | 0) + (count | 0), 1);',
     replace: '  setInsertionPointCore(L, (startPos | 0) + (count | 0) + 1, 1);',
     note: 'selection end off by one'},
  ],
});
