# A. Galaxy subsystem music path: Update transition, UnregisterMusic, library API

§0–§9 are the research. The translation and its verification against the original are §10. Galaxy.dll SHA256 `606e71d1…` (base `0x10600000`), Engine.dll at its
preferred base. Every claim has an instruction address. Field names come from a
string, an SDK header or an export symbol; otherwise they are `+0xNN`.
"Unnamed" means no string or symbol names the function.

## 0. Headline corrections to existing notes

1. **PlayerPawn byte order (wrong in the brief and in `docs/galaxy-audio.md` step 14).**
   `+0x670` Song (UMusic*), **`+0x674` SongSection**, **`+0x675` CdTrack**, `+0x676` Transition.
   Three independent anchors:
   - SDK `Engine/Inc/EngineClasses.h` APlayerPawn: `UMusic* Song; BYTE SongSection; BYTE CdTrack; BYTE Transition;`.
   - `Exec "CDTRACK n"` stores n at `Actor+0x675` (`0x106070e9`) and then `Transition=1` at `+0x676` (`0x106070f5`).
   - Update passes byte `Actor+0x674` (`0x1060a85a`) to `glxControlMusic(2, ·)` (`0x1060a863`). The failure-log
     string at `0x1064a34c` reads "glxControlMusic( GLX_SETPOSITION2, Viewport->Actor->SongSection )".
     `Actor+0x675` is passed to glxStartCDAudio (`0x1060a8e9`, `0x1060a8f3`), whose unwind string (`0x1063cd5c`)
     reads "glxStartCDAudio( Viewport->Actor->CdTrack,Viewport->Actor->CdTrack )".
2. **`docs/galaxy-volumes.md`:** "with a song handle at `+0x40` … with `+0x3c`" is wrong. `+0x40` is the
   UseDigitalMusic config bool and `+0x3c` is UseCDMusic (the StaticConstructor offsets in galaxy-audio.md).
   SetInstantMusicVolume checks the two config flags (`0x1060667c`, `0x106066bb`), not a handle. The
   subsystem's song pointer is `+0x888` (below).
3. **`0x1060e840` is not a "library tick".** It is `EnterCriticalSection(0x1067b670); return 0`
   (`0x1060e840..0x1060e84d`). `0x10618920` is the matching `LeaveCriticalSection` (`0x10618920..0x1061892d`).
   So all of Update runs inside the Galaxy critical section: Enter at `0x10609549`, Leave at `0x1060abd6`.
   The `'tick'` leaf in `scripts/native-galaxy-audio-oracle.py` is this lock.
4. **`0x106300f4` is `jmp [0x10699ab8]` = MSVCRT `_ftol`** (an import thunk), not a Galaxy-owned `_ftol`.
5. **"The original's level change of the subsystem is not traced"** (galaxy-audio.md, Play section) is now
   closed (§5.3): LoadMap's SetViewport calls are no-ops for music.
6. **SetVolumes' and SetInstantMusicVolume's library results go to `appFailAssert`**, not to a log line, and
   **SetVolumes' sample volume is 126 under PC 64** (127 under PC 53/24). See §10.2.

## 1. State and inputs (raw offsets)

### UGalaxyAudioSubsystem (`this` = ecx in Update)

| Off | Type | Role | Evidence |
|---|---|---|---|
| `+0x3c` | UBOOL | UseCDMusic (config) | read `0x1060a610`, `0x1060a8da`, `0x106062d9`, `0x106067d5` |
| `+0x40` | UBOOL | UseDigitalMusic (config) | read `0x1060a6b0`, `0x10606282`, `0x1060667c` |
| `+0x44` | UBOOL | UseReverb (config) | gates the reverb tail `0x1060aa41` |
| `+0x54` | UBOOL | initialized | Destroy `0x106067aa`. (Exec runs on the FExec sub-object `this+0x28`, so its `[edi+0x54]` is `+0x7c` and its `[edi+0x860]` is `+0x888`.) |
| `+0x60` | INT | Latency (ms; Init clamps it to 10..250) | `fild dword [esi+0x60]` `0x1060a56b`/`0x1060a59d`/`0x1060a5cf` |
| `+0x64` | INT | EffectsChannels (first music voice index) | `0x1060a831` |
| `+0x69` | BYTE | MusicVolume (config) | SetVolumes `0x106061d7` |
| `+0x6a`/`+0x6b` | BYTE | SoundVolume / SpeechVolume | SetVolumes `0x106061d4`/`0x10606230` |
| `+0x7c` | UViewport* | Viewport (its `+0x30` is Actor) | `0x1060a50b`, `0x1060a515` |
| `+0x880` | double | last Update time | prologue `0x10609595..0x106095a4` |
| **`+0x888`** | UMusic* | current music (assert text "Music==CurrentMusic" at `0x10649bcc` names it) | set `0x1060a67e`; cleared `0x1060a625`, `0x10606fd7` |
| **`+0x88c`** | BYTE | current CD track (0xff = none) | ctor `0x10604ac4` = 0xff; set `0x1060a68d` from `Actor+0x675`; `0x1060a62f` = 0xff |
| **`+0x88d`** | BYTE | current section (0xff = no section) | set `0x1060a6a4` from `Actor+0x674`; no constructor store |
| `+0x88e` | 0x6c bytes | last reverb parameter block sent | compared at `0x1060ab70`, copied at `0x1060ab87`; SetViewport sends it (`0x10605f4d`/`0x10605f54`) |
| **`+0x900`** | float | music fade factor (the assert text at `0x106498a4` calls it `MusicFade`) | ctor `0x10604aba` = `0x3f800000`; `0x1060a663` = 1.0f; fade writes `0x1060a565`/`0x1060a597`/`0x1060a5c9` |

Constructor `0x10604a20` writes only `+0x900=1.0f` and `+0x88c=0xff` of these (`0x10604aba`, `0x10604ac4`).
`+0x888` and `+0x88d` start at whatever object construction gives them (expected zero; unverified).
**Given that `+0x888` starts at 0**, neither initial value is observable: the first transition then takes
the "nothing playing" path (§2.3) and writes both.

### APlayerPawn (`Viewport->Actor`)
`+0x670` Song, `+0x674` SongSection, `+0x675` CdTrack, `+0x676` Transition. Enum EMusicTransition (SDK
EngineClasses.h): 0 None, 1 Instant, 2 Segue, 3 Fade, 4 FastFade, 5 SlowFade.

### UMusic (SDK UnAudio.h: `TLazyArray<BYTE> Data; FName FileType; INT OriginalSize; void* Handle;`)
`+0x28` FLazyLoader vtable (Engine `0x104267fc`: slot 0 Load `0x1030cbb0`, slot 1 Unload `0x1030cd90`),
`+0x2c` SavedAr, `+0x30` SavedPos, `+0x34` Data ptr, `+0x38` Num, `+0x3c` Max, `+0x48` Handle.

### Installed config (`DeusEx.ini [Galaxy.GalaxyAudioSubsystem]`)
UseCDMusic=False, UseDigitalMusic=True, UseReverb=True, Latency=40, EffectsChannels=16, MusicVolume=153,
SoundVolume=204, SpeechVolume=255. `[Core.System]` does not suppress DevMusic or DevAudio, so the original
logs carry the music lines (§7.4).

## 2. Update music section (`0x1060a50b..0x1060aa15`)

Reached when the channel loop exits (`0x106099ca jge 0x1060a50b`). The whole section is inside the Update
lock (§0.3). `dt` = `[ebp-0x30]`, a double: the prologue's `fst qword` at `0x1060959b`, set to 0.0 when
`< 0` or unordered (`0x106095ad..0x106095c1`) and to 1.0 when not `< 1.0` (`0x106095cd..0x106095e1`). It
is wall time (appSecondsSlow or RDTSC×GSecondsPerCycle), not game time, so fades advance while the game is
paused.

**No null check on `Viewport->Actor`:** `0x1060a515`/`0x1060a518` dereference it, unlike the ambient scan's
check at `0x10609612`.

### 2.1 Pseudocode (each line anchored)

```
A  = Viewport->Actor                                   ; 0x1060a50b,0x1060a515
T  = A[+0x676]                                         ; 0x1060a518
if T == 0:                                             ; 0x1060a520 -> 0x1060aa09
    A[+0x674] = byte [0x10698201]                      ; 0x1060aa09,0x1060aa0f  (library order position)
    goto reverb                                        ; 0x1060aa15
changed = (this[+0x888] != A[+0x670])                  ; 0x1060a526..0x1060a536 (setne bl)
if this[+0x888]==0 && this[+0x88c]==0xff: goto NEW     ; 0x1060a539..0x1060a544 (nothing playing: no fade)
if this[+0x88d]==0xff: done=1                          ; 0x1060a54a..0x1060a551 -> 0x1060a5e5
elif T==3: f = fade - dt;      fst f; done = (Lat*-0.002  > f)  ; 0x1060a557..0x1060a57f
elif T==5: f = fade - dt*0.2;  fst f; done = (Lat*-0.0004 > f)  ; 0x1060a581..0x1060a5b1
elif T==4: f = fade - dt*3.0;  fst f; done = (Lat*-0.006  > f)  ; 0x1060a5b3..0x1060a5e3
else (1 Instant, 2 Segue, >=6): done=1                 ; 0x1060a5b6 jne -> 0x1060a5e5
if done:                                   [ShutUpMusic]
    if this[+0x888] && changed: this->vtbl[+0x70](this[+0x888])   ; UnregisterMusic 0x1060a5fa..0x1060a60d
    if UseCDMusic && this[+0x88c]!=0xff: glxStopCDAudio()         ; 0x1060a610..0x1060a620
    this[+0x888]=0; this[+0x88c]=0xff                             ; 0x1060a625,0x1060a62f
else:
    SetVolumes()                                                  ; 0x1060a638 (applies the fade)
NEW:                                       [NewMusic]             ; 0x1060a642
if this[+0x888]!=0 || this[+0x88c]!=0xff: goto reverb             ; 0x1060a648..0x1060a657 (still fading)
this[+0x900] = 1.0f                                               ; 0x1060a663
SetVolumes()                                                      ; 0x1060a66d
this[+0x888]=A[+0x670]; this[+0x88c]=A[+0x675]; this[+0x88d]=A[+0x674]  ; 0x1060a678..0x1060a6a4
if this[+0x888] && UseDigitalMusic:                               ; 0x1060a6a2..0x1060a6b5
    if changed:                            [StartNewMusic]        ; 0x1060a6bb
        Logf(GLog, 781 DevMusic, "Load music: %s", M.GetFullName())   ; 0x1060a6c7..0x1060a6ef
        M.Data.Load()                      ; vtbl(+0x28)[0]           0x1060a6fa..0x1060a700
        M.Data.Num += 1024; if Num>Max {Max=Num+3*Num/8+32; FArray::Realloc(1)}  ; 0x1060a708..0x1060a735
        Mem = {'MEMO', 0xc, M.Data.ptr, M.Data.Num, 0}             ; 0x1060a73b..0x1060a774 ([ebp-0x10c..-0xfc])
        r = glxLoadMusic(&Mem, 2)                                 ; 0x1060a77e
        if r: Logf(767 Warning, "%s failed: %i", "glxLoadMusic(&Mem, GLX_LOADFROMMEMORY )", r) ; 0x1060a786..0x1060a7a2
        M[+0x48] = 0xffffffff                                     ; 0x1060a7b5 (whether or not the load failed)
        M.Data.Unload()                    ; vtbl(+0x28)[1]           0x1060a7bc..0x1060a7c8
    SetVolumes()                                                  ; 0x1060a810
    if this[+0x88d] != 0xff:                                      ; 0x1060a815
        glxStopMusic()                                            ; 0x1060a822 (result ignored)
        for i in 0..31: byte[(this[+0x64]+i)*0xa0 + 0x1068dcaf] = 0   ; 0x1060a82a..0x1060a844
        glxStartMusic()                                           ; 0x1060a846 (result ignored)
        r = glxControlMusic(2, A[+0x674])                         ; 0x1060a857..0x1060a863
        if r: Logf(767, "%s failed: %i", "glxControlMusic( GLX_SETPOSITION2, Viewport->Actor->SongSection )", r)
        byte [0x10697ca8] = 1                                     ; 0x1060a88d
    else:
        glxStopMusic()                                            ; 0x1060a8cc
if this[+0x88c]!=0xff && UseCDMusic: glxStartCDAudio(A[+0x675], A[+0x675])  ; 0x1060a8d1..0x1060a8f3
A[+0x676] = 0                                                     ; 0x1060a8fb..0x1060a901
reverb:                                                           ; 0x1060aa15
```

Details:
- **The T==0 write-back** `Actor+0x674 = [0x10698201]` runs on every Update with no pending transition. It
  runs regardless of UseDigitalMusic and whether any module is loaded; glxInit seeds the byte with 0xff
  (`0x1060e0b6`).
- **`changed` is recomputed every Update while T≠0** (before ShutUp clears `+0x888`). During a fade, changing
  `Song` back to the current song cancels the unregister and the reload; the section still restarts.
- **Same song, new section** (`changed=0`): no UnregisterMusic and no reload. The module stays loaded and
  playing through ShutUp. Under the lock, NewMusic restores the full volume (MusicFade=1, `0x1060a66d`),
  then stops, clears the voices, starts and seeks.
- **Segue (2) behaves exactly like Instant (1)**: no code path tells them apart (`0x1060a557`, `0x1060a581`,
  `0x1060a5b3` test only 3, 5, 4).
- **A song section of 0xff** (`+0x88d`) skips the fade (`0x1060a551`), and NewMusic then only calls
  glxStopMusic (`0x1060a8cc`). That is the "silence" request.
- ShutUp does not call SetVolumes. The music volume stays at the last fading frame's
  `ftol(max(fade,0)·…)`. That is 0 whenever some frame left the fade in `[threshold, 0)`. A single large
  `dt` that jumps from a positive fade straight past the threshold leaves the last nonzero volume (§2.2).
- The return values of glxStopMusic, glxStartMusic, glxStopCDAudio and glxStartCDAudio are ignored (no test
  after `0x1060a822`, `0x1060a846`, `0x1060a620`, `0x1060a8f3`). The unwind strings `0x1063cc94`
  "glxStopMusic()", `0x1063ccb4` "glxStartMusic()", `0x1063cc14` "glxStopCDAudio", `0x1063cd3c` and
  `0x1063cd5c` are present in .rdata with no reference: their try blocks were optimized out. Their order
  (UpdateMusic `0x1063cbc8` < ShutUpMusic < glxStopCDAudio < NewMusic < StartNewMusic < glxLoadMusic <
  glxStopMusic < glxStartMusic < glxControlMusic < glxStopMusic < glxStartCDAudio) confirms the source
  order above.
- If glxLoadMusic fails, Handle is still set to -1 and the start sequence still runs (on whatever module the
  library holds).

### 2.2 Fade constants and x87 detail

| Data VA | Type | Bits | Value | Use |
|---|---|---|---|---|
| `0x1063d6f8` | m64 | `bf60624dd2f1a9fc` | -0.002 | Fade (3) threshold factor `0x1060a56e` |
| `0x1063d678` | m64 | `3fc999999999999a` | 0.2 | SlowFade (5) rate `0x1060a58f` |
| `0x1063d6e8` | m64 | `bf3a36e2eb1c432d` | -0.0004 | SlowFade threshold `0x1060a5a0` |
| `0x1063d6d8` | m64 | `4008000000000000` | 3.0 | FastFade (4) rate `0x1060a5c1` |
| `0x1063d6c8` | m64 | `bf789374bc6a7efa` | -0.006 | FastFade threshold `0x1060a5d2` |
| immediate | m32 | `3f800000` | 1.0f | reset `0x1060a663` (and ctor) |

The instruction sequences are:
- Fade: `fld m32 [+0x900]; fsub m64 dt; fst m32 [+0x900]`
- SlowFade and FastFade: `fld m32 [+0x900]; fld m64 dt; fmul m64 rate; fsubp; fst m32 [+0x900]`

Each is followed by `fild m32 Latency; fmul m64 k; fcompp; fnstsw; test ah,0x41; je done`. After `fcompp`,
st0 = `Latency·k` and st1 = the **register** fade value. `done` ⇔ C0=C3=0 ⇔ `Latency·k > fade`, ordered.
Equal or unordered keeps fading.

- **The compare uses the unrounded register value**, not the m32 just stored: `fst` keeps st0. That
  register value is the result rounded to the x87 precision-control width. The CRT default is PC=53; it is
  PC=24 if the D3D FPUSETUP note applies (see the `d3d-fpusetup-control-word` memory). The stored float is
  the value the next frame reloads.
- `Latency·k` is `fild` (exact) times the m64 constant, rounded to PC.
- At Latency=40 the thresholds are -0.08, -0.016 and -0.24. Starting from 1.0 at rates 1, 0.2 and 3 per
  second, the fades end after the first frame whose cumulative dt passes about 1.08 s (Fade), 5.08 s
  (SlowFade) or 0.413 s (FastFade). These are frame-quantized approximations.

### 2.3 Library call order by case (from §2.1)

| Case | Calls (under the Update lock) |
|---|---|
| First music ever, or after the old UMusic was GC-destroyed (`+0x888=0`, `+0x88c=0xff`) | SetVolumes → [Load, Add(1024), glxLoadMusic(&Mem,2), Handle=-1, Unload] → SetVolumes → glxStopMusic → clear voices → glxStartMusic → glxControlMusic(2,sect) → `[0x10697ca8]=1` → T=0. All in the same frame. |
| Song A → B, A still current | fade frames: SetVolumes each frame. Done frame: UnregisterMusic(A) {glxStopMusic, glxUnloadMusic} → (glxStopCDAudio if CD) → the first-music sequence for B in the same frame |
| Same song, section change | fade frames: SetVolumes. Done frame: (no unregister) → SetVolumes → SetVolumes → glxStopMusic → clear voices → glxStartMusic → glxControlMusic(2, new) → flag |
| Song → None | done frame: UnregisterMusic(A) → SetVolumes (fade=1) → nothing else |

SetVolumes always calls glxSetSampleVolume, then glxSetMusicVolume when UseDigitalMusic, then the CD volume
when UseCDMusic (§3).

### 2.4 EH guard map (Update FuncInfo `0x106458b0`, handler stub `0x1063a430`)

The try blocks and their catch-handler names: UpdateMusic states `0xd..0x23` (handler `0x1060a9d0`),
ShutUpMusic `0x10..0x12` (`0x1060a99a`), NewMusic `0x14..0x22` (`0x1060a961`), StartNewMusic `0x15..0x1f`
(`0x1060a90d`), "glxLoadMusic(&Mem, 2 )" `0x16` (`0x1060a7cd`), "glxControlMusic( 2, … SongSection )"
`0x1c` (`0x1060a896`), UpdateReverb `0x25..0x27`, glxSetSampleReverb `0x26`. The handlers only call
appUnwindf and rethrow; they have no behavior. Note that the macro-expanded constants in the unwind text
give **GLX_LOADFROMMEMORY = 2** and **GLX_SETPOSITION2 = 2**.

### 2.5 After music (for the complete call order)

Reverb tail `0x1060aa15..0x1060abbc` (not in scope; summary only):
- A 0x6c-byte local is zeroed.
- If UseReverb (`+0x44`), the listener `[ebp-0x40]` has `+0xc8` (Zone) and Zone `+0x3bc` bit 0 is set, the
  local is filled:
  - `+0xc` = f32(Zone`+0x3c4`·(1/255 m64 `0x1063d548`))
  - `+0x10` = f32(clamp(Zone`+0x3c8`, 0, 44100))
  - for i<6: `+0x34+8i` = clamp(Zone`+0x3cc+i`·0.002f, 0.001f, 0.34f) and `+0x38+8i` =
    clamp(Zone`+0x3d2+i`·f32(1/255) `0x1063d724`, 0.001f, 0.999f)
- The local is then compared with `this+0x88e` (27 dwords). If it differs, it is copied there and
  `glxSetSampleReverb(&local)` (`0x1060ab8e`) is called.
- If `+0x78` and `[0x10698174]`, a COM call at vtbl `+0x34` follows (3D path, `0x1060abc7..0x1060abd3`).
- Last, glxUnlock `0x1060abd6`; `ret 0x10` `0x1060abeb`.

## 3. MusicVolume: SetVolumes (`0x106061b0`, export thunk `0x10601087`)

Callers: Update `0x1060a63a`/`0x1060a66d`/`0x1060a810`, PostEditChange `0x10605b9e`, SetViewport
`0x10605f5e`. `K` = m64 1/255 `0x1063d548` (`3f70101010101010`); m64 0.0 `0x1063d538`; m64 1.0 `0x1063c0e8`;
m32 0.0f `0x1063d528`; m32 127.0f `0x1063d530`.

```
nS = f32(fild(+0x6a)·K)                         ; 0x106061e0..0x106061f3 (fstp m32 [ebp-0x14])
nM = f32(clamp(fild(+0x69)·K, 0.0, 1.0))        ; 0x106061f6..0x1060622b (FCOM C0 tests; fstp m32 [ebp-0x18])
sp = fild(+0x6b)·K                              ; 0x10606236 (stays in a register, never stored)
m  = (nS < sp) ? sp : nS                        ; 0x1060623f fld m32 nS; fcomp st1; C0 -> keep sp (extended)
glxSetSampleVolume(_ftol(m·127.0f), 0)          ; 0x10606250..0x1060625e; assert line 0x221 (text 0x106498fc)
if +0x40: f = fld m32 +0x900; if f<0.0f: f=0.0f ; 0x10606289..0x1060629e
          glxSetMusicVolume(_ftol(f·nM·127.0f), 0)  ; 0x106062a4..0x106062b5 (fmul m32, fmul m32); assert 0x223 (text 0x106498a4)
if +0x3c: same value -> 0x1060e9a0(v, 0)        ; 0x106062e0..0x1060630c (no check)
```

`_ftol` (MSVCRT) truncates the PC-rounded extended product. With MusicVolume=153: nM = f32(0.6) = `0x3f19999a`
and ftol(1.0·nM·127) = 76. With MusicFade<0 the volume is 0. With SoundVolume 204 and SpeechVolume 255 the
sample volume is `ftol(sp·127)` with `sp` = 255·K still in a register: 126 under PC 64, 127 under PC 53/24
(measured, §10.4). A nonzero setter result reaches `appFailAssert` (lines 0x221, 0x223).

**SetInstantMusicVolume (`0x10606610`)** uses the argument byte (`0x1060662c`/`0x10606632`) instead of
`+0x69`, with the same clamp. It does not apply MusicFade: it calls glxSetMusicVolume(ftol(nM'·127), 0)
(assert text `0x10649948`, line 0x25c) if `+0x40`, then `0x1060e9a0` if `+0x3c`, then stores `+0x69`
(`0x106066de`). Mid-fade it jumps the volume to unfaded until the next fading frame's SetVolumes.

## 4. UnregisterMusic (`0x10606e60`, thunk `0x1060101e`, vtbl `+0x70`), thiscall, `ret 4`

```
check(Music)                         ; 0x10606e81, line 0x2cd, text "Music" 0x10649be4
if Music[+0x48]:                     ; 0x10606ea9
    check(Music == this[+0x888])     ; 0x10606eb4, line 0x2d0, text "Music==CurrentMusic" 0x10649bcc
    Logf(GLog, 781 DevMusic, "Unregister music: %s", Music.GetFullName())  ; 0x10606ed4..0x10606ef7
    glxStopMusic()                   ; 0x10606efc (result ignored)
    r = glxUnloadMusic(); if r: Logf(767, "%s failed: %i", "glxUnloadMusic()", r)  ; 0x10606f0c..0x10606f2e
    Music[+0x48] = 0                 ; 0x10606f33
if this[+0x888] == Music: this[+0x888] = 0   ; 0x10606fcf..0x10606fd7 (also when Handle was 0)
```

Callers: Update (vtbl, `0x1060a60d`), SetViewport's loop over every UMusic with a Handle (`0x10605d2d`), and
Engine `UMusic::Destroy` (`0x10370d4c..0x10370d67`: `if (UMusic::Audio) Audio->vtbl[+0x70](this)` before
`UObject::Destroy`). `UMusic::Audio` is set in Init (`0x1060591f`) and cleared in Destroy (`0x106067c8`).
UnregisterMusic does **not** reset `+0x88c`, `+0x88d` or `+0x900`.

## 5. Other subsystem entry points that touch music

### 5.1 RegisterMusic
`0x106043d0` is `ret 4`. Nothing else registers music: the only caller of glxLoadMusic is Update
(`0x1060a77e`; xref scan of .text).

### 5.2 Init (`0x10605580`)
glxInit `0x1060df30` (assert "glxInit()==0", `0x106496f4`), then glxSetCallback `0x1060e980`, then a clear
of `+0x88e` (`0x106056cf`), then **glxSetSampleVoices(EffectsChannels)** `0x1060ebc0` (`0x106056db..0x106056df`,
assert text `0x10649674`). The last sets the library's first-music-voice byte `[0x1068828d] = EffectsChannels`.
Then `USound::Audio = UMusic::Audio = this` (`0x1060590e`/`0x1060591f`).

### 5.3 SetViewport (`0x10605c40`)
```
Logf(775 DevAudio, "Galaxy SetViewport: %s", name|"NULL")        ; 0x10605c8a..0x10605c9d
for i < +0x64: StopSound(i)                                      ; 0x10605ca6..0x10605cb4
if this[+0x7c] == InViewport: return                             ; 0x10605cbb (je 0x10605f30)
if this[+0x7c]: for each UMusic in GObjObjects with [+0x48]: UnregisterMusic  ; 0x10605cc9..0x10605d62
                glxStopOutput 0x10618710                         ; 0x10605d68
this[+0x7c] = InViewport                                         ; 0x10605d9f
if InViewport:
   if Actor[+0x670] && Actor[+0x676]==0: Actor[+0x676] = 1 (Instant)  ; 0x10605dd0..0x10605de7
   glxStartOutput(...) ; on failure "Safely failed to initialize Galaxy: %i", Viewport=0, return
   glxSetSampleReverb(this+0x88e)                                ; 0x10605f4d..0x10605f54
   SetVolumes()                                                  ; 0x10605f5e
   ... (a loop over the USound objects in GObjObjects follows, 0x10605f6c..; not traced)
```
Engine callers:
- UGameEngine::Init `0x1038979c` calls `SetViewport(viewport)`: the real attach.
- UGameEngine::LoadMap `0x1038c549` and `0x1038dfdb`, and UGameEngine::Browse `0x1038ba23`, call
  `Audio->SetViewport(Audio->GetViewport())`. GetViewport `0x10606190` returns `+0x7c`.
- UViewport::Destroy `0x103733a3`.

The LoadMap and Browse calls hit the early return. **A map change only stops the effect channels.** Music
continues until the new player's Transition drives Update.

### 5.4 Destroy (`0x10606780`)
If `+0x54`: `USound::Audio=UMusic::Audio=0`, `SetViewport(NULL)` (which unregisters every handled UMusic), then
`if UseCDMusic && +0x88c≠0xff: glxStopCDAudio` (`0x106067d5..0x106067e5`), glxDeinit `0x1060d7e0`.

### 5.5 Exec (`0x10607070`, FExec sub-object)
- `CDTRACK n`: `Actor+0x675=n`, `Actor+0x676=1` (`0x106070e9`/`0x106070f5`).
- `CDVOLUME f`: `0x1060e9a0(ftol(f·127.0f), 0)`.
- `MUSICORDER n`, only when `+0x888` is set (`0x10607167`): `glxControlMusic(1, n)` (`0x106071a8`), log
  "Galaxy order %i".

## 6. Library API (all cdecl: the caller does `add esp`; return 0 = OK)

Common errors seen: `0x11` bad argument or range; 1 a module is already loaded; 2 music is playing (or
already playing); 3 no music channels; 4 music not playing. One critical section `0x1067b670` (recursive)
guards all state.

| VA | Name (evidence) | Args → ret | Behavior / state touched |
|---|---|---|---|
| `0x1060e840` | lock (unnamed; Kernel32 import) | () → 0 | EnterCriticalSection(`0x1067b670`) |
| `0x10618920` | unlock (unnamed) | () → 0 | LeaveCriticalSection(`0x1067b670`) |
| `0x10618be0` | glxLoadMusic (strings `0x1064a3ec`, `0x1063cc64`) | (stream*, flags) → err | See below |
| `0x1060e850` | music-state reset (unnamed; only caller glxLoadMusic `0x10618c12`) | () → 0 / 2 if playing | See below |
| `0x10619450` | glxUnloadMusic (strings `0x10649b70`, `0x1063c808`) | () → 0 / 2 if playing | See below |
| `0x106183a0` | glxStopMusic (unwind strings; called before glxUnloadMusic) | () → 0/3/4 | 4 if `[0x10698349]==0`; 3 if `[0x10698348]==0`; else under lock voice[i]`+0x10`=0 for i∈[`[0x1068828d]`, +`[0x10698348]`), `[0x10698349]=0` |
| `0x106122a0` | glxStartMusic (unwind string order) | () → 0/2/3 | 2 if already playing; 3 if no channels; else voice[i]`+0x10`=1 over the same range, `[0x10698349]=1` |
| `0x1060d0e0` | glxControlMusic (strings `0x1064a34c`, `0x1063ccd4`) | (cmd, value) → 0/0x11 | See below |
| `0x1060eb60` | glxSetMusicVolume (assert text `0x106498a4`, `0x10649948`) | (vol 0..127, mode) → 0/0x11 | mode 0 (GLX_VOLSET): current `[0x10697cf0]`=vol, step `[0x106886a4]`=0; else step = (current≥vol ? -mode : mode). Target `[0x106886a5]`=vol |
| `0x1060ec00` | glxSetSampleVolume (assert text `0x106498fc`) | (vol, mode) → 0/0x11 | Same pattern on `[0x1069817c]` / `[0x10697ca0]` / `[0x10697ce4]` |
| `0x1060ebc0` | glxSetSampleVoices (assert text `0x10649674`) | (n) → 1 ok / 0 | 0 if output started `[0x10698394]` or n+`[0x10698348]`>256; else `[0x1068828d]`=n and voice[0..n)`+0x10`=1 |
| `0x10618290` | glxStopCDAudio (unwind string `0x1063cc14`) | () → 1 none / MCI result | If MCI id `[0x1067b6f8]`: MCI_STOP 0x808, MCI_CLOSE 0x804; id=0 on success |
| `0x10611c70` | glxStartCDAudio (unwind string `0x1063cd5c`) | (from, to) | MCI_OPEN cdaudio (0x803, flags 0x3100), MCI_SET tmsf (0x80d/0x400), MCI_STATUS (0x814), MCI_PLAY from/to (0x806, 0xc). Unused (UseCDMusic=False) |
| `0x1060e9a0` | CD volume (unnamed; callers SetVolumes, SetInstantMusicVolume, Exec CDVOLUME) | (vol 0..127, mode unread) → 0/0x11 | `[0x10698350]`=vol; WINMM auxSetVolume and the mixer CD line (0x1005) |
| `0x106113d0` | glxSetSampleReverb (strings `0x1064a2fc`) | (params*) → err | Under lock, if params and params`+0xc`≠0.0: params`+0x64`=`[0x10688284]`, 27 dwords → `0x10688220`, buffers… (mixer, agent D) |
| `0x106061b0` (thunk `0x10601087`) | UGalaxyAudioSubsystem::SetVolumes (export) | thiscall () | §3 |
| `0x10612310` | 2D voice start (galaxy-audio.md) | — | not on the music path |

**glxLoadMusic (`0x10618be0`):**
- Returns 0x11 for a null stream (`0x10618bed`), and **1 if `[0x10698348]≠0`**, i.e. a module is already
  loaded (`0x10618bfc`).
- Calls the reset `0x1060e850`; returns 2 if that returns 2.
- Flags bit 0 installs the file I/O table (`0x10618970/90/b0/d0`); bit 1 installs the memory I/O table:
  - `[0x1064a744]` seek `0x10618aa0(stream, off, whence)`: 0 SET, 1 CUR, 2 END, else returns 1. Pos is
    clamped to `len` by an unsigned compare.
  - `[0x1064a748]` read `0x10618b10(dst, size, count, stream)`: fread-like; count is cut to
    `(len-pos)/size`.
  - `[0x1064a74c]` write `0x10618b70`.
  - `[0x1064a750]` tell `0x10618bd0`.
  - `[0x1064a740]` = free `0x10618960`.
  - The memory stream uses only `+8` data, `+0xc` length and `+0x10` position. The `'MEMO'` tag and the 0xc
    at `+0/+4` are not read by these callbacks.
- It reads a 0x30-byte header, seeks back by -0x30 (`0x10618c82..0x10618c97`), and dispatches:

| Signature | Loader |
|---|---|
| "MThd" | `0x1062b130` |
| "MTM" | `0x1062aa90` |
| "FAR\xfe" | `0x1062a510` |
| **"IMPM" (Impulse Tracker)** | **`0x10628990(stream)`** (`0x10618d0d..0x10618d1b`) |
| +8 "AM  " | `0x10628000(stream, flags)` |
| +0x2c "SCRM" | `0x10627490` |
| +0x2c "PTMF" | `0x10626ca0` |
| "MAS_UTrack_V00" | `0x106263d0` |
| "Extended Module: " | `0x10625940` |
| "if" / "JN" | `0x106247b0` |
| +0x14 "!Scream!" / "BMOD2STM" | `0x10624d10` |
| anything else | `0x106252f0` |

It returns the loader's result.

**The reset `0x1060e850`:**
- Returns 2 if playing.
- Under lock, each voice from `[0x1068828d]` to 255 (base `0x1068dca0`, stride 0xa0) is zeroed, then given:
  `+0xc`=0xbc, `+0x12`=0x4e20, `+0x14`=`+0x16`=0x4000, `+0x1a`=0x7fff, `+0x1e`=0x28, `+0x3f`=`+0x41`=0x64.
- Globals: `[0x10698201]`=0xff, `[0x10697ca8]`=0, `[0x10698140]`=1, `[0x1069834a]`=0,
  `[0x10697cf0]`=0x7f, `[0x10698200]`=1, `[0x10698141]`=0xff, `[0x10698188]`=`[0x1069817e]`=0x78,
  `[0x10698342]`=`[0x10697cea]`=0x30, `[0x10698180]`=0x7800, and `0x10698208`/`0x10697ce6`/`0x10697ce8`/
  `0x106886a6` = 0 (`0x1060e8ed..0x1060e95d`).
- It does not touch the volume target or step at `0x106886a4/a5`.

**glxUnloadMusic (`0x10619450`):**
- Returns 2 if playing.
- Under lock: for each of the 256 slots at `0x10697d40..0x10698140` that is set, frees `entry+0x24+0x1c·j`
  for j < `entry+8`, then the entry, and nulls the slot. Then calls `0x106195b0(i)` for i=0..255 (instrument
  'INST' unload; it also clears voice `+0xf` for voices whose `+0xd`==i, `0x106195ef..0x1061960a`). Finally
  `[0x10698348]=0`.

**glxControlMusic (`0x1060d0e0`):**
- In every command, `pos = value<0 ? value+[0x10698201]+2 : value`.
- **cmd 2** (SETPOSITION2): fails with 0x11 if `pos > [0x1069834a]` (order count, signed `jg`); else
  `[0x10698201]=(BYTE)(pos-1)`.
- **cmd 1**: the same, plus `[0x10697ca8]=1` and `[0x10697cdc]=0` (`0x1060d17b..0x1060d193`; it enters the
  lock a second time and leaves twice).
- **cmd 3**: `[0x10698200]=(BYTE)value`.
- Any other command: 0x11.
- From Update the value is a zero-extended byte, so relative mode cannot happen. `pos == order count` is
  accepted.

Library globals relevant to music. The roles are inferred from use (no string or symbol names them; agents B
and C to confirm), except `[0x10698201]`: SETPOSITION2 writes `pos-1` there and Update writes it back into
SongSection. Also inferred: `[0x10698394]`, read as "output started" by glxSetSampleVoices.
`[0x10698348]` module channel count (0 = no module), `[0x10698349]` music
playing, `[0x1069834a]` order count, `[0x10698201]` order position ("section"), `[0x10697ca8]` position jump
pending (sequencer readers `0x10616f29`, `0x106179df`; pattern-loop writer `0x10617a30` also decrements
`0x10698201`), `[0x1068828d]` first music voice (= EffectsChannels), `[0x10697cf0]` music volume.
Voice array: base `0x1068dca0`, 256 × 0xa0. `+0x0f` is the "voice active" byte: the mixer loop
`0x10614a6a` skips voices with 0, sample end clears it at `0x10614f1a`, Update clears it. `+0x10` is the
voice enable byte (start/stop/sample-voices). `+0x0d` holds an instrument index (`0x106195f6`).

## 7. Engine and script side

### 7.1 Writers of the PlayerPawn fields
- `PlayerPawn.ClientSetMusic(NewSong, NewSection, NewCdTrack, NewTransition)` (PlayerPawn.uc:1193) only
  assigns the four fields.
- `GameInfo.PostLogin` (GameInfo.uc:957): `ClientSetMusic(Level.Song, Level.SongSection, Level.CdTrack, MTRAN_Fade)`.
  DeusExGameInfo does not override PostLogin; only DeusExMPGame and TeamDMGame do. Engine order (from
  `docs/script-player-login.md`): SetPlayer `0x1039718e` (Viewport.Actor = new player), …,
  `Game.PostLogin` `0x10397c34`.
- `MusicEvent` (Engine): ClientSetMusic(Song|Level.Song, …, Transition), with 255/255 when the song is
  None (MusicEvent.uc:18-25).
- `DeusExPlayer.UpdateDynamicMusic` (DeusExPlayer.uc:1387). It is called from PlayerTick of PlayerWalking,
  PlayerFlying, PlayerSwimming, Dying, Interpolating and Conversation (lines 3686, 3741, 3838, 3938, 4171,
  7397). It returns at once if Level.Song is None, or in single player if musicMode is Dying or Outro.
  Sections (the comment at :1376): 0 Ambient1, 1 Dying, 2 Ambient2, 3 Combat, 4 Conversation, 5 Outro.

  | State or condition | Call |
  |---|---|
  | Interpolating with MissionNumber ≥ 0 | (Song, 5, 255, FastFade) → Outro |
  | Interpolating with MissionNumber < 0 | musicMode = Outro, no call |
  | Conversation | `savedSection = (Ambient ? SongSection : 255)`; (Song, 4, 255, Fade) |
  | Dying | (Song, 1, 255, Fade) |
  | Combat check every 1 s (ScriptedPawn in 'Attacking' with Enemy==self within 1600+radius) | `savedSection` as above; (Song, 3, 255, FastFade) |
  | Out of combat for 5 s | (Song, savedSection or Level.SongSection, 255, SlowFade from Combat, else Fade) |

  `savedSection = SongSection` reads the byte Galaxy writes back from `[0x10698201]` (§2.1 T==0 path), so it
  is the library's live order position.
- Others: `DeusExPlayer.PlayMusic` (cheat window; FastFade), `CreditsScrollWindow` (Credits_Music section 0,
  FastFade, then restores), `PlayMusicWindow`. Conversations have no music event. The ConSys and DeusEx
  sources were grepped: the only music changes come from the player state via UpdateDynamicMusic.
- Volume: `MenuChoice_MusicVolume` → `Player.SetInstantMusicVolume` (native 270 → Galaxy vtbl `+0x98`).

### 7.2 Class defaults and the 00_Intro values
- 00_Intro `LevelInfo0` serializes only `Song = Intro_Music` (import). SongSection and CdTrack take the class
  defaults: LevelInfo **CdTrack = 255** (tag match in the Engine.u LevelInfo class export at offset 127) and
  SongSection = 0 (no tag).
- The PlayerPawn class default is CdTrack=255 too.
- These come from tag-byte pattern matches in the class exports, not a full UClass parse.
- `DeusExLevelInfo1.missionNumber = 98` (serialized).

### 7.3 Derived 00_Intro sequence (UseDigitalMusic=True, Latency=40)
1. LoadMap(00_Intro): `SetViewport(GetViewport())` (stops channels only), GC, Login, SetPlayer, PostLogin →
   `ClientSetMusic(Intro_Music, 0, 255, MTRAN_Fade)`, so `Actor+0x670/674/675/676` = Intro_Music/0/255/3.
2. The first Galaxy Update after that, from UGameEngine::Draw:
   - **From the main menu (DX.dx), Title_Music is still current.** The boot log loads it with entry.dx, and
     the original logs show it survives map-change GC (§7.4).
   - So the fade runs about 1.08 s at `dt`/frame (the music volume reaches 0 once the fade is negative).
   - Then UnregisterMusic(Title_Music), with its glxStopMusic and glxUnloadMusic.
   - In the same frame NewMusic loads Intro_Music: `glxLoadMusic(&Mem{len = OriginalSize+1024}, 2)` → IT
     loader `0x10628990`.
   - It then sets volumes (sample 126 under PC 64, 127 under PC 53/24; music ftol(f32(0.6)·127) = 76) and starts:
     glxStopMusic (→4), clear voice `+0xf` 16..47, glxStartMusic, glxControlMusic(2,0) → `[0x10698201]=0xff`,
     `[0x10697ca8]=1`. Last, Transition=0.
3. Later frames write `Actor+0x674 = [0x10698201]`: 0xff until the sequencer applies the jump, then the
   current order.
4. MissionIntro.FirstFrame calls `StartConversationByName('Intro', bob, False, True)`. bForcePlay is True, so
   the player is **not** sent to state Conversation (DeusExPlayer.uc:7878-7887: the forced-play branch only
   calls `conPlay.StartConversation`). SetInstantSoundVolume(32) leaves the sample volume at 127 (speech 255
   dominates).
5. No section switch is expected: the player is neither in Conversation nor Interpolating (00_Intro has 5
   InterpolationPoints but no InterpolationTrigger or SpecialEvent actor; the export census was run), and the
   Walking branch only acts on combat. **This is conditional on the player's runtime state, which is not
   verified.** If the player were Interpolating, missionNumber 98 ≥ 0 would issue (Song, 5, 255, FastFade).

### 7.4 Original-game measurements (existing logs, no new run)
`.cache/original-startup-deusex.log`:
- Boot: "LoadMap: entry.dx", "Loading: Package Title_Music" (l.56-58), then "Galaxy SetViewport:
  WindowsViewport0" and "Load music: Music Title_Music.Title_Music" (l.125, 128). That there is no fade on
  the first start comes from the code (`+0x888=0`, `+0x88c=0xff`), not from the log.
- DX → 00_Training: SetViewport (l.139, the LoadMap no-op), GC finishes (l.161) without unloading
  Title_Music, "Bringing Level…" (l.163), SetViewport (l.173), "Unregister music: Title_Music" (l.174),
  "Load music: Training_Music" (l.175). The log proves the caller: Update's ShutUp path (vtbl `+0x70`), not
  GC or SetViewport. The fade itself follows from Transition=Fade with a current section of 0, not from the
  log; `-log` has no timestamps.
- Title_Music is unloaded only at exit (l.270).

CrossOver bottle `DeusEx.log`, 11_Paris_Everett → 03_NYC_747: "Unloading: Package ParisChateau_Music" then
"Unregister music: ParisChateau_Music" during "Purging garbage" (l.199-200). That is the UMusic::Destroy
path: the old song is gone before the first Update, so the new song starts with no fade (`+0x888=0`,
`+0x88c=0xff`). **Whether a map change fades depends on whether GC destroys the old UMusic.**

### 7.5 Browser port (phase 4)
Translated and wired; see §10. (Before phase 4 nothing read the four PlayerPawn fields, galaxy-volumes.mjs
only stored the music byte and `script-music-load.mjs` kept Data resident; §10.1 replaces all three.)

## 8. Unresolved branches / open questions

1. **x87 precision control** for the fade compare and the volume `_ftol` products: PC=53 (CRT) vs PC=24 (the
   D3D FPUSETUP question, still open in memory). It decides the frame on which `done` fires when
   `fade ≈ Latency·k`, and the ±1 of the music volume. The oracle measures all three words (§10.4): PC 64
   gives sample volume 126 and PC 53/24 give 127; PC 24 also rounds the prologue's dt. The translation
   matches each at its own precision; which one the game uses is still open.
2. **`Data.Add(1024)` padding** is uninitialized `appRealloc` memory, and `Mem.length` includes it. Agent B:
   does the IT loader `0x10628990` ever read past `OriginalSize`? If it does, the original is
   nondeterministic there.
3. **The sequencer applies `[0x10697ca8]`, `[0x10698201]=pos-1` and `[0x10698140]`** (agent C). Points to
   check:
   - Update sets the flag inline but not `[0x10697cdc]=0`, which cmd 1 does. What is `0x10697cdc`?
   - `[0x10698140]` (row for the next pattern) is reset only by the load-path reset `0x1060e850`, so a
     same-song section jump may start at a stale row.
   - Agent C should confirm.
4. **SongSection write-back timing.** `Actor+0x674` reads a value that the mixer or sequencer thread advances
   asynchronously, under the same lock. A port must decide when its sequencer ticks relative to Update.
   This matters for `savedSection`.
5. **Clearing voice `+0xf` for `[EffectsChannels, +32)`** happens regardless of the module's channel count
   (`[0x10698348]`, up to 64 for IT). Can a module use more than 32 music voices? If so, the voices above 32
   keep sounding across a restart (agent C/D).
6. **The initial `+0x888`/`+0x88d`** (no constructor store) are assumed zero; not observable (§1).
7. **The player's state in 00_Intro** under forced-play ConPlay (§7.3 step 5) is not verified in the
   original. In Play (headless, about 14 s) no section switch happens (§10.2).
8. **glxLoadMusic returning 1** (module still loaded) is possible only if `+0x888` was cleared without an
   unload. No such path was found, but it is not proved impossible: for example UMusic::Destroy of a Handle=0
   object that equals `+0x888` while another module is loaded.
9. **`0x1060e9a0` and `0x1060e850` names**: no string names them.
10. Mixer-thread locking: confirm that the mixer callback takes `0x1067b670` (agent D). Otherwise the
    stop/clear/start/seek sequence is not atomic with respect to mixing.

## 9. How I would probe this

**Harness.** Extend `scripts/native-galaxy-audio-oracle.py`. It already runs Update `0x10609510` with the
lock leaves, appSecondsSlow on a case clock and GTimestamp=0. Set EffectsChannels to 0 so the channel loop
is empty, leave ShowFlags without `0x4800` (no ambient scan), and keep `+0x44`/`+0x78` = 0 (no reverb or 3D).

**Fabricate:**
- The viewport Actor bytes `+0x670/674/675/676`.
- Subsystem `+0x3c/+0x40/+0x60/+0x64/+0x69..6b`, `+0x888/+0x88c/+0x88d/+0x900`.
- UMusic objects: `+0x28` points to a two-slot stub vtable that records Load/Unload. Set `+0x34/+0x38/+0x3c`
  over real `Intro_Music` bytes, `+0x48`.
- Leaves for GetFullName (returns a fixed wide string), GLog/Logf (record the name number and the format
  text), FArray::Realloc (a real reallocation on a bump heap, padding filled with a sentinel), and
  appFailAssert (abort the case).

**Tier 1 (transition logic).** Replace each glx* function (§6) with a recording leaf that returns a scripted
code.
- Sequences: frame-by-frame dt lists (constant, jittered, 0, 1, NaN), crossed with the Transition values
  0..6, Latency ∈ {10, 40, 250} and the x87 control word ∈ {0x027f, 0x037f, 0x007f}.
- Cases: first start; A→B; A→A section change; A→None; section 0xff; mid-fade Song flips; glxLoadMusic
  failing; UseDigitalMusic=0; UseCDMusic=1 with a CdTrack.
- Record per frame: bits of `+0x900`, `+0x888`, `+0x88c`, `+0x88d`; Actor `+0x674`/`+0x676`; the vtbl `+0x70`
  calls; every glx call with its arguments in order; the Logf records; Music `+0x48`, Num, Max; the
  Load/Unload order.

**Tier 2 (library integration).** Execute the real glxLoadMusic (with the IT loader), glxStop/StartMusic,
glxControlMusic, glxSetMusicVolume, glxSetSampleVolume, glxUnloadMusic and SetVolumes. Leave only
Enter/LeaveCriticalSection and MSVCRT malloc/free/realloc as leaves (bump allocator with recorded sizes).
After each frame, dump:
- `0x10698348/49/4a`, `0x10698201`, `0x10698200`, `0x10698140`, `0x10697ca8`, `0x10697cdc`, `0x10697cf0`,
  `0x106886a4/a5`, `0x1069817c`
- voices 16..47 bytes `+0x0d/+0x0f/+0x10`
- the slot table `0x10697d40..0x10698140`

Compare against the translation. Seed `.data` from the file image, as the existing oracle does.

**Original-game check (cheap).** DevMusic and DevAudio are not suppressed. One scripted CrossOver run of
New Game → 00_Intro (and a same-song section change via the `MUSICORDER` console command, or a
DeusExPlayer combat trigger) yields the order of "Galaxy SetViewport", "Unregister music" and "Load music",
plus any "failed: %i" lines. That confirms §7.3 without visuals. Fade duration needs audio capture or
timestamped logs (`-log` has none); propose an RDTSC-stamped hook only if a fade-timing dispute appears.

## 10. Translation and verification (phase 4, 2026-10-06)

### 10.1 What runs in Play

The music section of Update, SetVolumes, SetInstantMusicVolume and UnregisterMusic are translated in
`src/runtime/galaxy-music.mjs`. The UMusic Data lifecycle StartNewMusic drives is translated there too:
Engine's lazy Load `0x1030cbb0` through the shared `script-lazy-byte-array.mjs`, Unload `0x1030cd90`, and
`Add(1024)`.

`galaxy-audio.mjs` runs Update in this order:

1. It takes `library.lock()` after the viewport test (`0x10609549`).
2. It runs the channel logic.
3. It calls the music section with the prologue's clamped dt.
4. It releases the lock at the end (`0x1060abd6`).

The zone reverb tail (§2.5) is still not translated.

`script-audio-live.mjs`:

- **Fields.** Reads the four PlayerPawn fields from the viewport actor through `runtime.readNamed`, and
  writes SongSection and Transition through `runtime.writeNamed`.
- **Config.** Takes UseDigitalMusic, UseCDMusic, MusicVolume, Latency and EffectsChannels from
  `DeusEx.ini [Galaxy.GalaxyAudioSubsystem]`:
  - Latency is clamped to 10..250 and EffectsChannels to 0..32. Both clamps are in `0x10605ad0`, the
    PostEditChange body (vtable `+0x40`, which also calls SetVolumes at `0x10605b9e`), not in Init. Whether
    construction reaches PostEditChange is not traced; the installed values are inside both ranges.
  - `UseCDMusic=True` is refused with an error. The CD calls (`glxStopCDAudio`, `glxStartCDAudio`, the CD
    volume `0x1060e9a0`) are not translated. The `+0x88c` byte is translated, because it steers the
    transition whatever UseCDMusic says.
- **Volume bytes.** Owns the subsystem's three volume bytes and shares them:
  - with Update's category ratio, which now reads the live SoundVolume and SpeechVolume;
  - with natives 268–270, which now reach the library. 268 and 269 call `setSampleVolume`; 270 runs
    SetInstantMusicVolume.

UMusic objects (`galaxy-music-objects.mjs`):

- **A map's `LevelInfo.Song` import** reaches `PlayerPawn.Song` as the resource registry's export
  reference. Its UMusic state is kept per reference.
  - Its initial state is the original's after `UMusic::Serialize`: SavedPos is the negated position of
    Data's compact count, `Num = Max = OriginalSize`, and Handle is 0.
  - Load re-reads the package bytes when SavedPos is positive.
- **A DynamicLoadObject Music** is a load-graph object. It uses the graph's `+0x28` record and lazy
  loader. This path is written but not reached by a map yet.

### 10.2 Corrections found while translating

- **Library results in SetVolumes and SetInstantMusicVolume.** A nonzero result goes to `appFailAssert`
  (lines `0x221`, `0x223`, `0x25c`; texts `0x106498fc`, `0x106498a4`, `0x10649948`), not to a log line.
  The volumes passed are always 0..127, where the setters return 0.
- **The SetVolumes sample volume** is not always 127. `sp = fild(+0x6b)·K` stays in a register. Under PC 64,
  255·K is just below 1, so `ftol(sp·127)` is **126**; under PC 53 or 24 it is 127. The §7.3 step 2 value
  ("sample 127") holds only for those control words. SetInstantSound/SpeechVolume store `float32(Speech·K)`
  first and so give 127 under every control word.
- **The music volume expression** is `(fade·nM)·127` in that order (`0x106062a4..0x106062af`), though the
  assert text reads `127*NormMusicVolume*Max(MusicFade,0.f)`.
- **`Data.Add(1024)`** (`0x1060a708..0x1060a735`) does `Num += 0x400`. If `Num > Max` (signed), it sets
  `Max = Num + (3·Num)/8 + 32` (signed division: `cdq; and edx,7; sar 3`) and calls `FArray::Realloc(1)`.
  After Serialize `Max = Num`, so a load always reallocates. Core's `FArray::Realloc` (`0x10145440`) is
  `GMalloc->Realloc(Data, Max·ElementSize, "FArray")`.
- **Engine Unload `0x1030cd90`.** If SavedPos (`+8`) is negative: `Num = Max = 0`, `Realloc(1)`, then
  SavedPos is negated. Otherwise it does nothing.
- **Under PC 24 the prologue's dt is rounded too.** The FSUB `appSecondsSlow() - [+0x880]`
  (`0x1060959b`) rounds the elapsed time to 24 bits before the store.
- **§8.7 in Play.** In Play's headless 00_Intro (not the original), about 14 s of frames gave no section
  switch: the player is neither Conversation nor Interpolating there.

### 10.3 Oracle

`scripts/native-galaxy-audio-oracle.py GAME_ROOT CASES --music OUT [--modules DIR]` runs on the phase-1
loader oracle's machine:

- Galaxy.dll rebased, with Engine and Core.
- glxInit's state section and `glxSetSampleVoices(16)` executed.
- The `.data` snapshot restored per case.

It calls the real Update `0x10609510` with these settings:

- EffectsChannels idle channels, reset by Init's StopSound loop;
- ShowFlags 0, so there is no ambient scan;
- UseReverb 0, so the reverb tail compares equal and sends nothing.

It also calls SetVolumes, SetInstantMusicVolume and `vtbl+0x70` (UnregisterMusic, as UMusic::Destroy
calls it), each with the case's x87 control word.

The fabricated inputs:

- **Viewport Actor bytes:** `+0x670..+0x676`.
- **Subsystem fields:** `+0x3c`, `+0x40`, `+0x60`, `+0x64`, `+0x69..0x6b`, `+0x888`, `+0x88c`, `+0x88d`,
  `+0x900`.
- **UMusic objects:**
  - the real FLazyLoader vtable `0x104267fc`;
  - an archive (SavedAr) over a stream that holds Data's compact count at SavedPos 0x40, then the bytes;
  - Data either resident (SavedPos negative) or emptied.

Real code runs for Engine's Load and Unload, its byte-array serializer `0x1030cca0` and Core's
`FArray::Realloc`. The leaves are:

- the critical sections and MSVCRT (phase 1);
- appSecondsSlow on the case clock, with GTimestamp 0;
- `GMalloc->Realloc` on a bump heap (new bytes filled with 0xcd, so the slack is recognisable);
- GetFullName, `"Music <Pkg>.<Name>"`;
- Logf, formatted and recorded;
- appFailAssert, which aborts the op;
- the archive's Serialize, CountBytes, Tell and Seek, and the compact-index operator.

Tier 1 also makes every glx* function a recording leaf returning the case's scripted code. Tier 2 runs the
real library on DX songs.

Each op records, in order:

- every glx call with its arguments and result;
- for glxLoadMusic, its Mem block: tag `'MEMO'`, `0xc`, whose Data, the length, whether the first
  OriginalSize bytes are the module, and the slack (1024 bytes the original never writes);
- each voice `+0x0f` clear (from the store at `0x1060a83d`);
- the break flag store (`0x1060a88d`);
- the order read (`0x1060aa09`);
- the UnregisterMusic and SetVolumes entries;
- the lazy Load and Unload entries with SavedPos;
- each `FArray::Realloc` with Num and Max;
- the Logf lines;
- faults.

After each op it records:

- MusicFade's bits, `+0x888`, `+0x88c`, `+0x88d`;
- the Actor's `+0x674..0x676`;
- the volume bytes;
- each UMusic's Handle, SavedPos, Data, Num and Max;
- tier 2 only: the library globals of §9, voices `+0x0d..+0x10`, and the slot counts.

Instruction coverage is recorded with block hooks:

| Body | Reached | Not reached |
| --- | --- | --- |
| Update music section `0x1060a50b..0x1060aa15` | 234/333 | glxStopCDAudio and glxStartCDAudio, and the exception handlers |
| SetVolumes | 86/113 | the `< 0.0` clamp a byte cannot reach, the two appFailAssert tails, the CD branch |
| SetInstantMusicVolume | 55/70 | the same three kinds |
| UnregisterMusic | 65/106 | the instructions after the two appFailAssert calls (the leaf aborts there), the exception handlers |
| Engine lazy Load | 50/51 | the null-`this` arm |
| Engine lazy Unload | 34/34 | |

### 10.4 Verification

`scripts/validate-galaxy-music-update.mjs` builds the cases, runs the oracle (about 16 s), and replays every
case through `createGalaxyAudio` + `createGalaxyMusic`, at the case's precision (0x037f → 64, 0x027f → 53,
0x007f → 24). It compares every op's events and state; all are equal.

**Tier 1: 711 cases.**

Six families, each crossed with Transition 0..6 × Latency 10/40/250 (dt 1/60, plus jittered dt at
Latency 40), × the three control words:

- first start;
- A→B;
- A→A with a new section;
- A→None;
- current section 0xff;
- new section 0xff.

Special cases, also under the three control words unless marked:

- a mid-fade flip back to the current song (no unregister, no reload);
- a mid-fade flip to a third song;
- a mid-fade Transition change;
- UseDigitalMusic 0, at a first start and at A→B;
- failures (0x037f only): glxLoadMusic returning 1, 2, 3 and 0x11; glxControlMusic 0x11; glxUnloadMusic 2;
- large dt that jumps past the threshold, for Fade, FastFade and SlowFade;
- unordered and out-of-range dt;
- fade-edge cases: dt stepped by single ulps around the threshold, for Fade at Latency 10, 40 and 250, and
  for FastFade and SlowFade at 40;
- the same UMusic reloaded after an unregister (Load re-reads the archive);
- CdTrack steering without UseCDMusic;
- Transition 7, 200 and 255;
- UMusic::Destroy: of the current song; mid-fade; of a non-current handled song (assert
  `Music==CurrentMusic`); of None (assert `Music`);
- a same-song restart from section 0xff;
- the order write-back over 16 values;
- a SetVolumes grid: MusicVolume {0, 1, 128, 153, 254, 255} × SoundVolume {0, 32, 204, 255} ×
  SpeechVolume {0, 128, 255} × 11 MusicFade values (±0, 0.5, 1, 1.5, −0.1, a denormal, NaN, …) ×
  UseDigitalMusic;
- SetInstantMusicVolume over 18 dword values (low byte and clamp) × UseDigitalMusic.

**Tier 2: 7 cases.** The real library runs Intro, Training, Title and Lebedev:

- first start, then Destroy;
- Intro→Training with a fade;
- Intro section changes, including section 40 > song length 28, which the library refuses with 0x11 and
  logs;
- Lebedev→None;
- Title→Intro→Title, a reload of Title;
- Destroy mid-fade;
- UseDigitalMusic 0.

The replay feeds the translation the real library's results. The mirror library runs alongside, and its own
results and modelled bytes are compared after every op: order, break flag, playing, module loaded, the
`0x10698200` flag, the music and sample master/step/target. The mirror matches until it meets the refused
section-40 control. It cannot know a song length, so it counts that call as uncertain and stops being
compared for the rest of that case.

**Totals:** 37,496 ops, 32,471 Update frames, 108,545 events, 215 mirror state checks.

**Sensitivity.** Replaying 50 of the 0x037f cases at 53 bits fails all 50.

**How the control words differ in the original.** These are the same programs; 243 scenarios run under all
three words:

| Against 0x037f | Scenarios differing | Sample volume | Music volume | MusicFade bits | Fade end frame |
| --- | --- | --- | --- | --- | --- |
| 0x027f | 210 | 210 (127 instead of 126) | 1 | 1 | 1 (a fade-edge FastFade case) |
| 0x007f | 210 | 210 | 13 | 75 | 13 (fade-edge Fade cases end a frame later, FastFade ones a frame earlier) |

The translation matches each control word at its own precision. Which word the game thread uses during
Update is still open (§8.1). Play runs at 64, as galaxy-audio.mjs does.

### 10.5 Play behaviour and its evidence

`scripts/validate-galaxy-music-play.mjs` boots each map headless in its own process, on a simulated clock,
with the HUD painted every frame (Galaxy Update follows it, `0x1038f638`).

**00_Intro** (the mirror library):

- **First frame.** One batch: SetVolumes (126, 76), glxLoadMusic of 1,843,231 + 1024 bytes, SetVolumes,
  stop, clear voices 16..47, start, glxControlMusic(2, 0), break flag. Transition becomes 0, the Handle −1,
  and Data is emptied. The log reads `Load music: Music Intro_Music.Intro_Music`.
- **Idle frames.** No music ops follow. The only batch is MissionIntro's `SetInstantSoundVolume(32)`
  (`setSampleVolume(127)`). SongSection is 255: the mirror's order, since it has no sequencer.
- **Player start** (`game.reset()`) issues no library op. The reloaded LevelInfo holds the same Song
  reference. The new PostLogin's Fade gives 65 SetVolumes frames, with the music volume falling 76 → 0,
  then the restart batch with no unload or load. This is the original's LoadMap as §5.3 derives it: the
  map package reloads in place, the music package stays loaded, and the collection keeps the UMusic the
  new LevelInfo references.
- **`dispose()`.** Issues glxStopMusic and glxUnloadMusic, each outside a lock, and clears `+0x888`.

**00_Training** goes through the browser host's proxy (`createGame({musicLibrary})`). The first frame posts
one encoded batch: the load+start ops with Training_Music's 1,449,937 + 1024 bytes. `order()` gives
SongSection 0xff, and `dispose()` posts the unregister.

**01_NYC_UNATCOIsland**, W held. The first frame loads LibertyIsland_Music and starts section 0. At tick
1871, MeetPaul's state change runs UpdateDynamicMusic's `ClientSetMusic(Level.Song, 4, 255, MTRAN_Fade)`.
That gives 64 fading frames, then section 4 restarts on the loaded module.

**State digests.**

- bench-sim's digests do not change: it never paints the HUD, so Galaxy Update never runs.
- Play's `state-digest.mjs` digest changes from the first painted frame. A field diff of 00_Intro after 300
  frames, against the same run with the section disabled, shows exactly two changed fields:
  `JCDentonMale0.Transition` 3 → 0 and `SongSection` 0 → 255.
- Any digest reference taken before phase 4 from a painted run is stale for those two fields. No checked-in
  validator holds one.

**Cost** (host timing, Linux host):

- **Steady state** (Transition 0): a microbenchmark of lock, update and unlock gives 98–132 ns per frame;
  in place it is 3–5 µs, which includes the timing wrapper.
- **Transition frames:** median 29–38 µs. The song-load frame is 1.6–1.9 ms, for the copy of the module
  into the grown Data buffer.
- **Galaxy Update**, with and without the section, interleaved: 308–314 / 306–312 µs median on 00_Intro and
  821–863 / 834–849 µs on Island, over two runs each. The difference is within noise; its sign flips between runs.

### 10.6 Still open

- The game thread's control word (§8.1).
- The mirror's and the host proxy's song length: unknown until the library reports it.
- **Same-song map changes.** The original keeps the UMusic and fades; Play disposes the runtime and reloads
  without a fade.
- **SetViewport's attach.** Its SetVolumes and its `Transition = 1` for a viewport actor with a Song are not
  modelled. Play has no SetViewport, and NewMusic's SetVolumes precedes every load.
- The load-graph UMusic path (DynamicLoadObject music).
- The CD branch.
- The zone reverb tail.

**Rerun.**

```
NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-galaxy-music-update.mjs [--reuse] [--only NAME]
node scripts/validate-galaxy-music-play.mjs [--map 00_Intro|00_Training|01_NYC_UNATCOIsland]
```
