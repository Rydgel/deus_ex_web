/** Validate UGC::SetFont (native 1242) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-font.mjs'),
  metaExport: 'GC_SET_FONT_NATIVE',
  entry: 'gcSetFont',
  oracleFile: 'native-gc-set-font-oracle.py',
  section: 'setFont',
  resultKind: 'void',
  metadataParams: ['NewFont:object'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: "  L.write(L.base + GC.boldFont, 'u32', newFont >>> 0);\n",
     replace: '',
     note: 'drop the boldFont store (exec pushes the arg twice)'},
    {file: 'module',
     find: "L.write(L.base + GC.normalFont, 'u32', newFont >>> 0);",
     replace: "L.write(L.base + GC.boldFont, 'u32', newFont >>> 0);",
     note: 'both stores land on boldFont'},
    {file: 'module',
     find: 'newFont >>> 0);\n  L.write(L.base + GC.boldFont',
     replace: '(newFont >>> 0) ^ 1);\n  L.write(L.base + GC.boldFont',
     note: 'first store corrupts the pointer'},
  ],
});
