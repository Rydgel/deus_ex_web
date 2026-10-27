/** The classes the original's DLLs register at startup, which carry RF_Native (0x04000000) for the whole process: the only objects
 * with that flag in every registry dump of the probes gc1 and gc2 (DX.dx, 00_Training, 01_NYC_UNATCOIsland, Training again; 238 each,
 * the same set; docs/class-lifetime.md). UObject::CollectGarbage(RF_Native) keeps them and marks from them (SerializeRootSet visits
 * every object with the keep flags), so they are the process collection's roots besides the root array (script-process-collection.mjs).
 * A package's list holds its registered classes whether or not their script export has loaded. */
export const NATIVE_CLASSES = Object.freeze({
  Core: ['ArrayProperty', 'BoolProperty', 'ByteProperty', 'Class', 'ClassProperty', 'Commandlet', 'Const', 'DebugInfo', 'Enum',
    'Exporter', 'Factory', 'Field', 'FixedArrayProperty', 'FloatProperty', 'Function', 'IntProperty', 'Language', 'Linker',
    'LinkerLoad', 'LinkerSave', 'MapProperty', 'NameProperty', 'Object', 'ObjectProperty', 'Package', 'PackageMap', 'Property',
    'State', 'StrProperty', 'Struct', 'StructProperty', 'Subsystem', 'System', 'TextBuffer', 'TextBufferFactory'],
  Engine: ['AIEvent', 'AIEventType', 'AIReceiverEvent', 'AISenderEvent', 'Actor', 'ActorChannel', 'AudioSubsystem', 'Bitmap', 'Brush',
    'BspNodes', 'BspSurfs', 'ButtonMarker', 'Camera', 'CameraPoint', 'Canvas', 'Carcass', 'Channel', 'Client', 'Console',
    'ControlChannel', 'Decal', 'Decoration', 'DemoPlayPendingLevel', 'DemoRecConnection', 'DemoRecDriver', 'Engine', 'EventManager',
    'FileChannel', 'Font', 'GameEngine', 'GameInfo', 'GameReplicationInfo', 'HUD', 'Info', 'Input', 'InternetInfo',
    'InterpolationPoint', 'Inventory', 'InventorySpot', 'Keypoint', 'Level', 'LevelBase', 'LevelInfo', 'LevelSummary', 'LiftCenter',
    'LiftExit', 'Light', 'LodMesh', 'Menu', 'Mesh', 'Model', 'Mover', 'Music', 'Mutator', 'NavigationPoint', 'NetConnection',
    'NetDriver', 'NetPendingLevel', 'PackageMapLevel', 'Palette', 'PathNode', 'Pawn', 'PendingLevel', 'Player', 'PlayerPawn',
    'PlayerReplicationInfo', 'PlayerStart', 'Polys', 'Primitive', 'Projectile', 'RenderBase', 'RenderDevice', 'RenderIterator',
    'ReplicationInfo', 'SavedMove', 'Scout', 'ScriptedTexture', 'ServerCommandlet', 'SkyZoneInfo', 'Sound', 'SpawnNotify', 'StatLog',
    'StatLogFile', 'Teleporter', 'Texture', 'Trigger', 'TriggerMarker', 'Triggers', 'Vectors', 'Verts', 'Viewport', 'WarpZoneInfo',
    'WarpZoneMarker', 'Weapon', 'ZoneInfo', 'locationid'],
  Extension: ['BorderWindow', 'ButtonWindow', 'CheckboxWindow', 'ClipWindow', 'ComputerWindow', 'EditWindow', 'ExtString',
    'ExtensionObject', 'Flag', 'FlagBase', 'FlagBool', 'FlagByte', 'FlagFloat', 'FlagInt', 'FlagName', 'FlagRotator', 'FlagVector',
    'GC', 'GameEngineExt', 'InputExt', 'LargeTextWindow', 'ListWindow', 'ModalWindow', 'PlayerPawnExt', 'RadioBoxWindow', 'RootWindow',
    'ScaleManagerWindow', 'ScaleWindow', 'ScrollAreaWindow', 'TabGroupWindow', 'TextLogWindow', 'TextWindow', 'TileWindow',
    'ToggleWindow', 'ViewportWindow', 'Window'],
  ConSys: ['ConAudioList', 'ConCamera', 'ConChoice', 'ConEvent', 'ConEventAddCredits', 'ConEventAddGoal', 'ConEventAddNote',
    'ConEventAddSkillPoints', 'ConEventAnimation', 'ConEventCheckFlag', 'ConEventCheckObject', 'ConEventCheckPersona',
    'ConEventChoice', 'ConEventComment', 'ConEventEnd', 'ConEventJump', 'ConEventMoveCamera', 'ConEventRandomLabel', 'ConEventSetFlag',
    'ConEventSpeech', 'ConEventTrade', 'ConEventTransferObject', 'ConEventTrigger', 'ConFlagRef', 'ConHistory', 'ConHistoryEvent',
    'ConImport', 'ConItem', 'ConListItem', 'ConObject', 'ConSpeech', 'Conversation', 'ConversationList', 'ConversationMissionList'],
  DeusEx: ['Augmentation', 'AugmentationManager', 'DataVaultImageNote', 'DeusExDecoration', 'DeusExGameEngine', 'DeusExLevelInfo',
    'DeusExLog', 'DeusExPlayer', 'DeusExSaveInfo', 'DumpLocation', 'GameDirectory', 'LaserIterator', 'ParticleIterator',
    'ScriptedPawn', 'Skill', 'SkillManager'],
  DeusExText: ['DeusExTextParser', 'TextImport'],
  Fire: ['FireTexture', 'FractalTexture', 'IceTexture', 'WaterTexture', 'WaveTexture', 'WetTexture'],
  Window: ['WindowManager'],
  IpDrv: ['InternetLink', 'MasterServerCommandlet', 'TcpLink', 'TcpNetDriver', 'TcpipConnection', 'UdpLink', 'UpdateServerCommandlet'],
  WinDrv: ['WindowsClient', 'WindowsViewport'],
  Render: ['Render'],
  D3DDrv: ['D3DRenderDevice'],
  Galaxy: ['GalaxyAudioSubsystem'],
});

/** Every native class as a lower-case "package.class" key. */
export const NATIVE_CLASS_KEYS = Object.freeze(new Set(Object.entries(NATIVE_CLASSES)
  .flatMap(([pkg, names]) => names.map(name => `${pkg}.${name}`.toLowerCase()))));
