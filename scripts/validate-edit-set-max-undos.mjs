/** Validate XEditWindow::SetMaxUndos (native 1896) vs the oracle. */
import path from 'node:path';
import {runEditValidator} from './editwindow-validator-lib.mjs';

await runEditValidator({
  moduleFile: path.resolve('src/runtime/script-edit-set-max-undos.mjs'),
  metaExport: 'EDIT_SET_MAX_UNDOS_NATIVE',
  entry: 'editWindowSetMaxUndos',
  oracleFile: 'native-edit-set-max-undos-oracle.py',
  section: 'setMaxUndos',
  resultKind: 'void',
  metadataParams: ['newMaxUndos:int'],
  mutations: [
    {file: 'module',
     find: '  if (n < 0) n = -1;',
     replace: '  if (n < 0) n = 0;',
     note: 'negative clamp lands on 0 instead of the -1 unlimited sentinel'},
    {file: 'model',
     find: '  if (saved < 0) saved = -1;',
     replace: '  if (saved < 0) saved = 0;',
     note: 'savedUndoPos underflow clamps to 0 instead of -1'},
    {file: 'model',
     find: '  const excess = num - maxUndos;',
     replace: '  const excess = num - maxUndos + 1;',
     note: 'trim destroys one record too many'},
  ],
});
