/** Validate UGC::IsDrawingEnabled (native 1215) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-is-drawing-enabled.mjs'),
  metaExport: 'GC_IS_DRAWING_ENABLED_NATIVE',
  entry: 'gcIsDrawingEnabled',
  oracleFile: 'native-gc-is-drawing-enabled-oracle.py',
  section: 'isDrawingEnabled',
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
     find: '  flags: 0x48,',
     replace: '  flags: 0x4c,',
     note: 'flag word read at the polyFlags offset'},
  ],
});
