/** Validate UGC::EnableSpecialText (native 1260) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-enable-special-text.mjs'),
  metaExport: 'GC_ENABLE_SPECIAL_TEXT_NATIVE',
  entry: 'gcEnableSpecialText',
  oracleFile: 'native-gc-enable-special-text-oracle.py',
  section: 'enableSpecialText',
  resultKind: 'void',
  metadataParams: ['bNewSpecialText:bool'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: '(bNewSpecialText & 1) << 1',
     replace: '(bNewSpecialText & 1) << 2',
     note: 'flag lands in bit2 instead of specialText bit1'},
    {file: 'module',
     find: '~GC_TEXT_FLAGS.specialText',
     replace: '~GC_TEXT_FLAGS.wordWrap',
     note: 'clears the wordWrap bit instead of the specialText bit'},
    {file: 'model',
     find: '  specialText: 0x2,',
     replace: '  specialText: 0x4,',
     note: 'flag constant points at bit2'},
  ],
});
