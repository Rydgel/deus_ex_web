# Stage 3 batch 3: milestones A, B and C complete

Milestone A is `ea93916`: every Training map actor receives the original
LoadMap passes. Milestone B spawns the real configured DeusExGameInfo and
runs original InitGame, which spawns its Mutator. Milestone C (2026-09-25)
boots Play through the original SpawnPlayActor -> DeusExGameInfo.Login. The
player has a real PlayerReplicationInfo, and Esc pauses the level. Player
start reloads the map and logs a new player in; the old player's graph is
retired with the old level. See [player login](script-player-login.md) and
the measured [scoreboard](stage-3-exit-criteria.md).

The sections below record why the first C attempt stopped. Their boundaries
are closed: dynamic string arrays, InputExt/ResetConfig, InitRootWindow and
CheckFlag. The player-owned native Destroy chain belongs to a garbage
collection after the reload: Viewport.Actor keeps the old player reachable
through LoadMap's own collection. Play retires the graph without modeling
that collection, so retired generations accumulate in memory. The login
page records this.

Superseded 2026-09-26: LoadMap nulls Viewport.Actor and destroys the old
player before the load, and its collection purges the retired generation in
the same reset. Play implements both
([Player start collection](script-loadmap-gc.md)).

## Why the first C attempt stopped

Research and bounded reference probes closed the originally named player
constructor and pawn-spawn prerequisites, but found additional required native
families. The estimate that this combined work exceeds roughly one day of new
recovery/integration is a planning judgment, not an original-game measurement.
Per the task's stop rule, Play remains at verified milestone B. Real Login,
PlayerReplicationInfo in Play, and Esc-menu pausing are **not delivered**.

The actual additional boundaries are:

- **Native Input bootstrap/config reload.** Original
  DeusExPlayer.TravelPostAccept unconditionally calls ResetKeyboard (544).
  Engine `0x103b96d0` checks Player is a Viewport and reads Input at +0x60;
  it calls UObject::ResetConfig(Input.Class) at `0x103b973d`. The original
  viewport creates Input before SpawnPlayActor; a synthetic null pointer would
  bypass this callback. ResetConfig is Core `0x10151ac0..0x10151d85`: copy the
  class's default INI section into GConfig, reload derived CDOs, reload instances,
  and call PostEditChange. It does not Flush. Engine.Input and Extension.InputExt
  have no script-package class exports; their native registry rows do not yet
  provide the required superclass/config/default/property graph. Recovery
  targets are UInput registration `0x10392fe0`, StaticInitInput `0x103930c0`,
  UInput constructor `0x10347080`, and InputExt constructor `0x1002cfb0`.
  Existing scalar config loading and the bounded Alias struct parser are usable
  evidence, but do not establish the missing native class bootstrap.
- **Player-owned destruction on reset.** Accepted DestroyActor invokes
  ConditionalDestroy synchronously. DeusExPlayer::Destroy `0x100141f0` chains
  to PlayerPawnExt::Destroy `0x10037d40`, which handles FlagBase and rootWindow
  before Actor destruction. Reusing the generic Actor Destroy hook skips these
  overrides. FlagBase::Destroy `0x100239f0` first calls UObject::Destroy, then
  unlinks its 64 flag buckets via RemoveFlag `0x10023a80`; it does **not** destroy
  its registered flag nodes. The existing Map-based flag-value projection does
  not model that node ownership. The current world-destruction adapter also
  explicitly rejects Pawn ancestry.
- **DumpLocation native FString array.** Native 3015 CreateDumpLocationObject
  `0x10014c30` runs unconditionally in DeusExGameInfo.Login. Constructor
  `0x10014fb0` reads CurrentUser, allocates scratch storage, and enumerates
  System-directory `*.DMP` names. Original execution cases were recovered, but
  reflected allocation hits the VM's unsupported dynamic StrProperty array
  (`dumpFileDirectory`); the VM currently admits only dynamic int arrays.

## Preserved local work

All 32 unfinished C files were copied and hash-verified under
`.cache/batch3-c-unfinished/files/`, with `manifest.json` and `tracked.patch`.
They are intentionally outside Git and are **not** a working C implementation.
The snapshot includes partially wired Login and incomplete reset handling;
applying it does not make the milestone pass. Original assets and disassembly
also remain outside Git.

Useful saved research pages are `docs/script-player-login.md`,
`docs/script-player-dump.md`, and `docs/script-native-flagbase-research.md`
under that snapshot. The constructor oracle passed all 56 native constructors;
the pawn binding validator covered registered FlagBase/PRI identities, pawn
list linkage and foot/head/body zone callbacks. The dump oracle passed its
native cases, but its reflected-allocation validator remains failing at the
FString-array boundary. The flag oracle passed native allocation, hashing,
update, remove/re-add, and unlink-only destruction; its runtime implementation
was not started. None of these prerequisite results claims completed Login.

Resume from original native Input registration/reference cases and the other
named ownership/storage boundaries before admitting real Login into Play.
Then verify initial startup and reset, PRI, Esc SetPause, scene identity and the
requested instructor/keypad/weapon/augmentation/console validators.

## Final verification

`npm test`: 534 passed. One full `npm run validate -- --jobs 4` sweep:
388 passed, 6 failed, 1143 seconds. The expected failures were the open Stage 3
gate and the pre-existing NPC mesh-preview geometry-upload assertion. Four
additional sweep failures were addressed in validator fixtures and rechecked:

- Native player-sequence exceeded the 6144 MiB cap. Its original oracle does
  isolated physics, so the comparison now builds that exact serialized scene
  instead of a complete script world per case. Both maps pass all nine
  supported cases and line-query comparisons using hash-verified captures.
- NPC inventory now includes the original distributor's Medical Room key;
  the corrected validator passes load and two resets while retaining all
  twelve armed-NPC inventory assertions.
- World destruction now checks the authored distributor's startup deletion
  together with the shadow chain, instead of assuming only shadows. After B,
  reset also tore down the previous run's LoadMap GameInfo/Mutator/
  GameReplicationInfo into the new startup's deferred chain. A reload now
  starts that chain empty after the old world's teardown (as a freshly loaded
  ULevel does), so reset reproduces the fresh-startup chain exactly.
- MIB wandering no longer assumes a success tick from partial startup's RNG
  stream; within a bounded minute it verifies an actual successful search and
  movement on both load and reset.

The full sweep was not repeated. Focused rechecks cover the corrected fixtures;
no runtime behavior was altered to satisfy these assertions. The optional
native-player-sequence stairs-only reuse mode has an existing stale capture
hash and was not regenerated; the main two-map comparison passes.
