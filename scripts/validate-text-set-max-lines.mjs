/** Validate XTextWindow::SetMaxLines (native 1560) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-set-max-lines.mjs'),
  metaExport: 'TEXT_SET_MAX_LINES_NATIVE',
  entry: 'textWindowSetMaxLines',
  oracleFile: 'native-text-set-max-lines-oracle.py',
  section: 'setMaxLines',
  resultKind: 'execVoid',
  metadataParams: ['newMaxLines:int'],  mutations: [
    {file: 'model',
     find: '  if (n < minLines) n = minLines;',
     replace: '  if (n > minLines) n = minLines;',
     note: 'clamp-up-to-min inverted — any max above min snaps to min'},
    {file: 'model',
     find: '  if (L.read(L.base + TEXT_WINDOW.maxLines, \'i32\') === n) return;',
     replace: '  if (L.read(L.base + TEXT_WINDOW.minLines, \'i32\') === n) return;',
     note: 'unchanged-guard reads minLines — equal max still rewrites'},
    {file: 'model',
     find: '  const minLines = L.read(L.base + TEXT_WINDOW.minLines, \'i32\');',
     replace: '  const minLines = L.read(L.base + TEXT_WINDOW.maxLines, \'i32\');',
     note: 'clamps against maxLines instead of minLines'},
  ],

});
