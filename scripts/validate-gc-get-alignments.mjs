/** Validate UGC::GetAlignments (native 1257) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-get-alignments.mjs'),
  metaExport: 'GC_GET_ALIGNMENTS_NATIVE',
  entry: 'gcGetAlignments',
  oracleFile: 'native-gc-get-alignments-oracle.py',
  section: 'getAlignments',
  resultKind: 'outs',
  metadataParams: ['HAlign:byte', 'VAlign:byte'],
  invoke: (fn, object, args, services, caseSpec, mod) => caseSpec.mode === 'method'
    ? mod.gcGetAlignmentsMethod(object, args[0] !== 0, args[1] !== 0, services)
    : fn(object, services),
  mutations: [
    {file: 'module',
     find: "hAlign: writeH ? L.read(L.base + GC.hAlign, 'u8') : null,",
     replace: "hAlign: writeH ? L.read(L.base + GC.vAlign, 'u8') : null,",
     note: 'first out gets the vAlign byte'},
    {file: 'module',
     find: 'writeH ?',
     replace: '!writeH ?',
     note: 'inverted null check on the first out pointer'},
    {file: 'model',
     find: '  hAlign: 0x94,',
     replace: '  hAlign: 0x95,',
     note: 'field offset off by one'},
  ],
});
