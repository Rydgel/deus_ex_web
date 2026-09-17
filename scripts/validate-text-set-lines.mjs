/** Validate XTextWindow::SetLines (native 1558) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-set-lines.mjs'),
  metaExport: 'TEXT_SET_LINES_NATIVE',
  entry: 'textWindowSetLines',
  oracleFile: 'native-text-set-lines-oracle.py',
  section: 'setLines',
  resultKind: 'execVoid',
  metadataParams: ['newMinLines:int', 'newMaxLines:int'],  mutations: [
    {file: 'model',
     find: '  if (mn > mx) mn = mx;',
     replace: '  if (mn > mx) mx = mn;',
     note: 'min clamped UP to a smaller max inverted — max rises instead'},
    {file: 'model',
     find: '  let mn = newMinLines | 0;\n  let mx = newMaxLines | 0;\n  if (mn < 0) mn = 0;',
     replace: '  let mn = newMinLines | 0;\n  let mx = newMaxLines | 0;',
     note: 'negative min clamp dropped — -5 stores raw'},
    {file: 'model',
     find: '  L.write(L.base + TEXT_WINDOW.maxLines, \'i32\', mx);',
     replace: '  L.write(L.base + TEXT_WINDOW.maxLines, \'i32\', mn);',
     note: 'maxLines written with the min value'},
  ],

});
