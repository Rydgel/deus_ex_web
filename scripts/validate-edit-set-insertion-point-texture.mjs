/** Validate XEditWindow::SetInsertionPointTexture (native 1905) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-insertion-point-texture.mjs'),
  metaExport: 'EDIT_SET_INSERTION_POINT_TEXTURE_NATIVE',
  entry: 'editWindowSetInsertionPointTexture',
  oracleFile: 'native-edit-set-insertion-point-texture-oracle.py',
  section: 'setInsertionPointTexture',
  resultKind: 'void',
  metadataParams: ['NewTexture:object', 'NewColor:struct'],
  mutations: [
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.ipTexture, 'u32', newTexture | 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.selTexture, 'u32', newTexture | 0);",
     note: 'texture stored into the selected-area texture field'},
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.ipColor, 'u32', newColor | 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.ipColor, 'u32', newTexture | 0);",
     note: 'colour field receives the texture argument'},
    {file: 'model',
     find: "    requireService(L, 'updateCaret')(L.object, L.base, sticky | 0), 'updateCaret') | 0;",
     replace: "    requireService(L, 'updateCaret')(L.object, L.base, (sticky | 0) + 1), 'updateCaret') | 0;",
     note: 'updateCaret invoked with sticky+1'},
  ],
});
