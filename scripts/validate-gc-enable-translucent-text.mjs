/** Validate UGC::EnableTranslucentText (native 1247) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-enable-translucent-text.mjs'),
  metaExport: 'GC_ENABLE_TRANSLUCENT_TEXT_NATIVE',
  entry: 'gcEnableTranslucentText',
  oracleFile: 'native-gc-enable-translucent-text-oracle.py',
  section: 'enableTranslucentText',
  resultKind: 'void',
  metadataParams: ['bNewTranslucency:bool'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: '(bNewTranslucency & 1) << 5',
     replace: '(bNewTranslucency & 1) << 4',
     note: 'flag lands in the modulated bit4 instead of translucentText bit5'},
    {file: 'module',
     find: 'GC_POLY.textTranslucent',
     replace: 'GC_POLY.textOpaque',
     note: 'the set branch also stores the opaque text polyflags 0x802'},
    {file: 'model',
     find: '  textTranslucent: 0x804,',
     replace: '  textTranslucent: 0x805,',
     note: 'translucent text polyflags word gains bit0'},
    {file: 'model',
     find: '  translucentText: 0x20,',
     replace: '  translucentText: 0x10,',
     note: 'flag constant points at bit4'},
  ],
});
