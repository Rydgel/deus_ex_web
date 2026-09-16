/** Validate XListWindow::EnableAutoExpandColumns (native 1792) vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';
import {listLeafServices} from './listwindow-services.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-enable-auto-expand-columns.mjs'),
  metaExport: 'WINDOW_LIST_ENABLE_AUTO_EXPAND_COLUMNS_NATIVE',
  entry: 'listWindowEnableAutoExpandColumns',
  oracleFile: 'native-window-list-enable-auto-expand-columns-oracle.py',
  section: 'enableAutoExpandColumns',
  resultKind: 'void',
  metadataParams: ['bAutoExpand:bool'],
  services: (heap, base, spec) => listLeafServices(heap, base, spec),
  mutations: [
    {file: 'module',
     find: '  if (((flags >>> 1) & 1) === arg) return;',
     replace: '  if (((flags >>> 1) & 1) === (arg & 1)) return;',
     note: 'argument compare masks to one bit'},
    {file: 'module',
     find: '  if (next & LIST_FLAGS.autoExpand) autoExpandColumns(L, 1);',
     replace: '  if (next & LIST_FLAGS.multiSelect) autoExpandColumns(L, 1);',
     note: 'driver gated on the multi-select bit'},
    {file: 'module',
     find: 'autoExpandColumns(L, 1);',
     replace: 'autoExpandColumns(L, 0);',
     note: 'enabling resets column widths to the padding'},
    {file: 'module',
     find: '  if (((flags >>> 1) & 1) === arg) return;',
     replace: '  if (((flags >>> 2) & 1) === arg) return;',
     note: 'current state read from the multi-select bit'},
  ],
});
