/** Validate XTextLogWindow::ClearLog (native 1571) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-clear-log.mjs'),
  metaExport: 'TEXT_CLEAR_LOG_NATIVE',
  entry: 'textLogWindowClearLog',
  oracleFile: 'native-text-clear-log-oracle.py',
  section: 'clearLog',
  resultKind: 'execVoid',
  metadataParams: [],  mutations: [
    {file: 'model',
     find: '  for (let i = 0; i < num; i += 1) {',
     replace: '  for (let i = 0; i < 0; i += 1) {',
     note: 'per-record teardown loop skipped — record strings are never freed'},
    {file: 'model',
     find: '  L.write(log + 4, \'i32\', 0);\n  L.write(log + 8, \'i32\', 0);',
     replace: '  L.write(log + 4, \'i32\', 0);',
     note: 'log max not zeroed — the array realloc uses stale capacity'},
    {file: 'model',
     find: '  farrayRealloc(L, log, TEXT_LOG.size);\n  refreshLogText(L);',
     replace: '  farrayRealloc(L, log, TEXT_LOG.size);',
     note: 'aggregate text rebuild dropped — this->text keeps the old join'},
  ],

});
