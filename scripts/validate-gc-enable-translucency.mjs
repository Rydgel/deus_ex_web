/** Validate UGC::EnableTranslucency (native 1218) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-enable-translucency.mjs'),
  metaExport: 'GC_ENABLE_TRANSLUCENCY_NATIVE',
  entry: 'gcEnableTranslucency',
  oracleFile: 'native-gc-enable-translucency-oracle.py',
  section: 'enableTranslucency',
  resultKind: 'void',
  metadataParams: ['bNewTranslucency:bool'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: '(bNewTranslucency & 1) << 3',
     replace: '(bNewTranslucency & 1) << 4',
     note: 'flag lands in the modulated bit4 instead of translucent bit3'},
    {file: 'module',
     find: '  updateStyleFromFlags(L, L.base);\n',
     replace: '',
     note: 'drop the style-from-flags helper call'},
    {file: 'module',
     find: '  updatePolyFlagsFromFlags(L, L.base);\n',
     replace: '',
     note: 'drop the polyflags-from-flags helper call'},
    {file: 'model',
     find: '  translucent: 0x4,',
     replace: '  translucent: 0x8,',
     note: 'polyflags helper ORs bit3 instead of bit2'},
  ],
});
