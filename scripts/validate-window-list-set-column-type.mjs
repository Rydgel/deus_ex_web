/** Validate XListWindow::SetColumnType (native 1775) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';
import {listLeafServices} from './listwindow-services.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-set-column-type.mjs'),
  metaExport: 'WINDOW_LIST_SET_COLUMN_TYPE_NATIVE',
  entry: 'listWindowSetColumnType',
  oracleFile: 'native-window-list-set-column-type-oracle.py',
  section: 'setColumnType',
  resultKind: 'void',
  metadataParams: ['colIndex:int', 'newType:byte', 'newFmt:string'],
  services: (heap, base, spec) => listLeafServices(heap, base, spec),
  mutations: [
    {file: 'module',
     find: "    fmt = type === 1 ? '%f' : type === 2 ? '%02h:%02m' : '';",
     replace: "    fmt = type === 1 ? '%g' : type === 2 ? '%02h:%02m' : '';",
     note: 'type 1 default format uses %g'},
    {file: 'module',
     find: '  if (fmt == null || fmt === 0)',
     replace: "  if (fmt == null || fmt === 0 || fmt === '')",
     note: 'an explicit empty format string selects the default'},
    {file: 'module',
     find: '  if (ctx) {',
     replace: '  if (!ctx) {',
     note: 'field reparse runs only without a measure context'},
    {file: 'module',
     find: "  L.write(colPtr + LIST_COL.type, 'u8', type);",
     replace: "  L.write(colPtr + LIST_COL.type, 'u8', type + 1);",
     note: 'stored column type off by one'},
    {file: 'module',
     find: '  if (!colIndexValid(L, col)) return;',
     replace: '  if (colIndexValid(L, col)) return;',
     note: 'valid column indices are rejected'},
  ],
});
