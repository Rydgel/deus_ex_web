/** Validate UGC::GetTextVSpacing (native 1251) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-get-text-v-spacing.mjs'),
  metaExport: 'GC_GET_TEXT_V_SPACING_NATIVE',
  entry: 'gcGetTextVSpacing',
  oracleFile: 'native-gc-get-text-v-spacing-oracle.py',
  section: 'getTextVSpacing',
  resultKind: 'execFloat',
  metadataParams: ['ReturnValue:float'],
  invoke: (fn, object, args, services) => fn(object, services),
  mutations: [
    {file: 'module',
     find: "L.read(L.base + GC.textVSpacing, 'f32')",
     replace: "L.read(L.base + GC.underlineHeight, 'f32')",
     note: 'getter reads underlineHeight instead of textVSpacing'},
    {file: 'module',
     find: "GC.textVSpacing, 'f32'",
     replace: "GC.textVSpacing, 'u32'",
     note: 'getter returns raw bits instead of the decoded float'},
    {file: 'model',
     find: '  textVSpacing: 0x90,',
     replace: '  textVSpacing: 0x8c,',
     note: 'field offset off by four'},
  ],
});
