/** Focused original-evidence validator for Window.QueryPreferredSize. */
import {
  WINDOW_QUERY_PREFERRED_SIZE_NATIVE,
  queryPreferredSizeNative,
} from '../src/runtime/script-window-query-preferred-size.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-query-preferred-size.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_QUERY_PREFERRED_SIZE_NATIVE',
  entry: 'queryPreferredSizeNative',
  oracleFile: 'native-window-queryPreferredSize-oracle.py',
  section: 'queryPreferredSize',
  exportPath: 'window.querypreferredsize',
  metadataParams: ['preferredWidth:float', 'preferredHeight:float'],
  bodyRanges: [{
    body: WINDOW_QUERY_PREFERRED_SIZE_NATIVE.helperBody,
    end: WINDOW_QUERY_PREFERRED_SIZE_NATIVE.helperEnd,
    sha256: WINDOW_QUERY_PREFERRED_SIZE_NATIVE.helperSha256,
  }],
  invoke: (fn, receiver, args, world) =>
    fn(receiver, args[0], args[1], world.services),
  mutations: [
    {
      find: 'virtualSlot: WINDOW_QUERY_PREFERRED_SIZE_VIRTUAL.preferredSize',
      replace: 'virtualSlot: 0x78',
      note: 'preferredSize virtual slot +0x7c -> +0x78 mislabels the event',
    },
    {
      find: 'dirty: 0x02',
      replace: 'dirty: 0x04',
      note: 'cache dirty bit 0x02 -> 0x04 misses the recompute flag',
    },
    {
      find: '(depth + 1) >>> 0',
      replace: '(depth + 2) >>> 0',
      note: 'recursion counter +1 -> +2 corrupts the depth write',
    },
  ],
});
