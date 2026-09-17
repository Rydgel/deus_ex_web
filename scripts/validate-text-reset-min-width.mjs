/** Validate XTextWindow::ResetMinWidth (native 1563) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-reset-min-width.mjs'),
  metaExport: 'TEXT_RESET_MIN_WIDTH_NATIVE',
  entry: 'textWindowResetMinWidth',
  oracleFile: 'native-text-reset-min-width-oracle.py',
  section: 'resetMinWidth',
  resultKind: 'execVoid',
  metadataParams: [],  mutations: [
    {file: 'model',
     find: '  if (fcompC0C3(L.read(L.base + TEXT_WINDOW.minWidth, \'u32\'), 0)) return;',
     replace: '  if (fcompC3(L.read(L.base + TEXT_WINDOW.minWidth, \'u32\'), 0)) return;',
     note: 'guard narrows to == — negative fields now reset'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.minWidth, \'u32\', 0);',
     replace: '  L.write(L.base + TEXT_WINDOW.minWidth, \'u32\', 0x80000000);',
     note: 'reset writes -0.0f instead of +0.0f'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.minWidth, \'u32\', 0);\n  askParentForReconfigure(L);',
     replace: '  L.write(L.base + TEXT_WINDOW.minWidth, \'u32\', 0);',
     note: 'reconfigure dropped after the reset write'},
  ],

});
