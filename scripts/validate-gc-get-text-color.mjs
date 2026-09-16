/** Validate UGC::GetTextColor (native 1241) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-get-text-color.mjs'),
  metaExport: 'GC_GET_TEXT_COLOR_NATIVE',
  entry: 'gcGetTextColor',
  oracleFile: 'native-gc-get-text-color-oracle.py',
  section: 'getTextColor',
  resultKind: 'execOut',
  metadataParams: ['TextColor:struct'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: "L.read(L.base + GC.textColor, 'u32')",
     replace: "L.read(L.base + GC.tileColor, 'u32')",
     note: 'getter reads the tile color dword'},
    {file: 'module',
     find: "GC.textColor, 'u32'",
     replace: "GC.textColor, 'u16'",
     note: 'getter truncates the dword read to a word'},
    {file: 'model',
     find: '  textColor: 0x68,',
     replace: '  textColor: 0x6c,',
     note: 'field offset off by four'},
  ],
});
