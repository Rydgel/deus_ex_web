/** Validate XTextWindow::GetTextLength (native 1553) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-get-text-length.mjs'),
  metaExport: 'TEXT_GET_TEXT_LENGTH_NATIVE',
  entry: 'textWindowGetTextLength',
  oracleFile: 'native-text-get-text-length-oracle.py',
  section: 'getTextLength',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:int'],
  invoke: (fn, object, args, services, spec, heap, cells) =>
    fn(object, cells.out, services),  mutations: [
    {file: 'model',
     find: '  L.write(out, \'i32\', num !== 0 ? num - 1 : 0);',
     replace: '  L.write(out, \'i32\', num);',
     note: 'returns num (count includes the terminator)'},
    {file: 'model',
     find: '  L.write(out, \'i32\', num !== 0 ? num - 1 : 0);',
     replace: '  L.write(out, \'i32\', num - 1);',
     note: 'unconditional num-1 — empty text reports -1'},
    {file: 'model',
     find: '  const num = L.read(L.base + TEXT_WINDOW.textNum, \'i32\');\n  L.write(out, \'i32\', num !== 0 ? num - 1 : 0);',
     replace: '  const num = L.read(L.base + TEXT_WINDOW.textMax, \'i32\');\n  L.write(out, \'i32\', num !== 0 ? num - 1 : 0);',
     note: 'reads the capacity field instead of the count'},
  ],

});
