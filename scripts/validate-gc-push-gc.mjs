/** Validate UGC::PushGC (native 1271) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-push-gc.mjs'),
  metaExport: 'GC_PUSH_GC_NATIVE',
  entry: 'gcPushGC',
  oracleFile: 'native-gc-push-gc-oracle.py',
  section: 'pushGC',
  resultKind: 'execInt',
  metadataParams: ['ReturnValue:int'],
  invoke: (fn, object, args, services) => fn(object, services),
  extraFiles: {copyGC: path.resolve('src/runtime/script-gc-copy-gc.mjs')},
  mutations: [
    {file: 'module',
     find: 'L.write(self + GC.depth, \'i32\', L.read(self + GC.depth, \'i32\') + 1);\n  return depth;',
     replace: 'L.write(self + GC.depth, \'i32\', L.read(self + GC.depth, \'i32\') + 1);\n  return depth + 1;',
     note: 'returns the new depth instead of the pre-push depth'},
    {file: 'module',
     find: 'if (L.read(self + GC.owner, \'u32\') !== 0) return depth;',
     replace: 'if (false) return depth;',
     note: 'skips the saved-node owner check'},
    {file: 'module',
     find: 'L.write(node + GC.depth, \'i32\', L.read(self + GC.depth, \'i32\'));',
     replace: 'L.write(node + GC.depth, \'i32\', L.read(self + GC.depth, \'i32\') + 1);',
     note: 'saved node records depth+1 instead of the pre-push depth'},
    {file: 'module',
     find: "  L.write(node + GC.stackTop, 'u32', L.read(self + GC.stackTop, 'u32'));\n  L.write(self + GC.stackTop, 'u32', node);",
     replace: "  L.write(self + GC.stackTop, 'u32', node);\n  L.write(node + GC.stackTop, 'u32', L.read(self + GC.stackTop, 'u32'));",
     note: 'reversed link order makes the node point at itself'},
  ],
});
