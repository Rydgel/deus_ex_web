/** Validate UGC::GetTileColor (native 1231) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-get-tile-color.mjs'),
  metaExport: 'GC_GET_TILE_COLOR_NATIVE',
  entry: 'gcGetTileColor',
  oracleFile: 'native-gc-get-tile-color-oracle.py',
  section: 'getTileColor',
  resultKind: 'execOut',
  metadataParams: ['tileColor:struct'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: "L.read(L.base + GC.tileColor, 'u32')",
     replace: "L.read(L.base + GC.textColor, 'u32')",
     note: 'getter reads the text color dword'},
    {file: 'module',
     find: "GC.tileColor, 'u32'",
     replace: "GC.tileColor, 'u8'",
     note: 'getter truncates the dword read to a byte'},
    {file: 'model',
     find: '  tileColor: 0x54,',
     replace: '  tileColor: 0x58,',
     note: 'field offset off by four'},
  ],
});
