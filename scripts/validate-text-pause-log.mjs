/** Validate XTextLogWindow::PauseLog (native 1573) vs the oracle. */
import path from 'node:path';
import {runTextValidator} from './textwindow-validator-lib.mjs';

await runTextValidator({
  moduleFile: path.resolve('src/runtime/script-text-pause-log.mjs'),
  metaExport: 'TEXT_PAUSE_LOG_NATIVE',
  entry: 'textLogWindowPauseLog',
  oracleFile: 'native-text-pause-log-oracle.py',
  section: 'pauseLog',
  resultKind: 'execVoid',
  metadataParams: ['bNewPauseState:bool'],  mutations: [
    {file: 'model',
     find: '    ((flags & ~LOG_FLAG_PAUSE) | ((bNewPauseState & 1) << 2)) >>> 0);',
     replace: '    ((flags & ~LOG_FLAG_PAUSE) | ((bNewPauseState & 1) << 1)) >>> 0);',
     note: 'pause lands on bit1 instead of bit2'},
    {file: 'model',
     find: '    ((flags & ~LOG_FLAG_PAUSE) | ((bNewPauseState & 1) << 2)) >>> 0);',
     replace: '    (flags | ((bNewPauseState & 1) << 2)) >>> 0);',
     note: 'old pause bit never cleared — unpause is a no-op'},
    {file: 'model',
     find: '    ((flags & ~LOG_FLAG_PAUSE) | ((bNewPauseState & 1) << 2)) >>> 0);',
     replace: '    ((flags & ~LOG_FLAG_PAUSE) | ((bNewPauseState & 3) << 2)) >>> 0);',
     note: 'two arg bits shifted in — arg 2 lights bit3'},
  ],

});
