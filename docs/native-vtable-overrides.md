# Native virtual overrides in the game's own DLLs

Census of 2026-10-13, made after the Island live comparison found that `AScriptedPawn::Tick` (DeusEx.dll `0x100195a0`) was not
modelled anywhere in Play ([live divergence](script-pawn-locomotion.md#live-divergence-the-tactics-event-is-alterdestination-2026-10-13);
the Terrorist18 case below). The question: which other virtual functions do DeusEx.dll, Extension.dll and ConSys.dll override that Play does
not model?

## Method

`node scripts/census-native-overrides.mjs --markdown` (needs `.cache/sdk-layouts.json` with vftables, see [SDK reference](sdk-reference.md)):

1. For every class of the three DLLs (the classes the SDK headers declare, plus every class whose vftable `??_7Class@@6B@` the
   DLL exports) take the SDK's vftable (`scripts/sdk-layouts.mjs`): the slots whose owner is the class itself, destructors apart, are its
   declared overrides or new virtuals.
2. Read the retail vftable of the class and its base's from the DLLs: slot `n` is the dword at `vftable + 4n`. A slot that is only a
   `jmp [IAT]` stands for the imported function it forwards to (the DLLs carry forwarding thunks for inherited virtuals).
   Slots whose function differs from the base's and that the SDK does not list would be "retail only"; **there are none**: the SDK's
   override list is the retail one for the 43 classes (the hidden `AScriptedPawn.h` adds `Tick`, which the SDK declares in the class).
3. For each override, mention counts in `src`, `native`, `docs`, `scripts`, `tools`: of its retail address, else of `Class::Method`.

## Result

280 overriding slots in 43 classes (43 of the 89 classes with exported or declared vftables; the others override nothing but destructors).
85 are not mentioned anywhere by address or name, and of those the game logic is reached by **one**:

| Package | Classes (overriding slots) | Reached by shipped content | Play models |
|---|---|---|---|
| DeusEx | `AScriptedPawn::Tick`; `ADeusExPlayer::Destroy`; `UParticleIterator::CurrentItem`; `UDeusExSaveInfo::Destroy` | every NPC on every tick; the player's destruction; the render iterators; saves | Destroy x2 and CurrentItem yes; **`AScriptedPawn::Tick` no** |
| ConSys | `DConEvent::BindActor`, `ImportFile`; `DConHistory::Destroy`; `DConAudioList::Serialize` | conversations | BindActor and Destroy yes; ImportFile and Serialize are editor/package-load only |
| Extension (game) | `APlayerPawnExt::Destroy`, `PreRenderWindows`, `PostRenderWindows`; `XGameEngineExt` (Destroy, Serialize, Tick, Init, Key, MouseDelta, MousePosition, Browse); `XInputExt::PreProcess/Process`; `XFlag*::SetValue/GetValue` | HUD/UI every frame; the engine loop and input; the flag store | Destroy, Key, Tick (host loop) and the input chain yes; **`Pre/PostRenderWindows` and the XFlag accessors not by address or name** (check, below) |
| Extension (windows) | 20 window classes, 220 slots | menus, HUD, computers | by family (script-window-* docs); the 63 not mentioned are mostly default `XWindow` virtuals (empty bodies), `Serialize`, `ConfigurationChanged` of the scale, scroll and border windows |

The follow-ups this leaves, in the order content reaches them:

1. **`AScriptedPawn::Tick`** (2.1 KB plus `0x10019e30` and `0x10019f60`): see [ScriptedPawn native tick](script-scripted-pawn-tick.md).
2. `APlayerPawnExt::PreRenderWindows/PostRenderWindows` (`0x10038300`, `0x10038380`) run for the HUD each frame. Play's HUD
   (`src/runtime/script-play-hud.mjs`, native 1051) reaches them through the script natives that call them; whether the virtual
   bodies are exactly what those paths translate has not been read (small).
3. `XFlag*::SetValue/GetValue` (the mission flag store): `src/runtime/script-triggers.mjs` models the XFlagBool/XFlagBase operations
   (low-bit store, GetBool) by name; the other flag types (Byte, Int, Float, Name, Vector, Rotator) are not mentioned (small).
4. The unmentioned window overrides: the family-level window work covers the screens that the census reaches; a window the
   census has not reached would show as an unmodelled virtual here.

## All overriding slots

| Class | Slot | Function (SDK) | Retail address | Repo mentions |
|---|---|---|---|---|
| DeusEx:ADeusExPlayer | 9 | void ADeusExPlayer::Destroy() | `0x100141f0` | address: src/runtime/script-player-destroy.mjs, docs/script-loadmap-gc.md +3 |
| DeusEx:AScriptedPawn | 25 | UBOOL AScriptedPawn::Tick(FLOAT, ELevelTick) | `0x100195a0` | **none** |
| DeusEx:UParticleIterator | 25 | AActor *UParticleIterator::CurrentItem() | `0x1001ab20` | address: src/runtime/script-particles.mjs, docs/particles.md +1 |
| DeusEx:UDeusExSaveInfo | 9 | void UDeusExSaveInfo::Destroy() | `0x101025f4` (same as parent) | address: docs/script-destroy.md, docs/script-object-release.md +1 |
| Extension:XBorderWindow | 21 | void XBorderWindow::Init(XWindow *) | `0x100010c0` | **none** |
| Extension:XBorderWindow | 22 | void XBorderWindow::CleanUp() | `0x10001210` | address: src/runtime/script-text-parser-natives.mjs, src/runtime/script-text-parser.mjs +1 |
| Extension:XBorderWindow | 25 | XCursor *XBorderWindow::CursorRequested(XWindow *, FLOAT, FLOAT, FLOAT &, FLOAT &, FColor &, UTexture **) | `0x100016c0` | **none** |
| Extension:XBorderWindow | 31 | void XBorderWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x10001a40` | **none** |
| Extension:XBorderWindow | 34 | UBOOL XBorderWindow::ChildRequestedReconfiguration(XWindow *) | `0x100421d0` | address: src/runtime/script-window-host.mjs, docs/sdk-reference.md +1 |
| Extension:XBorderWindow | 36 | void XBorderWindow::ConfigurationChanged() | `0x10001bc0` | **none** |
| Extension:XBorderWindow | 39 | void XBorderWindow::MouseMoved(FLOAT, FLOAT) | `0x100020e0` | **none** |
| Extension:XBorderWindow | 48 | UBOOL XBorderWindow::MouseButtonPressed(FLOAT, FLOAT, EInputKey, INT) | `0x10001e00` | **none** |
| Extension:XBorderWindow | 49 | UBOOL XBorderWindow::MouseButtonReleased(FLOAT, FLOAT, EInputKey, INT) | `0x10001ff0` | **none** |
| Extension:XBorderWindow | 54 | void XBorderWindow::Draw(XGC *) | `0x10001ce0` | **none** |
| Extension:XButtonWindow | 21 | void XButtonWindow::Init(XWindow *) | `0x10007640` | address: src/runtime/script-window-families.mjs |
| Extension:XButtonWindow | 22 | void XButtonWindow::CleanUp() | `0x10007770` | address: src/runtime/script-window-host.mjs, docs/script-window-input.md |
| Extension:XButtonWindow | 30 | void XButtonWindow::Timer(XTimerId, INT, XTimerData) | `0x100080e0` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-timers.mjs +2 |
| Extension:XButtonWindow | 38 | void XButtonWindow::SensitivityChanged(UBOOL) | `0x10007f10` | address: src/runtime/script-window-host.mjs |
| Extension:XButtonWindow | 39 | void XButtonWindow::MouseMoved(FLOAT, FLOAT) | `0x10007e30` | address: src/runtime/script-window-mouse.mjs, docs/script-window-input.md |
| Extension:XButtonWindow | 42 | void XButtonWindow::FocusEnteredWindow() | `0x10007fc0` | address: src/runtime/script-window-mouse.mjs, docs/script-window-input.md |
| Extension:XButtonWindow | 43 | void XButtonWindow::FocusLeftWindow() | `0x10008050` | address: src/runtime/script-window-mouse.mjs, docs/script-window-input.md |
| Extension:XButtonWindow | 48 | UBOOL XButtonWindow::MouseButtonPressed(FLOAT, FLOAT, EInputKey, INT) | `0x10007bd0` | **none** |
| Extension:XButtonWindow | 49 | UBOOL XButtonWindow::MouseButtonReleased(FLOAT, FLOAT, EInputKey, INT) | `0x10007d10` | **none** |
| Extension:XButtonWindow | 53 | void XButtonWindow::Tick(FLOAT) | `0x10008190` | address: src/runtime/script-window-family-draw.mjs |
| Extension:XButtonWindow | 54 | void XButtonWindow::Draw(XGC *) | `0x100082c0` | address: src/runtime/script-window-family-draw.mjs, docs/script-window-host.md |
| Extension:XButtonWindow | 73 | void XButtonWindow::PressButton(EInputKey) | `0x10007b20` | address: src/runtime/script-window-input.mjs, docs/script-window-input.md |
| Extension:XCheckboxWindow | 21 | void XCheckboxWindow::Init(XWindow *) | `0x1000a710` | address: src/runtime/script-window-families.mjs, docs/script-window-checkbox.md +3 |
| Extension:XCheckboxWindow | 22 | void XCheckboxWindow::CleanUp() | `0x1000a7d0` | address: src/runtime/script-window-host.mjs, docs/script-window-checkbox.md +1 |
| Extension:XCheckboxWindow | 31 | void XCheckboxWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x1000acb0` | address: src/runtime/script-window-family-layout.mjs, docs/script-window-checkbox.md +3 |
| Extension:XCheckboxWindow | 54 | void XCheckboxWindow::Draw(XGC *) | `0x1000aad0` | address: src/runtime/script-window-family-draw.mjs, docs/script-window-checkbox.md +3 |
| Extension:XClipWindow | 21 | void XClipWindow::Init(XWindow *) | `0x1000b320` | address: docs/script-window-scroll-children.md |
| Extension:XClipWindow | 22 | void XClipWindow::CleanUp() | `0x1000b400` | **none** |
| Extension:XClipWindow | 31 | void XClipWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x1000c660` | **none** |
| Extension:XClipWindow | 33 | void XClipWindow::ChildRequestedVisibilityChange(XWindow *, UBOOL) | `0x1000c2e0` | **none** |
| Extension:XClipWindow | 34 | UBOOL XClipWindow::ChildRequestedReconfiguration(XWindow *) | `0x100421d0` (same as parent) | address: src/runtime/script-window-host.mjs, docs/sdk-reference.md +1 |
| Extension:XClipWindow | 35 | void XClipWindow::ChildRequestedShowArea(XWindow *, FLOAT, FLOAT, FLOAT, FLOAT) | `0x1000c360` | address: docs/script-window-scroll-show-area.md |
| Extension:XClipWindow | 36 | void XClipWindow::ConfigurationChanged() | `0x1000c560` | **none** |
| Extension:XComputerWindow | 10 | void XComputerWindow::Serialize(FArchive &) | `0x1000d830` | **none** |
| Extension:XComputerWindow | 21 | void XComputerWindow::Init(XWindow *) | `0x1000d530` | address: src/runtime/script-window-computer.mjs, docs/script-window-computer.md |
| Extension:XComputerWindow | 22 | void XComputerWindow::CleanUp() | `0x1000d6d0` | address: src/runtime/script-window-computer-playback.mjs, docs/script-window-computer-playback.md |
| Extension:XComputerWindow | 37 | void XComputerWindow::VisibilityChanged(UBOOL) | `0x1000ee70` | address: src/runtime/script-window-computer-playback.mjs, docs/script-window-computer-playback.md |
| Extension:XComputerWindow | 51 | UBOOL XComputerWindow::VirtualKeyPressed(EInputKey, UBOOL) | `0x1000f530` | address: src/runtime/script-window-host.mjs, docs/script-window-computer-terminals.md +1 |
| Extension:XComputerWindow | 53 | void XComputerWindow::Tick(FLOAT) | `0x1000f7b0` | address: src/runtime/script-window-computer-playback.mjs, docs/script-window-computer-playback.md |
| Extension:XComputerWindow | 54 | void XComputerWindow::Draw(XGC *) | `0x1000ed60` | address: src/runtime/script-window-computer-playback.mjs, docs/script-window-computer-playback.md |
| Extension:XComputerWindow | 70 | UBOOL XComputerWindow::EditActivated(XWindow *, UBOOL) | `0x1000f330` | **none** |
| Extension:XEditWindow | 10 | void XEditWindow::Serialize(FArchive &) | `0x1001d1d0` | **none** |
| Extension:XEditWindow | 21 | void XEditWindow::Init(XWindow *) | `0x1001cea0` | address: src/runtime/script-window-edit.mjs, docs/script-edit-model.md +1 |
| Extension:XEditWindow | 22 | void XEditWindow::CleanUp() | `0x1001d0b0` | address: src/runtime/script-edit-model.mjs, src/runtime/script-window-edit.mjs +2 |
| Extension:XEditWindow | 25 | XCursor *XEditWindow::CursorRequested(XWindow *, FLOAT, FLOAT, FLOAT &, FLOAT &, FColor &, UTexture **) | `0x10020940` | address: src/runtime/script-window-edit.mjs, docs/script-large-text-window.md +1 |
| Extension:XEditWindow | 31 | void XEditWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x10020ac0` | address: src/runtime/script-window-edit.mjs, docs/script-large-text-window.md +1 |
| Extension:XEditWindow | 36 | void XEditWindow::ConfigurationChanged() | `0x10020ba0` | address: src/runtime/script-window-edit.mjs, docs/script-large-text-window.md +1 |
| Extension:XEditWindow | 37 | void XEditWindow::VisibilityChanged(UBOOL) | `0x10020c60` | address: src/runtime/script-window-edit.mjs, docs/script-large-text-window.md +1 |
| Extension:XEditWindow | 39 | void XEditWindow::MouseMoved(FLOAT, FLOAT) | `0x100216b0` | address: src/runtime/script-window-edit.mjs, docs/script-large-text-window.md +1 |
| Extension:XEditWindow | 48 | UBOOL XEditWindow::MouseButtonPressed(FLOAT, FLOAT, EInputKey, INT) | `0x10021570` | address: src/runtime/script-window-edit.mjs, docs/script-large-text-window.md +1 |
| Extension:XEditWindow | 49 | UBOOL XEditWindow::MouseButtonReleased(FLOAT, FLOAT, EInputKey, INT) | `0x10021760` | address: src/runtime/script-window-edit.mjs, docs/script-large-text-window.md +1 |
| Extension:XEditWindow | 50 | UBOOL XEditWindow::KeyPressed(TCHAR) | `0x10021290` | address: src/runtime/script-window-edit.mjs, src/runtime/script-window-host.mjs +5 |
| Extension:XEditWindow | 51 | UBOOL XEditWindow::VirtualKeyPressed(EInputKey, UBOOL) | `0x10021480` | address: src/runtime/script-window-edit.mjs, docs/script-large-text-window.md +1 |
| Extension:XEditWindow | 53 | void XEditWindow::Tick(FLOAT) | `0x100207d0` | address: src/runtime/script-window-edit.mjs, docs/script-large-text-window.md +1 |
| Extension:XEditWindow | 54 | void XEditWindow::Draw(XGC *) | `0x10020d00` | address: src/runtime/script-window-edit.mjs, docs/script-large-text-window.md +1 |
| Extension:XEditWindow | 71 | void XEditWindow::SetText(const TCHAR *) | `0x1001e260` | address: src/runtime/script-edit-model.mjs, src/runtime/script-window-host.mjs +1 |
| Extension:XEditWindow | 72 | void XEditWindow::AppendText(const TCHAR *) | `0x1001e310` | address: src/runtime/script-window-edit.mjs, src/runtime/script-window-host.mjs +3 |
| Extension:XEditWindow | 73 | UBOOL XEditWindow::InsertText(const TCHAR *, UBOOL, UBOOL) | `0x1001e3c0` | address: src/runtime/script-edit-insert-text.mjs, src/runtime/script-edit-model.mjs +2 |
| Extension:XEditWindow | 74 | void XEditWindow::DeleteChar(UBOOL, UBOOL) | `0x1001e560` | address: src/runtime/script-edit-delete-char.mjs, src/runtime/script-edit-model.mjs +1 |
| Extension:XEditWindow | 75 | UBOOL XEditWindow::FilterChar(TCHAR &) | `0x10021830` | address: src/runtime/script-edit-model.mjs, docs/script-edit-model.md +1 |
| Extension:XFlag | 9 | void XFlag::Destroy() | `0x10023870` | address: src/runtime/script-player-destroy.mjs, docs/script-flagbase-iterators.md +3 |
| Extension:XFlag | 21 | void XFlag::SetValue(void *) | `0x10003be0` | address: src/runtime/script-window-host.mjs |
| Extension:XFlag | 22 | void XFlag::GetValue(void *) | `0x10003be0` | address: src/runtime/script-window-host.mjs |
| Extension:XFlagBool | 21 | void XFlagBool::SetValue(void *) | `0x1001a5d0` | **none** |
| Extension:XFlagBool | 22 | void XFlagBool::GetValue(void *) | `0x1001a5f0` | **none** |
| Extension:XFlagByte | 21 | void XFlagByte::SetValue(void *) | `0x1001a860` | **none** |
| Extension:XFlagByte | 22 | void XFlagByte::GetValue(void *) | `0x1001a870` | **none** |
| Extension:XFlagInt | 21 | void XFlagInt::SetValue(void *) | `0x1001aac0` | **none** |
| Extension:XFlagInt | 22 | void XFlagInt::GetValue(void *) | `0x1001aad0` | **none** |
| Extension:XFlagFloat | 21 | void XFlagFloat::SetValue(void *) | `0x1001ad10` | **none** |
| Extension:XFlagFloat | 22 | void XFlagFloat::GetValue(void *) | `0x1001ad20` | **none** |
| Extension:XFlagName | 21 | void XFlagName::SetValue(void *) | `0x1001af20` | **none** |
| Extension:XFlagName | 22 | void XFlagName::GetValue(void *) | `0x1001af40` | **none** |
| Extension:XFlagVector | 21 | void XFlagVector::SetValue(void *) | `0x1001b340` | **none** |
| Extension:XFlagVector | 22 | void XFlagVector::GetValue(void *) | `0x1001b360` | **none** |
| Extension:XFlagRotator | 21 | void XFlagRotator::SetValue(void *) | `0x1001b340` | **none** |
| Extension:XFlagRotator | 22 | void XFlagRotator::GetValue(void *) | `0x1001b360` | **none** |
| Extension:XFlagBase | 9 | void XFlagBase::Destroy() | `0x100239f0` | address: src/runtime/script-player-destroy.mjs, src/runtime/script-runtime.mjs +6 |
| Extension:XGC | 9 | void XGC::Destroy() | `0x10026d40` | address: src/runtime/script-window-host.mjs, docs/script-window-destroy.md |
| Extension:XGameEngineExt | 9 | void XGameEngineExt::Destroy() | (vftable not exported) | **none** |
| Extension:XGameEngineExt | 10 | void XGameEngineExt::Serialize(FArchive &) | (vftable not exported) | **none** |
| Extension:XGameEngineExt | 21 | void XGameEngineExt::Tick(FLOAT) | (vftable not exported) | name only: docs/visual-acceptance.md |
| Extension:XGameEngineExt | 25 | void XGameEngineExt::Init() | (vftable not exported) | **none** |
| Extension:XGameEngineExt | 28 | int XGameEngineExt::Key(UViewport *, EInputKey) | (vftable not exported) | name only: src/runtime/script-console-command.mjs, src/runtime/script-window-host.mjs +6 |
| Extension:XGameEngineExt | 31 | void XGameEngineExt::MouseDelta(class UViewport *, DWORD, FLOAT, FLOAT) | (vftable not exported) | **none** |
| Extension:XGameEngineExt | 32 | void XGameEngineExt::MousePosition(class UViewport *, DWORD, FLOAT, FLOAT) | (vftable not exported) | **none** |
| Extension:XGameEngineExt | 42 | UBOOL XGameEngineExt::Browse(FURL, const TMap<FString, FString> *, FString &) | (vftable not exported) | **none** |
| Extension:XInputExt | 23 | UBOOL XInputExt::PreProcess(EInputKey, EInputAction, FLOAT) | (vftable not exported) | name only: src/runtime/script-console-command.mjs |
| Extension:XInputExt | 24 | UBOOL XInputExt::Process(FOutputDevice &, EInputKey, EInputAction, FLOAT) | (vftable not exported) | name only: src/runtime/script-console-command.mjs, src/runtime/script-window-host.mjs +6 |
| Extension:XLargeTextWindow | 10 | void XLargeTextWindow::Serialize(FArchive &) | `0x1002d630` | address: src/runtime/script-window-large-text.mjs |
| Extension:XLargeTextWindow | 21 | void XLargeTextWindow::Init(XWindow *) | `0x1002d480` | address: src/runtime/script-window-large-text.mjs, docs/script-large-text-window.md |
| Extension:XLargeTextWindow | 22 | void XLargeTextWindow::CleanUp() | `0x1002d560` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-large-text.mjs +1 |
| Extension:XLargeTextWindow | 31 | void XLargeTextWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x1002e1d0` | address: src/runtime/script-window-large-text.mjs, docs/script-large-text-window.md +1 |
| Extension:XLargeTextWindow | 32 | void XLargeTextWindow::ParentRequestedGranularity(FLOAT &, FLOAT &) | `0x1002e380` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-large-text.mjs +2 |
| Extension:XLargeTextWindow | 36 | void XLargeTextWindow::ConfigurationChanged() | `0x1002e430` | address: src/runtime/script-window-large-text.mjs, docs/script-large-text-window.md +1 |
| Extension:XLargeTextWindow | 54 | void XLargeTextWindow::Draw(XGC *) | `0x1002e500` | address: src/runtime/script-window-large-text.mjs, docs/script-large-text-window.md +1 |
| Extension:XLargeTextWindow | 71 | void XLargeTextWindow::SetText(const TCHAR *) | `0x1002d6b0` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-large-text.mjs +2 |
| Extension:XLargeTextWindow | 72 | void XLargeTextWindow::AppendText(const TCHAR *) | `0x1002d730` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-large-text.mjs +2 |
| Extension:XListWindow | 10 | void XListWindow::Serialize(FArchive &) | `0x1002ec70` | address: docs/script-window-list-family.md |
| Extension:XListWindow | 21 | void XListWindow::Init(XWindow *) | `0x1002e900` | address: src/runtime/script-window-list.mjs, docs/script-window-list-family.md +1 |
| Extension:XListWindow | 22 | void XListWindow::CleanUp() | `0x1002ead0` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-list.mjs +2 |
| Extension:XListWindow | 31 | void XListWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x10033260` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-list.mjs +2 |
| Extension:XListWindow | 32 | void XListWindow::ParentRequestedGranularity(FLOAT &, FLOAT &) | `0x100332c0` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-list.mjs +2 |
| Extension:XListWindow | 37 | void XListWindow::VisibilityChanged(UBOOL) | `0x10033d90` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-list.mjs +2 |
| Extension:XListWindow | 39 | void XListWindow::MouseMoved(FLOAT, FLOAT) | `0x100338c0` | address: src/runtime/script-window-list.mjs, docs/script-window-list-family.md +1 |
| Extension:XListWindow | 48 | UBOOL XListWindow::MouseButtonPressed(FLOAT, FLOAT, EInputKey, INT) | `0x10033750` | address: src/runtime/script-window-list.mjs, docs/script-window-list-family.md +1 |
| Extension:XListWindow | 49 | UBOOL XListWindow::MouseButtonReleased(FLOAT, FLOAT, EInputKey, INT) | `0x100339c0` | address: src/runtime/script-window-list.mjs, docs/script-window-list-family.md +1 |
| Extension:XListWindow | 50 | UBOOL XListWindow::KeyPressed(TCHAR) | `0x10033ae0` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-list.mjs +5 |
| Extension:XListWindow | 51 | UBOOL XListWindow::VirtualKeyPressed(EInputKey, UBOOL) | `0x10033ca0` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-list.mjs +2 |
| Extension:XListWindow | 53 | void XListWindow::Tick(FLOAT) | `0x10033e50` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-list.mjs +2 |
| Extension:XListWindow | 54 | void XListWindow::Draw(XGC *) | `0x10033350` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-list.mjs +2 |
| Extension:XModalWindow | 10 | void XModalWindow::Serialize(FArchive &) | `0x10036d90` | **none** |
| Extension:XModalWindow | 21 | void XModalWindow::Init(XWindow *) | `0x10036c00` | address: src/runtime/script-window-families.mjs |
| Extension:XModalWindow | 22 | void XModalWindow::CleanUp() | `0x10036cf0` | address: src/runtime/script-window-host.mjs, docs/script-window-input.md |
| Extension:XModalWindow | 29 | void XModalWindow::DescendantRemoved(XWindow *) | `0x10037400` | address: docs/script-window-destroy.md |
| Extension:XModalWindow | 37 | void XModalWindow::VisibilityChanged(UBOOL) | `0x10037330` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-input.mjs +3 |
| Extension:XModalWindow | 50 | UBOOL XModalWindow::KeyPressed(TCHAR) | `0x10037510` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-typed-keys.mjs +2 |
| Extension:XModalWindow | 53 | void XModalWindow::Tick(FLOAT) | `0x100374a0` | address: docs/script-window-root-tick.md |
| Extension:XExtensionObject | 9 | void XExtensionObject::Destroy() | `0x101025f4` (same as parent) | address: docs/script-destroy.md, docs/script-object-release.md +1 |
| Extension:APlayerPawnExt | 9 | void APlayerPawnExt::Destroy() | `0x10037d40` | address: src/runtime/script-player-destroy.mjs, docs/script-loadmap-gc.md +4 |
| Extension:APlayerPawnExt | 45 | void APlayerPawnExt::PreRenderWindows(UCanvas *) | `0x10038300` | **none** |
| Extension:APlayerPawnExt | 46 | void APlayerPawnExt::PostRenderWindows(UCanvas *) | `0x10038380` | **none** |
| Extension:XRadioBoxWindow | 10 | void XRadioBoxWindow::Serialize(FArchive &) | `0x100387b0` | **none** |
| Extension:XRadioBoxWindow | 21 | void XRadioBoxWindow::Init(XWindow *) | `0x10038660` | address: src/runtime/script-window-families.mjs |
| Extension:XRadioBoxWindow | 22 | void XRadioBoxWindow::CleanUp() | `0x10038710` | address: src/runtime/script-window-host.mjs, docs/script-window-checkbox.md |
| Extension:XRadioBoxWindow | 28 | void XRadioBoxWindow::DescendantAdded(XWindow *) | `0x10038b90` | address: src/runtime/script-window-host.mjs |
| Extension:XRadioBoxWindow | 29 | void XRadioBoxWindow::DescendantRemoved(XWindow *) | `0x10038cb0` | address: src/runtime/script-native-class-registry.mjs, src/runtime/script-window-host.mjs +3 |
| Extension:XRadioBoxWindow | 31 | void XRadioBoxWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x100388e0` | address: src/runtime/script-window-family-layout.mjs |
| Extension:XRadioBoxWindow | 33 | void XRadioBoxWindow::ChildRequestedVisibilityChange(XWindow *, UBOOL) | `0x100389d0` | address: src/runtime/script-window-host.mjs |
| Extension:XRadioBoxWindow | 34 | UBOOL XRadioBoxWindow::ChildRequestedReconfiguration(XWindow *) | `0x100421d0` (same as parent) | address: src/runtime/script-window-host.mjs, docs/sdk-reference.md +1 |
| Extension:XRadioBoxWindow | 36 | void XRadioBoxWindow::ConfigurationChanged() | `0x10038840` | address: src/runtime/script-window-family-layout.mjs |
| Extension:XRadioBoxWindow | 60 | UBOOL XRadioBoxWindow::ToggleChanged(XWindow *, UBOOL) | `0x10038a60` | address: src/runtime/script-window-host.mjs, docs/script-window-host.md |
| Extension:XRootWindow | 9 | void XRootWindow::Destroy() | `0x10039320` | address: src/runtime/script-window-host.mjs, docs/script-loadmap-gc.md +2 |
| Extension:XRootWindow | 21 | void XRootWindow::Init(XWindow *) | `0x10005ca0` | address: src/runtime/script-window-host.mjs |
| Extension:XRootWindow | 22 | void XRootWindow::CleanUp() | `0x10039240` | address: src/runtime/script-window-host.mjs, docs/script-loadmap-gc.md +3 |
| Extension:XRootWindow | 23 | UBOOL XRootWindow::ConvertVectorToCoordinates(FVector, FLOAT *, FLOAT *) | `0x10039f10` | address: src/runtime/script-window-projection.mjs, docs/render-pass-precision.md |
| Extension:XRootWindow | 29 | void XRootWindow::DescendantRemoved(XWindow *) | `0x1003b5c0` | address: src/runtime/script-window-host.mjs, docs/script-window-destroy.md |
| Extension:XRootWindow | 34 | UBOOL XRootWindow::ChildRequestedReconfiguration(XWindow *) | `0x1003a6d0` | address: src/runtime/script-window-tree-natives.mjs |
| Extension:XRootWindow | 36 | void XRootWindow::ConfigurationChanged() | `0x1003a660` | address: src/runtime/script-window-tree-natives.mjs |
| Extension:XRootWindow | 53 | void XRootWindow::Tick(FLOAT) | `0x1003a540` | address: docs/script-window-root-tick.md |
| Extension:XRootWindow | 71 | void XRootWindow::Init(APlayerPawnExt *) | `0x10039050` | address: src/runtime/script-window-families.mjs, docs/script-window-host.md |
| Extension:XRootWindow | 72 | UBOOL XRootWindow::HandleMouse(FLOAT, FLOAT) | `0x1003b670` | **none** |
| Extension:XRootWindow | 73 | UBOOL XRootWindow::HandleVirtualKeyboard(EInputKey, EInputAction, UBOOL) | `0x1003b820` | address: src/runtime/script-window-input.mjs, docs/script-window-input.md |
| Extension:XRootWindow | 74 | UBOOL XRootWindow::HandleKeyboard(TCHAR) | `0x1003b720` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-typed-keys.mjs +3 |
| Extension:XRootWindow | 75 | UBOOL XRootWindow::HandleButtons(EInputKey, EInputAction) | `0x1003b960` | address: src/runtime/script-window-input.mjs, docs/script-window-input.md +1 |
| Extension:XScaleWindow | 10 | void XScaleWindow::Serialize(FArchive &) | `0x1003d5f0` | **none** |
| Extension:XScaleWindow | 21 | void XScaleWindow::Init(XWindow *) | `0x1003d200` | address: docs/script-window-scroll-children.md |
| Extension:XScaleWindow | 22 | void XScaleWindow::CleanUp() | `0x1003d4f0` | **none** |
| Extension:XScaleWindow | 31 | void XScaleWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x1003f780` | **none** |
| Extension:XScaleWindow | 36 | void XScaleWindow::ConfigurationChanged() | `0x1003f8f0` | **none** |
| Extension:XScaleWindow | 39 | void XScaleWindow::MouseMoved(FLOAT, FLOAT) | `0x10040030` | **none** |
| Extension:XScaleWindow | 48 | UBOOL XScaleWindow::MouseButtonPressed(FLOAT, FLOAT, EInputKey, INT) | `0x1003fdc0` | **none** |
| Extension:XScaleWindow | 49 | UBOOL XScaleWindow::MouseButtonReleased(FLOAT, FLOAT, EInputKey, INT) | `0x10040150` | **none** |
| Extension:XScaleWindow | 53 | void XScaleWindow::Tick(FLOAT) | `0x10040250` | name only: src/runtime/script-window-scale-draw.mjs |
| Extension:XScaleWindow | 54 | void XScaleWindow::Draw(XGC *) | `0x1003fb10` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-scale-draw.mjs +4 |
| Extension:XScaleManagerWindow | 21 | void XScaleManagerWindow::Init(XWindow *) | `0x100419f0` | address: docs/script-window-scroll-children.md |
| Extension:XScaleManagerWindow | 22 | void XScaleManagerWindow::CleanUp() | `0x10041ac0` | **none** |
| Extension:XScaleManagerWindow | 27 | void XScaleManagerWindow::ChildRemoved(XWindow *) | `0x10042480` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-scroll-children.mjs +1 |
| Extension:XScaleManagerWindow | 31 | void XScaleManagerWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x100420e0` | **none** |
| Extension:XScaleManagerWindow | 33 | void XScaleManagerWindow::ChildRequestedVisibilityChange(XWindow *, UBOOL) | `0x100421e0` | **none** |
| Extension:XScaleManagerWindow | 34 | UBOOL XScaleManagerWindow::ChildRequestedReconfiguration(XWindow *) | `0x100421d0` | address: src/runtime/script-window-host.mjs, docs/sdk-reference.md +1 |
| Extension:XScaleManagerWindow | 36 | void XScaleManagerWindow::ConfigurationChanged() | `0x10042260` | **none** |
| Extension:XScaleManagerWindow | 58 | UBOOL XScaleManagerWindow::ButtonActivated(XWindow *) | `0x10042720` | **none** |
| Extension:XScaleManagerWindow | 62 | UBOOL XScaleManagerWindow::ScalePositionChanged(XWindow *, INT, FLOAT, UBOOL) | `0x10042580` | **none** |
| Extension:XScaleManagerWindow | 64 | UBOOL XScaleManagerWindow::ScaleAttributesChanged(XWindow *, INT, INT, INT) | `0x10042640` | **none** |
| Extension:XScrollAreaWindow | 21 | void XScrollAreaWindow::Init(XWindow *) | `0x10042d80` | address: src/runtime/script-window-scroll-area.mjs, docs/script-window-scroll-area.md |
| Extension:XScrollAreaWindow | 22 | void XScrollAreaWindow::CleanUp() | `0x100430f0` | **none** |
| Extension:XScrollAreaWindow | 29 | void XScrollAreaWindow::DescendantRemoved(XWindow *) | `0x10043980` | address: src/runtime/script-window-scroll-area.mjs, docs/script-window-scroll-removal.md |
| Extension:XScrollAreaWindow | 31 | void XScrollAreaWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x100438f0` | address: docs/script-window-scroll-children.md |
| Extension:XScrollAreaWindow | 33 | void XScrollAreaWindow::ChildRequestedVisibilityChange(XWindow *, UBOOL) | `0x10043740` | **none** |
| Extension:XScrollAreaWindow | 34 | UBOOL XScrollAreaWindow::ChildRequestedReconfiguration(XWindow *) | `0x100421d0` | address: src/runtime/script-window-host.mjs, docs/sdk-reference.md +1 |
| Extension:XScrollAreaWindow | 36 | void XScrollAreaWindow::ConfigurationChanged() | `0x100437c0` | **none** |
| Extension:XScrollAreaWindow | 48 | UBOOL XScrollAreaWindow::MouseButtonPressed(FLOAT, FLOAT, EInputKey, INT) | `0x10043d10` | **none** |
| Extension:XScrollAreaWindow | 63 | UBOOL XScrollAreaWindow::ScaleRangeChanged(XWindow *, INT, INT, FLOAT, FLOAT, UBOOL) | `0x10043a50` | **none** |
| Extension:XScrollAreaWindow | 65 | UBOOL XScrollAreaWindow::ClipAttributesChanged(XWindow *, INT, INT, INT, INT) | `0x10043b50` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-scroll-configuration.mjs |
| Extension:XScrollAreaWindow | 68 | UBOOL XScrollAreaWindow::ClipPositionChanged(XWindow *, INT, INT) | `0x10043c40` | **none** |
| Extension:XExtString | 10 | void XExtString::Serialize(FArchive &) | `0x10044140` | address: src/runtime/script-text-parser-natives.mjs, docs/script-text-parser.md +1 |
| Extension:XExtString | 21 | void XExtString::SetText(const TCHAR *) | `0x10044170` | **none** |
| Extension:XExtString | 22 | void XExtString::AppendText(const TCHAR *) | `0x10044240` | **none** |
| Extension:XTabGroupWindow | 10 | void XTabGroupWindow::Serialize(FArchive &) | `0x10044f60` | **none** |
| Extension:XTabGroupWindow | 21 | void XTabGroupWindow::Init(XWindow *) | `0x10044d90` | address: src/runtime/script-window-families.mjs |
| Extension:XTabGroupWindow | 22 | void XTabGroupWindow::CleanUp() | `0x10044ea0` | address: src/runtime/script-window-host.mjs, docs/script-window-input.md |
| Extension:XTabGroupWindow | 31 | void XTabGroupWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x10045700` | address: src/runtime/script-window-family-layout.mjs |
| Extension:XTabGroupWindow | 33 | void XTabGroupWindow::ChildRequestedVisibilityChange(XWindow *, UBOOL) | `0x10045870` | address: src/runtime/script-window-host.mjs |
| Extension:XTabGroupWindow | 34 | UBOOL XTabGroupWindow::ChildRequestedReconfiguration(XWindow *) | `0x100421d0` | address: src/runtime/script-window-host.mjs, docs/sdk-reference.md +1 |
| Extension:XTabGroupWindow | 36 | void XTabGroupWindow::ConfigurationChanged() | `0x10045640` | **none** |
| Extension:XTextWindow | 10 | void XTextWindow::Serialize(FArchive &) | `0x10045cc0` | **none** |
| Extension:XTextWindow | 21 | void XTextWindow::Init(XWindow *) | `0x10045af0` | address: src/runtime/script-window-text.mjs, docs/script-window-text.md |
| Extension:XTextWindow | 22 | void XTextWindow::CleanUp() | `0x10045c30` | address: src/runtime/script-window-host.mjs, docs/script-window-destroy.md |
| Extension:XTextWindow | 31 | void XTextWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x100465a0` | address: src/runtime/script-window-family-layout.mjs, docs/script-instructor-conversation.md +3 |
| Extension:XTextWindow | 32 | void XTextWindow::ParentRequestedGranularity(FLOAT &, FLOAT &) | `0x10046880` | address: src/runtime/script-window-family-layout.mjs, src/runtime/script-window-host.mjs +5 |
| Extension:XTextWindow | 54 | void XTextWindow::Draw(XGC *) | `0x10046930` | address: src/runtime/script-window-family-draw.mjs, docs/script-window-host.md |
| Extension:XTextWindow | 71 | void XTextWindow::SetText(const TCHAR *) | `0x10045d50` | address: src/runtime/script-text-model.mjs, src/runtime/script-text-set-text.mjs +5 |
| Extension:XTextWindow | 72 | void XTextWindow::AppendText(const TCHAR *) | `0x10045e60` | address: src/runtime/script-text-append-text.mjs, src/runtime/script-text-model.mjs +6 |
| Extension:XTextLogWindow | 10 | void XTextLogWindow::Serialize(FArchive &) | `0x10047620` | **none** |
| Extension:XTextLogWindow | 21 | void XTextLogWindow::Init(XWindow *) | `0x100474b0` | address: src/runtime/script-window-families.mjs |
| Extension:XTextLogWindow | 22 | void XTextLogWindow::CleanUp() | `0x100475b0` | address: src/runtime/script-window-host.mjs, docs/script-window-checkbox.md |
| Extension:XTextLogWindow | 36 | void XTextLogWindow::ConfigurationChanged() | `0x10047910` | address: src/runtime/script-window-text-log.mjs, docs/script-window-host.md |
| Extension:XTextLogWindow | 53 | void XTextLogWindow::Tick(FLOAT) | `0x10047c30` | address: src/runtime/script-window-text-log.mjs, docs/script-window-host.md |
| Extension:XTextLogWindow | 54 | void XTextLogWindow::Draw(XGC *) | `0x10047a10` | address: src/runtime/script-window-text-log.mjs, docs/script-window-host.md |
| Extension:XTileWindow | 10 | void XTileWindow::Serialize(FArchive &) | `0x100484c0` | **none** |
| Extension:XTileWindow | 21 | void XTileWindow::Init(XWindow *) | `0x10048360` | address: docs/script-instructor-conversation.md |
| Extension:XTileWindow | 22 | void XTileWindow::CleanUp() | `0x10048430` | address: src/runtime/script-window-host.mjs, docs/script-window-destroy.md |
| Extension:XTileWindow | 31 | void XTileWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x100487e0` | **none** |
| Extension:XTileWindow | 32 | void XTileWindow::ParentRequestedGranularity(FLOAT &, FLOAT &) | `0x10048860` | address: src/runtime/script-window-scroll-layout.mjs |
| Extension:XTileWindow | 33 | void XTileWindow::ChildRequestedVisibilityChange(XWindow *, UBOOL) | `0x10048940` | address: src/runtime/script-window-host.mjs |
| Extension:XTileWindow | 34 | UBOOL XTileWindow::ChildRequestedReconfiguration(XWindow *) | `0x100421d0` | address: src/runtime/script-window-host.mjs, docs/sdk-reference.md +1 |
| Extension:XTileWindow | 36 | void XTileWindow::ConfigurationChanged() | `0x100489c0` | address: src/runtime/script-window-family-layout.mjs |
| Extension:XToggleWindow | 21 | void XToggleWindow::Init(XWindow *) | `0x10049820` | address: src/runtime/script-window-families.mjs, scripts/native-window-checkbox-oracle.py |
| Extension:XToggleWindow | 22 | void XToggleWindow::CleanUp() | `0x100498a0` | address: src/runtime/script-window-host.mjs, docs/script-window-checkbox.md |
| Extension:XToggleWindow | 48 | UBOOL XToggleWindow::MouseButtonPressed(FLOAT, FLOAT, EInputKey, INT) | `0x10049a80` | address: docs/script-window-input.md, scripts/native-window-mouse-focus-oracle.py |
| Extension:XToggleWindow | 49 | UBOOL XToggleWindow::MouseButtonReleased(FLOAT, FLOAT, EInputKey, INT) | `0x10049b30` | address: docs/script-window-input.md, scripts/native-window-mouse-focus-oracle.py |
| Extension:XToggleWindow | 73 | void XToggleWindow::PressButton(EInputKey) | `0x10049c30` | address: docs/script-window-input.md, scripts/native-window-mouse-focus-oracle.py |
| Extension:XViewportWindow | 10 | void XViewportWindow::Serialize(FArchive &) | `0x1004a0f0` | **none** |
| Extension:XViewportWindow | 21 | void XViewportWindow::Init(XWindow *) | `0x10049f10` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-viewport.mjs +2 |
| Extension:XViewportWindow | 22 | void XViewportWindow::CleanUp() | `0x1004a070` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-viewport.mjs +2 |
| Extension:XViewportWindow | 23 | UBOOL XViewportWindow::ConvertVectorToCoordinates(FVector, FLOAT *, FLOAT *) | `0x1004afc0` | address: src/runtime/script-window-projection.mjs, src/runtime/script-window-viewport.mjs +2 |
| Extension:XViewportWindow | 54 | void XViewportWindow::Draw(XGC *) | `0x1004a770` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-viewport.mjs +4 |
| Extension:XViewportWindow | 55 | void XViewportWindow::PostDraw(XGC *) | `0x1004af20` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-viewport.mjs +2 |
| Extension:XViewportWindow | 71 | void XViewportWindow::CalcView(class AActor *, class AActor *, FVector &, FRotator &) | `0x1004b180` | address: src/runtime/script-window-viewport.mjs, scripts/native-window-viewport-oracle.py |
| Extension:XViewportWindow | 72 | void XViewportWindow::RenderFrame(class URenderBase *, struct FSceneNode *) | `0x1004b260` | address: src/runtime/script-window-viewport.mjs, docs/script-window-viewport.md +1 |
| Extension:XWindow | 9 | void XWindow::Destroy() | `0x1004c010` | address: src/runtime/script-window-destroy.mjs, src/runtime/script-window-host.mjs +1 |
| Extension:XWindow | 21 | void XWindow::Init(XWindow *) | `0x1004bb30` | address: src/runtime/script-window-computer.mjs, src/runtime/script-window-construction.mjs +9 |
| Extension:XWindow | 22 | void XWindow::CleanUp() | `0x1004bec0` | address: src/runtime/script-window-destroy.mjs, src/runtime/script-window-host.mjs +3 |
| Extension:XWindow | 23 | UBOOL XWindow::ConvertVectorToCoordinates(FVector, FLOAT *, FLOAT *) | `0x1004faf0` | address: src/runtime/script-window-projection.mjs |
| Extension:XWindow | 24 | UBOOL XWindow::QueryPointInWindow(FLOAT, FLOAT) | `0x10003430` | address: src/runtime/script-window-mouse.mjs |
| Extension:XWindow | 25 | XCursor *XWindow::CursorRequested(XWindow *, FLOAT, FLOAT, FLOAT &, FLOAT &, FColor &, UTexture **) | `0x10003440` | address: src/runtime/script-window-mouse.mjs, docs/script-window-input.md |
| Extension:XWindow | 26 | void XWindow::ChildAdded(XWindow *) | `0x100034c0` | address: src/runtime/script-window-host.mjs |
| Extension:XWindow | 27 | void XWindow::ChildRemoved(XWindow *) | `0x100034e0` | address: src/runtime/script-window-host.mjs, docs/script-window-destroy.md |
| Extension:XWindow | 28 | void XWindow::DescendantAdded(XWindow *) | `0x10003500` | address: src/runtime/script-window-host.mjs |
| Extension:XWindow | 29 | void XWindow::DescendantRemoved(XWindow *) | `0x10003520` | address: src/runtime/script-native-class-registry.mjs, src/runtime/script-window-host.mjs +1 |
| Extension:XWindow | 30 | void XWindow::Timer(XTimerId, INT, XTimerData) | `0x100504f0` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-timers.mjs |
| Extension:XWindow | 31 | void XWindow::ParentRequestedPreferredSize(UBOOL, FLOAT &, UBOOL, FLOAT &) | `0x10050390` | address: src/runtime/script-window-host.mjs, scripts/native-window-checkbox-oracle.py |
| Extension:XWindow | 32 | void XWindow::ParentRequestedGranularity(FLOAT &, FLOAT &) | `0x10050450` | address: src/runtime/script-window-family-layout.mjs, src/runtime/script-window-host.mjs +7 |
| Extension:XWindow | 33 | void XWindow::ChildRequestedVisibilityChange(XWindow *, UBOOL) | `0x10003540` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-visibility.mjs +1 |
| Extension:XWindow | 34 | UBOOL XWindow::ChildRequestedReconfiguration(XWindow *) | `0x10003580` | address: docs/stage-3-handoff.md |
| Extension:XWindow | 35 | void XWindow::ChildRequestedShowArea(XWindow *, FLOAT, FLOAT, FLOAT, FLOAT) | `0x100035b0` | address: src/runtime/script-window-mouse.mjs |
| Extension:XWindow | 36 | void XWindow::ConfigurationChanged() | `0x10003600` | address: src/runtime/script-window-host.mjs |
| Extension:XWindow | 37 | void XWindow::VisibilityChanged(UBOOL) | `0x10003610` | address: src/runtime/script-window-host.mjs |
| Extension:XWindow | 38 | void XWindow::SensitivityChanged(UBOOL) | `0x10003630` | address: src/runtime/script-window-host.mjs, docs/script-window-sensitivity.md |
| Extension:XWindow | 39 | void XWindow::MouseMoved(FLOAT, FLOAT) | `0x10003650` | **none** |
| Extension:XWindow | 40 | void XWindow::MouseEnteredWindow() | `0x10003680` | address: src/runtime/script-window-mouse.mjs |
| Extension:XWindow | 41 | void XWindow::MouseLeftWindow() | `0x10003690` | address: src/runtime/script-window-mouse.mjs |
| Extension:XWindow | 42 | void XWindow::FocusEnteredWindow() | `0x100036a0` | **none** |
| Extension:XWindow | 43 | void XWindow::FocusLeftWindow() | `0x100036b0` | **none** |
| Extension:XWindow | 44 | void XWindow::FocusEnteredDescendant(XWindow *) | `0x100036c0` | address: src/runtime/script-window-mouse.mjs |
| Extension:XWindow | 45 | void XWindow::FocusLeftDescendant(XWindow *) | `0x100036e0` | address: src/runtime/script-window-mouse.mjs |
| Extension:XWindow | 46 | UBOOL XWindow::RawMouseButtonPressed(FLOAT, FLOAT, EInputKey, EInputAction) | `0x10003700` | **none** |
| Extension:XWindow | 47 | UBOOL XWindow::RawKeyPressed(EInputKey, EInputAction, UBOOL) | `0x10003750` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-input.mjs +1 |
| Extension:XWindow | 48 | UBOOL XWindow::MouseButtonPressed(FLOAT, FLOAT, EInputKey, INT) | `0x10003790` | **none** |
| Extension:XWindow | 49 | UBOOL XWindow::MouseButtonReleased(FLOAT, FLOAT, EInputKey, INT) | `0x100037e0` | **none** |
| Extension:XWindow | 50 | UBOOL XWindow::KeyPressed(TCHAR) | `0x10003830` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-typed-keys.mjs +2 |
| Extension:XWindow | 51 | UBOOL XWindow::VirtualKeyPressed(EInputKey, UBOOL) | `0x10003a40` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-input.mjs +1 |
| Extension:XWindow | 52 | UBOOL XWindow::AcceleratorKeyPressed(TCHAR) | `0x10003a80` | address: src/runtime/script-window-host.mjs, src/runtime/script-window-typed-keys.mjs +2 |
| Extension:XWindow | 53 | void XWindow::Tick(FLOAT) | `0x10003be0` | address: src/runtime/script-window-host.mjs |
| Extension:XWindow | 54 | void XWindow::Draw(XGC *) | `0x10003bf0` | address: src/runtime/script-window-family-draw.mjs, src/runtime/script-window-host.mjs +6 |
| Extension:XWindow | 55 | void XWindow::PostDraw(XGC *) | `0x10003c80` | address: src/runtime/script-window-host.mjs, scripts/native-window-viewport-oracle.py |
| Extension:XWindow | 56 | void XWindow::MouseGrabLost(XWindow *) | `0x10003be0` | address: src/runtime/script-window-host.mjs |
| Extension:XWindow | 57 | void XWindow::StyleChanged() | `0x10003d10` | address: src/runtime/script-conplay-live.mjs, src/runtime/script-window-change-style.mjs +3 |
| Extension:XWindow | 58 | UBOOL XWindow::ButtonActivated(XWindow *) | `0x10003d20` | address: src/runtime/script-window-host.mjs, docs/script-window-input.md |
| Extension:XWindow | 59 | UBOOL XWindow::ButtonActivatedRight(XWindow *) | `0x10003d50` | address: src/runtime/script-window-host.mjs, docs/script-window-input.md |
| Extension:XWindow | 60 | UBOOL XWindow::ToggleChanged(XWindow *, UBOOL) | `0x10003d80` | address: src/runtime/script-window-host.mjs |
| Extension:XWindow | 61 | UBOOL XWindow::BoxOptionSelected(XWindow *, INT) | `0x10003dc0` | **none** |
| Extension:XWindow | 62 | UBOOL XWindow::ScalePositionChanged(XWindow *, INT, FLOAT, UBOOL) | `0x10003e00` | **none** |
| Extension:XWindow | 63 | UBOOL XWindow::ScaleRangeChanged(XWindow *, INT, INT, FLOAT, FLOAT, UBOOL) | `0x10003e50` | **none** |
| Extension:XWindow | 64 | UBOOL XWindow::ScaleAttributesChanged(XWindow *, INT, INT, INT) | `0x10003eb0` | **none** |
| Extension:XWindow | 65 | UBOOL XWindow::ClipAttributesChanged(XWindow *, INT, INT, INT, INT) | `0x10003f00` | address: src/runtime/script-window-host.mjs |
| Extension:XWindow | 66 | UBOOL XWindow::ListRowActivated(XWindow *, INT) | `0x10003f50` | address: src/runtime/script-window-host.mjs, docs/script-window-list-family.md |
| Extension:XWindow | 67 | UBOOL XWindow::ListSelectionChanged(XWindow *, INT, INT) | `0x10003f90` | address: src/runtime/script-window-host.mjs, docs/script-window-list-family.md |
| Extension:XWindow | 68 | UBOOL XWindow::ClipPositionChanged(XWindow *, INT, INT) | `0x10003fd0` | **none** |
| Extension:XWindow | 69 | UBOOL XWindow::TextChanged(XWindow *, UBOOL) | `0x10004010` | address: src/runtime/script-window-host.mjs, docs/script-edit-model.md |
| Extension:XWindow | 70 | UBOOL XWindow::EditActivated(XWindow *, UBOOL) | `0x10004050` | address: src/runtime/script-window-host.mjs |
| ConSys:DConAudioList | 10 | void DConAudioList::Serialize(FArchive &) | `0x100010c0` | **none** |
| ConSys:DConEvent | 21 | void DConEvent::ImportFile(DConImport *) | `0x10002340` | **none** |
| ConSys:DConEvent | 22 | bool DConEvent::BindActor(AActor *, AActor *, DConversation *) | `0x10002350` | address: src/runtime/script-conversation-base-bind.mjs, docs/script-conversation-base-bind.md +3 |
| ConSys:DConHistory | 9 | void DConHistory::Destroy() | `0x1000ca20` | address: src/runtime/script-conplay-live.mjs, docs/script-instructor-conversation.md +2 |
