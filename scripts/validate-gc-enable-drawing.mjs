/** Validate UGC::EnableDrawing (native 1214) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-enable-drawing.mjs'),
  metaExport: 'GC_ENABLE_DRAWING_NATIVE',
  entry: 'gcEnableDrawing',
  oracleFile: 'native-gc-enable-drawing-oracle.py',
  section: 'enableDrawing',
  resultKind: 'void',
  metadataParams: ['bDrawEnabled:bool'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: '(bDrawEnabled & 1) << 1',
     replace: '(bDrawEnabled & 1) << 2',
     note: 'flag lands in the masked bit2 instead of drawing bit1'},
    {file: 'module',
     find: '~GC_FLAGS.drawing',
     replace: '~GC_FLAGS.masked',
     note: 'clears the masked bit instead of the drawing bit'},
    {file: 'model',
     find: '  drawing: 0x2,',
     replace: '  drawing: 0x4,',
     note: 'flag constant points at bit2'},
  ],
});
