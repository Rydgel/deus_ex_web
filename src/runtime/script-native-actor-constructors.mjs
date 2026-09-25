/**
 * Every native Actor-class constructor, generated from the original DLLs by
 * scripts/validate-native-actor-constructors.mjs --write (do not edit by hand).
 *
 * UClass::Bind copies the nearest native ancestor's ClassConstructor down to a
 * script-only class, so this table is the construction contract of every
 * SpawnActor product. Each row is the registered InternalConstructor run once
 * on a patterned instance: `vtable` is the final +0 store, `pendingKillBody`
 * the body its +0x2c IsPendingKill entry reaches through jump thunks, and
 * `memberBytes` the bytes the body
 * writes besides the vtable ([offset, value]; absent when it writes none, which
 * leaves template members intact in the patterned case). `conditionalFlagBase`
 * records the original allocation required when the inherited FlagBase is null;
 * it is verified in a separate null-pointer case. The command line is empty.
 * `unresolved` rows name why the
 * body could not be run. Evidence: docs/script-spawn.md "Native constructor family".
 */
const freeze = value => Object.freeze(value);
const row = fields => freeze(fields);

export const NATIVE_ACTOR_CONSTRUCTORS = freeze({
  'deusex.augmentation': row({dll: 'DeusEx.dll', internalCtor: 0x1000c6b0, vtable: 0x10027984, pendingKillBody: 0x1030df80}),
  'deusex.augmentationmanager': row({dll: 'DeusEx.dll', internalCtor: 0x1000bf40, vtable: 0x100278f4, pendingKillBody: 0x1030df80}),
  'deusex.deusexdecoration': row({dll: 'DeusEx.dll', internalCtor: 0x1000a5f0, vtable: 0x10027744, pendingKillBody: 0x1030df80}),
  'deusex.deusexlevelinfo': row({dll: 'DeusEx.dll', internalCtor: 0x10009e40, vtable: 0x100276b4, pendingKillBody: 0x1030df80}),
  'deusex.deusexplayer': row({dll: 'DeusEx.dll', internalCtor: 0x100016b0, vtable: 0x10027568, pendingKillBody: 0x1030df80, conditionalFlagBase: freeze({"offset":2192,"className":"Extension.FlagBase","instanceSize":300,"vtable":302367244,"defaultExpiration":0})}),
  'deusex.scriptedpawn': row({dll: 'DeusEx.dll', internalCtor: 0x100044c0, vtable: 0x10027624, pendingKillBody: 0x1030df80}),
  'deusex.skill': row({dll: 'DeusEx.dll', internalCtor: 0x1000b6b0, vtable: 0x10027864, pendingKillBody: 0x1030df80}),
  'deusex.skillmanager': row({dll: 'DeusEx.dll', internalCtor: 0x1000af50, vtable: 0x100277d4, pendingKillBody: 0x1030df80}),
  'engine.actor': row({dll: 'Engine.dll', internalCtor: 0x10302dab, vtable: 0x104268dc, pendingKillBody: 0x1030df80}),
  'engine.brush': row({dll: 'Engine.dll', internalCtor: 0x10302284, vtable: 0x10426c9c, pendingKillBody: 0x1030df80}),
  'engine.buttonmarker': row({dll: 'Engine.dll', internalCtor: 0x1030115e, vtable: 0x10427ee8, pendingKillBody: 0x1030df80}),
  'engine.camera': row({dll: 'Engine.dll', internalCtor: 0x10303a53, vtable: 0x10426b18, pendingKillBody: 0x1030df80}),
  'engine.camerapoint': row({dll: 'Engine.dll', internalCtor: 0x103033af, vtable: 0x10427178, pendingKillBody: 0x1030df80}),
  'engine.carcass': row({dll: 'Engine.dll', internalCtor: 0x103030ee, vtable: 0x1042839c, pendingKillBody: 0x1030df80}),
  'engine.decal': row({dll: 'Engine.dll', internalCtor: 0x10303a26, vtable: 0x10426f74, pendingKillBody: 0x1030df80, memberBytes: freeze([[0x320, 0x0], [0x321, 0x0], [0x322, 0x0], [0x323, 0x0], [0x324, 0x0], [0x325, 0x0], [0x326, 0x0], [0x327, 0x0], [0x328, 0x0], [0x329, 0x0], [0x32a, 0x0], [0x32b, 0x0]])}),
  'engine.decoration': row({dll: 'Engine.dll', internalCtor: 0x1030248c, vtable: 0x104282f0, pendingKillBody: 0x1030df80}),
  'engine.gameinfo': row({dll: 'Engine.dll', internalCtor: 0x10301802, vtable: 0x10427ae0, pendingKillBody: 0x1030df80}),
  'engine.gamereplicationinfo': row({dll: 'Engine.dll', internalCtor: 0x10302f81, vtable: 0x10427428, pendingKillBody: 0x1030df80}),
  'engine.hud': row({dll: 'Engine.dll', internalCtor: 0x10301bf4, vtable: 0x104284f4, pendingKillBody: 0x1030df80}),
  'engine.info': row({dll: 'Engine.dll', internalCtor: 0x1030348b, vtable: 0x104272d0, pendingKillBody: 0x1030df80}),
  'engine.internetinfo': row({dll: 'Engine.dll', internalCtor: 0x1030342c, vtable: 0x104276d8, pendingKillBody: 0x1030df80}),
  'engine.interpolationpoint': row({dll: 'Engine.dll', internalCtor: 0x10301992, vtable: 0x10427224, pendingKillBody: 0x1030df80}),
  'engine.inventory': row({dll: 'Engine.dll', internalCtor: 0x1030299b, vtable: 0x104286f8, pendingKillBody: 0x1030df80}),
  'engine.inventoryspot': row({dll: 'Engine.dll', internalCtor: 0x1030191a, vtable: 0x10428040, pendingKillBody: 0x1030df80}),
  'engine.keypoint': row({dll: 'Engine.dll', internalCtor: 0x10303148, vtable: 0x10427020, pendingKillBody: 0x1030df80}),
  'engine.levelinfo': row({dll: 'Engine.dll', internalCtor: 0x10302f45, vtable: 0x10427a34, pendingKillBody: 0x1030df80}),
  'engine.liftcenter': row({dll: 'Engine.dll', internalCtor: 0x10302739, vtable: 0x10427d90, pendingKillBody: 0x1030df80}),
  'engine.liftexit': row({dll: 'Engine.dll', internalCtor: 0x103018a2, vtable: 0x10427ce4, pendingKillBody: 0x1030df80}),
  'engine.light': row({dll: 'Engine.dll', internalCtor: 0x10302a54, vtable: 0x104288fc, pendingKillBody: 0x1030df80}),
  'engine.locationid': row({dll: 'Engine.dll', internalCtor: 0x10301b81, vtable: 0x104270cc, pendingKillBody: 0x1030df80}),
  'engine.menu': row({dll: 'Engine.dll', internalCtor: 0x103015af, vtable: 0x10428448, pendingKillBody: 0x1030df80}),
  'engine.mover': row({dll: 'Engine.dll', internalCtor: 0x10302b62, vtable: 0x10426e08, pendingKillBody: 0x1030df80}),
  'engine.mutator': row({dll: 'Engine.dll', internalCtor: 0x10303418, vtable: 0x10427b8c, pendingKillBody: 0x1030df80}),
  'engine.navigationpoint': row({dll: 'Engine.dll', internalCtor: 0x10301d07, vtable: 0x10427c38, pendingKillBody: 0x1030df80}),
  'engine.pathnode': row({dll: 'Engine.dll', internalCtor: 0x10301a2d, vtable: 0x10428244, pendingKillBody: 0x1030df80}),
  'engine.pawn': row({dll: 'Engine.dll', internalCtor: 0x103029f5, vtable: 0x10426994, pendingKillBody: 0x1030df80}),
  'engine.playerpawn': row({dll: 'Engine.dll', internalCtor: 0x10301ff0, vtable: 0x10426a40, pendingKillBody: 0x1030df80}),
  'engine.playerreplicationinfo': row({dll: 'Engine.dll', internalCtor: 0x10302333, vtable: 0x104274d4, pendingKillBody: 0x1030df80}),
  'engine.playerstart': row({dll: 'Engine.dll', internalCtor: 0x103035d5, vtable: 0x104280ec, pendingKillBody: 0x1030df80}),
  'engine.projectile': row({dll: 'Engine.dll', internalCtor: 0x103014e7, vtable: 0x10428850, pendingKillBody: 0x1030df80}),
  'engine.replicationinfo': row({dll: 'Engine.dll', internalCtor: 0x103013d4, vtable: 0x1042737c, pendingKillBody: 0x1030df80}),
  'engine.savedmove': row({dll: 'Engine.dll', internalCtor: 0x103028ba, vtable: 0x10427784, pendingKillBody: 0x1030df80}),
  'engine.scout': row({dll: 'Engine.dll', internalCtor: 0x103032a6, vtable: 0x10426bf0, pendingKillBody: 0x1030df80}),
  'engine.skyzoneinfo': row({dll: 'Engine.dll', internalCtor: 0x10302072, vtable: 0x10427988, pendingKillBody: 0x1030df80}),
  'engine.spawnnotify': row({dll: 'Engine.dll', internalCtor: 0x103038dc, vtable: 0x10426ec8, pendingKillBody: 0x1030df80}),
  'engine.statlog': row({dll: 'Engine.dll', internalCtor: 0x1030251d, vtable: 0x10427580, pendingKillBody: 0x1030df80}),
  'engine.statlogfile': row({dll: 'Engine.dll', internalCtor: 0x10301b3b, vtable: 0x1042762c, pendingKillBody: 0x1030df80}),
  'engine.teleporter': row({dll: 'Engine.dll', internalCtor: 0x10301159, vtable: 0x10428198, pendingKillBody: 0x1030df80}),
  'engine.trigger': row({dll: 'Engine.dll', internalCtor: 0x103010c3, vtable: 0x1042864c, pendingKillBody: 0x1030df80}),
  'engine.triggermarker': row({dll: 'Engine.dll', internalCtor: 0x1030214e, vtable: 0x10427f94, pendingKillBody: 0x1030df80}),
  'engine.triggers': row({dll: 'Engine.dll', internalCtor: 0x10301483, vtable: 0x104285a0, pendingKillBody: 0x1030df80}),
  'engine.warpzoneinfo': row({dll: 'Engine.dll', internalCtor: 0x103015b4, vtable: 0x104278dc, pendingKillBody: 0x1030df80}),
  'engine.warpzonemarker': row({dll: 'Engine.dll', internalCtor: 0x103038af, vtable: 0x10427e3c, pendingKillBody: 0x1030df80}),
  'engine.weapon': row({dll: 'Engine.dll', internalCtor: 0x10302ef5, vtable: 0x104287a4, pendingKillBody: 0x1030df80}),
  'engine.zoneinfo': row({dll: 'Engine.dll', internalCtor: 0x10302dc9, vtable: 0x10427830, pendingKillBody: 0x1030df80}),
  'extension.playerpawnext': row({dll: 'Extension.dll', internalCtor: 0x1001c360, vtable: 0x1205c32c, pendingKillBody: 0x1030df80, conditionalFlagBase: freeze({"offset":2192,"className":"Extension.FlagBase","instanceSize":300,"vtable":302367244,"defaultExpiration":0})}),
});
