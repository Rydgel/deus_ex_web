/** Validate UGC::SetTextVSpacing (native 1250) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';
import {f32FromBits} from './gc-services.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-text-v-spacing.mjs'),
  metaExport: 'GC_SET_TEXT_V_SPACING_NATIVE',
  entry: 'gcSetTextVSpacing',
  oracleFile: 'native-gc-set-text-v-spacing-oracle.py',
  section: 'setTextVSpacing',
  resultKind: 'void',
  metadataParams: ['newVSpacing:float'],
  invoke: (fn, object, args, services) => fn(object, f32FromBits(args[0]), services),
  mutations: [
    {file: 'module',
     find: 'L.write(L.base + GC.textVSpacing',
     replace: 'L.write(L.base + GC.baselineOffset',
     note: 'store lands on baselineOffset instead of textVSpacing'},
    {file: 'module',
     find: "'f32', newVSpacing)",
     replace: "'f32', newVSpacing + 0.5)",
     note: 'stored value corrupted before the f32 write'},
    {file: 'model',
     find: '  textVSpacing: 0x90,',
     replace: '  textVSpacing: 0x8c,',
     note: 'field offset off by four'},
  ],
});
