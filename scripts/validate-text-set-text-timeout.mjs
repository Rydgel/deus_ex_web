/** Validate XTextLogWindow::SetTextTimeout (native 1572) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-set-text-timeout.mjs'),
  metaExport: 'TEXT_SET_TEXT_TIMEOUT_NATIVE',
  entry: 'textLogWindowSetTextTimeout',
  oracleFile: 'native-text-set-text-timeout-oracle.py',
  section: 'setTextTimeout',
  resultKind: 'execVoid',
  metadataParams: ['newTimeout:float'],  mutations: [
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.lineSpacing, \'u32\', bits >>> 0);',
     replace: '  L.write(L.base + TEXT_WINDOW.logFlags, \'u32\', bits >>> 0);',
     note: 'timeout written to logFlags instead of the shared spacing slot'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.lineSpacing, \'u32\', bits >>> 0);\n}',
     replace: '  L.write(L.base + TEXT_WINDOW.lineSpacing, \'u32\', bits >>> 0);\n  askParentForReconfigure(L);\n}',
     note: 'phantom reconfigure — the real body is a bare store'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.lineSpacing, \'u32\', bits >>> 0);',
     replace: '  L.write(L.base + TEXT_WINDOW.lineSpacing, \'u32\', 0);',
     note: 'timeout zeroed — the marshalled float is ignored'},
  ],

});
