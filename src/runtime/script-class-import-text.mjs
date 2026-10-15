/** UClassProperty::ImportText (Core.dll 0x10167110) and the UObjectProperty::
 * ImportText body it calls first (0x10166e20), for the text of a `class<...>`
 * parameter (ScriptConsoleExec's ParseNext/ImportText loop, docs/script-
 * console-exec.md "Class parameters").
 *
 * UObjectProperty::ImportText: ReadToken(Buffer, Temp, 0x400, DottedNames 1);
 * a NULL token is a NULL result; `None` (appStricmp) stores None and returns
 * the buffer after the token; else the spaces after the token are skipped and
 * ONE wide character is consumed whatever it is. A quote there starts
 * `Class'Package.Object'` (0x10166ed6..0x10166f2f: ReadToken the object path,
 * the closing quote, StaticFindObject(UClass, ANY_PACKAGE, class name), then
 * the object in that class): an explicit boundary here, `quoted` receives
 * it. Any other character leaves the token to StaticFindObject(PropertyClass,
 * ANY_PACKAGE, token, 0) (0x10166ec6..0x10166f2f); a miss is a NULL result.
 * UClassProperty::ImportText then clears a found value that is not exactly a
 * UClass (`[obj+0x24] == 0x101f1c18`) or whose SuperField chain (+0x28) does
 * not reach MetaClass (`[property+0x64]`) to None; the result stays the
 * buffer. Everything is on UTF-16 units, as `text` is a JS string.
 *
 * `find(token)` is StaticFindObject over the objects the host holds: the
 * found object or null. `isClassChildOf(found)` is the check above (false
 * for a found object that is no class). Returns null for a NULL result, else
 * {value: the object or null, consumed: characters the returned pointer lies
 * past `text`'s start, which can be text.length + 1 when the text ends at the
 * token: the original's pointer then points one unit past the terminator}. */
import { readToken } from './config-text.mjs';

export function importClassText(text, { find, isClassChildOf, quoted = () => { throw new Error("Class'Package.Object' text is not recovered"); } }) {
  const read = readToken(text, 0x400, true);
  if (!read) return null;
  let consumed = text.length - read.rest.length;
  if (read.token.toLowerCase() === 'none') return { value: null, consumed };
  let skip = 0;
  while (read.rest[skip] === ' ') skip++;
  const next = read.rest[skip];
  consumed += skip + 1;
  if (next === "'") return quoted(read.token, read.rest.slice(skip + 1), consumed);
  const found = find(read.token);
  if (!found) return null;
  return { value: isClassChildOf(found) ? found : null, consumed };
}
