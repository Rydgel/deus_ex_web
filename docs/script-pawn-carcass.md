# ScriptedPawn carcass memory: natives 2108 and 2109

A `ScriptedPawn` remembers the carcasses it has already reacted to, so a dead body that stays in view does not restart the
reaction every cycle (`GetCarcassData` skips a carcass whose name `HaveSeenCarcass` knows; `CheckCarcassPresence` calls `AddCarcass` for the one it
reacts to). Both are DeusEx.dll natives: `var Name Carcasses[4]` and `var int NumCarcasses` (ScriptedPawn.uc 412-413).

Found live. Shooting an NPC in the Underworld scene ([weapon noise](visual-acceptance.md#weapon-noise-2026-10-14)) killed him; the other NPCs'
`CheckCarcassPresence` then reached `GetCarcassData` and Play paused with "Unsupported original door native 2108 in scriptedpawn.getcarcassdata".

## Contract (DeusEx.dll, SHA-256 `b91002f3...c0bee04`)

| Native | Exec wrapper | Worker |
| --- | --- | --- |
| 2108 `HaveSeenCarcass(Name)` | `0x100190a0` | `0x1001a010` |
| 2109 `AddCarcass(Name)` | `0x100190f0` | `0x1001a040` |

* The exec wrappers evaluate one Name through the script frame's token table (`0x100271a4`), step over the end-of-parameters token and
  call the worker on the receiver. 2108 stores the worker's result as a dword (0 or 1) at the result slot; 2109 stores nothing.
* **2108 worker.** `NumCarcasses` (+0xa04, signed): when it is not above 0 the result is 0. Otherwise the first `NumCarcasses` dwords of
  `Carcasses` (+0x9f4, FName indices) are compared with the name, and the result is 1 on the first match. Entries past `NumCarcasses`
  are never read, whatever they hold.
* **2109 worker.** An **unsigned** compare of `NumCarcasses` with 4 (`jae`): a count of 4 or more, or a negative one, adds nothing. Otherwise,
  when 2108's worker finds no match, the name is stored at `Carcasses[NumCarcasses]` and `NumCarcasses` is incremented. The list never
  wraps: a fifth distinct carcass is not remembered.
* Names compare by index. FNames are unique per spelling ignoring case, so the translation compares lower-cased spellings.

## Translation and verification

`src/runtime/script-pawn-carcass.mjs` (`execPawnCarcass`, wired in `ScriptRuntime.invokeNative` next to 2105-2107).
`scripts/native-pawn-carcass-oracle.py` runs the two exec wrappers and the real workers under Unicorn over a synthetic receiver (only the
script-frame token table is supplied; the receiver's full 4 KiB is compared before and after, so any other write fails);
`scripts/validate-pawn-carcass.mjs` replays 22 cases (empty list, hit, miss, case folding, last slot, full list, stale entry past the count,
`None`, a negative count, a count above 4) and the port equals the original in result, list, count and bytecode advance. Two mutants (a signed
count gate, a case-sensitive compare) fail it.

Live: the replay of a capture in which three shots killed an NPC ran the 600 ticks to the end with equal manager traffic
([weapon noise](visual-acceptance.md#weapon-noise-2026-10-14)).
