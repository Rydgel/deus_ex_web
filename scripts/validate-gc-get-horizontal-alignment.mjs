/** Validate UGC::GetHorizontalAlignment (native 1253) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-get-horizontal-alignment.mjs'),
  metaExport: 'GC_GET_HORIZONTAL_ALIGNMENT_NATIVE',
  entry: 'gcGetHorizontalAlignment',
  oracleFile: 'native-gc-get-horizontal-alignment-oracle.py',
  section: 'getHorizontalAlignment',
  resultKind: 'execByte',
  metadataParams: ['ReturnValue:byte'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: "L.read(L.base + GC.hAlign, 'u8')",
     replace: "L.read(L.base + GC.vAlign, 'u8')",
     note: 'getter reads vAlign instead of hAlign'},
    {file: 'module',
     find: "GC.hAlign, 'u8'",
     replace: "GC.hAlign, 'i8'",
     note: 'getter sign-extends the byte instead of zero-extending'},
    {file: 'model',
     find: '  hAlign: 0x94,',
     replace: '  hAlign: 0x95,',
     note: 'field offset off by one'},
  ],
});
