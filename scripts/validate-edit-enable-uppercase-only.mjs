/** Validate XEditWindow::EnableUppercaseOnly (native 1889) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-enable-uppercase-only.mjs'),
  metaExport: 'EDIT_ENABLE_UPPERCASE_ONLY_NATIVE',
  entry: 'editWindowEnableUppercaseOnly',
  oracleFile: 'native-edit-enable-uppercase-only-oracle.py',
  section: 'enableUppercaseOnly',
  resultKind: 'void',
  metadataParams: ['bUppercase:bool'],
  mutations: [
    {file: 'module',
     find: '  if (((flags >>> 2) & 1) === arg) return;',
     replace: '  if (((flags >>> 2) & 1) === (arg & 1)) return;',
     note: 'unchanged-compare masks the argument to one bit'},
    {file: 'module',
     find: '  if ((next & EDIT_FLAGS.uppercase) === 0) return;',
     replace: '  if ((next & EDIT_FLAGS.singleLine) === 0) return;',
     note: 'enable gate tests bit1 instead of bit2'},
    {file: 'model',
     find: '    if (ch >= 0x61 && ch <= 0x7a) L.write(chAddr, \'u16\', ch - 0x20);',
     replace: '    if (ch >= 0x61 && ch <= 0x79) L.write(chAddr, \'u16\', ch - 0x20);',
     note: 'uppercase range stops at y instead of z'},
  ],
});
