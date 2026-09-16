/** Validate UGC::PopGC (native 1272) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-pop-gc.mjs'),
  metaExport: 'GC_POP_GC_NATIVE',
  entry: 'gcPopGC',
  oracleFile: 'native-gc-pop-gc-oracle.py',
  section: 'popGC',
  resultKind: 'void',
  metadataParams: ['gcNum:int'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  extraFiles: {copyGC: path.resolve('src/runtime/script-gc-copy-gc.mjs')},
  mutations: [
    {file: 'module',
     find: 'if (nodeDepth < n) break;',
     replace: 'if (nodeDepth <= n) break;',
     note: 'walk stops before the node whose depth equals n'},
    {file: 'module',
     find: "free ? L.read(free + GC.depth, 'i32') + 1 : 1",
     replace: "free ? L.read(free + GC.depth, 'i32') : 1",
     note: 'free-list counter no longer continues past the old head'},
    {file: 'module',
     find: '    last = node;',
     replace: '    if (!last) last = node;',
     note: 'restores state from the first unlinked node instead of the last'},
    {file: 'module',
     find: "const target = top ? L.read(top + GC.depth, 'i32')\n      : L.read(L.base + GC.depth, 'i32') - 1;",
     replace: "const target = L.read(L.base + GC.depth, 'i32');",
     note: 'gcNum -1 dispatch uses the current depth instead of the top node'},
  ],
});
