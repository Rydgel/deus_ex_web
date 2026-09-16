/** Validate UGC::SetBaselineData (native 1262) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';
import {f32FromBits} from './gc-services.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-set-baseline-data.mjs'),
  metaExport: 'GC_SET_BASELINE_DATA_NATIVE',
  entry: 'gcSetBaselineData',
  oracleFile: 'native-gc-set-baseline-data-oracle.py',
  section: 'setBaselineData',
  resultKind: 'void',
  metadataParams: ['newBaselineOffset:float', 'newUnderlineHeight:float'],
  invoke: (fn, object, args, services) =>
    fn(object, f32FromBits(args[0]), f32FromBits(args[1]), services),
  mutations: [
    {file: 'module',
     find: "L.write(L.base + GC.baselineOffset, 'f32', newBaselineOffset);",
     replace: "L.write(L.base + GC.baselineOffset, 'f32', newUnderlineHeight);",
     note: 'first arg slot receives the underline height'},
    {file: 'module',
     find: "L.write(L.base + GC.underlineHeight, 'f32', newUnderlineHeight);",
     replace: "L.write(L.base + GC.baselineOffset + 4, 'f32', newUnderlineHeight);",
     note: 'underline height stored at +0x90 instead of +0x88'},
    {file: 'model',
     find: '  underlineHeight: 0x88,',
     replace: '  underlineHeight: 0x8c,',
     note: 'swapped field offsets'},
  ],
});
