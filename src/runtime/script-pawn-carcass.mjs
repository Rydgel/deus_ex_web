/** DeusEx.dll ScriptedPawn natives 2108 HaveSeenCarcass and 2109 AddCarcass (docs/script-pawn-carcass.md).
 *
 * Exec wrappers 0x100190a0 / 0x100190f0 evaluate one Name (the argument is stepped, then the end-of-parameters token) and call the
 * workers 0x1001a010 / 0x1001a040 on the receiver's `Carcasses[4]` (+0x9f4, FName indices) and `NumCarcasses` (+0xa04, signed int).
 * HaveSeenCarcass scans the first NumCarcasses entries for the name and returns whether one matched (a dword 0 or 1). AddCarcass
 * appends the name when NumCarcasses < 4 (unsigned compare) and the name is not already listed, and returns nothing. FNames are
 * unique per spelling ignoring case, so the comparison is the lower-cased spelling here. */
import {refValue} from './script-vm.mjs';

const nameKey = value => String(value ?? 'None').toLowerCase();

/** The worker 0x1001a010: index of `name` among the first `count` entries (signed), or -1. */
function seenAt(carcasses, count, name) {
  const wanted = nameKey(name);
  for (let i = 0; i < count; i++) if (nameKey(carcasses[i]) === wanted) return i;
  return -1;
}

/** `call.index` 2108 or 2109 with one name argument; `services` has read(actor, name) and write(actor, name, value). */
export function execPawnCarcass(call, services) {
  if (call.argumentCount !== 1) throw new Error('HaveSeenCarcass/AddCarcass take exactly one name');
  const name = refValue(call.evaluateArgument(0));
  const carcasses = services.read(call.receiver, 'Carcasses'), count = services.read(call.receiver, 'NumCarcasses') | 0;
  if (call.index === 2108) return seenAt(carcasses, count, name) >= 0;
  if (call.index !== 2109) throw new Error(`Unsupported carcass native ${call.index}`);
  // cmp NumCarcasses, 4; jae: an unsigned compare, so a negative count adds nothing
  if ((count >>> 0) < 4 && seenAt(carcasses, count, name) < 0) {
    const next = [...carcasses];
    next[count] = name == null || nameKey(name) === 'none' ? 'None' : String(name);
    services.write(call.receiver, 'Carcasses', next);
    services.write(call.receiver, 'NumCarcasses', count + 1);
  }
  return undefined;
}
