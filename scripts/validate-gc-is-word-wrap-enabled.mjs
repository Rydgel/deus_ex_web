/** Validate UGC::IsWordWrapEnabled (native 1259) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-is-word-wrap-enabled.mjs'),
  metaExport: 'GC_IS_WORD_WRAP_ENABLED_NATIVE',
  entry: 'gcIsWordWrapEnabled',
  oracleFile: 'native-gc-is-word-wrap-enabled-oracle.py',
  section: 'isWordWrapEnabled',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:bool'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: '>>> 0) & 1',
     replace: '>>> 1) & 1',
     note: 'reads bit1 instead of bit0'},
    {file: 'module',
     find: 'GC.textFlags',
     replace: 'GC.flags',
     note: 'reads the draw flag word +0x48 instead of textFlags +0x98'},
    {file: 'model',
     find: '  textFlags: 0x98,',
     replace: '  textFlags: 0x48,',
     note: 'text flag word aliases the draw flag word'},
  ],
});
