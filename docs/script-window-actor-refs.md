# Window actor-reference tracking

Source: original GOTY Extension.dll SHA256
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`.
Native indices 1497/1498/1499 register at 0x10054350/0x100543c0/0x10054430.
Their exec bodies evaluate one Actor argument, consume the parameter terminator,
and call XWindow AddActorRef 0x1004fe20, RemoveActorRef 0x1004fea0, and
IsActorValid 0x1004ff20 respectively. Each window body calls GetPlayerPawn
0x1004c5c0: find the original root through parent/type fields and read its
parentPawn at +0x588. No pawn means no operation, or false for IsActorValid.

APlayerPawnExt stores 32 entries `{Actor*, int refs}` at +0x898, stride 8,
and int count at +0x998. Add 0x10037f50, Remove 0x10038060 and IsValid
0x10038130 return immediately for a null argument. For non-null arguments they
first call FindActor 0x10038400. FindActor scans the current entries, clears an
actor pointer when Actor+0x28 has bit 0x80 (`bDeleteMe`, established in
`script-destroy.md`), and compacts surviving actor/refcount pairs in order.
It returns the matching actor's compacted index or -1 and updates count.
Trailing slots are not cleared. Even IsActorValid mutates this table by
compacting it; merely checking the queried actor's bDeleteMe is insufficient.

Add increments an existing refs dword with int32 wrap. Otherwise, when count
is at least 32, it shifts entries 1..count-1 down and decrements count, evicting
the oldest entry regardless of refs; if count is then below 32 it appends
the passed actor with refs 1. There is no extra bDeleteMe check on that new
argument. Remove decrements the found refs with int32 wrap and, if its signed
value is below 1, shifts later entries down and decrements count. IsValid
returns whether FindActor returned a nonnegative index.

The reference cases execute the unchanged window wrappers, root lookup, pawn
methods and FindActor in the original DLL. They compare the returned boolean,
count, and all 32 actor/refcount slots after each call, including stale tails,
null and missing actors, pending deletion, duplicate references, capacity
eviction and signed-int32 overflow. The browser host must supply canonical
actor identities and a live bDeleteMe reader. The tracking table belongs to
the canonical pawn identity, shared by every window rooted to that pawn.

`createWindowActorRefDispatcher(W, {isDeleted})` returns a dispatcher for
1497/1498/1499. Create it once per window host, and use
`runtime.namedReference(actor, 'bDeleteMe').get()` for the callback. Its
`tableFor(pawn)` returns the explicit `{count, slots[32]}` storage; no lookup
uses actor names. New tables start at the zeroed native actor-storage state.
If a host replaces a pawn, it must use that new canonical pawn identity; an
existing pawn's table must remain shared across its windows.

On 2026-09-23, `node scripts/validate-window-actor-refs.mjs` passed eight
unchanged original DLL sequences containing 31 steps. It checks every count
and all 32 slots after each step, as well as validity return values, and
alternates two nested windows in the duplicate-reference case to check shared
pawn ownership. Original input/output captures and validation logs stay under
ignored `.cache/window-actor-refs/`.
