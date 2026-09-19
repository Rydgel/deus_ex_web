/**
 * Native class-registration tables recovered from the installed GOTY
 * `Core.dll`, `Engine.dll`, and `DeusEx.dll`.  Each row is one static
 * registration body: it pushes
 * `staticCtor, internalCtor, flags, config, package, name, within, super, …, size`
 * and calls the shared UClass constructor with `ecx` = the per-class static
 * object.  `UClass::Bind` (`0x10127a20`) reaches these records through the
 * `autoclass` lookup at `0x1015a5a0` and copies the record's `+0x4e0`
 * ClassConstructor — the `internalCtor` column here.
 *
 * Core.dll sites end in `call 0x10102d9c` (UClass ctor thunk); Engine.dll and
 * DeusEx.dll sites end in `call dword ptr [IAT]` (`0x10599de0` and
 * `0x10027028` respectively).  Names were decoded from the pushed UTF-16
 * strings.  Rows where the internal-ctor argument is passed through a register
 * rather than an immediate are marked `internalCtor: null` — unresolved until
 * a concrete need arises.
 *
 * Correction recorded here: `PlayerPawn` IS registered in Engine.dll
 * (name string `0x1048186e`, static `0x1058c160`, ctor `0x10301ff0`).  An
 * earlier survey only checked the UTF-16 string at `0x1042a10e`, which is the
 * mangled name `PlayerPawn::GetOptimizedRepList`, and wrongly concluded no
 * registration existed.  The `UClass::Bind` missing-record path
 * (`appMsgf 'Can't bind to native class %s'` then superclass inherit) is
 * retained for classes genuinely absent from these tables.
 *
 * `DataVaultImage`/`Image02_NYC_Warehouse` do not appear in DeusEx.dll — they
 * are scripted-only classes that inherit Engine.AInventory's constructor
 * through `Bind`, matching docs/script-datavault-image.md.
 */

const freeze = value => Object.freeze(value);
const row = fields => freeze(fields);

export const CORE_DLL = freeze({
  sha256: '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  imageBase: 0x10100000,
  uclassCtorThunk: 0x10102d9c,
  staticConstructor: 0x10101041,
});

export const ENGINE_DLL_REGISTRY = freeze({
  sha256: '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  imageBase: 0x10300000,
  uclassCtorImport: 0x10599de0,
});

export const DEUSEX_DLL = freeze({
  imageBase: 0x10000000,
  uclassCtorImport: 0x10027028,
});

// name -> {staticClass, internalCtor, super, instanceSize}; sizes/within kept
// where the pushed tail was fully decoded.
export const CORE_CLASSES = freeze({
  Object:             row({staticClass: 0x1029e0d0, internalCtor: 0x101017da, super: 0x1029e0d0, instanceSize: 0x28}),
  Field:              row({staticClass: 0x101f2b18, internalCtor: 0x101017da, super: 0x1029e0d0, instanceSize: 0x34}),
  Struct:             row({staticClass: 0x101f2618, internalCtor: 0x10102720, super: 0x101f2b18, instanceSize: 0x6c}),
  State:              row({staticClass: 0x101f2118, internalCtor: 0x10101b90, super: 0x101f2618, instanceSize: 0x484}),
  Class:              row({staticClass: 0x101f1c18, internalCtor: 0x10102e0a, super: 0x101f2118, instanceSize: 0x4f4}),
  Function:           row({staticClass: 0x101f1718, internalCtor: 0x101013bb, super: 0x101f2618, instanceSize: 0x80}),
  Const:              row({staticClass: 0x101f1218, internalCtor: 0x10101122, super: 0x101f2b18, instanceSize: 0x40}),
  Enum:               row({staticClass: 0x1029d6d0, internalCtor: 0x10103409, super: 0x101f2b18, instanceSize: 0x40}),
  TextBuffer:         row({staticClass: 0x1029dbd0, internalCtor: 0x101015fa, super: 0x1029e0d0, instanceSize: 0x40}),
  Package:            row({staticClass: 0x1029b8e0, internalCtor: 0x10101da7, super: 0x1029e0d0, instanceSize: 0x34}),
  PackageMap:         row({staticClass: 0x101f36b8, internalCtor: 0x101025ea, super: 0x1029e0d0, instanceSize: 0x70}),
  Linker:             row({staticClass: 0x1029d1d0, internalCtor: 0x1010332d, super: 0x1029e0d0, instanceSize: 0xa4}),
  LinkerLoad:         row({staticClass: 0x1029c7d8, internalCtor: 0x10102261, super: 0x1029d1d0, instanceSize: 0x4e8}),
  LinkerSave:         row({staticClass: 0x1029c2e0, internalCtor: 0x10101ad7, super: 0x1029d1d0, instanceSize: 0xec}),
  Commandlet:         row({staticClass: 0x1029bde0, internalCtor: 0x101028ba, super: 0x1029e0d0, instanceSize: 0x1dc}),
  TextBufferFactory:  row({staticClass: 0x1029b3e0, internalCtor: 0x1010259f, super: 0x101f0270, instanceSize: 0x68}),
  Language:           row({staticClass: 0x1029aee0, internalCtor: 0x101017da, super: 0x1029e0d0, instanceSize: 0x2c}),
  System:             row({staticClass: 0x102a94f8, internalCtor: 0x101030d0, super: 0x1029c2e0, instanceSize: 0x6c}),
  Property:           row({staticClass: 0x102a7af0, internalCtor: 0x101017da, super: 0x101f2b18, instanceSize: 0x5c}),
  ByteProperty:       row({staticClass: 0x102a75f0, internalCtor: 0x10102653, super: 0x102a7af0, instanceSize: 0x60}),
  IntProperty:        row({staticClass: 0x102a70f0, internalCtor: 0x101015e1, super: 0x102a7af0, instanceSize: 0x5c}),
  BoolProperty:       row({staticClass: 0x102a6bf0, internalCtor: 0x1010270c, super: 0x102a7af0, instanceSize: 0x60}),
  FloatProperty:      row({staticClass: 0x102a66f0, internalCtor: 0x101033fa, super: 0x102a7af0, instanceSize: 0x5c}),
  ObjectProperty:     row({staticClass: 0x102a61f0, internalCtor: 0x10101564, super: 0x102a7af0, instanceSize: 0x64}),
  ClassProperty:      row({staticClass: 0x102a5cf0, internalCtor: 0x1010138e, super: 0x102a61f0, instanceSize: 0x68}),
  NameProperty:       row({staticClass: 0x102a57f0, internalCtor: 0x10102153, super: 0x102a7af0, instanceSize: 0x5c}),
  StrProperty:        row({staticClass: 0x102a52f0, internalCtor: 0x10101ab4, super: 0x102a7af0, instanceSize: 0x5c}),
  FixedArrayProperty: row({staticClass: 0x102a4df0, internalCtor: 0x10103139, super: 0x102a7af0, instanceSize: 0x64}),
  ArrayProperty:      row({staticClass: 0x102a48f0, internalCtor: 0x101033dc, super: 0x102a7af0, instanceSize: 0x60}),
  MapProperty:        row({staticClass: 0x102a43f0, internalCtor: 0x101024a0, super: 0x102a7af0, instanceSize: 0x64}),
  StructProperty:     row({staticClass: 0x102a3ef0, internalCtor: 0x101030a8, super: 0x102a7af0, instanceSize: 0x64}),
  DebugInfo:          row({staticClass: 0x101ef668, internalCtor: 0x10102d65}),
  Subsystem:          row({staticClass: 0x1029c2e0, internalCtor: 0x101017da}),
});

export const ENGINE_CLASSES = freeze({
  Mutator:              row({staticClass: 0x10485648, internalCtor: 0x10303418, super: 0x10572ed0, instanceSize: 0x324}),
  LodMesh:              row({staticClass: 0x105359d0, internalCtor: 0x10303855, super: 0x10589758, instanceSize: 0x1b0}),
  Actor:                row({staticClass: 0x1057cdf0, internalCtor: 0x10302dab, instanceSize: 0x318}),
  Light:                row({staticClass: 0x1057c8f0, internalCtor: 0x10302a54, super: 0x1057cdf0, instanceSize: 0x318}),
  Weapon:               row({staticClass: 0x1057c3f8, internalCtor: 0x10302ef5, super: 0x10576f70, instanceSize: 0x504}),
  LevelInfo:            row({staticClass: 0x1057bf00, internalCtor: 0x10302f45, super: 0x1057b018, instanceSize: 0x594}),
  GameInfo:             row({staticClass: 0x1057ba08, internalCtor: 0x10301802, super: 0x10572ed0, instanceSize: 0x740}),
  Camera:               row({staticClass: 0x1057b510, internalCtor: 0x10303a53, super: 0x1058c160, instanceSize: 0x890}),
  ZoneInfo:             row({staticClass: 0x1057b018, internalCtor: 0x10302dc9, super: 0x10572ed0, instanceSize: 0x474}),
  SkyZoneInfo:          row({staticClass: 0x1057ab20, internalCtor: 0x10302072, super: 0x1057b018, instanceSize: 0x474}),
  PathNode:             row({staticClass: 0x1057a628, internalCtor: 0x10301a2d, super: 0x1057a128, instanceSize: 0x44c}),
  NavigationPoint:      row({staticClass: 0x1057a128, internalCtor: 0x10301d07, super: 0x1057cdf0, instanceSize: 0x44c}),
  Scout:                row({staticClass: 0x10579c30, internalCtor: 0x103032a6, super: 0x1058c660, instanceSize: 0x5d4}),
  InterpolationPoint:   row({staticClass: 0x10579738, internalCtor: 0x10301992, super: 0x10577468, instanceSize: 0x344}),
  CameraPoint:          row({staticClass: 0x10579240, internalCtor: 0x103033af, super: 0x10577468, instanceSize: 0x390}),
  Decoration:           row({staticClass: 0x10578d48, internalCtor: 0x1030248c, super: 0x1057cdf0, instanceSize: 0x340}),
  Projectile:           row({staticClass: 0x10578850, internalCtor: 0x103014e7, super: 0x1057cdf0, instanceSize: 0x340}),
  WarpZoneInfo:         row({staticClass: 0x10578358, internalCtor: 0x103015b4, super: 0x1057b018, instanceSize: 0x528}),
  Teleporter:           row({staticClass: 0x10577e60, internalCtor: 0x10301159, super: 0x1057a128, instanceSize: 0x478}),
  PlayerStart:          row({staticClass: 0x10577960, internalCtor: 0x103035d5, super: 0x1057a128, instanceSize: 0x454}),
  Keypoint:             row({staticClass: 0x10577468, internalCtor: 0x10303148, super: 0x1057cdf0, instanceSize: 0x318}),
  Inventory:            row({staticClass: 0x10576f70, internalCtor: 0x1030299b, super: 0x1057cdf0, instanceSize: 0x434}),
  InventorySpot:        row({staticClass: 0x10576a78, internalCtor: 0x1030191a, super: 0x1057a128, instanceSize: 0x450}),
  Triggers:             row({staticClass: 0x10576580, internalCtor: 0x10301483, super: 0x1057cdf0, instanceSize: 0x318}),
  Trigger:              row({staticClass: 0x10576088, internalCtor: 0x103010c3, super: 0x10576580, instanceSize: 0x348}),
  TriggerMarker:        row({staticClass: 0x10575b90, internalCtor: 0x1030214e, super: 0x1057a128, instanceSize: 0x44c}),
  ButtonMarker:         row({staticClass: 0x10575698, internalCtor: 0x1030115e, super: 0x1057a128, instanceSize: 0x44c}),
  WarpZoneMarker:       row({staticClass: 0x10575198, internalCtor: 0x103038af, super: 0x1057a128, instanceSize: 0x458}),
  HUD:                  row({staticClass: 0x10574ca0, internalCtor: 0x10301bf4, super: 0x1057cdf0, instanceSize: 0x340}),
  Menu:                 row({staticClass: 0x105747a8, internalCtor: 0x103015af, super: 0x1057cdf0, instanceSize: 0x5cc}),
  SavedMove:            row({staticClass: 0x105742b0, internalCtor: 0x103028ba, super: 0x10572ed0, instanceSize: 0x32c}),
  Carcass:              row({staticClass: 0x10573db8, internalCtor: 0x103030ee, super: 0x10578d48, instanceSize: 0x358}),
  LiftCenter:           row({staticClass: 0x105738c0, internalCtor: 0x10302739, super: 0x1057a128, instanceSize: 0x474}),
  LiftExit:             row({staticClass: 0x105733c8, internalCtor: 0x103018a2, super: 0x1057a128, instanceSize: 0x460}),
  Info:                 row({staticClass: 0x10572ed0, internalCtor: 0x1030348b, super: 0x1057cdf0, instanceSize: 0x318}),
  ReplicationInfo:      row({staticClass: 0x105729d0, internalCtor: 0x103013d4, super: 0x10572ed0, instanceSize: 0x318}),
  PlayerReplicationInfo:row({staticClass: 0x105724d8, internalCtor: 0x10302333, super: 0x105729d0, instanceSize: 0x37c}),
  InternetInfo:         row({staticClass: 0x10571fe0, internalCtor: 0x1030342c, super: 0x10572ed0, instanceSize: 0x318}),
  StatLog:              row({staticClass: 0x10571ae8, internalCtor: 0x1030251d, super: 0x10572ed0, instanceSize: 0x3e4}),
  StatLogFile:          row({staticClass: 0x105715f0, internalCtor: 0x10301b3b, super: 0x10571ae8, instanceSize: 0x404}),
  GameReplicationInfo:  row({staticClass: 0x105710f8, internalCtor: 0x10302f81, super: 0x105729d0, instanceSize: 0x440}),
  LevelSummary:         row({staticClass: 0x10570c00, internalCtor: 0x1030159b, instanceSize: 0x60}),
  locationid:           row({staticClass: 0x10570708, internalCtor: 0x10301b81, super: 0x10577468, instanceSize: 0x32c}),
  Decal:                row({staticClass: 0x10570208, internalCtor: 0x10303a26, super: 0x1057cdf0, instanceSize: 0x32c}),
  SpawnNotify:          row({staticClass: 0x1056fd10, internalCtor: 0x103038dc, super: 0x1057cdf0, instanceSize: 0x320}),
  Sound:                row({staticClass: 0x10580868, internalCtor: 0x10303891, super: 0x1029e0d0, instanceSize: 0x54}),
  Music:                row({staticClass: 0x10580368, internalCtor: 0x103036a7, instanceSize: 0x4c}),
  AudioSubsystem:       row({staticClass: 0x1057fe68, internalCtor: 0x10370f70, instanceSize: 0x2c}),
  Viewport:             row({staticClass: 0x10581068, internalCtor: null, super: 0x10581668, instanceSize: 0xf8}),
  Client:               row({staticClass: 0x10581668, internalCtor: 0x10303bc0, instanceSize: 0x98}),
  Canvas:               row({staticClass: 0x10581c68, internalCtor: 0x103011f9, instanceSize: 0x84}),
  Console:              row({staticClass: 0x105823e0, internalCtor: 0x1030127b, instanceSize: 0x810}),
  Brush:                row({staticClass: 0x10582a28, internalCtor: 0x10302284, super: 0x1057cdf0, instanceSize: 0x374}),
  Engine:               row({staticClass: 0x10583c40, internalCtor: 0x103022c0, instanceSize: 0x68}),
  RenderBase:           row({staticClass: 0x10584138, internalCtor: 0x1037d2c0, instanceSize: 0x30}),
  RenderDevice:         row({staticClass: 0x10584630, internalCtor: 0x10302bbc, instanceSize: 0xbc}),
  RenderIterator:       row({staticClass: 0x10583738, internalCtor: 0x103023e2, instanceSize: 0x34}),
  ServerCommandlet:     row({staticClass: 0x10583028, internalCtor: 0x10303945, instanceSize: 0x1dc}),
  EventManager:         row({staticClass: 0x10586880, internalCtor: 0x10301cda, instanceSize: 0x43c}),
  AIEventType:          row({staticClass: 0x10586380, internalCtor: 0x103024ff, instanceSize: 0x3c}),
  AIEvent:              row({staticClass: 0x10585e88, internalCtor: 0x1030121c, instanceSize: 0x38}),
  AISenderEvent:        row({staticClass: 0x10585990, internalCtor: 0x1030250e, super: 0x10585e88, instanceSize: 0x14c}),
  AIReceiverEvent:      row({staticClass: 0x10585498, internalCtor: 0x10302ce3, super: 0x10585e88, instanceSize: 0x84}),
  Font:                 row({staticClass: 0x10587348, internalCtor: 0x10303468, instanceSize: 0x38}),
  Polys:                row({staticClass: 0x10587948, internalCtor: 0x10301834, instanceSize: 0x38}),
  GameEngine:           row({staticClass: 0x10587f50, internalCtor: 0x103029ff, super: 0x10583c40, instanceSize: 0xd0}),
  Input:                row({staticClass: 0x10588550, internalCtor: 0x10303d37, instanceSize: 0xfb0}),
  LevelBase:            row({staticClass: 0x10589058, internalCtor: null, instanceSize: 0x8c}),
  Level:                row({staticClass: 0x10588b58, internalCtor: 0x10303ae9, super: 0x10589058, instanceSize: 0x1150}),
  Mesh:                 row({staticClass: 0x10589758, internalCtor: 0x103020bd, super: 0x1058d368, instanceSize: 0x12c}),
  BspNodes:             row({staticClass: 0x1058b158, internalCtor: 0x10302d5b, instanceSize: 0x63c}),
  BspSurfs:             row({staticClass: 0x1058ac58, internalCtor: 0x10302e82, instanceSize: 0x34}),
  Vectors:              row({staticClass: 0x1058a758, internalCtor: 0x10302f18, instanceSize: 0x34}),
  Verts:                row({staticClass: 0x1058a258, internalCtor: 0x10302b3f, instanceSize: 0x38}),
  Model:                row({staticClass: 0x10589d58, internalCtor: 0x103036ed, super: 0x1058d368, instanceSize: 0x704}),
  Mover:                row({staticClass: 0x1058bb58, internalCtor: 0x10302b62, super: 0x10582a28, instanceSize: 0x534}),
  Pawn:                 row({staticClass: 0x1058c660, internalCtor: 0x103029f5, super: 0x1057cdf0, instanceSize: 0x5d4}),
  PlayerPawn:           row({staticClass: 0x1058c160, internalCtor: 0x10301ff0, super: 0x1058c660, instanceSize: 0x890}),
  Player:               row({staticClass: 0x1058cd68, internalCtor: null, instanceSize: 0x5c}),
  Primitive:            row({staticClass: 0x1058d368, internalCtor: 0x103023ce, super: 0x1029e0d0, instanceSize: 0x54}),
  ScriptedTexture:      row({staticClass: 0x1058db40, internalCtor: 0x10303df0, super: 0x1058e648, instanceSize: 0xd8}),
  Bitmap:               row({staticClass: 0x1058eb48, internalCtor: 0x10479eb0, instanceSize: 0x54}),
  Texture:              row({staticClass: 0x1058e648, internalCtor: 0x1030249b, super: 0x1058eb48, instanceSize: 0xc0}),
  Palette:              row({staticClass: 0x1058e148, internalCtor: 0x1030233d, instanceSize: 0x34}),
  Channel:              row({staticClass: 0x10590318, internalCtor: null, instanceSize: 0x5c}),
  ControlChannel:       row({staticClass: 0x1058fe20, internalCtor: 0x10302595, super: 0x10590318, instanceSize: 0x60}),
  ActorChannel:         row({staticClass: 0x1058f928, internalCtor: 0x10301082, super: 0x10590318, instanceSize: 0xac}),
  FileChannel:          row({staticClass: 0x1058f430, internalCtor: 0x103020ae, super: 0x10590318, instanceSize: 0x668}),
  NetConnection:        row({staticClass: 0x10590c40, internalCtor: null, super: 0x1058cd68, instanceSize: 0x3eb8}),
  DemoRecConnection:    row({staticClass: 0x10591d40, internalCtor: 0x10301951, super: 0x10590c40, instanceSize: 0x3eb8}),
  DemoRecDriver:        row({staticClass: 0x10591848, internalCtor: 0x10303b89, super: 0x10592448, instanceSize: 0xbc}),
  PackageMapLevel:      row({staticClass: 0x10592940, internalCtor: 0x10302dba, instanceSize: 0x74}),
  NetDriver:            row({staticClass: 0x10592448, internalCtor: 0x1030318e, instanceSize: 0x90}),
  PendingLevel:         row({staticClass: 0x10593540, internalCtor: null, instanceSize: 0xa8}),
  NetPendingLevel:      row({staticClass: 0x10593048, internalCtor: 0x10302e91, super: 0x10593540, instanceSize: 0xa8}),
  // Registered via UE1 deferred templated registration: the InternalConstructor
  // is threaded through static-init and not statically recoverable.  See
  // dynamicConstructor handling below and docs/script-linker-preload.md.
  Player:               row({staticClass: 0x1058cd68, internalCtor: null, dynamicConstructor: true}),
});

export const DEUSEX_CLASSES = freeze({
  AugmentationManager: row({staticClass: 0x100382b8, internalCtor: 0x1000bf40, instanceSize: 0x3fc}),
  Skill:               row({staticClass: 0x100387b8, internalCtor: 0x1000b6b0, instanceSize: 0x3a0}),
  SkillManager:        row({staticClass: 0x10038cb0, internalCtor: 0x1000af50, instanceSize: 0x38c}),
  DataVaultImageNote:  row({staticClass: 0x100391b8, internalCtor: 0x1000df30, instanceSize: 0x44}),
  DeusExDecoration:    row({staticClass: 0x100396d8, internalCtor: 0x1000a5f0, instanceSize: 0x3ac}),
  DeusExGameEngine:    row({staticClass: 0x10039bd8, internalCtor: 0x100126e0, super: 0x10583c40, instanceSize: 0xd0}),
  DeusExLevelInfo:     row({staticClass: 0x1003a0d8, internalCtor: 0x10009e40, instanceSize: 0x388}),
  DeusExLog:           row({staticClass: 0x1003a5d8, internalCtor: 0x1000dc30, instanceSize: 0x38}),
  DeusExPlayer:        row({staticClass: 0x1003aad8, internalCtor: 0x100016b0, instanceSize: 0xd64}),
  DeusExSaveInfo:      row({staticClass: 0x1003b0d8, internalCtor: 0x1000d760, instanceSize: 0x78}),
  DumpLocation:        row({staticClass: 0x1003b600, internalCtor: 0x100136e0, instanceSize: 0xa8}),
  GameDirectory:       row({staticClass: 0x1003bb20, internalCtor: 0x10012ea0, instanceSize: 0x54}),
  ScriptedPawn:        row({staticClass: 0x1003c020, internalCtor: 0x100044c0, instanceSize: 0xa10}),
  LaserIterator:       row({staticClass: 0x1003c520, internalCtor: 0x1001a780, instanceSize: 0x190}),
  ParticleIterator:    row({staticClass: 0x1003ca20, internalCtor: 0x1000d360, instanceSize: 0xd50}),
  Augmentation:        row({staticClass: 0x10037db0, internalCtor: 0x1000c6b0}),
});

// The remaining native-code packages the shipped startup binds (see
// docs/original-startup-log.md).  Every row is one registration body decoded by
// tools/class-registration-scan.py; the tool self-tests against the hand-recovered
// Core/Engine tables.  Rows with `dynamicConstructor: true` have an autoclass
// record but NO distinct C++ constructor — their DLL emits no own
// InternalConstructor thunk (Fire ships 4 thunks for 6 textures; Engine.Player
// likewise has none).  UClass::Bind copies such a record's +0x4e0, which is its
// superclass's ClassConstructor, so `bindScriptClassConstructor` inherits the
// super constructor for them — bit-for-bit what Bind's fall-through produces,
// and the reason the original startup logs zero "Can't bind" warnings.

export const EXTENSION_CLASSES = freeze({
  BorderWindow:         row({staticClass: 0x100994a0, internalCtor: 0x100068e0}),
  ButtonWindow:         row({staticClass: 0x100999b0, internalCtor: 0x100092f0}),
  CheckboxWindow:       row({staticClass: 0x10099ec0, internalCtor: 0x1000a030}),
  ClipWindow:           row({staticClass: 0x1009a3d0, internalCtor: 0x1000ce80}),
  ComputerWindow:       row({staticClass: 0x1009a8e0, internalCtor: 0x100191e0}),
  EditWindow:           row({staticClass: 0x1009ae18, internalCtor: 0x10013680}),
  Flag:                 row({staticClass: 0x1009c2e8, internalCtor: 0x1001a380}),
  FlagBool:             row({staticClass: 0x1009ccd8, internalCtor: 0x1001a560}),
  FlagByte:             row({staticClass: 0x1009c7e0, internalCtor: 0x1001a800}),
  FlagInt:              row({staticClass: 0x1009d1e0, internalCtor: 0x1001aa60}),
  FlagFloat:            row({staticClass: 0x1009bdf0, internalCtor: 0x1001acb0}),
  FlagName:             row({staticClass: 0x1009b8f8, internalCtor: 0x1001aec0}),
  FlagVector:           row({staticClass: 0x1009d6e0, internalCtor: 0x1001b0d0}),
  FlagRotator:          row({staticClass: 0x1009b400, internalCtor: 0x1001b2d0}),
  FlagBase:             row({staticClass: 0x1009dbe8, internalCtor: 0x1001b5a0}),
  GameEngineExt:        row({staticClass: 0x1009e100, internalCtor: 0x1001ba00}),
  GC:                   row({staticClass: 0x100a28c8, internalCtor: 0x10002ce0}),
  InputExt:             row({staticClass: 0x100a2e00, internalCtor: 0x1001c670}),
  LargeTextWindow:      row({staticClass: 0x100a3300, internalCtor: 0x10012a40}),
  ListWindow:           row({staticClass: 0x100a5a18, internalCtor: 0x100162f0}),
  ModalWindow:          row({staticClass: 0x100a7358, internalCtor: 0x10005390}),
  ExtensionObject:      row({staticClass: 0x100a7868, internalCtor: 0x10002770}),
  PlayerPawnExt:        row({staticClass: 0x100a7d70, internalCtor: 0x1001c360}),
  RadioBoxWindow:       row({staticClass: 0x100a8268, internalCtor: 0x10015900}),
  RootWindow:           row({staticClass: 0x100a8768, internalCtor: 0x10005c00}),
  ScaleWindow:          row({staticClass: 0x100aab28, internalCtor: 0x10016f10}),
  ScaleManagerWindow:   row({staticClass: 0x100ab030, internalCtor: 0x100182c0}),
  ScrollAreaWindow:     row({staticClass: 0x100ab540, internalCtor: 0x100186d0}),
  ExtString:            row({staticClass: 0x100aba40, internalCtor: 0x1001cbc0}),
  TabGroupWindow:       row({staticClass: 0x100abf48, internalCtor: 0x10004cb0}),
  TextWindow:           row({staticClass: 0x100ac450, internalCtor: 0x10008e60}),
  TextLogWindow:        row({staticClass: 0x100ac960, internalCtor: 0x10014830}),
  TileWindow:           row({staticClass: 0x100ace60, internalCtor: 0x10015090}),
  ToggleWindow:         row({staticClass: 0x100ad378, internalCtor: 0x10009970}),
  ViewportWindow:       row({staticClass: 0x100ad878, internalCtor: 0x10018ae0}),
  Window:               row({staticClass: 0x100ae5b8, internalCtor: 0x10003120}),
});

export const CONSYS_CLASSES = freeze({
  ConAudioList:         row({staticClass: 0x1001dcd8, internalCtor: 0x10001620}),
  ConCamera:            row({staticClass: 0x1001e1d8, internalCtor: 0x10003db0}),
  ConChoice:            row({staticClass: 0x1001e6d8, internalCtor: 0x10001f30}),
  ConEvent:             row({staticClass: 0x1001ebd8, internalCtor: 0x10002330}),
  ConEventAddCredits:   row({staticClass: 0x1001f0d8, internalCtor: 0x10005aa0}),
  ConEventAddGoal:      row({staticClass: 0x1001f5d8, internalCtor: 0x100060e0}),
  ConEventAddNote:      row({staticClass: 0x1001fad8, internalCtor: 0x10006720}),
  ConEventAddSkillPoints:row({staticClass: 0x1001ffd8, internalCtor: 0x10006cc0}),
  ConEventAnimation:    row({staticClass: 0x100204d0, internalCtor: 0x100073e0}),
  ConEventCheckFlag:    row({staticClass: 0x100209d8, internalCtor: 0x10007960}),
  ConEventCheckObject:  row({staticClass: 0x10020ed8, internalCtor: 0x10007e90}),
  ConEventCheckPersona: row({staticClass: 0x100213d8, internalCtor: 0x10008490}),
  ConEventChoice:       row({staticClass: 0x100218d8, internalCtor: 0x10008a60}),
  ConEventComment:      row({staticClass: 0x10021dd8, internalCtor: 0x10008fa0}),
  ConEventEnd:          row({staticClass: 0x100222d8, internalCtor: 0x10009450}),
  ConEventJump:         row({staticClass: 0x100227d8, internalCtor: 0x10004420}),
  ConEventMoveCamera:   row({staticClass: 0x10022cd8, internalCtor: 0x10009aa0}),
  ConEventRandomLabel:  row({staticClass: 0x100231d8, internalCtor: 0x1000a730}),
  ConEventSetFlag:      row({staticClass: 0x100236e0, internalCtor: 0x1000ad90}),
  ConEventSpeech:       row({staticClass: 0x10023be0, internalCtor: 0x1000b310}),
  ConEventTrade:        row({staticClass: 0x100240e0, internalCtor: 0x1000b940}),
  ConEventTransferObject:row({staticClass: 0x100245e0, internalCtor: 0x1000bf80}),
  ConEventTrigger:      row({staticClass: 0x10024ae0, internalCtor: 0x1000c710}),
  ConFlagRef:           row({staticClass: 0x10024fe0, internalCtor: 0x10001c60}),
  ConHistory:           row({staticClass: 0x100254e0, internalCtor: 0x10003520}),
  ConHistoryEvent:      row({staticClass: 0x100259e0, internalCtor: 0x100039b0}),
  ConImport:            row({staticClass: 0x10025ed8, internalCtor: 0x10004ea0}),
  ConItem:              row({staticClass: 0x100263e0, internalCtor: 0x10002d10}),
  ConListItem:          row({staticClass: 0x100268e0, internalCtor: 0x10002e60}),
  ConObject:            row({staticClass: 0x10026de0, internalCtor: 0x10001370}),
  ConSpeech:            row({staticClass: 0x100272e0, internalCtor: 0x10001a00}),
  Conversation:         row({staticClass: 0x100277e8, internalCtor: 0x100026d0}),
  ConversationList:     row({staticClass: 0x10027ce8, internalCtor: 0x10003070}),
  ConversationMissionList:row({staticClass: 0x100281e8, internalCtor: 0x10003300}),
});

export const FIRE_CLASSES = freeze({
  FractalTexture:       row({staticClass: 0x10518560, internalCtor: null, dynamicConstructor: true}),
  FireTexture:          row({staticClass: 0x10519088, internalCtor: 0x1050b950}),
  WaterTexture:         row({staticClass: 0x10517340, internalCtor: null, dynamicConstructor: true}),
  WaveTexture:          row({staticClass: 0x10517d38, internalCtor: 0x1050ca30}),
  WetTexture:           row({staticClass: 0x10517838, internalCtor: 0x1050d310}),
  IceTexture:           row({staticClass: 0x10518a88, internalCtor: 0x1050dc50}),
});

export const IPDRV_CLASSES = freeze({
  InternetLink:         row({staticClass: 0x10726218, internalCtor: 0x107012a8}),
  TcpLink:              row({staticClass: 0x10726878, internalCtor: 0x1070106e}),
  TcpipConnection:      row({staticClass: 0x10727378, internalCtor: 0x10701023}),
  TcpNetDriver:         row({staticClass: 0x10726e78, internalCtor: 0x10701154}),
  UdpLink:              row({staticClass: 0x10727a78, internalCtor: 0x10701122}),
  MasterServerCommandlet:row({staticClass: 0x10728078, internalCtor: 0x10701276}),
  UpdateServerCommandlet:row({staticClass: 0x10728678, internalCtor: 0x107012fd}),
});

export const DEUSEXTEXT_CLASSES = freeze({
  DeusExTextParser:     row({staticClass: 0x1000a438, internalCtor: 0x10004220}),
});

const REGISTRY = freeze({
  Core: CORE_CLASSES,
  Engine: ENGINE_CLASSES,
  DeusEx: DEUSEX_CLASSES,
  Extension: EXTENSION_CLASSES,
  ConSys: CONSYS_CLASSES,
  Fire: FIRE_CLASSES,
  IpDrv: IPDRV_CLASSES,
  DeusExText: DEUSEXTEXT_CLASSES,
});

/**
 * The `findRegisteredClass` service for `bindScriptClassConstructor`: the
 * native `autoclass` lookup at `0x1015a5a0` walks the outer package's +0x28
 * record list by name.  Here the package argument is the class's outer
 * package name ('Core' | 'Engine' | 'DeusEx'); returns the registered
 * +0x4e0 ClassConstructor or null when no record exists.
 */
export function findNativeClassConstructor(packageName, className) {
  const table = REGISTRY[packageName];
  if (!table) return null;
  const entry = table[className];
  if (!entry) return null;
  return entry.internalCtor;
}

/**
 * True when the package/class has a registration record but its
 * InternalConstructor is threaded dynamically at static-init (UE1 deferred
 * templated registration) and is therefore recorded as `internalCtor: null`.
 * `UClass::Bind` uses this to suppress the spurious "Can't bind" warning — the
 * original's autoclass record exists (docs/original-startup-log.md shows a
 * clean run with zero such warnings) — and inherits the superclass constructor.
 */
export function isNativeClassRegisteredDynamic(packageName, className) {
  const entry = REGISTRY[packageName]?.[className];
  return Boolean(entry && entry.internalCtor == null && entry.dynamicConstructor);
}
