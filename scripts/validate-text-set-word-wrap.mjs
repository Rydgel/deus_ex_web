/** Validate XTextWindow::SetWordWrap (native 1555) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-set-word-wrap.mjs'),
  metaExport: 'TEXT_SET_WORD_WRAP_NATIVE',
  entry: 'textWindowSetWordWrap',
  oracleFile: 'native-text-set-word-wrap-oracle.py',
  section: 'setWordWrap',
  resultKind: 'execVoid',
  metadataParams: ['bNewWordWrap:bool'],
  mutations: [
    {file: 'model',
     find: '  if ((flags & TEXT_FLAGS.wordWrap) === (bWrap >>> 0)) return;',
     replace: '  if ((flags & TEXT_FLAGS.wordWrap) === ((bWrap >>> 0) & 1)) return;',
     note: 'guard compares the masked bit — raw arg 2/3 still writes'},
    {file: 'model',
     find: "    (flags ^ ((flags ^ bWrap) & TEXT_FLAGS.wordWrap)) >>> 0);",
     replace: "    (flags ^ ((flags ^ bWrap) & 3)) >>> 0);",
     note: 'toggle mask widened to two bits — bit1 flips too'},
    {file: 'model',
     find: '  askParentForReconfigure(L);\n}\n\n// 0x10046050',
     replace: '}\n\n// 0x10046050',
     note: 'reconfigure call dropped after the flag write'},
  ],
});
