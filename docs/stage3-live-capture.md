# Targeted Stage 3 live capture

On2026-09-12 the user started original Training in the existing CrossOver
DeusEx bottle and remained at the start. The read-only
`tools/dump-stage3-win.c` used OpenProcess with only QUERY_INFORMATION and
VM_READ, then ReadProcessMemory. It performed no writes or injected hooks.
Raw output and compiled helpers remain ignored under `.cache`.

The existing registry capture already established global object indices and
the earlier conversation-list capture established actor bindings. The new
measurement targets different fields:

- Class.Conversation is still global slot252. Its native PropertiesSize is120.
  Native fields conName/Description/CreatedBy/conOwnerName are at40/44/56/68.
  Consecutive bools bDataLinkCon/bDisplayOnce/bFirstPerson have offset80 and
  masks1/2/4, independently confirming the Core property-Link reconstruction.
- At steady Training state, Core BeginLoad nesting is0, GObjLoaded.Num is0,
  and GObjLoaders.Num is40. This is an outermost, empty-loaded-array case for
  a later StaticLoadObject call; the earlier nested oracle alone did not cover it.
- The DeusExConText linker is ordinal39 in GObjLoaders. Its export table has
  50335 entries. Export49584 is ConList_Mission00, whose +1c pointer exactly
  matches the live ConversationList object's pointer. That object points back
  to the same linker and index, and has ObjectFlags600f0004. Thus the existing
  object return in CreateExport is the relevant steady-state path.

The capture checks both slot identities before interpreting fields. Slots are
inputs from the current or earlier registry capture, not a universal index
formula. A different process/load sequence can have different slots. Reads
fail explicitly; failed memory reads never become fabricated zero values.

Reproduce while original Training is running, after checking the input slots:

```sh
i686-w64-mingw32-gcc -O2 -o .cache/dump-stage3-win.exe tools/dump-stage3-win.c -lpsapi
CX_BOTTLE=DeusEx /Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine \
  '/Users/gcc/Documents/deus_ex_web/.cache/dump-stage3-win.exe' 252 33948 \
  > .cache/stage3-live-training-20260912.txt
```

This is a state snapshot, not a trace of startup call order. Native instructions
remain the authority for the BeginLoad/EndLoad transitions and loader calls.
