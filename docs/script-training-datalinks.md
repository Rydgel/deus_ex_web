# Authored `00_Training` DataLink catalog

`loadTrainingDataLinkCatalog` in
[`src/runtime/script-training-datalinks.mjs`](../src/runtime/script-training-datalinks.mjs)
is a read-only, source-backed catalog for every `DataLinkTrigger` actor in
`00_Training.dx`. It does not install callbacks or run a DataLink lifecycle.
The async API accepts the shared `AssetStore` and optionally an already decoded
`00_Training` asset/map:

```js
const catalog = await loadTrainingDataLinkCatalog(assets, { mapAsset, map });
const route = catalog.routeForTag('DL_START');
route.chain.speech.text;       // exact ConSpeech text
route.audio.bytes;             // owned copy of the original MP3 payload
route.audio.seconds;           // original ConSys MPEG timing result
```

The catalog walks `DeusExConText.ConList_Mission00` through its authored
`ConItem` linked list rather than maintaining a replacement table. It keeps the
70 Mission 0 `bDataLinkCon` conversations available for name resolution, then
joins the 18 triggers actually authored in the map. All route names are matched
with the same case-insensitive comparison used by
`DeusExPlayer.GetActiveDataLink`.

## Evidence and decoding

The original `DataLinkTrigger` source declares `datalinkTag`, `checkFlag`, and
`bCheckFalse`. `Touch` and `Trigger` pass the tag to
`DeusExPlayer.StartDataLinkTransmission`; the player source scans its bound
`ConListItem` chain, rejects a `bDisplayOnce` conversation when
`<ConName>_Played` is true, and evaluates the conversation flag references.
The catalog therefore reports the effective played flag and the trigger's
authored check flag together.

Each Training route is verified to have this exact object chain:

```text
Conversation -> ConEventSpeech -> ConSpeech
                         \-> ConEventEnd (eventType 18)
```

The speech and end event `Conversation` references must point back to the
conversation export. The first event must be a `ConEventSpeech`, its `nextEvent`
must be a `ConEventEnd`, and its `ConSpeech` must contain nonempty authored
text and a nonnegative sound ID. Every Training speech binds `JaimeReyes` and
speaks to `JCDenton`. The existing content loader verifies the shared
`DataLinkPlay.infoLinkNames[9]` mapping to `Jaime Reyes` and decodes
`InfoPortraits.JaimeReyes` export 28. The catalog rehashes those decoded RGBA
pixels and exposes them at `catalog.speaker.portrait`:

```text
64 x 64, P8, opaque RGBA SHA-256
b2811f056a7c9af1990351a6593708bd4d0244402c1f6de2492b716d5954d0ef
```

For each speech sound ID, the loader follows the native filename convention
`ConAudioMission00_<soundID>` into `DeusExConAudioMission00.u`, validates the
serialized `Sound` lazy header as `mp3`, copies exactly the inline bytes, hashes
those bytes, and applies the recovered `DConversation::GetSoundLength` MPEG
calculation. `route.audio.bytes` remains encoded original data; native
`FSoundData` ownership, mixer conversion, and `ClientHearSound` are outside
this catalog.

## Trigger records

Collision dimensions below are effective values after the original
`ClassDefaults` merge. A blank serialized dimension in the map therefore uses
the authored `DataLinkTrigger` class default of 96×40. The initial flag set is
also the effective class/map state. All routes use `TriggerType=0`
(`TT_PlayerProximity`), `bInitiallyActive=true`, `bTriggerOnceOnly=true`,
`bHidden=true`, `bCheckFalse=false`, `bCheckFlagTimer=false`, and
`checkFlagTimer=1`. Their native-zero collision flags are
`bCollideWorld=false`, `bCollideWhenPlacing=false`, `bBlockActors=false`,
`bBlockPlayers=false`, and `bProjTarget=false`; their actor flags are
`bStatic=false`, `bNoDelete=false`, `bDeleteMe=false`, `bGameRelevant=false`,
and `bMovable=true`.

| Trigger | DataLink tag | Actor `Tag` | Location `(X,Y,Z)` | Radius × height | `bCollideActors` | `checkFlag` | Played flag |
| --- | --- | --- | --- | ---: | :---: | --- | --- |
| `DataLinkTrigger23` | `dl_start` | `DataLinkTrigger` | `(-811.616638, 832.431335, -75.067444)` | 300 × 20 | true | — | `DL_Start_Played` |
| `DataLinkTrigger24` | `dl_door` | `DataLinkTrigger` | `(-309.724121, 840.977051, -78.447487)` | 150 × 20 | true | — | `DL_door_Played` |
| `DataLinkTrigger4` | `dl_key` | `DataLinkTrigger` | `(385.213379, 849.000732, -148.447479)` | 200 × 20 | true | — | `DL_key_Played` |
| `DataLinkTrigger31` | `dl_crate` | `DataLinkTrigger` | `(1067, 127.830078, -72.447479)` | 200 × 20 | true | — | `DL_crate_Played` |
| `DataLinkTrigger7` | `dl_keypad` | `DataLinkTrigger` | `(1737.743896, 852.535645, -141.447479)` | 200 × 20 | true | — | `DL_keypad_Played` |
| `DataLinkTrigger8` | `dl_dark` | `DataLinkTrigger` | `(4264.266113, 846.047852, -141.447479)` | 200 × 20 | true | — | `DL_dark_Played` |
| `DataLinkTrigger9` | `dl_part2` | `DataLinkTrigger` | `(5465.376953, 549.596436, -141.447479)` | 200 × 20 | true | — | `DL_part2_Played` |
| `DataLinkTrigger10` | `dl_jump` | `DataLinkTrigger` | `(6991.212891, -54.746338, 5.552521)` | 200 × 20 | true | — | `DL_jump_Played` |
| `DataLinkTrigger11` | `dl_ladder` | `DataLinkTrigger` | `(6991.965820, -2362.698975, 5.552521)` | 200 × 20 | true | — | `DL_ladder_Played` |
| `DataLinkTrigger12` | `dl_swim` | `DataLinkTrigger` | `(6538.264648, -4009.103516, 5.552521)` | 200 × 20 | true | — | `DL_swim_Played` |
| `DataLinkTrigger18` | `dl_multitool` | `DataLinkTrigger` | `(2315.950439, 826.298584, -151.899567)` | 200 × 40 | true | — | `DL_multitool_Played` |
| `DataLinkTrigger19` | `dl_repairbot` | `DataLinkTrigger` | `(5109.035156, 488.160156, -151.900009)` | 150 × 40 | true | — | `DL_repairbot_Played` |
| `DataLinkTrigger20` | `dl_medbot` | `DataLinkTrigger` | `(5068.892578, -4054.106445, 8.099991)` | 150 × 40 | true | — | `DL_medbot_Played` |
| `DataLinkTrigger25` | `dl_lockstr` | `DataLinkTrigger` | `(1289.049194, 143.366211, -87.899910)` | 50 × 40 | true | `dl_crate_played` | `DL_lockstr_Played` |
| `DataLinkTrigger27` | `dl_cratestack` | `DataLinkTrigger` | `(7063.582031, -1632.376587, 8.099869)` | 150 × 40 | true | — | `DL_cratestack_Played` |
| `DataLinkTrigger6` | `dl_body` | `DataLinkTrigger` | `(3684.500732, 855.227783, -72.447479)` | 250 × 20 | true | — | `DL_body_Played` |
| `DataLinkTrigger32` | `dl_bodyexit` | `bodydoorsopen` | `(3747.576904, 443.154083, -39.900139)` | 96 × 40 | false | — | `DL_bodyexit_Played` |
| `DataLinkTrigger1` | `dl_f1f2` | `DataLinkTrigger` | `(381.449097, 448.742279, -100.447479)` | 100 × 20 | true | — | `DL_F1F2_Played` |

The `actorSlot` and map export index are retained in each `trigger` record for
callers that need to connect a catalog route back to the decoded level actor.
The `serialized` subrecord distinguishes map-authored overrides from class
defaults; it is intentionally not used as a second source of effective state.

## Conversation and audio records

The following table is generated from the returned route records. `Speech`
and `End` are export indices in `DeusExConText.u`; `Sound` is the export index
in `DeusExConAudioMission00.u`. Every row has `speakerName=JaimeReyes`,
`displayName=Jaime Reyes`, `audioPackageName=Mission00`, `bDataLinkCon=true`,
and `bDisplayOnce=true`.

| Tag | Conversation (export) | Speech → End | Sound ID (export) | MP3 bytes | SHA-256 | Seconds |
| --- | --- | --- | ---: | ---: | --- | ---: |
| `dl_start` | `DL_Start` (1926) | 32934 → 32549 | 79 (81) | 43056 | `f6367c840ed5988bd8d845125e67011d272799f5ec986039117c2634a8e2760c` | 7.176000118255615 |
| `dl_door` | `DL_door` (1866) | 43413 → 43351 | 41 (43) | 26052 | `53414c07a3ed032cb344ab7f353f5b98ab8f732ddb8ca04d3f4d244e3f02d529` | 4.3420000076293945 |
| `dl_key` | `DL_key` (1881) | 41700 → 41646 | 52 (54) | 61620 | `e893cab5ee815b04272fd075710064b0bedf10318efdc7e88502be638296a452` | 10.270000457763672 |
| `dl_crate` | `DL_crate` (1848) | 44977 → 44923 | 32 (34) | 42588 | `df082f97199a5727c88575b34bbfdc1380f7faf1602276e0b01a5b38a2c355f4` | 7.0980000495910645 |
| `dl_keypad` | `DL_keypad` (1737) | 41565 → 41507 | 53 (55) | 79872 | `e5141ef051db4c40af291cc9111db82363e34537c47b01ed4ecbbf545cdae9b1` | 13.312000274658203 |
| `dl_dark` | `DL_dark` (1852) | 44701 → 44647 | 34 (36) | 56004 | `bd5392b25a71cd07b1d0796d1d2d950a5b5359754e80e69f0c03e6af1b98dde8` | 9.333999633789062 |
| `dl_part2` | `DL_part2` (1897) | 39412 → 39355 | 67 (69) | 110292 | `a93e6eb373cbaa4660987f5e853f64ba1c5493dc5dea1867accb832d65b76300` | 18.381999969482422 |
| `dl_jump` | `DL_jump` (1795) | 41851 → 41784 | 51 (53) | 37908 | `80cc18540327f5239fd74fba816a9971c7d2729bf06afac746aa168afda0c72f` | 6.317999839782715 |
| `dl_ladder` | `DL_ladder` (1884) | 41417 → 41360 | 54 (56) | 34476 | `a2072c3a2364a55a5ea499612c1eab5e7685507e063e936e880d3420ad6f68ad` | 5.745999813079834 |
| `dl_swim` | `DL_swim` (1816) | 27188 → 27050 | 86 (88) | 133380 | `f7fa3017e02c3aa55718c6973b6380731cba3c1248afd1a6ffa3688b86823607` | 22.229999542236328 |
| `dl_multitool` | `DL_multitool` (1892) | 40269 → 40207 | 61 (63) | 107796 | `d6a40b88007b93e06fc555981566ded2b5a4e046810fb587483a8997c3b46dc6` | 17.965999603271484 |
| `dl_repairbot` | `DL_repairbot` (1799) | 37963 → 37848 | 73 (75) | 64116 | `f3c5f80ac58c524000711ff49af02466d3abe60c9c06e191b5f18c74f0b5799d` | 10.685999870300293 |
| `dl_medbot` | `DL_medbot` (1891) | 40415 → 40355 | 60 (62) | 76440 | `0363873a1433b585dd3681449d6d8dd74bfcc4427bdfd63ab3e464a31ac65e60` | 12.739999771118164 |
| `dl_lockstr` | `DL_lockstr` (1888) | 40763 → 40683 | 58 (60) | 95940 | `1e7d3bd68e599ebe3af2a115a613b7bcce27423a7bf5034eb72ed834e51d6cca` | 15.989999771118164 |
| `dl_cratestack` | `DL_cratestack` (1851) | 44836 → 44782 | 33 (35) | 105300 | `c4a782ae4e6fd6a1f64406c1154f37aacadc97b8bc5695f5771c450edf757a9d` | 17.549999237060547 |
| `dl_body` | `DL_body` (1853) | 45589 → 45514 | 28 (30) | 92820 | `2a1f67064b20860cbbaa7ac677e6f172994e56c8bf45184546f50888030d01fc` | 15.470000267028809 |
| `dl_bodyexit` | `DL_bodyexit` (1854) | 45433 → 45379 | 29 (31) | 33072 | `30e28b5bd125adbbc174e5841156da82605e3999be36b67becf5045476132307` | 5.51200008392334 |
| `dl_f1f2` | `DL_F1F2` (1867) | 43058 → 43001 | 43 (45) | 132756 | `7aad1a2f03197a4e42e96205e6249dc71ca3a3385e6f1c3cf6d5c012cc39cc05` | 22.125999450683594 |

The complete authored speech strings are available as
`route.chain.speech.text`. The focused validator keeps exact source-string
regression cases alongside every route's event, sound, hash, timing, location,
and collision assertions:

```sh
node scripts/validate-training-datalinks.mjs
```

## Unsupported branches

This catalog deliberately stops at authored data. It does not claim that all
18 routes can currently be played by the live browser lifecycle. The live
adapter currently admits only `DL_Start`; other routes need their original
event side effects and the generic `DataLinkPlay` scheduler wired before they
can be entered. The catalog does not model DataLink queueing, abort/resume,
continued speech, non-speech event types, or native window destruction. It also
does not bind the native sound archive, audio mixer, or original HUD renderer.
Those are runtime and presentation boundaries rather than missing source data.
