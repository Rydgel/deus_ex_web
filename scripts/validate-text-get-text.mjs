/** Validate XTextWindow::GetText (native 1552) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-get-text.mjs'),
  metaExport: 'TEXT_GET_TEXT_NATIVE',
  entry: 'textWindowGetText',
  oracleFile: 'native-text-get-text-oracle.py',
  section: 'getText',
  resultKind: 'execString',
  metadataParams: ['ReturnValue:string'],
  invoke: (fn, object, args, services, spec, heap, cells) =>
    fn(object, cells.out, services),  mutations: [
    {file: 'model',
     find: '    copyBytes(L, L.read(out, \'u32\'), src, num * 2);',
     replace: '    copyBytes(L, L.read(out, \'u32\'), src, (num - 1) * 2);',
     note: 'terminator wchar not copied — stale byte survives in a reused result'},
    {file: 'model',
     find: '  farrayRealloc(L, out, 2);',
     replace: '  farrayRealloc(L, out, 4);',
     note: 'result FString reallocates at elemSize 4 — the allocator event doubles'},
    {file: 'model',
     find: '  L.write(out + 8, \'i32\', num);\n  L.write(out + 4, \'i32\', num);',
     replace: '  L.write(out + 8, \'i32\', num - 1);\n  L.write(out + 4, \'i32\', num);',
     note: 'result max under-counts — capacity no longer equals num'},
  ],

});
