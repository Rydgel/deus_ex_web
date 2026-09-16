/** Validate UGC::IsTranslucentTextEnabled (native 1248) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-is-translucent-text-enabled.mjs'),
  metaExport: 'GC_IS_TRANSLUCENT_TEXT_ENABLED_NATIVE',
  entry: 'gcIsTranslucentTextEnabled',
  oracleFile: 'native-gc-is-translucent-text-enabled-oracle.py',
  section: 'isTranslucentTextEnabled',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:bool'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: '>>> 5) & 1',
     replace: '>>> 4) & 1',
     note: 'reads bit4 instead of bit5'},
    {file: 'module',
     find: '>>> 5) & 1;',
     replace: '>>> 5) & 2;',
     note: 'result mask reads bit6 after the shift'},
    {file: 'model',
     find: '  flags: 0x48,',
     replace: '  flags: 0x4c,',
     note: 'flag word read at the polyFlags offset'},
  ],
});
