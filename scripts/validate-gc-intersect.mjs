/** Validate UGC::Intersect (native 1200) bit-exact vs the oracle. */
import path from 'node:path';
import {f32FromBits} from './gc-services.mjs';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-intersect.mjs'),
  metaExport: 'GC_INTERSECT_NATIVE',
  entry: 'gcIntersect',
  oracleFile: 'native-gc-intersect-oracle.py',
  section: 'intersect',
  resultKind: 'void',
  metadataParams: ['ClipX:float', 'ClipY:float', 'clipWidth:float', 'clipHeight:float'],
  invoke: (fn, object, args, services) =>
    fn(object, f32FromBits(args[0]), f32FromBits(args[1]),
      f32FromBits(args[2]), f32FromBits(args[3]), services),
  // F = D+sy stays an x87 extended intermediate in the body; the JS double
  // cannot hold 2^40 + 1 + 2^-20, so this single probe case is allowed to
  // diverge — its two bit patterns are reported, not asserted.
  knownDivergent: ['extreme-gap-probe'],
  mutations: [
    {file: 'module',
     find: 'const Cp = !(C >= A) ? A : C;',
     replace: 'const Cp = C > A ? A : C;',
     note: 'C\' picks A on strict-greater instead of less-or-unordered'},
    {file: 'module',
     find: 'const E = Math.fround(C + sx);',
     replace: 'const E = C + sx;',
     note: 'E is no longer rounded to f32 where the body stores it'},
    {file: 'module',
     find: "L.write(base + GC.clipWidth, 'f32', R - Cp);",
     replace: "L.write(base + GC.clipHeight, 'f32', R - Cp);",
     note: 'R-C\' stored at +0x40 instead of +0x3c'},
    {file: 'module',
     find: 'const R = E > G ? Math.fround(G) : E;',
     replace: 'const R = E > G ? E : Math.fround(G);',
     note: 'R keeps the wrong side of the E-vs-G comparison'},
  ],
});
