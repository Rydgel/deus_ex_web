/** LargeTextWindow (1860) and EditWindow (1880-1921) natives in the window
 * host. Each case is the exec trampoline's marshalling (parameter defaults
 * read from Extension.dll exec bodies 0x1002e7b0 and 0x10021af0-0x10022a30)
 * in front of the recovered method translation. Texture and sound arguments
 * are stored as heap addresses; an omitted colour, whose alpha byte is the
 * exec's stale stack slot, stays an explicit boundary like the button
 * colour natives. docs/script-large-text-window.md. */
import {refValue} from './script-vm.mjs';
import {setVerticalSpacingMethod} from './script-text-model.mjs';
import {textMemory} from './script-text-model.mjs';
import {f32Bits} from './script-gc-draw-model.mjs';
import {editWindowMoveInsertionPoint} from './script-edit-move-insertion-point.mjs';
import {editWindowSetInsertionPoint} from './script-edit-set-insertion-point.mjs';
import {editWindowGetInsertionPoint} from './script-edit-get-insertion-point.mjs';
import {editWindowSetSelectedArea} from './script-edit-set-selected-area.mjs';
import {editWindowGetSelectedArea} from './script-edit-get-selected-area.mjs';
import {editWindowEnableEditing} from './script-edit-enable-editing.mjs';
import {editWindowIsEditingEnabled} from './script-edit-is-editing-enabled.mjs';
import {editWindowEnableSingleLineEditing} from './script-edit-enable-single-line-editing.mjs';
import {editWindowIsSingleLineEditingEnabled} from './script-edit-is-single-line-editing-enabled.mjs';
import {editWindowEnableUppercaseOnly} from './script-edit-enable-uppercase-only.mjs';
import {editWindowClearTextChangedFlag} from './script-edit-clear-text-changed-flag.mjs';
import {editWindowSetTextChangedFlag} from './script-edit-set-text-changed-flag.mjs';
import {editWindowHasTextChanged} from './script-edit-has-text-changed.mjs';
import {editWindowSetMaxSize} from './script-edit-set-max-size.mjs';
import {editWindowSetMaxUndos} from './script-edit-set-max-undos.mjs';
import {editWindowInsertText} from './script-edit-insert-text.mjs';
import {editWindowDeleteChar} from './script-edit-delete-char.mjs';
import {editWindowSetInsertionPointBlinkRate} from './script-edit-set-insertion-point-blink-rate.mjs';
import {editWindowSetInsertionPointTexture} from './script-edit-set-insertion-point-texture.mjs';
import {editWindowSetInsertionPointType} from './script-edit-set-insertion-point-type.mjs';
import {editWindowSetSelectedAreaTexture} from './script-edit-set-selected-area-texture.mjs';
import {editWindowSetSelectedAreaTextColor} from './script-edit-set-selected-area-text-color.mjs';
import {editWindowSetEditCursor} from './script-edit-set-edit-cursor.mjs';
import {editWindowSetEditSounds} from './script-edit-set-edit-sounds.mjs';
import {editWindowUndo} from './script-edit-undo.mjs';
import {editWindowRedo} from './script-edit-redo.mjs';
import {editWindowClearUndo} from './script-edit-clear-undo.mjs';
import {editWindowCopy} from './script-edit-copy.mjs';
import {editWindowCut} from './script-edit-cut.mjs';
import {editWindowPaste} from './script-edit-paste.mjs';
import {playEditSound} from './script-window-edit.mjs';

const packed = c => ['r','g','b','a'].reduce((word,k,i)=>word|((c?.[`core.object.color.${k}`]??0)&255)<<(8*i),0)>>>0;

/** `env`: editServices (the edit-model services), textServices (the text
 * model's for 1860) and the ED env for PlayEditSound. */
export function dispatchEditWindowNative(W, call, env) {
  const win = call.receiver;
  const arg = (i, fallback) => i < call.argumentCount ? (refValue(call.evaluateArgument(i)) ?? fallback) : fallback;
  const out = (i, v) => { const a = call.evaluateArgument(i); if (a?.reference) a.set(v); };
  const color = (i, name) => {
    const value = i < call.argumentCount ? refValue(call.evaluateArgument(i)) : undefined;
    if (value === undefined || value === null) W.boundary(`${name} omitted-colour stack alpha is not modeled`);
    return packed(value);
  };
  const address = value => value ? W.addressOf(value) : 0;
  const s = env.editServices;
  let value;
  switch (call.index) {
    case 1860: // execSetVerticalSpacing 0x1002e7b0 -> 0x1002d7e0 (float default 0)
      setVerticalSpacingMethod(textMemory(win, env.textServices), f32Bits(arg(0, 0)));
      break;
    case 1880: editWindowMoveInsertionPoint(win, arg(0, 0) & 0xff, arg(1, false) ? 1 : 0, s); break;
    case 1881: editWindowSetInsertionPoint(win, arg(0, 0) | 0, arg(1, false) ? 1 : 0, s); break;
    case 1882: value = editWindowGetInsertionPoint(win, s); break;
    case 1883: editWindowSetSelectedArea(win, arg(0, 0) | 0, arg(1, 0) | 0, s); break;
    case 1884: { const area = editWindowGetSelectedArea(win, s); out(0, area.start); out(1, area.length); break; }
    case 1885: editWindowEnableEditing(win, arg(0, true) ? 1 : 0, s); break;
    case 1886: value = Boolean(editWindowIsEditingEnabled(win, s)); break;
    case 1887: editWindowEnableSingleLineEditing(win, arg(0, true) ? 1 : 0, s); break;
    case 1888: value = Boolean(editWindowIsSingleLineEditingEnabled(win, s)); break;
    case 1889: editWindowEnableUppercaseOnly(win, arg(0, true) ? 1 : 0, s); break;
    case 1890: editWindowClearTextChangedFlag(win, s); break;
    case 1891: editWindowSetTextChangedFlag(win, arg(0, true) ? 1 : 0, s); break;
    case 1892: value = Boolean(editWindowHasTextChanged(win, s)); break;
    case 1895: editWindowSetMaxSize(win, arg(0, 0) | 0, s); break;
    case 1896: editWindowSetMaxUndos(win, arg(0, 0) | 0, s); break;
    case 1900: { // execInsertText 0x10022150: the marshalled string in a temporary FString
      const text = String(arg(0, '')), buffer = s.mem.allocString(text);
      try { value = Boolean(editWindowInsertText(win, buffer, arg(1, false) ? 1 : 0, arg(2, false) ? 1 : 0, s)); }
      finally { s.mem.free(buffer); }
      break;
    }
    case 1901: editWindowDeleteChar(win, arg(0, false) ? 1 : 0, arg(1, false) ? 1 : 0, s); break;
    case 1902: editWindowSetInsertionPointBlinkRate(win, arg(0, 0.75), arg(1, 1), s); break;
    case 1905: editWindowSetInsertionPointTexture(win, address(arg(0, null)), color(1, 'SetInsertionPointTexture'), s); break;
    case 1906: editWindowSetInsertionPointType(win, arg(0, 0) & 0xff, arg(1, 0), arg(2, 0), s); break;
    case 1907: editWindowSetSelectedAreaTexture(win, address(arg(0, null)), color(1, 'SetSelectedAreaTexture'), s); break;
    case 1908: editWindowSetSelectedAreaTextColor(win, color(0, 'SetSelectedAreaTextColor'), s); break;
    case 1909: editWindowSetEditCursor(win, address(arg(0, null)), address(arg(1, null)), color(2, 'SetEditCursor'), s); break;
    case 1910: editWindowUndo(win, s); break;
    case 1911: editWindowRedo(win, s); break;
    case 1912: editWindowClearUndo(win, s); break;
    case 1915: editWindowCopy(win, s); break;
    case 1916: editWindowCut(win, s); break;
    case 1917: editWindowPaste(win, s); break;
    case 1920: editWindowSetEditSounds(win, ...[0, 1, 2, 3].map(i => address(arg(i, null))), s); break;
    case 1921: playEditSound(W, win, arg(0, null), arg(1, -1), arg(2, 1), env.edit); break; // exec 0x10022880
    default: return {handled: false};
  }
  return {handled: true, value};
}
