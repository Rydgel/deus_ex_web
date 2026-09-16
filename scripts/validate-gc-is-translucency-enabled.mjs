/** Validate UGC::IsTranslucencyEnabled (native 1219) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-is-translucency-enabled.mjs'),
  metaExport: 'GC_IS_TRANSLUCENCY_ENABLED_NATIVE',
  entry: 'gcIsTranslucencyEnabled',
  oracleFile: 'native-gc-is-translucency-enabled-oracle.py',
  section: 'isTranslucencyEnabled',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:bool'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: '>>> 3) & 1',
     replace: '>>> 4) & 1',
     note: 'reads bit4 instead of bit3'},
    {file: 'module',
     find: '>>> 3) & 1;',
     replace: '>>> 3) & 2;',
     note: 'result mask reads bit4 after the shift'},
    {file: 'model',
     find: '  flags: 0x48,',
     replace: '  flags: 0x44,',
     note: 'flag word read at the style-byte offset'},
  ],
});
