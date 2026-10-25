/** Mission 14, the sub base, the Ocean Lab and the missile silo (docs/stage-6-inventory.md 14.6, docs/stage-6-chains.md): from mission 12's exit (the save its chain
 * pinned at the arrival in 14_Vandenberg_sub) through the mini-sub ride, the UC's schematic, the ride back, Gary Savage and Jock's lift to the silo, Howard Strong
 * and Jock's lift to the exit to 15_area51_bunker. The maps' own means:
 *   - the sub bay doors: ComputerSecurity2's first view "URV Pool Doors" (login tech/sharkman, its userList), its door choice opens sub_doors, whose Event doors_open
 *     fires FlagTrigger0 (doors_open); MiniSub0's frob fires subexit: FlagTrigger1 (doors_open), FlagTrigger4 (DL_downloaded_Played false), MapExit3 to the Lab;
 *   - the UC: Teleporter2 from the Lab; ComputerPersonal0's special option "Access UC Schematics" (login mj12/skywalker) fires schematic (FlagTrigger0 sets
 *     schematic_downloaded); DataLinkTrigger2 plays DL_Downloaded (GetSchematic done, MeetSavage); Mission14.Timer brings Bob Page in and ConversationTrigger0 starts
 *     PageTaunt; Teleporter0 back to the Lab;
 *   - the Lab's sub bay: ComputerSecurity1's first view "URV Bay" (login Oceanguard/Kraken) opens subdoor, whose Event door_flag fires FlagTrigger0 (door_open);
 *     MiniSub0's subexit: FlagTrigger1 (door_open), FlagTrigger2 (DL_downloaded_Played true), MapExit2 to the sub base's subbay;
 *   - the sub base again: Mission14.Timer (DL_downloaded_Played) brings the helicopter and Gary in; GaryWaitingForSchematics (radius 120); JockBarks (the helicopter's
 *     frob; needs !DL_Dead_Played) and its Go branch: ChopperExit, MapExit2 to the silo;
 *   - the silo: Mission14.Timer brings the helicopter in and plays DL_Dead once no HowardStrong is left (DataLinkTrigger2 beside him plays DL_Dead too, but without
 *     the helicopter, JockArea51's owner); the player kills Howard Strong (Health 100) with the GEP gun the start carries; JockArea51 (radius 160, needs
 *     DL_Dead_Played) and its continue branch: SiloExit, Dispatcher0, ExitPath, MapExit0 to 15_area51_bunker.
 * The missile (Switch4 abort, the launch computer, DL_Savage2/3) is not an exit condition and is left out. Placements from scripts/chain-plan.mjs in Play's world
 * (cold maps; `terminal` for the special option; a ring search in the level the chain reaches where a mission script brought an owner in).
 * Gates the placements pass: the silo's blast doors (blastdoor1..3, locked, Keypad3 pairs, code 8456) between the front gate and Howard at the bottom, and the
 * doors between the steps of each map, not inventoried. The GEP gun is the inventory of mission 12's provisional start (nicouzouf Save0028, belt 6): a start
 * from mission 11's chain needs a weapon that start carries. TiffanySavage_Dead (mission 12's Dead branch) picks GaryWaitingForSchematics' Dead branch. */
export default {
  mission: '14',
  steps: [
    { op: 'start', kind: 'slot', source: 'chain', chain: '12', slot: 'Save0112', index: 112 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm14-1-sub' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },

    // the sub bay doors from ComputerSecurity2 (the door-open choice of the first view at (419,251) of the original's viewport: Play's (138.5,131) in its 720x480 root)
    { op: 'watch', actors: ['ComputerSecurity2'] },
    { op: 'place', at: [5002, -2252, -1551], view: [-424, 32776], harness: true, note: '60 units east of ComputerSecurity2 (4942,-2252,-1515), aimed at it' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerSecurity2', watch: ['ComputerSecurity2'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'tech' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'sharkman' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [419, 251], note: 'the first view\'s door-open choice (sub_doors)' },
    { op: 'wait', flag: 'doors_open', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    { op: 'snap', label: 'm14-2-doors' },
    { op: 'place', at: [5581, -2467, -1551], view: [-5015, 32743], harness: true, note: '130 units east of MiniSub0 (5451,-2467,-1580), aimed at it' },
    { op: 'frob', target: 'MiniSub0', watch: ['MiniSub0'] },
    { op: 'travel', to: '14_OceanLab_Lab', label: 'leg1' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm14-3-lab' },

    { op: 'place', at: [908, 3792, -4126], view: [0, 0], drop: true, harness: true, note: 'above Teleporter2 (908,3792,-4216, radius 100): the fall enters it' },
    { op: 'travel', to: '14_OceanLab_UC', label: 'leg2' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm14-4-uc' },

    // the schematic: ComputerPersonal0's one special option (chain-plan.mjs terminal: the button at (641,329))
    { op: 'watch', actors: ['ComputerPersonal0'] },
    { op: 'place', at: [296, 6637, -3133], view: [-11024, 41013], harness: true, note: 'north-east of ComputerPersonal0 (264,6605,-3174), aimed at it (chain-plan.mjs terminal)' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal0', watch: ['ComputerPersonal0'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'mj12' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'skywalker' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 329], note: 'the special option "Access UC Schematics"' },
    { op: 'wait', flag: 'schematic_downloaded', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    { op: 'place', at: [814, 7156, -3098], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger2 (814,7156,-3208, radius 500, height 40: the player cylinder starts 7 units above its top; DL_Downloaded needs schematic_downloaded)' },
    { op: 'wait', flag: 'DL_Downloaded_Played', timeout: 120 },
    { op: 'snap', label: 'm14-5-schematic' },
    // Mission14.Timer brings Bob Page in once schematic_downloaded is set (MS_UnhideBobPage); ConversationTrigger0 (radius 50, conversationTag pagetaunt) starts PageTaunt
    // (GaryWaitingForSchematics checks PageTaunt_Played)
    { op: 'wait', flag: 'MS_UnhideBobPage', timeout: 30 },
    { op: 'place', at: [820, 6714, -4094], view: [0, 0], drop: true, harness: true, note: 'above ConversationTrigger0 (820,6714,-4184, radius 50, height 40): the fall enters it' },
    { op: 'conv', name: 'PageTaunt', watch: ['BobPage0'], timeout: 180 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm14-6-pagetaunt' },
    { op: 'place', at: [1236, 3830, -4094], view: [0, 0], drop: true, harness: true, note: 'above Teleporter0 (1236,3830,-4184, radius 100): the fall enters it' },
    { op: 'travel', to: '14_OceanLab_Lab', label: 'leg3' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm14-7-lab-again' },

    // the Lab's sub bay door from ComputerSecurity1 (the first view's door-open choice), then the mini-sub back (DL_downloaded_Played set)
    { op: 'watch', actors: ['ComputerSecurity1'] },
    { op: 'place', at: [488, 636, -2127], view: [-6728, 49067], harness: true, note: '60 units north of ComputerSecurity1 (488,576,-2133), aimed at it' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerSecurity1', watch: ['ComputerSecurity1'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'Oceanguard' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'Kraken' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [419, 251], note: 'the first view\'s door-open choice (subdoor)' },
    { op: 'wait', flag: 'door_open', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'] },
    { op: 'place', at: [317, 243, -2159], view: [-6686, 32740], harness: true, note: '130 units east of MiniSub0 (187,243,-2217), aimed at it' },
    { op: 'frob', target: 'MiniSub0', watch: ['MiniSub0'] },
    { op: 'travel', to: '14_Vandenberg_sub', label: 'leg4' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', flag: 'MS_DestroySub', timeout: 30 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm14-8-sub-again' },

    // Gary (GarySavage0, WaitingFor at 2569,3383,776 once the Timer brought him in) and Jock's helicopter (BlackHelicopter2 at 2105,3648,896, radius 461): one place
    // 70 units from Gary from which the view selects the helicopter: GaryWaitingForSchematics (radius 120) plays, then the helicopter's frob starts JockBarks (an
    // overheard conversation; GaryWaitingForSchematics_Played picks its Go branch: ChopperExit, MapExit2 along Camera2)
    { op: 'place', at: [2519, 3432, 777], view: [1778, 27756], harness: true, turnFirst: true, note: '70 units north-west of GarySavage0 (2569,3383,776 in the restored level), aimed at BlackHelicopter2 (2105,3648,896; agentc ring search)' },
    { op: 'conv', name: 'GaryWaitingForSchematics', watch: ['GarySavage0'], timeout: 240 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm14-9-gary' },
    { op: 'frob', target: 'BlackHelicopter2', watch: ['BlackHelicopter2'] },
    { op: 'travel', to: '14_Oceanlab_silo', label: 'leg5', timeout: 240 },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    // DL_FrontGate (DataLinkTrigger0 at the arrival): its _Played flag is set at the DataLink's end; the first capture's original read the snapshot after it,
    // Play's 3 s in (mission 10's DL_metrosewer, docs/travel.md "Arriving at a portal")
    { op: 'wait', flag: 'DL_FrontGate_Played', timeout: 120 },
    { op: 'snap', label: 'm14-10-silo' },

    // Howard Strong (Health 100, Standing at -52,-6768,-320 at the silo's bottom): Mission14.Timer brings the helicopter in and plays DL_Dead once none is left
    { op: 'belt', n: 2, note: 'the GEP gun mission 9 found (belt 2 on the chain\'s line)' },
    { op: 'place', at: [-352, -6768, -262], view: [-3266, 11], harness: true, note: '300 units west of HowardStrong0 (-52,-6768,-320), aimed at him (stand, a clear line)' },
    { op: 'click', until: { flag: 'HowardStrong_Dead' }, gap: 2.5, max: 8, watch: ['HowardStrong0'] },
    { op: 'wait', flag: 'DL_Dead_Played', timeout: 120 },
    { op: 'snap', label: 'm14-11-howard' },

    // Jock's helicopter (BlackHelicopter0, brought in at -195,-5681,1509; radius 461, blocks players): its frob starts JockArea51 (needs DL_Dead_Played), whose
    // continue branch fires SiloExit: Dispatcher0 (ExitPath after 1 s, the helicopter's path), MapExit0 along Camera1 to 15_area51_bunker
    { op: 'place', at: [-195, -6221, 1469], view: [2, 16376], harness: true, turnFirst: true, note: '540 units south of BlackHelicopter0 (-195,-5681,1509), aimed at it (agentc ring search after Howard\'s death)' },
    { op: 'frob', target: 'BlackHelicopter0', watch: ['BlackHelicopter0'] },
    { op: 'conv', name: 'JockArea51', timeout: 180 },
    { op: 'travel', to: '15_area51_bunker', label: 'exit', timeout: 240 },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 15 },
    // DL_JockDeathTongComment, started at the arrival: its flag at its end (the first capture's original had it by this snapshot, Play not yet)
    { op: 'wait', flag: 'DL_JockDeathTongComment_Played', timeout: 120 },
    { op: 'snap', label: 'm14-12-area51' },
    // mission 15's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 114, label: 'exit' },
  ],
};
