/** Mission 8, Hell's Kitchen again (docs/stage-6-inventory.md 08.6, docs/stage-6-chains.md): from mission 6's exit (08_NYC_Street, the hotel's roof) through the
 * bar's M08MeetHarleyFilben (Mission08.Timer then brings Stanton Dowd into the world), StantonDowd, the smuggler's M08SmugglerConvos, DL_Exit (FlagTrigger8,
 * touched with StantonDowd_Played, fires ExitLink: DataLinkTrigger10 plays DL_Exit once M08SmugglerConvos_Played is set; DataLinkTrigger4 plays it instead for a
 * player StantonDowd found carrying explosives), the helicopter Mission08.Timer brings in once StantonDowd_Played and DL_Exit_Played are set (tag CopterExit,
 * Mission08.uc:266-275), and M08JockExit's Go branch (TriggerExit: Dispatcher0, CameraExit, MapExit0 and its camera path) to the exit to 09_NYC_Dockyard.
 * Placements from scripts/chain-plan.mjs (`drop`, `approach`, `stand`). */
// God mode as a value, not the God toggle: a restored level's arrival re-possesses the pawn filed there with its God mode (docs/stage-6-chains.md)
const cheats = [
  { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
  { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
];
export default {
  mission: '08',
  steps: [
    { op: 'start', kind: 'slot', source: 'chain', chain: '06', slot: 'Save0106', index: 106 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'h1-loaded' },
    ...cheats,

    // the bar: M08MeetHarleyFilben
    { op: 'place', at: [-703, -675, -417], view: [0, 0], harness: true, turnFirst: true, note: '200 units west of Teleporter3 (-503,-675,-457, radius 60; the bar\'s front door), facing it: the walk enters it' },
    { op: 'walk', untilTravel: true, seconds: 2 },
    { op: 'travel', to: '08_NYC_Bar', label: 'leg1' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [-1679, 340, 49], view: [-6812, 32737], harness: true, turnFirst: true, note: 'east of HarleyFilben0 at his place (planned 60 units from where he settles), facing him' },
    { op: 'frob', target: 'HarleyFilben0' },
    { op: 'conv', name: 'M08MeetHarleyFilben', watch: ['HarleyFilben0'], timeout: 300 },
    { op: 'wait', seconds: 10 },
    { op: 'snap', label: 'h2-filben' },
    { op: 'place', at: [731, 850, 92], view: [0, 0], harness: true, turnFirst: true, note: '200 units west of Teleporter2 (931,850,52, radius 60), facing it: the walk enters it' },
    { op: 'walk', untilTravel: true, seconds: 2 },
    { op: 'travel', to: '08_NYC_Street', label: 'leg2' },
    ...cheats,
    { op: 'wait', seconds: 3 },

    // Stanton Dowd (in the world once M08MeetHarleyFilben_Played: Mission08.uc:186-196)
    { op: 'state', label: 'stanton', actor: 'StantonDowd0', fields: ['bHidden'] },
    { op: 'place', at: [1014, 2454, -399], view: [-6127, 40974], harness: true, turnFirst: true, note: '60 units north-east of StantonDowd0 (972,2412,-399 in the world), aimed at him (chain-plan.mjs face --flags M08MeetHarleyFilben_Played; the spot due east crushes the player)' },
    { op: 'frob', target: 'StantonDowd0' },
    { op: 'conv', name: 'StantonDowd', watch: ['StantonDowd0'], timeout: 300 },
    { op: 'wait', seconds: 10 },
    { op: 'snap', label: 'h3-stanton' },

    // the smuggler: M08SmugglerConvos (DL_Exit's first trigger needs it)
    { op: 'place', at: [3171, -872, -1309], view: [0, 0], drop: true, harness: true, note: 'above Teleporter16 (3171,-872,-1399, radius 90; the smuggler\'s front door)' },
    { op: 'travel', to: '08_NYC_Smug', label: 'leg3' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    // the original's first capture found the smuggler elsewhere than Play's (-950,1493,-48; the frob selected nothing): placed beside him where he is
    { op: 'watch', actors: ['Smuggler0'] },
    { op: 'frobNear', actor: 'Smuggler0', distance: 60, bearing: [0, 1.571, 3.142, -1.571], hold: true, settle: 0.3, harness: true, note: 'beside the smuggler where he is, held still (he walks: Play\'s third placement, the recapture\'s first missed him), aimed at him' },
    { op: 'conv', name: 'M08SmugglerConvos', choose: [{ index: 3, label: 'bye2' }, { index: 0, label: 'NoWarning' }], watch: ['Smuggler0'], timeout: 300 },
    { op: 'wait', seconds: 5 },
    { op: 'snap', label: 'h4-smuggler' },
    { op: 'place', at: [7, -1439, 471], view: [0, 0], drop: true, harness: true, note: 'above Teleporter2 (7,-1439,381, radius 100)' },
    { op: 'travel', to: '08_NYC_Street', label: 'leg4' },
    ...cheats,
    { op: 'wait', seconds: 3 },

    // DL_Exit: FlagTrigger8 (radius 400) touched with StantonDowd_Played fires ExitLink, DataLinkTrigger10
    { op: 'place', at: [1946, -1121, -380], view: [0, 0], drop: true, harness: true, note: 'above FlagTrigger8 (1946,-1121,-470, radius 400)' },
    { op: 'wait', flag: 'DL_Exit_Played', timeout: 180 },
    { op: 'wait', seconds: 5 },
    { op: 'state', label: 'exit-helicopter', actor: 'BlackHelicopter0', fields: ['bHidden'] },
    { op: 'snap', label: 'h5-dl-exit' },

    // the roof: M08JockExit (Jock is BlackHelicopter0, radius 250) and its Go branch
    // the helicopter blocks the player once in the world (Vehicles.PutInWorld restores its default collision: bBlockPlayers) and its cylinder (radius 225) is
    // nearly the conversation's radius (250): the right button from just outside it, aimed up at it from the roof
    { op: 'place', at: [331, 965, 593], view: [4741, 32781], harness: true, turnFirst: true, note: '255 units east of BlackHelicopter0 (76,965,757 in the world, radius 225), aimed at it (a ring search in the chain\'s level)' },
    { op: 'frob', target: 'BlackHelicopter0', watch: ['BlackHelicopter0'] },
    { op: 'conv', name: 'M08JockExit', choose: [{ index: 0, label: 'Go' }], watch: ['BlackHelicopter0'], timeout: 300 },
    { op: 'travel', to: '09_NYC_Dockyard', label: 'exit', timeout: 240 },
    ...cheats,
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'h6-dockyard' },
    // mission 9's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 108, label: 'exit' },
  ],
};
