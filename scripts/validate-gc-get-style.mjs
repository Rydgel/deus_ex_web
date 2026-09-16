/** Validate UGC::GetStyle (native 1213) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-get-style.mjs'),
  metaExport: 'GC_GET_STYLE_NATIVE',
  entry: 'gcGetStyle',
  oracleFile: 'native-gc-get-style-oracle.py',
  section: 'getStyle',
  resultKind: 'execByte',
  metadataParams: ['ReturnValue:byte'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: "L.read(L.base + GC.style, 'u8')",
     replace: "L.read(L.base + GC.hAlign, 'u8')",
     note: 'getter reads the hAlign byte instead of style'},
    {file: 'module',
     find: "GC.style, 'u8'",
     replace: "GC.style, 'u16'",
     note: 'getter widens the byte read to a word'},
    {file: 'model',
     find: '  style: 0x44,',
     replace: '  style: 0x45,',
     note: 'style field offset off by one'},
  ],
});
