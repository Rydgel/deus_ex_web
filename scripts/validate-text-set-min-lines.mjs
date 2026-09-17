/** Validate XTextWindow::SetMinLines (native 1559) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-set-min-lines.mjs'),
  metaExport: 'TEXT_SET_MIN_LINES_NATIVE',
  entry: 'textWindowSetMinLines',
  oracleFile: 'native-text-set-min-lines-oracle.py',
  section: 'setMinLines',
  resultKind: 'execVoid',
  metadataParams: ['newMinLines:int'],  mutations: [
    {file: 'model',
     find: '  if (n > maxLines) n = maxLines;',
     replace: '  if (n < maxLines) n = maxLines;',
     note: 'clamp-to-max inverted — any min below max snaps to max'},
    {file: 'model',
     find: '  let n = newMinLines | 0;\n  if (n < 0) n = 0;',
     replace: '  let n = newMinLines | 0;',
     note: 'negative clamp dropped — -4 stores raw'},
    {file: 'model',
     find: '  const maxLines = L.read(L.base + TEXT_WINDOW.maxLines, \'i32\');',
     replace: '  const maxLines = L.read(L.base + TEXT_WINDOW.minLines, \'i32\');',
     note: 'clamps against minLines instead of maxLines'},
  ],

});
