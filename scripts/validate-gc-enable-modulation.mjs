/** Validate UGC::EnableModulation (native 1220) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-enable-modulation.mjs'),
  metaExport: 'GC_ENABLE_MODULATION_NATIVE',
  entry: 'gcEnableModulation',
  oracleFile: 'native-gc-enable-modulation-oracle.py',
  section: 'enableModulation',
  resultKind: 'void',
  metadataParams: ['bNewModulation:bool'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: '(bNewModulation & 1) << 4',
     replace: '(bNewModulation & 1) << 5',
     note: 'flag lands in the translucentText bit5 instead of modulated bit4'},
    {file: 'module',
     find: '  updateStyleFromFlags(L, L.base);\n',
     replace: '',
     note: 'drop the style-from-flags helper call'},
    {file: 'module',
     find: '  updatePolyFlagsFromFlags(L, L.base);\n',
     replace: '',
     note: 'drop the polyflags-from-flags helper call'},
    {file: 'model',
     find: '  modulated: 0x10,',
     replace: '  modulated: 0x20,',
     note: 'flag constant points at bit5'},
  ],
});
