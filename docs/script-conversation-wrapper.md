# Original ConBindEvents mission selection

Authority is installed DeusEx.dll SHA-256
`b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04`.
DeusExPlayer native2100 wrapper10014310 calls10014320; DeusExDecoration
native2101 wrapper1000e9d0 calls1000ea50; ScriptedPawn native2102 wrapper
10018f70 calls10019140. The wrappers consume EndFunctionParms then call the
corresponding no-argument body. All three bodies have the same ordinary
mission-selection instructions, with different addresses/exception labels.

Using Decoration addresses, the contract is:

1. Start actor-array index0 at1000ea7f. Each advance rereads receiver.XLevel+ac
   and the level Actors data+2c/count+30. Skip null slots; walk each object's
   Class+24/Super+28 for exact DeusExLevelInfo static class1003a0d8. Stop at
   the first matching actor, including a subclass.
2. If none exists, call imported GLog.Logf with the missing-DeusExLevelInfo
   diagnostic and return. No actor binding or purge occurs.
3. Read that info's missionNumber+33c as signed int; a negative value returns.
4. Read ConversationPackage FString+37c/Num+380, substituting the native empty
   string pointer for Num0. Compare it case-insensitively to the literal
   DeusExConversations100343d0 via Core.appStricmp IAT10027108.
5. On equality, copy DeusExCon100343bc into the prefix buffer. Otherwise,
   reread the field and copy its terminated text. Format missionNumber with
   ConList_Mission%02d10034394, then the complete %sText.%s10034380 path.
6. Call Core.StaticLoadObject through IAT100270fc with
   (ConSys.ConversationList, null Outer, path, null filename, flags2, null
   sandbox). The imported class address comes from IAT10027004.
7. A null loaded object returns without binding. Otherwise, call its imported
   DConversationList.BindConversations through10027014 with this actor.

The literals and imports were resolved directly from the installed PE. The
field names/types are the original DeusExLevelInfo source/package metadata.
The translation requires a synchronous explicit StaticLoadObject service:
preparing an export's fields is not equivalent to the full native loader.
It supports valid strings fitting the original stack buffers; native overflow
from oversized input remains unsupported. Core name/path loading and the
ConListItem allocator/delete paths remain separately bound services.

`scripts/validate-conversation-wrapper.mjs` compares the translation with full
execution of all three original bodies via the accompanying native oracle.
Cases cover missing info, negative missions, case-insensitive package alias,
custom/empty prefixes, class inheritance, failed loads and loaded binding.
The comparison includes load arguments and log/load/bind call order; the
original path construction executes with explicit CRT services. Generated
FFrame argument decoding and full StaticLoadObject ownership are separate.
