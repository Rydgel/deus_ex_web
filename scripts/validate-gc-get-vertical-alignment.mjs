/** Validate UGC::GetVerticalAlignment (native 1255) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-get-vertical-alignment.mjs'),
  metaExport: 'GC_GET_VERTICAL_ALIGNMENT_NATIVE',
  entry: 'gcGetVerticalAlignment',
  oracleFile: 'native-gc-get-vertical-alignment-oracle.py',
  section: 'getVerticalAlignment',
  resultKind: 'execByte',
  metadataParams: ['ReturnValue:byte'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: "L.read(L.base + GC.vAlign, 'u8')",
     replace: "L.read(L.base + GC.hAlign, 'u8')",
     note: 'getter reads hAlign instead of vAlign'},
    {file: 'module',
     find: "GC.vAlign, 'u8'",
     replace: "GC.vAlign, 'i8'",
     note: 'getter sign-extends the byte instead of zero-extending'},
    {file: 'model',
     find: '  vAlign: 0x95,',
     replace: '  vAlign: 0x94,',
     note: 'field offset off by one'},
  ],
});
