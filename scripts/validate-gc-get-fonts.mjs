/** Validate UGC::GetFonts (native 1246) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-get-fonts.mjs'),
  metaExport: 'GC_GET_FONTS_NATIVE',
  entry: 'gcGetFonts',
  oracleFile: 'native-gc-get-fonts-oracle.py',
  section: 'getFonts',
  resultKind: 'outs',
  metadataParams: ['normalFont:object', 'boldFont:object'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: 'normalFont: L.read(L.base + GC.normalFont',
     replace: 'normalFont: L.read(L.base + GC.boldFont',
     note: 'first out gets the bold font'},
    {file: 'module',
     find: 'boldFont: L.read(L.base + GC.boldFont',
     replace: 'boldFont: L.read(L.base + GC.unknown84',
     note: 'second out reads the wrong field'},
    {file: 'model',
     find: '  normalFont: 0x7c,',
     replace: '  normalFont: 0x80,',
     note: 'field offset off by four'},
  ],
});
