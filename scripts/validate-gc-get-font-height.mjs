#!/usr/bin/env node
/**
 * GC.GetFontHeight (native 1281) validator — replays every
 * gc-textmetrics-cases.json case through the JS translation and compares
 * the f32 result bits, events and canonical GC state against the Unicorn
 * oracle running the real Extension.dll method + exec bodies over real
 * UFont data.  Then applies the mutation gate.
 *
 * Usage: node scripts/validate-gc-get-font-height.mjs
 */
import path from 'node:path';
import {runTextMetricsValidator} from './gc-textmetrics-validator-lib.mjs';

await runTextMetricsValidator({
  moduleFile: path.resolve(import.meta.dirname, '../src/runtime/script-gc-get-font-height.mjs'),
  metaExport: 'GC_GET_FONT_HEIGHT_NATIVE',
  entry: 'execGcGetFontHeight',
  oracleFile: 'native-gc-fontheight-oracle.py',
  section: 'getFontHeight',
  resultKind: 'execFloat',
  metadataParams: ['bIncludeSpace:bool', 'ReturnValue:float'],
  invoke(fn, object, args, services) {
    const arg = args[0];
    return fn(object, arg && typeof arg === 'object' && 'value' in arg ? arg.value : arg,
      services);
  },
  mutations: [
    {file: 'fontModel', note: 'space height reads the width field (+8) instead of +0xc',
     find: '  vSize:  0x0c, // height',
     replace: '  vSize:  0x08, // height'},
    {file: 'module', note: 'bold-font compare loses the equal case (>= not <)',
     find: 'if (!(height >= spaceH)) height = spaceH;',
     replace: 'if (height > spaceH) height = spaceH;'},
    {file: 'module', note: 'bIncludeSpace polarity inverted',
     find: '  if (bIncludeSpace)\n    height = Math.fround(height + L.read(L.base + GC.textVSpacing, \'f32\'));',
     replace: '  if (!bIncludeSpace)\n    height = Math.fround(height + L.read(L.base + GC.textVSpacing, \'f32\'));'},
    {file: 'module', note: 'normal-font slot read swapped for the bold slot',
     find: 'const normal = L.read(L.base + GC.normalFont, \'u32\');',
     replace: 'const normal = L.read(L.base + GC.boldFont, \'u32\');'},
  ],
});
