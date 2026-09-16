/** Validate UGC::EnableWordWrap (native 1258) bit-exact vs the oracle. */
import path from 'node:path';
import {runGcValidator} from './gc-validator-lib.mjs';

await runGcValidator({
  moduleFile: path.resolve('src/runtime/script-gc-enable-word-wrap.mjs'),
  metaExport: 'GC_ENABLE_WORD_WRAP_NATIVE',
  entry: 'gcEnableWordWrap',
  oracleFile: 'native-gc-enable-word-wrap-oracle.py',
  section: 'enableWordWrap',
  resultKind: 'void',
  metadataParams: ['bNewWordWrap:bool'],
  invoke: (fn, object, args, services) => fn(object, args[0], services),
  mutations: [
    {file: 'module',
     find: '(bNewWordWrap >>> 0)) & 1',
     replace: '(bNewWordWrap >>> 0)) & 3',
     note: 'argument mask widened to two bits'},
    {file: 'module',
     find: 'L.read(L.base + GC.textFlags',
     replace: 'L.read(L.base + GC.flags',
     note: 'reads the draw flag word +0x48 instead of textFlags +0x98'},
    {file: 'model',
     find: '  textFlags: 0x98,',
     replace: '  textFlags: 0x94,',
     note: 'text flag word moved onto the alignment bytes'},
  ],
});
