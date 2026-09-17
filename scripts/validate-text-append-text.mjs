/** Validate XTextWindow::AppendText (native 1551) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-append-text.mjs'),
  metaExport: 'TEXT_APPEND_TEXT_NATIVE',
  entry: 'textWindowAppendText',
  oracleFile: 'native-text-append-text-oracle.py',
  section: 'appendText',
  resultKind: 'execVoid',
  metadataParams: ['NewText:string'],  mutations: [
    {file: 'model',
     find: '    wcharCopy(L, L.read(str, \'u32\') + (num - 1) * 2, textPtr);',
     replace: '    wcharCopy(L, L.read(str, \'u32\') + num * 2, textPtr);',
     note: 'append lands past the old NUL — a hole stays in the stored text'},
    {file: 'model',
     find: '    const newNum = num + wcharLen(L, textPtr);',
     replace: '    const newNum = num + wcharLen(L, textPtr) + 1;',
     note: 'append over-counts num by one — the FString reports a phantom char'},
    {file: 'model',
     find: '    const n2 = L.read(str + 4, \'i32\');\n    setAcceleratorText(L, n2 !== 0 ? L.read(str, \'u32\') : emptyWString(L));',
     replace: '    setAcceleratorText(L, textPtr);',
     note: 'accelerator scans the appended argument instead of the stored text'},
  ],

});
