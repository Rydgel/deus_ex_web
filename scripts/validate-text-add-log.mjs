/** Validate XTextLogWindow::AddLog (native 1570) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-add-log.mjs'),
  metaExport: 'TEXT_ADD_LOG_NATIVE',
  entry: 'textLogWindowAddLog',
  oracleFile: 'native-text-add-log-oracle.py',
  section: 'addLog',
  resultKind: 'execVoid',
  metadataParams: ['NewText:string', 'linecol:struct'],  mutations: [
    {file: 'model',
     find: '  L.write(rec + TEXT_LOG.expire, \'f32\', now + timeout);',
     replace: '  L.write(rec + TEXT_LOG.expire, \'f32\', now);',
     note: 'expire drops the timeout — lines never age out'},
    {file: 'model',
     find: '  if (L.read(recText + 4, \'i32\') !== (textPtr >>> 0)) {',
     replace: '  if (L.read(recText + 4, \'i32\') === (textPtr >>> 0)) {',
     note: 'record text assign guard inverted — the line stores no text'},
    {file: 'model',
     find: '  L.write(rec + TEXT_LOG.color, \'u32\', color >>> 0);\n  refreshLogText(L);',
     replace: '  L.write(rec + TEXT_LOG.color, \'u32\', color >>> 0);',
     note: 'aggregate text rebuild dropped — this->text goes stale'},
  ],

});
