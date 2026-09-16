/** Validate UGC::IsSmoothingEnabled (native 1211) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-is-smoothing-enabled.mjs'),
  metaExport: 'GC_IS_SMOOTHING_ENABLED_NATIVE',
  entry: 'gcIsSmoothingEnabled',
  oracleFile: 'native-gc-is-smoothing-enabled-oracle.py',
  section: 'isSmoothingEnabled',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:bool'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: '>>> 0) & 1',
     replace: '>>> 1) & 1',
     note: 'reads bit1 instead of bit0'},
    {file: 'module',
     find: '>>> 0) & 1;',
     replace: '>>> 0) & 2;',
     note: 'result mask widened to bit1'},
    {file: 'model',
     find: '  flags: 0x48,',
     replace: '  flags: 0x44,',
     note: 'flag word read at the style-byte offset'},
  ],
});
