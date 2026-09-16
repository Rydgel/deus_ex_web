/** Validate XEditWindow::Paste (native 1917) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-paste.mjs'),
  metaExport: 'EDIT_PASTE_NATIVE',
  entry: 'editWindowPaste',
  oracleFile: 'native-edit-paste-oracle.py',
  section: 'paste',
  resultKind: 'void',
  metadataParams: [],
  mutations: [
    {file: 'model',
     find: "  const src = num !== 0 ? L.read(clip, 'u32') : emptyWString(L);",
     replace: "  const src = num !== 0 ? L.read(L.base + EDIT_WINDOW.text, 'u32') : emptyWString(L);",
     note: 'paste inserts the window text instead of the clipboard'},
    {file: 'module',
     find: '  pasteEdit(L, 1, 0);',
     replace: '  pasteEdit(L, 0, 0);',
     note: 'Paste loses the bKeepUndo=1 flag so the insert clears history'},
    {file: 'module',
     find: '  pasteEdit(L, 1, 0);',
     replace: '  pasteEdit(L, 1, 1);',
     note: 'Paste extends the selection (bExtend=1)'},
  ],
});
