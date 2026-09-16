/** Validate XEditWindow::SetSelectedAreaTexture (native 1907) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-selected-area-texture.mjs'),
  metaExport: 'EDIT_SET_SELECTED_AREA_TEXTURE_NATIVE',
  entry: 'editWindowSetSelectedAreaTexture',
  oracleFile: 'native-edit-set-selected-area-texture-oracle.py',
  section: 'setSelectedAreaTexture',
  resultKind: 'void',
  metadataParams: ['NewTexture:object', 'NewColor:struct'],
  mutations: [
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.selTexture, 'u32', newTexture | 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.ipTexture, 'u32', newTexture | 0);",
     note: 'texture stored into the insertion-point texture field'},
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.selColor, 'u32', newColor | 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.selColor, 'u32', newTexture | 0);",
     note: 'colour field receives the texture argument'},
  ],
});
