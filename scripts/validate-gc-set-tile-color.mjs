/** Validate UGC::SetTileColor (native 1230) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-tile-color.mjs'),
  metaExport: 'GC_SET_TILE_COLOR_NATIVE',
  entry: 'gcSetTileColor',
  oracleFile: 'native-gc-set-tile-color-oracle.py',
  section: 'setTileColor',
  resultKind: 'void',
  metadataParams: ['newTileColor:struct'],
  dllAssert: [{offset: 0x1005e3c0, hex: '101010101010703f'}],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: "L.write(L.base + GC.tileFloats + 12, 'u32', 0);",
     replace: "L.write(L.base + GC.tileFloats + 12, 'u32', 1);",
     note: 'the +0x64 lane stores 1 instead of 0'},
    {file: 'module',
     find: 'gcColorChannel(color >>> 8)',
     replace: 'gcColorChannel(color >>> 4)',
     note: 'second channel uses the wrong byte'},
    {file: 'model',
     find: '0x3f70101010101010n',
     replace: '0x3f80101010101010n',
     note: 'color scale constant corrupted'},
    {file: 'module',
     find: "L.write(L.base + GC.tileColor, 'u32', color);",
     replace: "L.write(L.base + GC.textColor, 'u32', color);",
     note: 'color dword lands on the text field'},
  ],
});
