/** Validate UGC::EnableSmoothing (native 1210) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-enable-smoothing.mjs'),
  metaExport: 'GC_ENABLE_SMOOTHING_NATIVE',
  entry: 'gcEnableSmoothing',
  oracleFile: 'native-gc-enable-smoothing-oracle.py',
  section: 'enableSmoothing',
  resultKind: 'void',
  metadataParams: ['bNewSmoothing:bool'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: '(bNewSmoothing >>> 0)) & 1',
     replace: '(bNewSmoothing >>> 0)) & 3',
     note: 'argument mask widened to two bits'},
    {file: 'module',
     find: '  updatePolyFlagsFromFlags(L, L.base);\n',
     replace: '',
     note: 'drop the polyflags-from-flags helper call'},
    {file: 'model',
     find: '  smoothing: 0x1,',
     replace: '  smoothing: 0x2,',
     note: 'polyflags helper tests the drawing bit for noSmooth'},
  ],
});
