/** Validate XListWindow::AddRow (native 1730) bit-exact vs the oracle. */
import path from 'node:path';
import {runListValidator} from './listwindow-validator-lib.mjs';
import {listLeafServices} from './listwindow-services.mjs';

await runListValidator({
  moduleFile: path.resolve('src/runtime/script-window-list-add-row.mjs'),
  metaExport: 'WINDOW_LIST_ADD_ROW_NATIVE',
  entry: 'listWindowAddRow',
  oracleFile: 'native-window-list-add-row-oracle.py',
  section: 'addRow',
  resultKind: 'ptr',
  metadataParams: ['rowStr:string', 'clientData:int', 'ReturnValue:int'],
  services: (heap, base, spec) => listLeafServices(heap, base, spec),
  mutations: [
    {file: 'module', find: 'if (node) {',
     replace: 'if (!node) {',
     note: 'skip the insert/reconfigure when the row was created'},
    {file: 'model', find: "L.write(node + LIST_ROW.clientData, 'i32', clientData);",
     replace: "L.write(node + LIST_ROW.clientData, 'i32', clientData + 1);",
     note: 'clientData off by one'},
    {file: 'model', find: 'text.charCodeAt(i) !== delim',
     replace: 'text.charCodeAt(i) !== delim && i - pos < 2',
     note: 'tokens truncated to two characters'},
    {file: 'model', find: 'for (let i = at; i < total; i++)',
     replace: 'for (let i = at + 1; i < total; i++)',
     note: 'sorted insert never renumbers the inserted row'},
    {file: 'model', find: '+ ((tripled + (tripled < 0 ? 7 : 0)) >> 3) + 0x20',
     replace: '+ ((tripled + (tripled < 0 ? 7 : 0)) >> 3) + 0x21',
     note: 'TArray growth allocates one extra element'},
  ],
});
