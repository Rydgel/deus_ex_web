/** Validate UGC::SetHorizontalAlignment (native 1252) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-horizontal-alignment.mjs'),
  metaExport: 'GC_SET_HORIZONTAL_ALIGNMENT_NATIVE',
  entry: 'gcSetHorizontalAlignment',
  oracleFile: 'native-gc-set-horizontal-alignment-oracle.py',
  section: 'setHorizontalAlignment',
  resultKind: 'void',
  metadataParams: ['newHAlign:byte'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: 'newHAlign & 0xff',
     replace: 'newHAlign & 0x7f',
     note: 'exec masks the evaluated slot with &0xff; mutating drops bit7'},
    {file: 'module',
     find: 'L.write(L.base + GC.hAlign',
     replace: 'L.write(L.base + GC.vAlign',
     note: 'store lands on vAlign instead of hAlign'},
    {file: 'model',
     find: '  hAlign: 0x94,',
     replace: '  hAlign: 0x95,',
     note: 'field offset off by one'},
  ],
});
