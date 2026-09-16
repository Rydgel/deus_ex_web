/** Validate XEditWindow::InsertText (native 1900) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-insert-text.mjs'),
  metaExport: 'EDIT_INSERT_TEXT_NATIVE',
  entry: 'editWindowInsertText',
  oracleFile: 'native-edit-insert-text-oracle.py',
  section: 'insertText',
  resultKind: 'int',
  metadataParams: ['InsertText:string', 'bUndo:bool', 'bSelect:bool', 'ReturnValue:bool'],
  mutations: [
    {file: 'model',
     find: "      if (L.read(p, 'u16') === 0x6e) { // 'n'\n        L.write(w, 'u16', 0xa);",
     replace: "      if (L.read(p, 'u16') === 0x6e) { // 'n'\n        L.write(w, 'u16', 0xd);",
     note: 'convertPipes emits CR instead of LF for |n'},
    {file: 'model',
     find: '    if (((w - run) & ~1) >= 0x800) {',
     replace: '    if (((w - run) & ~1) >= 0x400) {',
     note: 'run-buffer flush threshold halved (0x400 instead of 0x800 bytes)'},
    {file: 'model',
     find: '  if (accepted === 0) {',
     replace: '  if (accepted !== 0) {',
     note: 'insertTextVirtual rejects when filterText accepts'},
  ],
});
