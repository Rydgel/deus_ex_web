/** Validate UGC::SetVerticalAlignment (native 1254) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-vertical-alignment.mjs'),
  metaExport: 'GC_SET_VERTICAL_ALIGNMENT_NATIVE',
  entry: 'gcSetVerticalAlignment',
  oracleFile: 'native-gc-set-vertical-alignment-oracle.py',
  section: 'setVerticalAlignment',
  resultKind: 'void',
  metadataParams: ['newVAlign:byte'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: 'newVAlign & 0xff',
     replace: 'newVAlign & 0x7f',
     note: 'exec masks the evaluated slot with &0xff; mutating drops bit7'},
    {file: 'module',
     find: 'L.write(L.base + GC.vAlign',
     replace: 'L.write(L.base + GC.hAlign',
     note: 'store lands on hAlign instead of vAlign'},
    {file: 'model',
     find: '  vAlign: 0x95,',
     replace: '  vAlign: 0x94,',
     note: 'field offset off by one'},
  ],
});
