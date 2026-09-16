/** Validate XListWindow::SetColumnWidth (native 1767) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';
import {listLeafServices} from './listwindow-services.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-set-column-width.mjs'),
  metaExport: 'WINDOW_LIST_SET_COLUMN_WIDTH_NATIVE',
  entry: 'listWindowSetColumnWidth',
  oracleFile: 'native-window-list-set-column-width-oracle.py',
  section: 'setColumnWidth',
  resultKind: 'void',
  metadataParams: ['colIndex:int', 'newWidth:float'],
  services: (heap, base, spec) => listLeafServices(heap, base, spec),
  mutations: [
    {file: 'module',
     find: '  if (cur === next || Number.isNaN(cur) || Number.isNaN(next)) return;',
     replace: '  if (cur !== next) return;',
     note: 'same width still writes and reconfigures'},
    {file: 'module',
     find: '  if (L.read(L.base + LIST_WINDOW.flags, \'u32\') & LIST_FLAGS.autoExpand)',
     replace: '  if (L.read(L.base + LIST_WINDOW.flags, \'u32\') & LIST_FLAGS.multiSelect)',
     note: 'auto-expand driver gated on the multi-select bit'},
    {file: 'module',
     find: '  if (!colIndexValid(L, col)) return;',
     replace: '  if (colIndexValid(L, col)) return;',
     note: 'valid column indices are rejected'},
    {file: 'model',
     find: '  if (!(reset | 0)) {',
     replace: '  if (reset | 0) {',
     note: 'driver resets column widths when called with one'},
  ],
});
