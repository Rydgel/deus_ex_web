/** Validate UGC::SetStyle (native 1212) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-style.mjs'),
  metaExport: 'GC_SET_STYLE_NATIVE',
  entry: 'gcSetStyle',
  oracleFile: 'native-gc-set-style-oracle.py',
  section: 'setStyle',
  resultKind: 'void',
  metadataParams: ['NewStyle:byte'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: 'const style = newStyle & 0xff;',
     replace: 'const style = newStyle & 0x1ff;',
     note: 'argument mask widened past the byte the method consumes'},
    {file: 'module',
     find: 'if (style === 0) {',
     replace: 'if (style === 9) {',
     note: 'style 0 no longer takes the early-return path without the helper'},
    {file: 'module',
     find: 'if (style === 2) next = ((next & ~0x18) | GC_FLAGS.masked) >>> 0;',
     replace: 'if (style === 2) next = ((next & ~0x14) | GC_FLAGS.masked) >>> 0;',
     note: 'style 2 clears bits 2,4 instead of bits 3,4'},
    {file: 'model',
     find: '  masked: 0x4,',
     replace: '  masked: 0x8,',
     note: 'style 2 sets the translucent bit'},
  ],
});
