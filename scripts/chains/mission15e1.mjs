/** Stage 6 row 6.5.1, ending 1 (Tracer Tong's: the reactor destroyed) from its in-world trigger, from the real slot nicouzouf Save0042 (15_Area51_Page; Final filed).
 * The chain (the maps' own actors, docs/stage-6-exit-criteria.md 6.5): Page's Switch0 (coolant_switch: LogicTrigger4 fires coolant, FlagTrigger0 sets coolantcut);
 * Teleporter8 to 15_Area51_Final#final_end, where Mission15.Timer swaps the generator switches once coolantcut is set (MS_ButtonsHidden); each switch (Switch10
 * gen_switch1_on, Switch16 gen_switch2_on) toggles one input of its LogicTrigger (AND), the coolant_cut FlagTriggers 2 and 4 (overlapping cylinders, one drop
 * touches both, each once) the other: RSwitch1/2, FlagTrigger0/1 set ReactorSwitch1/2. A DL_Tong7 DataLinkTrigger (CoolantCut, both switches) plays DL_tong7, which
 * sets ReactorReady; FlagTrigger5 touched opens Generator_panel; the three reactor buttons in turn (button_1 opens injector2 over the second, button_2 injector3 over
 * the third; Rbutton1..3 set ReactorButton1..3); FlagTrigger9 touched with ReactorButton3 opens Generator_overload over Switch4, whose destroy_generator runs
 * Dispatcher7 and MapExit0 to 99_Endgame1. Each LogicTrigger input toggles: every switch and each FlagTrigger is touched exactly once. Placements from
 * scripts/chain-plan.mjs (`face`, `drop`, `approach`; the movers opened with `--before "CauseEvent ..."`) in Play's world, and from the coolant switch on with `face-chain`
 * in the slot's own levels (`node scripts/chain-plan.mjs face-chain 15e1 15 Switch10`). */
export default {
  mission: '15e1',
  steps: [
    { op: 'start', kind: 'slot', source: 'nicouzouf', slot: 'Save0042', index: 42 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'e1-1-loaded' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'God', harness: true },

    // planned from the slot's level (the cold map's north spot lands 34 units higher in the slot's state, in both programs, and misses the switch)
    { op: 'place', at: [7530, -10864, -5967], view: [-8276, 16326], harness: true, note: '40 units south of Switch0 (7530,-10824,-5969), aimed at it' },
    { op: 'frob', target: 'Switch0', watch: ['Switch0'] },
    { op: 'wait', flag: 'coolantcut', timeout: 30 },
    { op: 'snap', label: 'e1-2-coolant' },
    { op: 'place', at: [5012, -12063, -5032], view: [0, 0], drop: true, harness: true, note: 'above Teleporter8 (5012,-12063,-5122, radius 128): the fall enters it' },
    { op: 'travel', to: '15_Area51_final', timeout: 60 },
    // God mode (ReducedDamageType) and bCheatsEnabled are not travel properties: the arrival drops both, in both programs, and the reactor's radiation killed the
    // original's player over its longer real seconds; the player stays invincible as at the start
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'God', harness: true },
    { op: 'wait', flag: 'MS_ButtonsHidden', timeout: 30 },
    { op: 'snap', label: 'e1-3-final' },

    // the Final's placements are planned in the restored level of the slot (the cold map's differ: a spot lands higher there)
    { op: 'place', at: [-3496, -4332, -2031], view: [-9023, 40950], harness: true, note: '40 units north-east of Switch10 (-3524,-4360,-2039; gen_switch1_on, at the hidden Switch9\'s place), aimed at it' },
    { op: 'frob', target: 'Switch10', watch: ['Switch10'] },
    { op: 'place', at: [-2774, -4336, -2031], view: [-8980, 41010], harness: true, note: '40 units north-east of Switch16 (-2802,-4365,-2039; gen_switch2_on), aimed at it' },
    { op: 'frob', target: 'Switch16', watch: ['Switch16'] },
    { op: 'place', at: [-3177, -3816, -1662], view: [0, 0], drop: true, harness: true, note: 'above FlagTrigger2 (-3177,-3816,-1752); FlagTrigger4 (-3170,-3758) overlaps it: the fall enters both' },
    { op: 'wait', flag: 'ReactorSwitch1', timeout: 30 },
    { op: 'wait', flag: 'ReactorSwitch2', timeout: 30 },
    { op: 'place', at: [-3511, -4330, -2000], view: [0, 57344], harness: true, note: 'south-west of DataLinkTrigger20 (-3405,-4436,-2040; DL_Tong7): the walk enters it' },
    { op: 'walk', seconds: 2 },
    { op: 'wait', flag: 'ReactorReady', timeout: 180 },
    { op: 'snap', label: 'e1-4-reactor-ready' },

    // the Mechanic (Mechanic0, PowerGuy) stands about 180 units from the reactor buttons: his overheard radius conversations PowerGuyScared1 (ReactorReady, no button)
    // and 2 (button 1, not button 3) start from his tick once his DistanceFromPlayer is current, which the drawing keeps (the headless stand-in from here on); when each
    // starts follows each program's own pace, so the chain waits for each in its window. PowerGuyScared3 (button 3) started in neither program's runs (120 s in Play)
    { op: 'watch', actors: ['Mechanic0'] },
    { op: 'place', at: [-2991, -5077, -1626], view: [0, 0], harness: true, note: 'west of FlagTrigger5 (-2811,-5077,-1666): the walk enters it' },
    { op: 'walk', seconds: 2 },
    { op: 'wait', seconds: 5 },
    { op: 'state', label: 'generator-panel', actor: 'DeusExMover0', fields: ['KeyNum', 'bLocked'] },
    { op: 'place', at: [-3302, -4972, -1591], view: [-5684, 32809], harness: true, note: '45 units east of Switch1 (-3347,-4972,-1580; button_1), aimed at it' },
    { op: 'wait', flag: 'PowerGuyScared1_Played', timeout: 120 },
    { op: 'frob', target: 'Switch1', watch: ['Switch1'] },
    { op: 'wait', flag: 'ReactorButton1', timeout: 30 },
    { op: 'wait', seconds: 8 },
    { op: 'place', at: [-3302, -5036, -1591], view: [-5680, 32761], harness: true, note: '45 units east of Switch2 (-3347,-5036,-1580; button_2, behind injector2), aimed at it' },
    { op: 'frob', target: 'Switch2', watch: ['Switch2'] },
    { op: 'wait', flag: 'ReactorButton2', timeout: 30 },
    { op: 'wait', seconds: 8 },
    { op: 'wait', flag: 'PowerGuyScared2_Played', timeout: 120 },
    { op: 'place', at: [-3302, -5100, -1591], view: [-5681, 32873], harness: true, note: '45 units east of Switch5 (-3347,-5100,-1580; button_3, behind injector3), aimed at it' },
    { op: 'frob', target: 'Switch5', watch: ['Switch5'] },
    { op: 'wait', flag: 'ReactorButton3', timeout: 30 },
    { op: 'snap', label: 'e1-5-buttons' },

    { op: 'place', at: [-3329, -5022, -1490], view: [0, 0], harness: true, note: 'west of FlagTrigger9 (-2949,-5022,-1530, radius 300): the walk enters it' },
    { op: 'walk', seconds: 2 },
    { op: 'wait', seconds: 5 },
    { op: 'state', label: 'generator-overload', actor: 'DeusExMover19', fields: ['KeyNum', 'bLocked'] },
    { op: 'place', at: [-3171, -5014, -1591], view: [-8626, 16369], harness: true, note: '40 units south of Switch4 (-3171,-4974,-1595), aimed at it, Generator_overload open' },
    { op: 'frob', target: 'Switch4', watch: ['Switch4'] },
    { op: 'travel', to: '99_Endgame1', timeout: 60 },
    // Endgame1 sets EndgameExplosions at its own pace: the snapshot waits for it in both programs
    { op: 'wait', flag: 'EndgameExplosions', timeout: 90 },
    { op: 'snap', label: 'e1-6-endgame' },
    // the endgame: its conversation, the quote and the delay, then the credits (about 84 s after the arrival in the measured endings, docs/travel.md step 5); a
    // click ends them (CreditsScrollWindow.MouseButtonReleased: FinishedScrolling) and the credits window's bLoadIntro sends the player to dxonly
    { op: 'wait', seconds: 120 },
    { op: 'point', at: [640, 360], note: 'a click on the credits' },
    { op: 'travel', to: 'dxonly', timeout: 60 },
    { op: 'snap', label: 'e1-dxonly' },
  ],
};
