# Original conversation-list binding and purge

Authority is ConSys.dll SHA-256
`f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa`.
The recovered `DConversationList::BindConversations` body is `10010b70`;
`PurgeBoundConversations` is `10010cf0`. This trace supersedes the broad claims
made for the earlier descriptor-only `matchConversations` prototype.

BindConversations saves its ConItem head (+28) before calling Purge on the
actor. For each saved ConItem, it reads ConObject at +28, then computes whether
the resolved conName FName spelling contains the case-sensitive substring
`_Bark`. This uses Core appStrstr, imported at IAT10013148, with literal
1001dc30. The actor's BindName and BarkBindName are FStrings at +2ac/+2b8;
the conversation's conOwnerName is at +44.

The native gates at `10010bb3–10010c86` bind when either:

- BarkBindName equals conOwnerName (appStricmp) and conName contains `_Bark`;
- BindName equals conOwnerName and either BarkBindName is empty or conName
  does not contain `_Bark`.

The body does not special-case the literal BindName `None`. Training's None
decorations have no matching conversation owners; the earlier measured empty
bindings remain valid for that data. Matching order remains mission-list order,
with every bound item prepended to the actor list.

The repeated BarkBindName/empty comparison has opposite branch polarity:
JE at10010c58 accepts; JE at10010c82 skips. With stable string storage the
second equality cannot follow a first inequality. The translation nevertheless
preserves the native skip if storage changes between the two calls.

For each match, the body performs this exact order at `10010c88–10010cd5`:

1. Increment Conversation.ownerRefCount (+74), before allocation.
2. Construct NAME_None using imported FName(EName) at IAT100130e0.
3. Read the ConversationList's Outer through UObject.GetOuter (IAT10013144).
4. Call ConListItem operator new `10002dc0` with size30, that Outer,
   NAME_None and flags0. It forwards to Core StaticAllocateObject.
5. Run ConListItem constructor `1000ecc0`, which calls Core UObject's
   constructor, installs vtable1001346c, and zeros con+28 and next+2c.
6. Read item ObjectFlags (+1c), write con, then write flags OR4 (RF_Public).
7. Read actor.ConListItems (+2dc), write item.next, then publish the new head.

Allocation failure reaches a null dereference in the original; a host must fail
explicitly and must not silently roll back the already incremented count.

Purge reads actor.ConListItems. For each item it decrements con.ownerRefCount,
saves item.next, then calls the item's deleting-destructor virtual +0c with
flags1. Only after the loop does it write the actor's head to None. An initially
empty head is also assigned None. These operations require canonical typed
Conversation/ConListItem identities, shared native allocation/name/Outer
services, and actual deletion ownership; plain descriptor nodes do not supply
this contract.

The shared runtime now connects the recovered mission wrapper, canonical list
fields and this binder. It allocates typed ConListItems through the fresh
object/registry path, runs their native constructor, and purges through their
scalar destructor plus Core lifecycle services. The Training validator supplies
the loader, package-native Outer, name table and allocator explicitly. Complete
Play native-loader/registry bootstrap remains open. Existing Training captures
establish their observed matches/order, not every native branch.

`scripts/validate-native-conversation-list.mjs` executes the full original
BindConversations and Purge bodies with explicit CRT, name/Outer and item
lifecycle services. It compares the complete comparison/write/service trace
with the translation for distinct and empty bark names, case-sensitive `_Bark`,
retention of the source head across purge, existing flags and prepend order.
One controlled name-storage change establishes the repeated-compare skip above.
Item constructor/destructor execution has its own bounded oracle.

The Num0 fallback at1001e1cc is an empty TCHAR in the PE zero-filled data,
not the literal text `None`. Both zero-length and allocated-empty storage
compare as empty text through this string-only boundary.
