# Scroll-family cleanup and destruction

Contract recorded before translation from Extension.dll SHA-256
93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c.

Manager.CleanUp (41ac0) and ScrollArea.CleanUp (430f0) call Window.CleanUp
without additional writes. Their destructors (18240/18650) have no owning members;
they set the family, Window, ExtensionObject vtables around ConditionalDestroy,
then call UObject's destructor. Existing host base destruction supplies those
services; native allocation release remains the existing host heap boundary.

Clip.CleanUp (b400) calls TabGroup.CleanUp. Its destructor (ccf0) adds a Clip
ConditionalDestroy before the inherited TabGroup sequence and owns no additional
containers. TabGroup's two 4-byte-element arrays are destroyed in +158 then +14c
order; native modal-table cleanup is the existing recovered TabGroup path.

Scale.CleanUp (3d4f0) empties every FString in the 12-byte-element label array
+268, then destroys each now-empty FString, empties the outer array, and calls
Window.CleanUp. The format string+1dc is deliberately retained until the
Scale destructor (16c90), which destroys labels, removes/releases the outer
array, destroys the format string, then performs the Window/base destructor
sequence. Loop bounds/pointers in cleanup are reread after allocator calls.

Original reference cases execute these bodies and Core's actual container/string
helpers with explicit allocator, ConditionalDestroy and inherited-cleanup leaves.
Compare object/container bytes and ordered releases before admitting families
into host destruction. Recursive removal uses the previously recovered manager
ChildRemoved and area DescendantRemoved callbacks. This slice concerns window
ownership, not general UObject/resource GC or native allocator compatibility.

## Verified delivery

Ten complete original cleanup/destructor cases establish the base-call routes
and compare every owning-member byte and allocator release in order. Scale
cases include empty arrays and three labels (including allocated empty text).
The format survives CleanUp and is released by the destructor. Native vtable
writes are checked in the oracle's base-call sequence; the host retains its
existing logical family dispatch, heap and ConditionalDestroy representation.
A retained empty label allocation is explicitly refused at the destructor
boundary because its direct native Free ownership is not supplied by this heap.

All four families are admitted to host cleanup. The live Training fixture now
restores its notification fixtures and destroys the actual medical scroll-area
subtree through SafeDestroy, checks that every descendant was destroyed, verifies
parent unlinking, and checks released scale label/format storage. Both bot
integration routes pass. This is recursive scroll-subtree cleanup, not completion
of bot setup, full-screen interaction, native heap reclamation or Stage 3.

Reproduce: `node scripts/validate-window-scroll-cleanup.mjs`,
`node scripts/validate-window-baseline-play.mjs`, and `npm run build`.
