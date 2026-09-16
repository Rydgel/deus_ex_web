/** Validate UGC::SetFonts (native 1245) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-fonts.mjs'),
  metaExport: 'GC_SET_FONTS_NATIVE',
  entry: 'gcSetFonts',
  oracleFile: 'native-gc-set-fonts-oracle.py',
  section: 'setFonts',
  resultKind: 'void',
  metadataParams: ['newNormalFont:object', 'newBoldFont:object'],
  invoke: (fn, object, args, services) => fn(object, args[0], args[1], services),
  mutations: [
    {file: 'module',
     find: "L.write(L.base + GC.boldFont, 'u32', newBoldFont >>> 0);",
     replace: "L.write(L.base + GC.boldFont, 'u32', newNormalFont >>> 0);",
     note: 'bold slot receives the normal font'},
    {file: 'module',
     find: "L.write(L.base + GC.normalFont, 'u32', newNormalFont >>> 0);",
     replace: "L.write(L.base + GC.boldFont, 'u32', newNormalFont >>> 0);",
     note: 'both stores land on boldFont'},
  ],
});
