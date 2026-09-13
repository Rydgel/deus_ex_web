# Original state queries

The installed Core.u declares IsInState at native 281 and GetStateName at 284.
Authority is Core.dll SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
The IsInState export thunk `10101410` jumps to `1013ece0`. It evaluates its
FName argument, advances Code past EndFunctionParms, then reads receiver+0xc
(StateFrame). A null frame returns false. Otherwise it reads frame+0x18
(StateNode), compares each node's FName at +0x20, and follows SuperField at
+0x28 until a match or null. It writes a normalized 0 or 1 result at
`1013ed33–1013ed4c`; it does not compare only the active state's name.

GetStateName's thunk `101012ee` jumps to body `1013edb0`, which advances Code past EndFunctionParms, follows
receiver+0xc and frame+0x18, and returns the node's FName at +0x20. Either null
pointer returns NAME_None (zero). There is no superclass walk in this query.

The existing logical ScriptState represents the class sentinel as a null
`stateNode`; a present logical frame therefore supplies its class as the
native node for these queries. This preserves the original distinction between
an absent frame and an initialized frame pointing at the class sentinel.
Class ancestry and inherited state ancestry use their already linked `base`
chains. FName comparison uses the logical VM's resolved spellings with ASCII
case folding; native global name indices remain a separate loader boundary.

The focused original-DLL probe supplies a NameConst evaluator, receiver/frame
pointers and node chains. It compares direct/inherited matches, a miss, null
frame, null node and a class sentinel. The DataLink validator then executes
ConPlayBase.StartConversation's original Dying-state rejection through the
shared native dispatch before its conversation binding calls.
