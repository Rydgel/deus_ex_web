# Window layout-native offsets (Stage 3 batch)

Recovered from unchanged Extension.dll
`93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c`
(image base `0x10000000`). None of these six natives depend on GC drawing or
font metrics. ListWindow row-model natives remain a separate subsystem.

| offset | width | natives in this batch | already recorded |
| ---: | --- | --- | --- |
| `+0x28` | u8 | SetFocusWindow, ChangeStyle GetRootWindow | Init / GetRootWindow type |
| `+0x30` bit `0x04` | u8 | SetFocusWindow selectable walk | visibility flags |
| `+0x80` / `+0x84` | f32 | SetFocusWindow geometry leaf args | Init |
| `+0x88` / `+0x89` | u8 | SetWindowAlignments H/V | position alignments |
| `+0x8c` / `+0x94` | f32 | SetWindowAlignments hMargin0 / vMargin0 | position x / y |
| `+0x90` / `+0x98` | f32 | SetWindowAlignments hMargin1 / vMargin1 | **new in alignments** |
| `+0x9c` | f32 | SetWidth | size width |
| `+0xa0` | f32 | (unread by SetWidth) | size height |
| `+0x104` / `+0x108` | u32 | SetFocusWindow tween fields | Init |
| `+0x138` | ptr | GetParent, Lower, SetFocusWindow, ChangeStyle | parent |
| `+0x140` | ptr | ChangeStyle `GetTopChild(..., 0)` | last/top child |
| `+0x144` | ptr | Lower prev sibling, ChangeStyle `GetLowerSibling(..., 0)` | lower sibling |
| `+0x148` | ptr | (unread by Lower / ChangeStyle) | higher sibling |
| `+0x178` | ptr | SetFocusWindow type `>= 2` ancestor | **new; beyond Window `0x14c`** |
| RootWindow `+0x5c8` | ptr | SetFocusWindow current focus | **new; RootWindow** |

SetFocusWindow clip/tween helpers `0x1004e230` / `0x1004ffb0` contain `fstp`
and stay host leaves. ChangeStyle vtable `+0xe4` is the StyleChanged
ProcessScript thunk and stays a host leaf.
