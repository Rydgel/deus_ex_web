/** Validate XEditWindow::SetSelectedAreaTextColor (native 1908) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-selected-area-text-color.mjs'),
  metaExport: 'EDIT_SET_SELECTED_AREA_TEXT_COLOR_NATIVE',
  entry: 'editWindowSetSelectedAreaTextColor',
  oracleFile: 'native-edit-set-selected-area-text-color-oracle.py',
  section: 'setSelectedAreaTextColor',
  resultKind: 'void',
  metadataParams: ['NewColor:struct'],
  mutations: [
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.selTextColor, 'u32', newColor | 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.selColor, 'u32', newColor | 0);",
     note: 'colour stored into the selected-area fill colour field'},
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.selTextColor, 'u32', newColor | 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.selTextColor, 'u32', (newColor | 0) >>> 8);",
     note: 'colour shifted right by one byte before storing'},
  ],
});
