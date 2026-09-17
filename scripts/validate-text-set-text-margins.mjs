/** Validate XTextWindow::SetTextMargins (native 1557) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-set-text-margins.mjs'),
  metaExport: 'TEXT_SET_TEXT_MARGINS_NATIVE',
  entry: 'textWindowSetTextMargins',
  oracleFile: 'native-text-set-text-margins-oracle.py',
  section: 'setTextMargins',
  resultKind: 'execVoid',
  metadataParams: ['newHMargin:float', 'newVMargin:float'],  mutations: [
    {file: 'model',
     find: '  const same = fcompC3(L.read(L.base + TEXT_WINDOW.hMargin, \'u32\'), hBits)\n    && fcompC3(L.read(L.base + TEXT_WINDOW.vMargin, \'u32\'), vBits);',
     replace: '  const same = L.read(L.base + TEXT_WINDOW.hMargin, \'u32\') === hBits\n    && L.read(L.base + TEXT_WINDOW.vMargin, \'u32\') === vBits;',
     note: 'unordered==equal lost — a NaN arg no longer suppresses its compare'},
    {file: 'model',
     find: '    && fcompC3(L.read(L.base + TEXT_WINDOW.vMargin, \'u32\'), vBits);',
     replace: '    || fcompC3(L.read(L.base + TEXT_WINDOW.vMargin, \'u32\'), vBits);',
     note: 'guard ORs — one equal margin suppresses the whole write'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.hMargin, \'u32\', hBits);',
     replace: '  L.write(L.base + TEXT_WINDOW.vMargin, \'u32\', hBits);',
     note: 'h arg written to the vMargin slot'},
  ],

});
