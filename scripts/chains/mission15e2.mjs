/** Stage 6 row 6.5.2, ending 2 (the merge with Helios) from its in-world trigger, from the real slot nicouzouf Save0042 (15_Area51_Page; Final filed in Current).
 * The chain (the maps' own actors, docs/stage-6-exit-criteria.md 6.5): the uplink locks' buttons Button18 and Button19 (events test1, test2: LogicTrigger3/2 fire
 * emitter_helios1/2, FlagTrigger2/3 set UplinkLock1/2); ComputerPersonal0, logged in as its one user (Icarus, panopticon: the map's userList) and its one special option
 * ("Engage Primary Router", TriggerEvent Set_flag_helios: FlagTrigger1 sets HeliosFree; the inventory's chain tool does not read computers' specialOptions);
 * Teleporter8 back to 15_Area51_Final#final_end (the filed level restored); FlagTrigger3 touched with HeliosFree fires Merge_helios_exit, MapExit1 to 99_Endgame2.
 * The special option is a button: the original's click is at (641,329) of its 1280x720 viewport, the button's centre in Play's terminal layout moved by the
 * difference of the centres (the `point` op). Placements from scripts/chain-plan.mjs `face` and `drop` in Play's world. */
export default {
  mission: '15e2',
  steps: [
    { op: 'start', kind: 'slot', source: 'nicouzouf', slot: 'Save0042', index: 42 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'e2-1-loaded' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'God', harness: true },

    { op: 'place', at: [6071, -5744, -5204], view: [-11557, 49032], harness: true, note: '40 units north of Button18 (6071,-5784,-5245), aimed at it' },
    { op: 'frob', target: 'Button18', watch: ['Button18'] },
    { op: 'wait', flag: 'UplinkLock1', timeout: 30 },
    { op: 'place', at: [5361, -5768, -5252], view: [-7110, 32751], harness: true, note: '40 units east of Button19 (5321,-5768,-5245), aimed at it' },
    { op: 'frob', target: 'Button19', watch: ['Button19'] },
    { op: 'wait', flag: 'UplinkLock2', timeout: 30 },

    // the slot saved the computer in state Off at its Begin code's FinishAnim (the Deactivate animation, bAnimating true): Frob does nothing until the animation ends,
    // which it does once the computer is drawn (in view as soon as the player stands at it): the headless frames' stand-in for that drawing starts with the placement
    { op: 'watch', actors: ['ComputerPersonal0'] },
    { op: 'place', at: [5743, -5329, -5220], view: [-10025, 32796], harness: true, note: '45 units east of ComputerPersonal0 (5698,-5329,-5246), aimed at it' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal0', watch: ['ComputerPersonal0'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'Icarus' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'panopticon' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 329], note: 'the special option "Engage Primary Router" (Play\'s terminal: the choice button\'s centre at (361,209) of its 720x480 root)' },
    { op: 'wait', flag: 'HeliosFree', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    { op: 'snap', label: 'e2-2-helios-free' },

    { op: 'place', at: [5012, -12063, -5032], view: [0, 0], drop: true, harness: true, note: 'above Teleporter8 (5012,-12063,-5122, radius 128): the fall enters it' },
    { op: 'travel', to: '15_Area51_final', timeout: 60 },
    // God mode (ReducedDamageType) and bCheatsEnabled are not travel properties: the arrival drops both, in both programs, and the reactor's radiation killed the
    // original's player over its longer real seconds; the player stays invincible as at the start
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'God', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'e2-3-final' },
    { op: 'place', at: [-3768, 2023, 586], view: [0, 0], drop: true, harness: true, note: 'above FlagTrigger3 (-3768,2023,496, radius 96): the fall enters it' },
    { op: 'travel', to: '99_Endgame2', timeout: 60 },
    { op: 'snap', label: 'e2-4-endgame' },
    // the endgame: its conversation, the quote and the delay, then the credits (about 84 s after the arrival in the measured endings, docs/travel.md step 5); a
    // click ends them (CreditsScrollWindow.MouseButtonReleased: FinishedScrolling) and the credits window's bLoadIntro sends the player to dxonly
    { op: 'wait', seconds: 120 },
    { op: 'point', at: [640, 360], note: 'a click on the credits' },
    { op: 'travel', to: 'dxonly', timeout: 60 },
    { op: 'snap', label: 'e2-dxonly' },
  ],
};
