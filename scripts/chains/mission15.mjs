/** Mission 15, Area 51 (docs/stage-6-inventory.md 15.6, docs/stage-6-chains.md): from the arrival in 15_Area51_Bunker (mission 14's exit save) through the
 * Entrance and the Final to Page's bunker and ending 3 (the Illuminati), the endgame, the credits and dxonly. Ending 3 is the shortest of the three endings' chains
 * (scripts/chains/mission15e1/e2/e3.mjs): it stays in 15_Area51_Page (no return to the filed Final, no terminal), so its steps are e3's.
 *
 * The traversal: Bunker Teleporter0 (#start of the Entrance), Entrance Teleporter0 (#start of the Final), Final Teleporter2 (#page_start), each by a fall into its
 * cylinder (scripts/chain-plan.mjs drop, 50 units above). The placements pass the gates the maps put in front of them (the Bunker's blast door and the
 * elevator's power, the Entrance's elevator, the Final's Page_Blastdoors that DL_Helios_Door2 opens once MeetHelios has played): none of them sets a flag the
 * ending needs. The scene conversations of the progression path (M15MeetEverett, M15MeetTong, MeetHelios, the DL_tong and DL_Final_Helios InfoLinks) set no
 * flag that gates ending 3 and are left out; the placements keep away from their owners' radii (Bob Page in the Page, BobPageAugmented0 at 6157,-7290,-5157,
 * radius 450, is 780 units or more from every spot of the chain).
 *
 * Ending 3 (as mission15e3.mjs, where Save0042's Page had MeetBobPage played; here the Page is entered fresh): the four blue-fusion nodes' Keypad3 pads (7243, events
 * node1..4: FlagTrigger16/17/14/15 set Node1..4_Frobbed); Mission15.Timer counts the flags each tick and plays DL_Blue<count>, so each node waits for its InfoLink;
 * DL_Blue4 triggers page_button (DeusExMover6 over Switch4); Switch4's kill_page runs Dispatcher1, whose start_endgame fires MapExit0 to 99_endgame3. */
export default {
  mission: '15',
  steps: [
    { op: 'start', kind: 'slot', source: 'chain', chain: '14', slot: 'Save0114', index: 114 },
    // the cheat lines before any Level time: Play's loaded player has ReducedDamageType None although mission 14 set All before its save (unverified why: the
    // console SET writes the class default too, and a property equal to its default is probably not written to the save), and something at the Bunker's
    // PlayerStart2 shoots him (Play: Health 81 at 1.5 s, dying at 3.5 s without God mode; a dying player cannot ghost and the placement stops Play)
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm15-1-bunker' },
    // Mission15.FirstFrame: with Ray alive the sabotaged helicopter comes in and DL_JockDeath plays 8 s after the arrival (Jock's death, MS_JockDead); with Ray dead
    // nothing happens. Either way the arrival's own scene is waited out before the chain moves on
    { op: 'wait', seconds: 15 },

    { op: 'place', at: [4707, -1039, -7454], view: [0, 0], drop: true, harness: true, note: 'above Teleporter0 (4707,-1039,-7544, radius 192): the fall enters it' },
    { op: 'travel', to: '15_Area51_entrance', label: 'leg1' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm15-2-entrance' },

    { op: 'place', at: [-2101, -56, -1934], view: [0, 0], drop: true, harness: true, note: 'above Teleporter0 (-2101,-56,-2024, radius 128): the fall enters it' },
    { op: 'travel', to: '15_Area51_Final', label: 'leg2' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm15-3-final' },

    { op: 'place', at: [-1566, -811, -1747], view: [0, 0], drop: true, harness: true, note: 'above Teleporter2 (-1566,-811,-1837, radius 128): the fall enters it' },
    { op: 'travel', to: '15_Area51_page', label: 'leg3' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm15-4-page' },

    // ending 3's chain (mission15e3.mjs's placements, planned with `face` in Play's cold map)
    { op: 'place', at: [6029, -8252, -5127], view: [-9200, 49158], harness: true, note: '50 units north of Keypad0 (6029,-8302,-5149), aimed at it' },
    { op: 'frob', target: 'Keypad0', watch: ['Keypad0'] },
    { op: 'key', names: ['7', '2', '4', '3'], gap: 0.5 },
    { op: 'wait', flag: 'Node1_Frobbed', timeout: 30 },
    { op: 'wait', flag: 'DL_Blue1_Played', timeout: 180 },

    { op: 'place', at: [6189, -7098, -5575], view: [-9181, 40938], harness: true, note: '50 units north-east of Keypad1 (6154,-7133,-5597), aimed at it' },
    { op: 'frob', target: 'Keypad1', watch: ['Keypad1'] },
    { op: 'key', names: ['7', '2', '4', '3'], gap: 0.5 },
    { op: 'wait', flag: 'Node2_Frobbed', timeout: 30 },
    { op: 'wait', flag: 'DL_Blue2_Played', timeout: 180 },

    { op: 'place', at: [6396, -6864, -5967], view: [-9109, 40956], harness: true, note: '50 units north-east of Keypad5 (6360,-6900,-5989), aimed at it' },
    { op: 'frob', target: 'Keypad5', watch: ['Keypad5'] },
    { op: 'key', names: ['7', '2', '4', '3'], gap: 0.5 },
    { op: 'wait', flag: 'Node3_Frobbed', timeout: 30 },
    { op: 'wait', flag: 'DL_Blue3_Played', timeout: 180 },

    { op: 'place', at: [4815, -6270, -5575], view: [-9138, 32771], harness: true, note: '50 units east of Keypad6 (4765,-6270,-5597), aimed at it' },
    { op: 'frob', target: 'Keypad6', watch: ['Keypad6'] },
    { op: 'key', names: ['7', '2', '4', '3'], gap: 0.5 },
    { op: 'wait', flag: 'Node4_Frobbed', timeout: 30 },
    { op: 'wait', flag: 'DL_Blue4_Played', timeout: 180 },
    { op: 'snap', label: 'm15-5-nodes' },
    { op: 'wait', seconds: 5 },
    { op: 'state', label: 'page-button', actor: 'DeusExMover6', fields: ['KeyNum', 'bLocked'] },

    { op: 'place', at: [6156, -6466, -5135], view: [-8727, 49137], harness: true, note: '40 units north of Switch4 (6156,-6506,-5140), aimed at it, Page_button open' },
    { op: 'frob', target: 'Switch4', watch: ['Switch4'] },
    { op: 'travel', to: '99_endgame3', timeout: 90 },
    { op: 'snap', label: 'm15-6-endgame' },
    // the endgame: its conversation, the quote and the delay, then the credits (about 84 s after the arrival in the measured endings, docs/travel.md step 5); a
    // click ends them (CreditsScrollWindow.MouseButtonReleased: FinishedScrolling) and the credits window's bLoadIntro sends the player to dxonly
    { op: 'wait', seconds: 120 },
    { op: 'point', at: [640, 360], note: 'a click on the credits' },
    { op: 'travel', to: 'dxonly', timeout: 60 },
    { op: 'snap', label: 'm15-dxonly' },
  ],
};
