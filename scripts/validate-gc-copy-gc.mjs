/** Validate UGC::CopyGC (native 1270) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-copy-gc.mjs'),
  metaExport: 'GC_COPY_GC_NATIVE',
  entry: 'gcCopyGC',
  oracleFile: 'native-gc-copy-gc-oracle.py',
  section: 'copyGC',
  resultKind: 'void',
  metadataParams: ['Copy:object'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: '((flags & ~0x3f) | (L.read(src + GC.flags, \'u32\') & 0x3f)) >>> 0',
     replace: '((flags & ~0x1f) | (L.read(src + GC.flags, \'u32\') & 0x1f)) >>> 0',
     note: 'flag copy mask narrowed to bits 0-4, losing translucentText'},
    {file: 'module',
     find: "  L.write(dst + GC.unknownA0, 'u32', L.read(src + GC.unknownA0, 'u32'));\n",
     replace: '',
     note: 'drops the +0xa0 copy'},
    {file: 'module',
     find: "  L.write(dst + GC.unknownA0, 'u32', L.read(src + GC.unknownA0, 'u32'));\n",
     replace: "  L.write(dst + GC.unknownA0, 'u32', L.read(src + GC.unknownA0, 'u32'));\n  L.write(dst + GC.depth, 'u32', L.read(src + GC.depth, 'u32'));\n",
     note: 'also copies +0xa8, a stack field the body never touches'},
    {file: 'module',
     find: '((textFlags & ~0x3) | (L.read(src + GC.textFlags, \'u32\') & 0x3)) >>> 0',
     replace: '((textFlags & ~0x1) | (L.read(src + GC.textFlags, \'u32\') & 0x1)) >>> 0',
     note: 'text-flag copy mask narrowed to bit 0, losing specialText'},
  ],
});
