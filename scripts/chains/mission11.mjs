/** Mission 11, Paris: the cathedral, the metro station and Everett's home (docs/stage-6-inventory.md 11.6, docs/stage-6-chains.md): from mission 10's exit
 * (the save its chain pinned in 11_Paris_Cathedral at cathedralstart) to the exit to 12_Vandenberg_Cmd. The maps' own means: Keypad0 (0022) for the
 * computervault; the Templar computer's special option "Establish System Uplink" (userList 34501/08711; TriggerEvent templar_upload: FlagTrigger2 sets
 * templar_upload), placed more than M11MeetGunther's radius (280) from Gunther, so the optional Gunther scene stays out of the chain; DL_morgan_uplink,
 * DL_metroentrance_after, Teleporter0 to the metro station; there Mission11.Timer brings Toby in (templar_upload), DL_tobywaiting, MeetTobyAtanwe (radius
 * 160; branch Yes) and the Timer's scripted travel (MS_PlayerTeleported, Level.Game.SendPlayer(Player, "11_PARIS_EVERETT"): no MapExit or teleporter);
 * Everett's home: AtanweAtEveretts (radius 120 from the arrival), MeetEverett (radius 100; Everett patrols), the Timer's helicopter (MeetEverett_Played)
 * and TakeOff's Go branch (ChopperExit: Dispatcher0, MapExit1 and its camera path). Placements from scripts/chain-plan.mjs (`drop`, `face`, `terminal`)
 * on the cold maps; the patrolling and appearing pawns placed from where they stand (the level held for the placement), the helicopter measured in the
 * level the chain reaches. Walked past by the placements: the cathedral's doors and guards, the computer room's way down, Everett's doors. */
const cheats = [
  { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
  // God mode set, not toggled: a restored arrival re-possesses the pawn filed there with its ReducedDamageType (the `God` toggle would switch it off)
  { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
];
export default {
  mission: '11',
  steps: [
    { op: 'start', kind: 'slot', source: 'chain', chain: '10', slot: 'Save0110', index: 110 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'h1-loaded' },
    ...cheats,

    // the cathedral: Keypad0 (0022) opens computervault; the Templar computer's special option "Establish System Uplink" (TriggerEvent templar_upload:
    // FlagTrigger2 sets templar_upload), logged in as its one user 34501/08711; placed south of it, more than M11MeetGunther's radius (280) from Gunther
    { op: 'place', at: [3672, -1233, -303], view: [-2709, 32793], harness: true, note: '60 units east of Keypad0 (3612,-1233,-280), aimed at it' },
    { op: 'frob', target: 'Keypad0', watch: ['Keypad0'] },
    { op: 'key', names: ['0', '0', '2', '2'], gap: 0.5 },
    { op: 'wait', seconds: 6 },
    { op: 'state', label: 'computervault', actor: 'DeusExMover14', fields: ['KeyNum', 'bLocked'] },
    // a computer of a loaded level can be mid-animation (state Off, bAnimating): it is drawn (the watch stand-in) from before the placement
    { op: 'watch', actors: ['ComputerPersonal0'] },
    { op: 'place', at: [5194, -1068, -839], view: [-5960, 16443], harness: true, note: '60 units south of ComputerPersonal0 (5194,-1008,-839), aimed at it; 515 units from GuntherHermann0 (4926,-628)' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal0' },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: '34501' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: '08711' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 329], note: 'the special option "Establish System Uplink" (the one option: the button of mission 15 ending 2\'s terminal)' },
    { op: 'wait', flag: 'templar_upload', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    { op: 'snap', label: 'h2-uplink' },
    { op: 'place', at: [3714, -1087, -221], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger1 (3714,-1087,-311, radius 96; DL_morgan_uplink, checkFlag templar_upload), beside the computervault door' },
    { op: 'wait', flag: 'DL_morgan_uplink_Played', timeout: 120 },
    { op: 'place', at: [-4174, -1591, -430], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger21 (-4174,-1591,-520, radius 96; DL_metroentrance_after)' },
    { op: 'wait', flag: 'DL_metroentrance_after_Played', timeout: 120 },
    { op: 'snap', label: 'h3-metro-entrance' },
    { op: 'place', at: [-4774, -3462, -667], view: [0, 0], drop: true, harness: true, note: 'above Teleporter0 (-4774,-3462,-777, radius 200; 11_Paris_Underground#Paris_Underground)' },
    { op: 'travel', to: '11_Paris_Underground', label: 'leg1' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    // Mission11.Timer: templar_upload brings Toby Atanwe into the world
    { op: 'state', label: 'underground-toby', actor: 'TobyAtanwe0', fields: ['bHidden'] },
    { op: 'snap', label: 'h4-underground' },
    { op: 'place', at: [381, -1769, 130], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger0 (381,-1769,40, radius 96; DL_tobywaiting)' },
    { op: 'wait', flag: 'DL_tobywaiting_Played', timeout: 120 },
    // MeetTobyAtanwe (radius 160): the player placed 80 units from where Toby stands (the level held for the placement), his radius starts it; both
    // choices continue (the first, branch Yes); Mission11.Timer then sets MS_PlayerTeleported and SendPlayer(Player, "11_PARIS_EVERETT")
    { op: 'line', text: 'set LevelInfo bPlayersOnly True', harness: true },
    { op: 'placeNear', actor: 'TobyAtanwe0', distance: 80, bearing: 0, harness: true, note: '80 units east of Toby Atanwe where he stands, aimed at him' },
    { op: 'line', text: 'set LevelInfo bPlayersOnly False', harness: true, settle: 1 },
    { op: 'conv', name: 'MeetTobyAtanwe', choose: [{ index: 0, label: 'Yes' }], watch: ['TobyAtanwe0'], timeout: 240 },
    { op: 'travel', to: '11_Paris_Everett', label: 'leg2', timeout: 120 },
    // Everett's home: the arrival (PlayerStart0, 16,1102) is 115 units from Toby (73,1002): AtanweAtEveretts (radius 120) starts by itself at once,
    // before the cheat lines (a line typed during it is the conversation's: in the first run both lines went to its window)
    { op: 'conv', name: 'AtanweAtEveretts', watch: ['TobyAtanwe0'], timeout: 120 },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'h5-everett' },

    // MeetEverett (radius 100; Everett patrols): placed 60 units from where he stands, the level held for the placement
    { op: 'line', text: 'set LevelInfo bPlayersOnly True', harness: true },
    { op: 'placeNear', actor: 'MorganEverett0', distance: 60, bearing: 0, harness: true, note: '60 units east of Morgan Everett where he stands, aimed at him' },
    { op: 'line', text: 'set LevelInfo bPlayersOnly False', harness: true, settle: 1 },
    { op: 'conv', name: 'MeetEverett', watch: ['MorganEverett0'], timeout: 300 },
    { op: 'wait', seconds: 3 },
    // Mission11.Timer: MeetEverett_Played brings the helicopter into the world
    { op: 'state', label: 'everett-helicopter', actor: 'BlackHelicopter0', fields: ['bHidden'] },
    { op: 'snap', label: 'h6-met-everett' },

    // TakeOff (the helicopter BlackHelicopter0, BindName BlackHelicopter; radius 350 inside its 461 cylinder) by the right button: its Go branch adds
    // MeetJock and triggers ChopperExit: Dispatcher0 fires CalledByDispatcher, MapExit1 and its camera path to 12_Vandenberg_Cmd
    { op: 'place', at: [392, 1582, 1121], view: [350, 10], harness: true, turnFirst: true, note: '500 units west of BlackHelicopter0 (892,1582,1177 in the world, radius 461) on the helipad, aimed at its centre (planned in the level the chain reaches)' },
    { op: 'frob', target: 'BlackHelicopter0' },
    { op: 'conv', name: 'TakeOff', choose: [{ index: 0, label: 'Go' }], watch: ['BlackHelicopter0'], timeout: 180 },
    { op: 'travel', to: '12_Vandenberg_Cmd', label: 'exit', timeout: 240 },
    ...cheats,
    // Carla (WaitingFor) walks to the arriving player and MeetCarlaBrown (radius 160) runs at each program's pace: the last snapshot waits for it
    { op: 'wait', flag: 'MeetCarlaBrown_Played', timeout: 180 },
    { op: 'wait', seconds: 5 },
    { op: 'snap', label: 'h7-vandenberg' },
    // mission 12's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 111, label: 'exit' },
  ],
};
