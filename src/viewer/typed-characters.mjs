/**
 * Browser stand-in for Windows' TranslateMessage: the WM_CHAR/WM_SYSCHAR
 * character units one keydown would post to the Deus Ex viewport window.
 *
 * Original contract (docs/script-window-typed-keys.md): the viewport window
 * class is registered with RegisterClassExW whenever GUnicodeOS is set
 * (Window.dll 0x11003650; Core sets GUnicodeOS for VER_PLATFORM_WIN32_NT at
 * 0x1016d5d5), so WM_CHAR's wParam is a UTF-16 code unit, not an ANSI byte.
 * WinDrv's WM_CHAR and WM_SYSCHAR case (0x1110a447) passes every unit except
 * 0x0d (Enter) to Client->Engine->Key.
 *
 * Which units a key produces is platform behaviour, not game code. This
 * adapter follows the Win32 TranslateMessage/US-layout rules: the browser's
 * `key` already carries the layout, Shift, Caps Lock, AltGr and dead-key
 * composition; Backspace, Tab, Enter and Escape produce their control
 * characters; Ctrl with a letter or [ \ ] ^ _ @ produces the C0 control
 * character, Ctrl+Backspace 0x7f and Ctrl+Enter 0x0a; Alt with a character is
 * WM_SYSCHAR with that character. A dead key, an IME composition, the
 * Windows/Command key and every non-character key produce nothing. Not
 * measured against TranslateMessage; macOS Option characters come from the
 * browser's layout, where Windows would deliver the unmodified character.
 */

const CTRL_PUNCTUATION = new Map([['[', 0x1b], ['\\', 0x1c], [']', 0x1d], ['^', 0x1e], ['_', 0x1f], ['@', 0x00], [' ', 0x20]]);

/** UTF-16 code units for one keydown-like {key, ctrlKey, altKey, metaKey, isComposing}. */
export function typedCharacters({key, ctrlKey = false, altKey = false, metaKey = false, isComposing = false} = {}) {
  if (isComposing || metaKey || typeof key !== 'string') return [];
  switch (key) {
    case 'Backspace': return [ctrlKey ? 0x7f : 0x08];
    case 'Tab': return ctrlKey ? [] : [0x09];
    case 'Enter': return [ctrlKey ? 0x0a : 0x0d];
    case 'Escape': return [0x1b];
    default: break;
  }
  if ([...key].length !== 1) return [];          // named keys, 'Dead', 'Process', 'Unidentified'
  if (ctrlKey && !altKey) {                      // Ctrl alone; Ctrl+Alt is AltGr's character
    const code = key.charCodeAt(0);
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return [code & 0x1f];
    return CTRL_PUNCTUATION.has(key) ? [CTRL_PUNCTUATION.get(key)] : [];
  }
  return Array.from({length: key.length}, (_, i) => key.charCodeAt(i));
}
