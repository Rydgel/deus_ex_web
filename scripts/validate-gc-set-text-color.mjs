/** Validate UGC::SetTextColor (native 1240) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-text-color.mjs'),
  metaExport: 'GC_SET_TEXT_COLOR_NATIVE',
  entry: 'gcSetTextColor',
  oracleFile: 'native-gc-set-text-color-oracle.py',
  section: 'setTextColor',
  resultKind: 'void',
  metadataParams: ['newTextColor:struct'],
  dllAssert: [{offset: 0x1005e3c0, hex: '101010101010703f'}],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: "L.write(L.base + GC.textFloats + 12, 'u32', 0);",
     replace: "L.write(L.base + GC.textFloats + 12, 'u32', 1);",
     note: 'the +0x78 lane stores 1 instead of 0'},
    {file: 'module',
     find: 'gcColorChannel(color >>> 16)',
     replace: 'gcColorChannel(color >>> 24)',
     note: 'third channel uses the wrong byte'},
    {file: 'model',
     find: '0x3f70101010101010n',
     replace: '0x3f80101010101010n',
     note: 'color scale constant corrupted'},
    {file: 'module',
     find: "L.write(L.base + GC.textColor, 'u32', color);",
     replace: "L.write(L.base + GC.tileColor, 'u32', color);",
     note: 'color dword lands on the tile field'},
  ],
});
