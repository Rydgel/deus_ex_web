# Original player CheckEncroachment and Touch

ULevel.CheckEncroachment1039a350 rejects null source. A non-brush source with no
collision bits in0x0d returns false immediately. Otherwise query the hash at
proposed position/rotation with extra0. Scan original ordered hits, excluding
self and Level.Actors[0]. Controlled player cylinder blocking follows native
IsBlockedBy: other brush requires source bCollideWorld and other bBlockPlayers;
other ordinary actor requires its bBlockPlayers and source bBlockPlayers if
other is a controlled player/projectile, otherwise source bBlockActors.

For each blocking hit, source.EncroachingOn(other) runs synchronously; a true
return immediately returns true (encroachment rejected), before any notification
pass. Moving brush source pushing is a separate original path and outside this
controlled-player entry. Callback effects must be visible to subsequent checks.

After all blocking hits are accepted, notify nonzero scans the four source
Touching slots in index order. If nonnull and !source.IsOverlapping(other), call
source.EndTouch(other,false). This uses CURRENT actor positions: the hash query
has restored the source pose before returning. Then scan the original hit list
again, skipping self/world. Re-evaluate IsBlockedBy; blocking results dispatch
other.EncroachedBy(source), even when notify is zero. Nonblocking hits invoke
source.BeginTouch(other) only when notify is nonzero. Return false. Native source
addresses1039a7e7–1039a8d6 establish this ordering.

Original IsOverlapping10369430 returns false if either actor has Brush and
IsA(Brush), or other==source.Level. Otherwise both cylinder XY and Z squared
comparisons are strict (<sum-radii squared, <sum-heights squared), with x87
retained differences/products. Collision flags do not participate.

Original BeginTouch10369570 invokes AddTouch10369630(source,other), then reciprocal
AddTouch only when the first helper returns true. AddTouch scans all four slots;
already-present returns true, otherwise it picks the LAST empty slot. Write slot,
dispatch source.Touch(other), then return whether that same slot still contains
other. Capacity overflow first removes every Physics==0 entry in slot order, choosing
the last removed slot. If none, an incoming Pawn replaces the first non-Pawn;
if all are Pawns, an incoming bIsPlayer Pawn replaces the first non-player Pawn.
When no entry qualifies, insertion is refused but AddTouch returns true, so the
reciprocal actor can still record the touch. EndTouch10369970 clears first matching source
slot before source.UnTouch(other) unless noNotifySelf; independently clears first
matching reciprocal slot before other.UnTouch(source), regardless noNotifySelf.
Events are synchronous and may change touch arrays; do not assume empty scripts.


## Runtime contract

`checkPlayerEncroachment(source, position, rotation, notify, callbacks)` returns
true on rejection. It accepts only a controlled player cylinder source, with
`controlledPlayer=true` and no brush primitive. `encroachmentCheck(source,
position, rotation, 0)` returns the original ordered full hit objects. Reuse
`actorEncroachmentCheck` with the same live collision hash as movement.
`dispatch(actor, event, [other])` is synchronous; its EncroachingOn return is the
script result. Script bodies are the caller's responsibility. Nothing assumes
that Touch, UnTouch, or EncroachedBy is empty.

`playerBlockedBy(source, other, worldActor)` exposes the same controlled-player
predicate for MoveActor integration. `actor-touch.mjs` exports
`beginTouch(actor, other, dispatch)`, `endTouch(actor, other, noNotifySelf,
dispatch)`, and `isOverlapping(actor, other)`. The CheckEncroachment callback
object can override these with the same signatures (dispatch already bound).

Actors require `position`, `radius`, `height`, four explicit `touching` slots,
`flags` (native +0x1dc), `worldActor`, and original class-derived traits:
`controlledPlayer` means GetPlayerPawn returns nonnull, `projectile` means
Projectile ancestry, and `movingBrush` here means a Brush primitive plus Brush
ancestry, including static brushes. Touch eviction additionally requires
`physics`, `isPawn`, and `pawnFlags` (+0x318, bIsPlayer mask0x2). Object identity
must remain stable. The helper does not serialize actor identity or copy slots.
Original full-slot validation calls Core.IsValid1014f7b0 before each physics
read. The harness populates the original object registry (1029e628/2c) and
executes that validation; runtime live objects are required. Invalid or missing
slots fail explicitly.

## Original evidence and validation

The contract above was recorded from Engine.dll before translation. Reference
instructions remain locally in `.cache/reference/CheckEncroachment.asm` and
`.cache/reference/ActorTouch.asm`; binaries are hash-gated by NativeCollision.
The oracle executes original CheckEncroachment, IsBlockedBy/GetPlayerPawn,
BeginTouch, AddTouch, EndTouch, IsOverlapping, and Core.IsValid. Its hash list and
script dispatch are controlled boundaries, with explicit rejection, Touch
cancellation, and flag-changing effects; it does not substitute native policy.

825 original cases compare exactly in result, callback order, callback-visible
slots, and final reciprocal slots. They cover the 720 source/target collision
flag, class, notify, and rejection combinations; old-touch cleanup; each slot;
callback cancellation; strict overlap boundaries; all stationary eviction;
pawn/player preference at each slot; refused reciprocal insertion; and live
flag changes between the two hit-list passes. Seven regression tests retain the
most integration-sensitive cases. Input SHA256 prevents stale capture reuse.

Run locally:

```sh
node scripts/validate-native-check-encroachment.mjs --capture-only
node scripts/validate-native-check-encroachment.mjs --reuse
node --test test/check-encroachment.test.mjs
```

Captures stay in `reports/movement/native-check-encroachment/`. These policy
cases use a controlled ordered hash list. The separately captured 308 original
real-scene ActorEncroachmentCheck cases validate that query layer; a combined
whole-level CheckEncroachment/FarMove comparison remains an integration check,
not established by either component corpus alone. Moving-brush source pushing
belongs to the mover helper. General non-player source blocking, arbitrary
script bodies, object lifetime/destruction, and unbounded x87 overlap edge
arithmetic are outside this controlled-player evidence scope.
