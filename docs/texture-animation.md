# Texture animation

Animated surface textures (computer screens, LED pads, flashing lights) are
chains of `UTexture` objects linked by `AnimNext`. Engine.dll advances a
chain each time the renderer asks for the texture; Render.dll draws the
current frame. Procedural textures (Fire.dll: fire, water, wet, ice) override
the same virtual functions and are not covered here.

## Engine.dll (`0c3a8b18…`)

The plain `UTexture` vftable (`??_7UTexture@@6B@`, `0x1042672c`) has Tick at
`+0x68`, ConstantTimeTick at `+0x6c` and Update at `+0x78`. Retail field
offsets differ from the SDK header by 4 bytes before `+0x4c`; the
instructions are the authority:

| Offset | Field |
| --- | --- |
| `+0x4c` | LastUpdateTime (double; script `InternalTime[2]`) |
| `+0x84` | flags (`4` bRealtime, `0x10` bRealtimeChanged) |
| `+0x8c` | AnimNext |
| `+0x90` | AnimCur (transient) |
| `+0x94` / `+0x95` | PrimeCount / PrimeCurrent (bytes) |
| `+0x98` / `+0x9c` | MinFrameRate / MaxFrameRate (floats) |
| `+0xa0` | Accumulator (float, transient) |

- **Get** (`0x103212e0`): Update(Time), then AnimCur, or the texture itself
  when AnimCur is None.
- **Update** (`0x103ecb70`): returns when Time equals LastUpdateTime (fcomp,
  so also when unordered). Otherwise it counts statistics, sets
  bRealtimeChanged on a bRealtime texture, calls Tick with the float
  `Time - LastUpdateTime`, and stores Time.
- **Tick** (`0x103ed0d0`): while PrimeCurrent < PrimeCount, PrimeCurrent++ and
  ConstantTimeTick. A MaxFrameRate equal to 0.0 (or NaN) means one
  ConstantTimeTick per Update. Otherwise `MinTime = f32(1/Clamp(MaxFrameRate,
  0.01f, 100f))` and `MaxTime = f32(1/Clamp(MinFrameRate, 0.01f, 100f))`. The
  sum `Delta + Accumulator` is compared unrounded and stored as a float:
  below MinTime, nothing; below MaxTime, ConstantTimeTick and Accumulator 0;
  else ConstantTimeTick, Accumulator -= MaxTime (compared unrounded), capped
  at MaxTime.
- **ConstantTimeTick** (`0x103ed330`): AnimCur starts at the texture, follows
  AnimNext and wraps to the texture at a None.
- **PostLoad** (`0x103ed8f0`) clamps UClamp/VClamp, sets Accumulator to 0 and
  LastUpdateTime to the current clock. The `InternalTime` values the packages
  carry (the editor's clock, about 1.0e5–1.6e5 s) are therefore overwritten
  at load.
- The clock is UViewport::Lock's `CurrentTime` (`+0xb0`): the CPU timestamp
  counter times GSecondsPerCycle when GTimestamp is set, else
  appSecondsSlow (Lock `0x10373797`; PostLoad uses the same expression). Only
  differences reach the animation, so Play uses `performance.now()`.

`src/runtime/texture-animation.mjs` translates Get, Update, Tick and
ConstantTimeTick on the x87 model. `scripts/validate-native-texture-animation.mjs`
runs the original bodies (`native-texture-animation-oracle.py`) on fabricated
chains: links, cycles, self links, priming, rates at and around the clamps,
zero, negative, infinite and NaN rates, saved accumulators and AnimCur,
backwards and repeated times, NaN times and appSeconds-sized first updates.
309 cases and 4,127 Get calls match: the returned frame, AnimCur,
PrimeCurrent, Accumulator bits and LastUpdateTime bits after each. Comparing
the stored accumulator instead of the unrounded sum fails it.

## Render.dll (`607f1077…`)

The BSP surface pass (`0x10b1a2d0`) takes each draw-list surface's texture,
`Texture->Update(Viewport->CurrentTime)` (vtable `+0x78`) and draws AnimCur or
the texture. A surface without a texture draws the viewport actor's
`Level.DefaultTexture` (`+0x508`). When the viewport actor is a PlayerPawn
whose `Sprite` (`+0x168`) is set, that texture replaces every surface's (Get
too); the player's Sprite is None in play.

The same pass pans: `PanU = f32(Surf.PanU + (ftol(Zone.TexUPanSpeed ·
Level.TimeSeconds · 35f · 256.0) & 0x3ffff) · (1/256))` under `PF_AutoUPan`
(`0x200`), and the same for V with TexVPanSpeed under `PF_AutoVPan`
(`0x400`). `Zone` is the draw list's zone actor (`+0x34`), Level is
`Frame->Level`'s LevelInfo (asserted). `PF_SmallWavy` (`0x2000`) follows.
These are recovered but not yet in the viewer.

## Play

`src/viewer/world.mjs` keeps one record per texture object with PostLoad's
state and its AnimNext record, prepares every frame of a chain as a GPU
texture of the material's variant, and on each drawn frame (before rendering,
UViewport::Lock's moment) calls Get for every animated head and points the
materials using it at the frame's texture. Animated materials stay out of
the merged opaque batches, whose texture slots are fixed. A frame whose size
differs from the head's keeps the head's UV scale and is noted (none in
Training).

Unverified: the original runs Update only for surfaces in its draw list after
BSP occlusion, which is not recovered, so a texture out of view keeps
advancing here instead of advancing once when it reappears. The world notes
this. Mesh skins with AnimNext still throw as unsupported.

`scripts/validate-texture-animation-play.mjs` loads Training in headless
Chromium: its 12 animated heads (14 materials) advance, each change follows
the chain's AnimNext, and every material draws the shown frame.
