/** Mission 9, the Brooklyn Naval Shipyard and the cemetery (docs/stage-6-inventory.md 09.6, docs/stage-6-chains.md): from the dockyard's arrival to the exit to
 * 10_Paris_Catacombs. The maps' own means: DL_Insertion; Teleporter6 into the Naval Assembly building (the front guards, the gates and the doors are walked
 * past by the placement); GoalCompleteTrigger3 with DL_BuildingEntryMain, DL_ShipEntry; AmmoRocket9 (rockets for the welds); Teleporter1 below decks; the
 * map's GEP gun WeaponGEPGun0 and one rocket at each of the five ShipBreech welds (minDamageThreshold 60, doorStrength 0.9: one rocket each, measured in
 * Play); ComputerPersonal0's special option "Reverse Pump Flow" (TriggerEvent PumpTrigger, FlagTrigger1 sets Bilge; userList PumpControl/Flush), so
 * Mission09.Timer plays DL_AllPlaced (welds gone, no Bilge) then DL_AllDone and sets MS_ShipBreeched; back up, DL_ShipExit, the dockyard (FirstFrame:
 * MS_ShipBreeched brings the roof's BlackHelicopter0 into the world), DL_Scuttled and the helicopter's frob (no BindName: DeusExDecoration.Frob triggers its
 * Event ToGraveyard, MapExit0 with its camera path); the cemetery: DL_Entry, M09MeetStantonDowd, the crypt's FlagTrigger1 (DL_Problem), the EM device
 * BreakableWall1 shot with the pistol (Event EMOff: deviceDestroyed), Mission09.Timer's helicopter and DL_ComingIn, M09JockLeave's Go branch (ChopperExit).
 * Placements from scripts/chain-plan.mjs (`drop`, `face`, `stand`) on the cold maps, the welds and the two helicopters measured in the level the chain
 * reaches.
 *
 * PROVISIONAL START: mission 8's chain (and its exit save) does not exist yet, so the chain starts from the real slot nicouzouf Save0021 (09_NYC_Dockyard
 * near the arrival, DL_Insertion not yet played); it becomes `{ op: 'start', kind: 'slot', source: 'chain', chain: '08', slot: 'Save0108', index: 108 }`
 * once mission 8's exit save exists. Start-dependent: `belt 6` is the slot's own GEP gun (the map's WeaponGEPGun0 adds its 4 rockets to it; a player
 * without one gets the map's gun on its own belt slot), and `belt 1` the pistol. */
const cheats = [
  { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
  { op: 'line', text: 'God', harness: true },
];
export default {
  mission: '09',
  steps: [
    // provisional (see above): becomes the start from mission 8's exit save
    { op: 'start', kind: 'slot', source: 'nicouzouf', slot: 'Save0021', index: 21 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'f1-loaded' },
    ...cheats,

    // the dockyard: DL_Insertion, then Teleporter6 into the Naval Assembly building
    { op: 'place', at: [2432, 1319, 130], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger0 (2432,1319,40, radius 60; DL_Insertion)' },
    { op: 'wait', flag: 'DL_Insertion_Played', timeout: 120 },
    { op: 'snap', label: 'f2-insertion' },
    { op: 'place', at: [4480, 6743, 280], view: [0, 0], drop: true, harness: true, note: 'above Teleporter6 (4480,6743,190, radius 60; 09_NYC_Ship#EnterShip)' },
    { op: 'travel', to: '09_NYC_Ship', label: 'leg1' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'f3-ship' },

    { op: 'place', at: [2178, -1733, -90], view: [0, 0], drop: true, harness: true, note: 'above GoalCompleteTrigger3 (2178,-1733,-180, radius 40; GetIntoSubPen), beside DataLinkTrigger0 (DL_BuildingEntryMain): the fall touches both' },
    { op: 'wait', flag: 'DL_BuildingEntryMain_Played', timeout: 120 },
    { op: 'place', at: [2361, -915, 402], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger2 (2361,-915,312, radius 96; DL_ShipEntry) on the ship' },
    { op: 'wait', flag: 'DL_ShipEntry_Played', timeout: 120 },
    { op: 'place', at: [2967, 429, 721], view: [-9678, 49116], harness: true, note: '60 units north of AmmoRocket9 (2967,369,680), aimed at it' },
    { op: 'frob', target: 'AmmoRocket9' },
    { op: 'snap', label: 'f4-ship-entry' },
    { op: 'place', at: [2478, 453, 402], view: [0, 0], drop: true, harness: true, note: 'above Teleporter1 (2478,453,312, radius 56; 09_NYC_ShipBelow#FromAbove)' },
    { op: 'travel', to: '09_NYC_ShipBelow', label: 'leg2' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'f5-shipbelow' },

    // the five hull welds (ShipBreech movers, minDamageThreshold 60, doorStrength 0.9): one GEP rocket each, from the inside of the hull
    { op: 'place', at: [-4263, -182, -207], view: [-8598, 57], harness: true, note: '75 units west of WeaponGEPGun0 (-4188,-182,-249; 4 rockets), aimed at it' },
    { op: 'frob', target: 'WeaponGEPGun0' },
    { op: 'belt', n: 6, note: 'the GEP gun (the slot\'s, on belt 6: the map\'s gun added its rockets to it)' },
    { op: 'wait', seconds: 3, note: 'the selected GEP reloads first (DeusExWeapon state Reload): a click before it ends fires nothing' },
    { op: 'place', at: [832, -796, -463], view: [-871, 49152], harness: true, note: '200 units north of the weld DeusExMover40 (wall1; its CrateExplosiveSmall1 at 832,-996,-491), aimed 50 units above the crate' },
    { op: 'click', settle: 180 },
    { op: 'place', at: [833, 793, -463], view: [-871, 16384], harness: true, note: '200 units south of the weld DeusExMover16 (wall2; CrateExplosiveSmall0 at 833,993,-491), aimed 50 units above the crate' },
    { op: 'click', settle: 180 },
    { op: 'place', at: [-3680, 1416, -463], view: [-871, 16384], harness: true, note: '200 units south of the weld DeusExMover31 (wall3; CrateExplosiveSmall4 at -3680,1616,-491), aimed 50 units above the crate' },
    { op: 'click', settle: 180 },
    { op: 'place', at: [-6349, 140, -463], view: [-1077, 28799], harness: true, note: '150 units east and 60 south of the weld DeusExMover32 (Wall4; CrateExplosiveSmall3 at -6499,200,-491), aimed 50 units above the crate' },
    { op: 'click', settle: 180 },
    { op: 'place', at: [-3296, -1432, -431], view: [-2496, 49152], harness: true, note: '200 units north of the weld DeusExMover33 (Wall5; CrateExplosiveSmall2 at -3296,-1632,-491), aimed 50 units above the crate' },
    { op: 'click', settle: 180 },
    // Mission09.Timer: no ShipBreech mover left and no Bilge yet: DL_AllPlaced
    { op: 'wait', flag: 'DL_AllPlaced_Played', timeout: 120 },
    { op: 'snap', label: 'f6-welds' },

    // the bilge pump: ComputerPersonal0's special option "Reverse Pump Flow" (TriggerEvent PumpTrigger: FlagTrigger1 sets Bilge), logged in as PumpControl/Flush
    // (one of its three users in the map's userList); the Timer then plays DL_AllDone and sets MS_ShipBreeched
    { op: 'place', at: [-2447, -642, -415], view: [-10778, 49063], harness: true, note: '48 units north of ComputerPersonal0 (-2447,-690,-457), aimed at it' },
    { op: 'frob', target: 'ComputerPersonal0', watch: ['ComputerPersonal0'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'PumpControl' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'Flush' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 329], note: 'the special option "Reverse Pump Flow" (the one option: the button of mission 15 ending 2\'s terminal)' },
    { op: 'wait', flag: 'Bilge', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    { op: 'wait', flag: 'MS_ShipBreeched', timeout: 60 },
    { op: 'wait', flag: 'DL_AllDone_Played', timeout: 180 },
    { op: 'snap', label: 'f7-breeched' },

    // out: Teleporter3 to the ship, DL_ShipExit (needs MS_ShipBreeched), Teleporter3 to the dockyard
    { op: 'place', at: [-1548, -325, 82], view: [0, 0], drop: true, harness: true, note: 'above Teleporter3 (-1548,-325,-8, radius 60; 09_NYC_Ship#FromBelow)' },
    { op: 'travel', to: '09_NYC_Ship', label: 'leg3' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [2707, 163, 386], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger3 (2707,163,296, radius 96; DL_ShipExit, checkFlag MS_ShipBreeched)' },
    { op: 'wait', flag: 'DL_ShipExit_Played', timeout: 120 },
    { op: 'snap', label: 'f8-ship-exit' },
    { op: 'place', at: [2438, -2352, -118], view: [0, 0], drop: true, harness: true, note: 'above Teleporter3 (2438,-2352,-208, radius 60; 09_NYC_Dockyard#ExitShip)' },
    { op: 'travel', to: '09_NYC_Dockyard', label: 'leg4' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    // Mission09.FirstFrame: MS_ShipBreeched brings the BlackHelicopter tagged BlackHelicopter into the world on the roof
    { op: 'state', label: 'dockyard-helicopter', actor: 'BlackHelicopter0', fields: ['bHidden'] },
    { op: 'snap', label: 'f9-dockyard' },

    // the roof: DL_Scuttled (checkFlag MS_ShipBreeched), then the helicopter: it has no BindName, so DeusExDecoration.Frob triggers its Event ToGraveyard
    // (MapExit0 with the camera path, Dispatcher0's CopterTrigger, GoalCompleteTrigger0: Escape)
    { op: 'place', at: [4288, 6922, 1490], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger7 (4288,6922,1400, radius 96; DL_Scuttled)' },
    { op: 'wait', flag: 'DL_Scuttled_Played', timeout: 120 },
    { op: 'place', at: [3589, 6732, 1409], view: [475, 32784], harness: true, note: '265 units east of BlackHelicopter0 (3324,6732,1460 in the world, radius 225), aimed at its centre (planned in the level the chain reaches)' },
    { op: 'frob', target: 'BlackHelicopter0' },
    { op: 'travel', to: '09_NYC_Graveyard', label: 'leg5', timeout: 240 },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'f10-graveyard' },

    // the graveyard: DL_Entry; Stanton Dowd in the crypt (Wandering: placed from where he is, in both programs); the crypt's exit FlagTrigger1 (DL_Problem
    // once M09MeetStantonDowd_Played); the EM device BreakableWall1 (minDamageThreshold 5, Event EMOff: FlagTrigger0 sets deviceDestroyed) shot with the pistol;
    // Mission09.Timer then brings Jock's helicopter (DL_ComingIn)
    { op: 'place', at: [375, 1941, 122], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger0 (375,1941,32, radius 160; DL_Entry)' },
    { op: 'wait', flag: 'DL_Entry_Played', timeout: 120 },
    // Dowd (Orders Wandering) stands still until the player is in his zone, then walks (about 70 units in the placement's two seconds, and the frob missed
    // him): the level is held (bPlayersOnly) while the player is placed from where Dowd stands and aimed at him, and the frob follows the release at once
    { op: 'line', text: 'set LevelInfo bPlayersOnly True', harness: true },
    { op: 'placeNear', actor: 'StantonDowd0', distance: 60, bearing: Math.PI, harness: true, note: '60 units west of Stanton Dowd (-1442,-37,-304 at his place), aimed at him' },
    { op: 'line', text: 'set LevelInfo bPlayersOnly False', harness: true, settle: 1 },
    { op: 'frob', target: 'StantonDowd0' },
    { op: 'conv', name: 'M09MeetStantonDowd', watch: ['StantonDowd0'], timeout: 240 },
    { op: 'snap', label: 'f11-dowd' },
    { op: 'place', at: [-1076, -387, -13], view: [0, 0], drop: true, harness: true, note: 'above FlagTrigger1 (-1076,-387,-103, radius 96; M09MeetStantonDowd_Played: event JocksProblem, DataLinkTrigger3 DL_Problem)' },
    { op: 'wait', flag: 'DL_Problem_Played', timeout: 120 },
    { op: 'place', at: [1039, 792, 57], view: [-5062, 57344], harness: true, note: '90 units north-west of BreakableWall1 (1103,728,48; the EM device), aimed at it' },
    { op: 'belt', n: 1, note: 'the pistol' },
    { op: 'wait', seconds: 2 },
    { op: 'click', until: { flag: 'deviceDestroyed' }, gap: 1.5, max: 10 },
    { op: 'wait', flag: 'DL_ComingIn_Played', timeout: 180 },
    { op: 'state', label: 'graveyard-helicopter', actor: 'BlackHelicopter1', fields: ['bHidden'] },
    { op: 'snap', label: 'f12-coming-in' },

    // Jock: M09JockLeave (BlackHelicopter1, BindName Jock, radius 240 inside its 225 cylinder) by the right button; its Go branch triggers ChopperExit:
    // Dispatcher1 fires CopterTrigger (the helicopter's path) and CopterCam (MapExit0 and its camera path to 10_Paris_Catacombs)
    { op: 'place', at: [1104, -270, 49], view: [296, 32759], harness: true, note: '265 units east of BlackHelicopter1 (839,-270,95 in the world, radius 225), aimed at its centre (planned in the level the chain reaches)' },
    { op: 'frob', target: 'BlackHelicopter1' },
    { op: 'conv', name: 'M09JockLeave', choose: [{ index: 0, label: 'Go' }], watch: ['BlackHelicopter1'], timeout: 120 },
    { op: 'travel', to: '10_Paris_Catacombs', label: 'exit', timeout: 240 },
    ...cheats,
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'f13-paris' },
    // mission 10's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 109, label: 'exit' },
  ],
};
