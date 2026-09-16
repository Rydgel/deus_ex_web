/** Validate UGC::EnableMasking (native 1216) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-enable-masking.mjs'),
  metaExport: 'GC_ENABLE_MASKING_NATIVE',
  entry: 'gcEnableMasking',
  oracleFile: 'native-gc-enable-masking-oracle.py',
  section: 'enableMasking',
  resultKind: 'void',
  metadataParams: ['bNewMasking:bool'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: '(bNewMasking & 1) << 2',
     replace: '(bNewMasking & 1) << 3',
     note: 'flag lands in the translucent bit3 instead of masked bit2'},
    {file: 'module',
     find: '  updateStyleFromFlags(L, L.base);\n',
     replace: '',
     note: 'drop the style-from-flags helper call'},
    {file: 'module',
     find: '  updatePolyFlagsFromFlags(L, L.base);\n',
     replace: '',
     note: 'drop the polyflags-from-flags helper call'},
    {file: 'model',
     find: '  masked: 0x4,',
     replace: '  masked: 0x8,',
     note: 'style helper tests the translucent bit for masked'},
  ],
});
