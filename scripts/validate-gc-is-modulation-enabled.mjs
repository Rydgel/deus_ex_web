/** Validate UGC::IsModulationEnabled (native 1221) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-is-modulation-enabled.mjs'),
  metaExport: 'GC_IS_MODULATION_ENABLED_NATIVE',
  entry: 'gcIsModulationEnabled',
  oracleFile: 'native-gc-is-modulation-enabled-oracle.py',
  section: 'isModulationEnabled',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:bool'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: '>>> 4) & 1',
     replace: '>>> 5) & 1',
     note: 'reads bit5 instead of bit4'},
    {file: 'module',
     find: '>>> 4) & 1;',
     replace: '>>> 4) & 2;',
     note: 'result mask reads bit5 after the shift'},
    {file: 'model',
     find: '  flags: 0x48,',
     replace: '  flags: 0x98,',
     note: 'flag word read at the textFlags offset'},
  ],
});
