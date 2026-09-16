/** Validate UGC::SetAlignments (native 1256) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-alignments.mjs'),
  metaExport: 'GC_SET_ALIGNMENTS_NATIVE',
  entry: 'gcSetAlignments',
  oracleFile: 'native-gc-set-alignments-oracle.py',
  section: 'setAlignments',
  resultKind: 'void',
  metadataParams: ['newHAlign:byte', 'newVAlign:byte'],
  invoke: (fn, object, args, services) => fn(object, args[0], args[1], services),
  mutations: [
    {file: 'module',
     find: "  L.write(L.base + GC.vAlign, 'u8', newVAlign & 0xff);\n",
     replace: '',
     note: 'drop the vAlign store'},
    {file: 'module',
     find: "L.write(L.base + GC.hAlign, 'u8', newHAlign & 0xff);",
     replace: "L.write(L.base + GC.vAlign, 'u8', newHAlign & 0xff);",
     note: 'both args land on vAlign'},
    {file: 'module',
     find: 'newVAlign & 0xff',
     replace: 'newVAlign & 0x7f',
     note: 'second arg mask drops bit7'},
  ],
});
