/** Browser keyboard codes to original Engine Actor.EInputKey names.
 *
 * The original WinDrv delivers Windows virtual-key codes, and the EInputKey
 * table in Engine.u is indexed by those codes (IK_0 = 0x30, IK_A = 0x41,
 * IK_NumPad0 = 0x60, ...). The browser reports KeyboardEvent.code instead, so
 * this platform layer names the key and the caller resolves the name against
 * the original table (script-input-console.mjs loads it). Windows reports the
 * generic VK_SHIFT/VK_CONTROL/VK_MENU for either side of a modifier. */
const NAMED = Object.freeze({
  Escape: 'Escape', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Space: 'Space',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Pause: 'Pause', CapsLock: 'CapsLock', NumLock: 'NumLock', ScrollLock: 'ScrollLock',
  Semicolon: 'Semicolon', Equal: 'Equals', Comma: 'Comma', Minus: 'Minus', Period: 'Period', Slash: 'Slash',
  Backquote: 'Tilde', BracketLeft: 'LeftBracket', Backslash: 'Backslash', BracketRight: 'RightBracket', Quote: 'SingleQuote',
  NumpadMultiply: 'GreyStar', NumpadAdd: 'GreyPlus', NumpadSubtract: 'GreyMinus', NumpadDecimal: 'NumPadPeriod', NumpadDivide: 'GreySlash',
});

/** `IK_` name for a KeyboardEvent.code, or null when the key has no mapping. */
export function inputKeyNameForCode(code) {
  let match;
  if ((match = /^Digit([0-9])$/.exec(code))) return `IK_${match[1]}`;
  if ((match = /^Key([A-Z])$/.exec(code))) return `IK_${match[1]}`;
  if ((match = /^Numpad([0-9])$/.exec(code))) return `IK_NumPad${match[1]}`;
  if ((match = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code))) return `IK_F${match[1]}`;
  return NAMED[code] ? `IK_${NAMED[code]}` : null;
}

/** EInputKey value for a KeyboardEvent.code from the original name table. */
export function inputKeyForCode(names, code) {
  const name = inputKeyNameForCode(code);
  if (!name) return -1;
  const wanted = name.toLowerCase();
  return names.findIndex(candidate => typeof candidate === 'string' && candidate.toLowerCase() === wanted);
}
