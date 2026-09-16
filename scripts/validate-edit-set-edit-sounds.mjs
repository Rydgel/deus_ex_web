/** Validate XEditWindow::SetEditSounds (native 1920) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-edit-sounds.mjs'),
  metaExport: 'EDIT_SET_EDIT_SOUNDS_NATIVE',
  entry: 'editWindowSetEditSounds',
  oracleFile: 'native-edit-set-edit-sounds-oracle.py',
  section: 'setEditSounds',
  resultKind: 'void',
  metadataParams: ['typeSound:object', 'deleteSound:object', 'enterSound:object', 'moveSound:object'],
  mutations: [
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.sound0, 'u32', typeSound | 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.sound3, 'u32', typeSound | 0);",
     note: 'typeSound stored into the moveSound field'},
    {file: 'module',
     find: "  L.write(L.base + EDIT_WINDOW.sound1, 'u32', deleteSound | 0);\n  L.write(L.base + EDIT_WINDOW.sound2, 'u32', enterSound | 0);",
     replace: "  L.write(L.base + EDIT_WINDOW.sound1, 'u32', enterSound | 0);\n  L.write(L.base + EDIT_WINDOW.sound2, 'u32', deleteSound | 0);",
     note: 'deleteSound and enterSound swapped'},
  ],
});
