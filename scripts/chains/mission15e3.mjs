/** Stage 6 row 6.5.3, ending 3 (the Illuminati: Page's bunker) from its in-world trigger, from the real slot nicouzouf Save0042 (15_Area51_Page: MeetHelios played,
 * Page's bunker entered, the goals killpage, DestroyArea51, DeactivateLocks and OverloadForceField open; no node frobbed). The chain (docs/stage-6-exit-criteria.md 6.5,
 * the map's own actors): the four blue-fusion nodes' Keypad3 pads (code 7243, events node1..4: FlagTrigger16/17/14/15 set Node1..4_Frobbed); Mission15.Timer counts
 * the flags each tick and plays DL_Blue<count>, so each node waits for its InfoLink before the next (four at once would play DL_Blue4 alone); DL_Blue4 triggers
 * page_button, which opens the Page_button mover (DeusExMover6) over Switch4; Switch4's event kill_page runs Dispatcher1, whose sixth event start_endgame fires
 * MapExit0 to 99_endgame3. Placements come from scripts/chain-plan.mjs `face` in Play's world (Switch4 with `--before "CauseEvent page_button"`). */
export default {
  mission: '15e3',
  steps: [
    { op: 'start', kind: 'slot', source: 'nicouzouf', slot: 'Save0042', index: 42 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'e3-1-loaded' },
    // Page's respawning MJ12 and the turrets: the player is placed in their view for the original's longer real seconds (God mode, as the other chains)
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'God', harness: true },

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
    { op: 'snap', label: 'e3-2-nodes' },
    { op: 'wait', seconds: 5 },
    { op: 'state', label: 'page-button', actor: 'DeusExMover6', fields: ['KeyNum', 'bLocked'] },

    { op: 'place', at: [6156, -6466, -5135], view: [-8727, 49137], harness: true, note: '40 units north of Switch4 (6156,-6506,-5140), aimed at it, Page_button open' },
    { op: 'frob', target: 'Switch4', watch: ['Switch4'] },
    { op: 'travel', to: '99_endgame3', timeout: 90 },
    { op: 'snap', label: 'e3-3-endgame' },
    // the endgame: its conversation, the quote and the delay, then the credits (about 84 s after the arrival in the measured endings, docs/travel.md step 5); a
    // click ends them (CreditsScrollWindow.MouseButtonReleased: FinishedScrolling) and the credits window's bLoadIntro sends the player to dxonly
    { op: 'wait', seconds: 120 },
    { op: 'point', at: [640, 360], note: 'a click on the credits' },
    { op: 'travel', to: 'dxonly', timeout: 60 },
    { op: 'snap', label: 'e3-dxonly' },
  ],
};
