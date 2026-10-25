/** Mission 10, Paris: the catacombs, the club, the metro and the chateau (docs/stage-6-inventory.md 10.6, docs/stage-6-chains.md): from mission 9's exit
 * (the save its chain pinned in 10_Paris_Catacombs) to Teleporter0 under the chateau, into 11_Paris_Cathedral#cathedralstart. The maps' own means:
 * DL_paris_10_start; the spiral stair's Teleporter0, the tunnels' Teleporter2 to the metro (Chad, Silhouette and the hostages are not on the chain); the
 * club's front teleporter, MeetNicolette (frob), the club's back teleporter (Mission10.PreTravel: NicoletteLeftClub); the metro (FirstFrame: Nicolette and
 * the helicopter enter), NicoletteOutside's Go branch (NicoletteReadyToLeave), JockReady (frob; its A1 branch triggers ChopperExit: MapExit1 and its
 * camera path); the chateau (FirstFrame: ClubComplete): NicoletteAtChateau (radius 120), DL_reached_computer, Beth DuClare's computer and its special
 * option "Transmit MEverett Meeting Signal" (userList bduclare/nico_angel; TriggerEvent everettsignal: FlagTrigger14's flag and the crypt doors), DL_EverettContact
 * (NicoletteRuns), LightSwitch2 for the bunker's secret door, NicoletteAfterEverett (radius 100), DL_EverettMaze, DL_entered_sewer and Teleporter0.
 * Placements from scripts/chain-plan.mjs (`drop`, `approach`, `face`, `terminal`) on the cold maps; Nicolette's and the helicopter's in the metro, and
 * the bunker's door, measured in the level the chain reaches. Walked past by the placements: the catacombs' and tunnels' doors, the club's entry (Louis),
 * the chateau's cellar and the candelabra's secret door on the way in; whether field002 (Keypad2, 1784; west of the computer room) stands on the original
 * route to the computer was not checked. */
const cheats = [
  { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
  // God mode set, not toggled: a restored arrival re-possesses the pawn filed there with its ReducedDamageType (the `God` toggle would switch it off)
  { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
];
export default {
  mission: '10',
  steps: [
    { op: 'start', kind: 'slot', source: 'chain', chain: '09', slot: 'Save0109', index: 109 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g1-loaded' },
    ...cheats,

    // the catacombs: DL_paris_10_start on the roof, then the spiral stair's Teleporter0 to the tunnels
    { op: 'place', at: [-3559, 4105, 2178], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger0 (-3559,4105,2088, radius 400; DL_paris_10_start)' },
    { op: 'wait', flag: 'DL_paris_10_start_Played', timeout: 120 },
    { op: 'place', at: [-252, 1437, -546], view: [0, 0], harness: true, note: '150 units west of Teleporter0 (-102,1437,-546, radius 100; the spiral stair to 10_Paris_Catacombs_Tunnels#spiralstair), facing it: the walk enters it' },
    { op: 'walk', untilTravel: true, seconds: 2 },
    { op: 'travel', to: '10_Paris_Catacombs_Tunnels', label: 'leg1' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g2-tunnels' },
    { op: 'place', at: [2478, -3789, -533], view: [0, 0], drop: true, harness: true, note: 'above Teleporter2 (2478,-3789,-623, radius 60; 10_Paris_Metro#sewer)' },
    { op: 'travel', to: '10_Paris_Metro', label: 'leg2' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g3-metro' },

    // the club: Teleporter7 (the front), MeetNicolette, then Teleporter0 (the back) to the metro: Mission10.PreTravel sets NicoletteLeftClub
    { op: 'place', at: [1195, 950, 259], view: [0, 0], drop: true, harness: true, note: 'above Teleporter7 (1195,950,149, radius 80; 10_Paris_Club#Paris_Club1)' },
    { op: 'travel', to: '10_Paris_Club', label: 'leg3' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g4-club' },
    { op: 'place', at: [-549, -1393, 49], view: [-5281, 32731], harness: true, turnFirst: true, note: '80 units east of NicoletteDuClare0 (-629,-1393 after a second of the map), aimed at her' },
    { op: 'frob', target: 'NicoletteDuClare0' },
    { op: 'conv', name: 'MeetNicolette', watch: ['NicoletteDuClare0'], timeout: 300 },
    { op: 'snap', label: 'g5-met-nicolette' },
    { op: 'place', at: [-2192, -1602, -51], view: [0, 0], drop: true, harness: true, note: 'above Teleporter0 (-2192,-1602,-161, radius 160; 10_Paris_Metro#Paris_Metro2)' },
    { op: 'travel', to: '10_Paris_Metro', label: 'leg4' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    // Mission10.FirstFrame: NicoletteLeftClub brings Nicolette and the helicopter tagged BlackHelicopter into the world
    { op: 'state', label: 'metro-nicolette', actor: 'NicoletteDuClare0', fields: ['bHidden'] },
    { op: 'state', label: 'metro-helicopter', actor: 'BlackHelicopter0', fields: ['bHidden'] },
    { op: 'snap', label: 'g6-metro-left-club' },
    { op: 'report', label: 'metro' },

    // NicoletteOutside (bump/frob): Nicolette walks from where she entered the world (3787,1859): the level is held while the player is placed from where she
    // stands, and the frob follows the release at once; its Go branch sets NicoletteReadyToLeave and triggers NicoletteFollows
    // the right button reaches a moving NPC only if he stands still: the original types the release of a held level and ParseRightClick over about 1.5 s
    // (mission 5's Alex walked out of the view in that time): his GroundSpeed is 0 for the conversation, then his class's 280 again
    { op: 'line', text: 'set DeusEx.NicoletteDuClare GroundSpeed 0', harness: true },
    { op: 'wait', seconds: 2 },
    { op: 'placeNear', actor: 'NicoletteDuClare0', distance: 60, bearing: Math.PI, harness: true, turnFirst: true, note: '60 units west of Nicolette where she stands (she walks from where she entered: 2916,651 and 3570,894 in two runs), aimed at her' },
    { op: 'frob', target: 'NicoletteDuClare0' },
    { op: 'conv', name: 'NicoletteOutside', choose: [{ index: 0, label: 'Go' }], watch: ['NicoletteDuClare0'], timeout: 240 },
    { op: 'line', text: 'set DeusEx.NicoletteDuClare GroundSpeed 280', harness: true },
    { op: 'snap', label: 'g7-ready-to-leave' },
    // JockReady (the helicopter BlackHelicopter0, BindName Jock; radius 200 inside its 461 cylinder) by the right button: its A1 branch triggers ChopperExit,
    // MapExit1 and its camera path to the chateau
    { op: 'place', at: [2635, 1101, 193], view: [1512, 4], harness: true, turnFirst: true, note: '500 units west of BlackHelicopter0 (3135,1101,305 in the world, radius 461), aimed at its centre (planned in the level the chain reaches)' },
    { op: 'frob', target: 'BlackHelicopter0' },
    { op: 'conv', name: 'JockReady', watch: ['BlackHelicopter0'], timeout: 120 },
    { op: 'travel', to: '10_Paris_Chateau', label: 'leg5', timeout: 240 },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g8-chateau' },
    { op: 'report', label: 'chateau' },

    // the chateau (Mission10.FirstFrame sets ClubComplete): NicoletteAtChateau (radius 120). Nicolette (Orders Following) stays about 180 units from the
    // arrival (120 s waited with her drawn): the player is placed 60 units from where she stands (the level held for the placement), her radius starts it
    { op: 'line', text: 'set LevelInfo bPlayersOnly True', harness: true },
    { op: 'placeNear', actor: 'NicoletteDuClare0', distance: 60, bearing: Math.PI / 2, harness: true, note: '60 units north of Nicolette where she stands (-400,2029,59 at the arrival), aimed at her' },
    { op: 'line', text: 'set LevelInfo bPlayersOnly False', harness: true, settle: 1 },
    { op: 'conv', name: 'NicoletteAtChateau', watch: ['NicoletteDuClare0'], timeout: 120 },
    // the computer room under the chateau: DL_reached_computer, then Beth DuClare's computer (ComputerPersonal0, tag beth_computer), logged in as its one
    // user bduclare/nico_angel: its special option "Transmit MEverett Meeting Signal" (TriggerEvent everettsignal: FlagTrigger14 sets everettsignal, and the
    // crypt doors tagged everettsignal are triggered)
    { op: 'place', at: [419, 4071, -78], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger1 (419,4071,-168, radius 100; DL_reached_computer)' },
    { op: 'wait', flag: 'DL_reached_computer_Played', timeout: 120 },
    { op: 'watch', actors: ['ComputerPersonal0'] },
    { op: 'place', at: [221, 4299, -107], view: [-11083, 32827], harness: true, note: '45 units east of ComputerPersonal0 (176,4299,-149), aimed at it (chain-plan.mjs terminal)' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal0' },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'bduclare' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'nico_angel' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 329], note: 'the special option "Transmit MEverett Meeting Signal" (chain-plan.mjs terminal: one button, (361,209) of Play\'s 720x480 root)' },
    { op: 'wait', flag: 'everettsignal', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    // DL_EverettContact (it triggers NicoletteRuns): DataLinkTrigger13 (200,4202,-168, radius 260; checkFlag everettsignal), which the drop at DL_reached_computer
    // fell through while the flag was false, re-checks it each second (DataLinkTrigger.EvaluateFlag's timer) and starts the DataLink a second after the signal;
    // the first capture's original had it played by g9, Play 4 s of game time later (the original's tool calls take wall-clock time): it is waited for
    { op: 'wait', flag: 'DL_EverettContact_Played', timeout: 120 },
    { op: 'state', label: 'crypt-door-1', actor: 'DeusExMover10', fields: ['KeyNum', 'bLocked'] },
    { op: 'state', label: 'crypt-door-2', actor: 'DeusExMover11', fields: ['KeyNum', 'bLocked'] },
    { op: 'snap', label: 'g9-signal' },
    { op: 'snap', label: 'g10-everett-contact' },
    // NicoletteRuns (OrdersTrigger1: RunningTo, no ordersTag) sends Nicolette running to the player; she stops behind the bunker's secret door
    // (DeusExMover16, tag cellar_door, TriggerToggle, closed: the placement went past the candelabra that opens it for 8 s; measured: 947,2659 after a
    // minute). LightSwitch2 on the bunker's side (event cellar_door) opens it; NicoletteAfterEverett (radius 100) starts when she reaches the player
    // (the crypt key, GoToCrypt, NicoletteFollows)
    { op: 'place', at: [881, 2808, -439], view: [5851, 49166], harness: true, turnFirst: true, note: '60 units north of LightSwitch2 (881,2748,-363), aimed at it' },
    { op: 'frob', target: 'LightSwitch2' },
    { op: 'conv', name: 'NicoletteAfterEverett', watch: ['NicoletteDuClare0'], timeout: 180 },
    { op: 'state', label: 'bunker-door', actor: 'DeusExMover16', fields: ['KeyNum', 'bLocked'] },
    { op: 'snap', label: 'g11-after-everett' },

    // the garden's maze (DL_EverettMaze), the crypt (its doors tagged everettsignal opened by the signal: KeyNum 1, bLocked kept), the sewer
    // (DL_entered_sewer) and Teleporter0 to 11_Paris_Cathedral#cathedralstart
    { op: 'place', at: [-259, -1997, 146], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger8 (-259,-1997,56, radius 240; DL_everettmaze)' },
    { op: 'wait', flag: 'DL_EverettMaze_Played', timeout: 120 },
    // Nicolette (NicoletteFollows: Orders Following since NicoletteAfterEverett) follows to the maze: FlagTrigger17/18 (radius 300/320, her class) stop her at
    // NicoStops and set NicoletteDoneFollowing (SetDoneFlag, DL_EverettContact_Played), then NicoletteFinalBarks2 (radius 200, NicoletteLeaves) plays with the
    // player at the maze; the first capture's original had both by g12, Play neither: she is waited for, drawn (the headless stand-in)
    // the player waits at the triggers' centre so that she follows into both cylinders (FlagTrigger18 first, its flag before FlagTrigger17's NicoStops:
    // Standing); waiting at the maze's DataLink she stopped 204 units off, inside 18 and outside 17, and kept following (Play). Then beside her for the bark
    { op: 'watch', actors: ['NicoletteDuClare0'] },
    { op: 'place', at: [-264, -2140, 146], view: [0, 16384], drop: true, harness: true, note: 'above FlagTrigger18 (-264,-2140,56, radius 320, her class; SetDoneFlag), 34 units from FlagTrigger17 (NicoStops)' },
    { op: 'wait', flag: 'NicoletteDoneFollowing', timeout: 240 },
    { op: 'wait', seconds: 3 },
    { op: 'placeNear', actor: 'NicoletteDuClare0', distance: 100, bearing: -1.571, turnFirst: true, harness: true, note: '100 units south of Nicolette where she stands, aimed at her (NicoletteFinalBarks2: radius 200)' },
    { op: 'wait', flag: 'NicoletteFinalBarks2_Played', timeout: 120 },
    // the graveyard (DataLinkTrigger15, radius 800 at ground level) lies on the way from the maze to the crypt: DL_graveyard_ambush by a fall into it (the
    // sewer's placement stood 5 units inside DataLinkTrigger18's cylinder in one program and not the other)
    { op: 'place', at: [-573, -3634, 146], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger15 (-573,-3634,56, radius 800; DL_graveyard_ambush)' },
    { op: 'wait', flag: 'DL_graveyard_ambush_Played', timeout: 120 },
    { op: 'place', at: [-1126, -4156, -152], view: [0, 49152], harness: true, note: '150 units north of DataLinkTrigger7 (-1126,-4306,-152, radius 96; DL_entered_sewer; a low ceiling), facing south: the walk crosses it' },
    { op: 'walk', seconds: 1 },
    { op: 'wait', flag: 'DL_entered_sewer_Played', timeout: 120 },
    { op: 'snap', label: 'g12-sewer' },
    { op: 'place', at: [-1478, -3416, -181], view: [0, 32768], harness: true, note: '160 units east of Teleporter0 (-1638,-3416,-181, radius 100; a tunnel), facing it: the walk enters it' },
    { op: 'walk', untilTravel: true, seconds: 2 },
    { op: 'travel', to: '11_Paris_Cathedral', label: 'exit', timeout: 120 },
    ...cheats,
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'g13-cathedral' },
    // mission 11's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 110, label: 'exit' },
  ],
};
