/** Validate UGC::SetNormalFont (native 1243) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-normal-font.mjs'),
  metaExport: 'GC_SET_NORMAL_FONT_NATIVE',
  entry: 'gcSetNormalFont',
  oracleFile: 'native-gc-set-normal-font-oracle.py',
  section: 'setNormalFont',
  resultKind: 'void',
  metadataParams: ['newNormalFont:object'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: "L.write(L.base + GC.normalFont, 'u32', newNormalFont >>> 0);",
     replace: "L.write(L.base + GC.boldFont, 'u32', newNormalFont >>> 0);",
     note: 'store lands on boldFont instead of normalFont'},
    {file: 'module',
     find: 'newNormalFont >>> 0);',
     replace: '(newNormalFont >>> 0) ^ 1);',
     note: 'stored pointer corrupted'},
    {file: 'model',
     find: '  normalFont: 0x7c,',
     replace: '  normalFont: 0x80,',
     note: 'field offset off by four'},
  ],
});
