/** Validate XTextWindow::ResetLines (native 1561) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-reset-lines.mjs'),
  metaExport: 'TEXT_RESET_LINES_NATIVE',
  entry: 'textWindowResetLines',
  oracleFile: 'native-text-reset-lines-oracle.py',
  section: 'resetLines',
  resultKind: 'execVoid',
  metadataParams: [],  mutations: [
    {file: 'model',
     find: '  if (L.read(L.base + TEXT_WINDOW.minLines, \'i32\') < 0\n      && L.read(L.base + TEXT_WINDOW.maxLines, \'i32\') < 0) return;',
     replace: '  if (L.read(L.base + TEXT_WINDOW.minLines, \'i32\') < 0\n      || L.read(L.base + TEXT_WINDOW.maxLines, \'i32\') < 0) return;',
     note: 'guard ORs — one negative field suppresses the reset'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.minLines, \'i32\', -1);',
     replace: '  L.write(L.base + TEXT_WINDOW.minLines, \'i32\', 0);',
     note: 'reset writes 0 instead of -1 to minLines'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.maxLines, \'i32\', -1);',
     replace: '  L.write(L.base + TEXT_WINDOW.minLines, \'i32\', -1);',
     note: 'maxLines reset lands on the minLines field'},
  ],

});
