/** Validate XTextWindow::GetTextPart (native 1554) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-get-text-part.mjs'),
  metaExport: 'TEXT_GET_TEXT_PART_NATIVE',
  entry: 'textWindowGetTextPart',
  oracleFile: 'native-text-get-text-part-oracle.py',
  section: 'getTextPart',
  resultKind: 'execPart',
  metadataParams: ['startPos:int', 'Count:int', 'OutText:string', 'ReturnValue:int'],
  invoke: (fn, object, args, services, spec, heap, cells) =>
    fn(object, args[0], args[1], args[2], cells.out, services),  mutations: [
    {file: 'model',
     find: '  const s = Math.min(start >>> 0, len >>> 0);',
     replace: '  const s = start >>> 0;',
     note: 'FString::Mid start clamp dropped — out-of-range start slices backward'},
    {file: 'model',
     find: '  e = e < (s >>> 0) ? s : Math.min(e, len >>> 0);',
     replace: '  e = Math.min(e, len >>> 0);',
     note: 'Mid unsigned-wrap guard dropped — start+count wrap slices negative'},
    {file: 'model',
     find: '  const target = L.read(gprop, \'u32\') !== 0 ? L.read(gprop, \'u32\') : local;',
     replace: '  const target = local;',
     note: 'out-string lvalue ignored — Mid result never reaches the destination'},
    {file: 'model',
     find: '  L.write(out, \'i32\', outNum !== 0 ? outNum - 1 : 0);',
     replace: '  L.write(out, \'i32\', outNum);',
     note: 'result returns the FString num (with terminator) not the char count'},
  ],

});
