/** Validate UGC::IsSpecialTextEnabled (native 1261) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-is-special-text-enabled.mjs'),
  metaExport: 'GC_IS_SPECIAL_TEXT_ENABLED_NATIVE',
  entry: 'gcIsSpecialTextEnabled',
  oracleFile: 'native-gc-is-special-text-enabled-oracle.py',
  section: 'isSpecialTextEnabled',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:bool'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: '>>> 1) & 1',
     replace: '>>> 2) & 1',
     note: 'reads bit2 instead of bit1'},
    {file: 'module',
     find: '>>> 1) & 1;',
     replace: '>>> 1) & 2;',
     note: 'result mask reads bit2 after the shift'},
    {file: 'model',
     find: '  textFlags: 0x98,',
     replace: '  textFlags: 0x50,',
     note: 'text flag word read at the textPolyFlags offset'},
  ],
});
