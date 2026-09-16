/** Validate UGC::SetBoldFont (native 1244) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-bold-font.mjs'),
  metaExport: 'GC_SET_BOLD_FONT_NATIVE',
  entry: 'gcSetBoldFont',
  oracleFile: 'native-gc-set-bold-font-oracle.py',
  section: 'setBoldFont',
  resultKind: 'void',
  metadataParams: ['newBoldFont:object'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: "L.write(L.base + GC.boldFont, 'u32', newBoldFont >>> 0);",
     replace: "L.write(L.base + GC.normalFont, 'u32', newBoldFont >>> 0);",
     note: 'store lands on normalFont instead of boldFont'},
    {file: 'module',
     find: 'newBoldFont >>> 0);',
     replace: '(newBoldFont >>> 0) ^ 1);',
     note: 'stored pointer corrupted'},
    {file: 'model',
     find: '  boldFont: 0x80,',
     replace: '  boldFont: 0x7c,',
     note: 'field offset off by four'},
  ],
});
