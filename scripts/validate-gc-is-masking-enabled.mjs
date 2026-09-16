/** Validate UGC::IsMaskingEnabled (native 1217) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-is-masking-enabled.mjs'),
  metaExport: 'GC_IS_MASKING_ENABLED_NATIVE',
  entry: 'gcIsMaskingEnabled',
  oracleFile: 'native-gc-is-masking-enabled-oracle.py',
  section: 'isMaskingEnabled',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:bool'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: '>>> 2) & 1',
     replace: '>>> 3) & 1',
     note: 'reads bit3 instead of bit2'},
    {file: 'module',
     find: '>>> 2) & 1;',
     replace: '>>> 2) & 2;',
     note: 'result mask reads bit3 after the shift'},
    {file: 'model',
     find: '  flags: 0x48,',
     replace: '  flags: 0x50,',
     note: 'flag word read at the textPolyFlags offset'},
  ],
});
