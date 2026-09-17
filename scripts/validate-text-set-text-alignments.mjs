/** Validate XTextWindow::SetTextAlignments (native 1556) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-set-text-alignments.mjs'),
  metaExport: 'TEXT_SET_TEXT_ALIGNMENTS_NATIVE',
  entry: 'textWindowSetTextAlignments',
  oracleFile: 'native-text-set-text-alignments-oracle.py',
  section: 'setTextAlignments',
  resultKind: 'execVoid',
  metadataParams: ['newHAlign:byte', 'newVAlign:byte'],  mutations: [
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.hAlign, \'u8\', newHAlign);',
     replace: '  L.write(L.base + TEXT_WINDOW.vAlign, \'u8\', newHAlign);',
     note: 'hAlign written to the vAlign byte — hAlign never updates'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.vAlign, \'u8\', newVAlign);\n}',
     replace: '}',
     note: 'vAlign store dropped — the field keeps its old byte'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.vAlign, \'u8\', newVAlign);\n}',
     replace: '  L.write(L.base + TEXT_WINDOW.vAlign, \'u8\', newVAlign);\n  askParentForReconfigure(L);\n}',
     note: 'phantom reconfigure — the real body never calls it'},
  ],

});
