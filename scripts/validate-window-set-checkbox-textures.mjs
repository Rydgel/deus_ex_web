/** Focused original-evidence validator for CheckboxWindow.SetCheckboxTextures. */
import {
  WINDOW_SET_CHECKBOX_TEXTURES_NATIVE,
  setCheckboxTexturesNative,
} from '../src/runtime/script-window-set-checkbox-textures.mjs';
import { runControlValidator } from './controlwindow-validator-lib.mjs';

await runControlValidator({
  moduleFile: new URL(
    '../src/runtime/script-window-set-checkbox-textures.mjs',
    import.meta.url).pathname,
  metaExport: 'WINDOW_SET_CHECKBOX_TEXTURES_NATIVE',
  entry: 'setCheckboxTexturesNative',
  oracleFile: 'native-window-setCheckboxTextures-oracle.py',
  section: 'setCheckboxTextures',
  exportPath: 'checkboxwindow.setcheckboxtextures',
  metadataParams: [
    'toggleOff:object', 'toggleOn:object',
    'textureWidth:float', 'textureHeight:float',
  ],
  invoke: (fn, receiver, args, world) =>
    fn(receiver, args[0], args[1], args[2], args[3], world.services),
  mutations: [
    {
      find: 'textureOn: 0x1f8',
      replace: 'textureOn: 0x1f4',
      note: 'field offset +0x1f8 -> +0x1f4 reads/writes the on-texture at the off slot',
    },
    {
      find: "writeField(object, F.textureOff, 'ptr', off, 'store-off', services);",
      replace: "writeField(object, F.textureOff, 'ptr', on, 'store-off', services);",
      note: 'stored off-texture <- on-texture changes what is stored',
    },
  ],
});
