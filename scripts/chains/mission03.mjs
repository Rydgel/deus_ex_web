/** Mission 3, UNATCO, Battery Park, the tunnels and the airfield (docs/stage-6-inventory.md 03.6, docs/stage-6-chains.md): from mission 2's exit (the save its chain
 * pinned in 03_NYC_UNATCOIsland) through the debriefing, Jock's island helicopter, Battery Park, the Brooklyn Bridge station, the Mole People's tunnels, the heli
 * base's DL_Airfield and the airfield to the exit to 04_NYC_UNATCOIsland. The maps' own means: Teleporter1 to the HQ; ManderleyDebriefing02 (radius 200);
 * Teleporter3 back; JockBarks (Jock is the island's BlackHelicopter0; its Ready branch, which needs ManderleyDebriefing02_Played, fires ChopperExit: Dispatcher0,
 * ChopperLeave, MapExit0 and its camera path); the teleporters of Battery Park, the station and the tunnels; DataLinkTrigger0 of the heli base (DL_Airfield) and
 * its elevator teleporter; M03JockLeave at the airfield (needs DL_Airfield_Played; its Ready branch fires HelicopterPickUp: Dispatcher0, MoveHelicopter, MapExit0).
 * Placements from scripts/chain-plan.mjs (`drop`, `stand`, `face`) in Play's world. */
const cheats = [
  { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
  { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
];
export default {
  mission: '03',
  steps: [
    { op: 'start', kind: 'slot', source: 'chain', chain: '02', slot: 'Save0102', index: 102 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'd1-loaded' },
    ...cheats,
    { op: 'place', at: [-5030, 2714, -10], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger0 (-5030,2714,-100, radius 400; DL_WelcomeBack)' },
    { op: 'wait', flag: 'DL_WelcomeBack_Played', timeout: 120 },

    // the HQ: Teleporter1 (the same mission: the island is filed), the debriefing
    { op: 'place', at: [-3375, 698, -401], view: [0, 0], drop: true, harness: true, note: 'above Teleporter1 (-3375,698,-511, radius 80)' },
    { op: 'travel', to: '03_NYC_UNATCOHQ', label: 'leg1' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'd2-hq' },
    { op: 'watch', actors: ['JosephManderley0'] },
    { op: 'place', at: [369, -165, 289], view: [-7114, 32747], harness: true, turnFirst: true, note: '60 units east of JosephManderley0 at his place, facing him' },
    { op: 'conv', name: 'ManderleyDebriefing02', watch: ['JosephManderley0'], timeout: 300 },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'd3-debriefed' },
    { op: 'place', at: [-2271, 1795, 764], view: [0, 0], drop: true, harness: true, note: 'above Teleporter3 (-2271,1795,654, radius 80)' },
    { op: 'travel', to: '03_NYC_UNATCOIsland', label: 'leg2' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'd4-island' },

    // Jock's helicopter on the island: its cylinder (radius 461) blocks the player and is wider than JockBarks' radius (300), so the conversation starts by the
    // right button from just outside it (the original pushed a player placed inside: the first capture never saw JockBarks start)
    { op: 'place', at: [-5567, 2510, -79], view: [116, 32772], harness: true, turnFirst: true, note: '490 units east of BlackHelicopter0 (-6057,2510,-35; BindName Jock, radius 461), aimed at it (chain-plan.mjs face)' },
    { op: 'frob', target: 'BlackHelicopter0', watch: ['BlackHelicopter0'] },
    { op: 'conv', name: 'JockBarks', watch: ['BlackHelicopter0'], timeout: 120 },
    { op: 'travel', to: '03_NYC_BatteryPark', label: 'leg3', timeout: 240 },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'd5-batterypark' },

    // the way to the airfield: Battery Park's Teleporter2, the station's Teleporter0, the tunnels' Teleporter2
    { op: 'place', at: [-4015, 3265, -598], view: [0, 0], drop: true, harness: true, note: 'above Teleporter2 (-4015,3265,-688, radius 80)' },
    { op: 'travel', to: '03_NYC_BrooklynBridgeStation', label: 'leg4' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [-1962, -1087, 200], view: [0, 0], drop: true, harness: true, note: 'above Teleporter0 (-1962,-1087,110, radius 18)' },
    { op: 'travel', to: '03_NYC_MolePeople', label: 'leg5' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [4916, -2188, 194], view: [0, 0], drop: true, harness: true, note: 'above Teleporter2 (4916,-2188,104, radius 100)' },
    { op: 'travel', to: '03_NYC_AirfieldHeliBase', label: 'leg6' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'd6-helibase' },

    // the heli base: DL_Airfield (the flag M03JockLeave needs), then the elevator teleporter to the airfield
    { op: 'place', at: [-297, 2075, 130], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger0 (-297,2075,40, radius 96; DL_Airfield)' },
    { op: 'wait', flag: 'DL_Airfield_Played', timeout: 120 },
    { op: 'snap', label: 'd7-dl-airfield' },
    { op: 'place', at: [2772, -16, 1512], view: [0, 0], drop: true, harness: true, note: 'above Teleporter5 (2772,-16,1422, radius 18; the elevator)' },
    { op: 'travel', to: '03_NYC_Airfield', label: 'leg7' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    // the airfield's helicopter (Jock, M03JockLeave's owner) is out of the world until the Lebedev scene: Mission03.FirstFrame brings it in on an entry with
    // MeetLebedev_Played or JuanLebedev_Dead (Mission03.uc:41-66)
    { op: 'state', label: 'airfield-helicopter-hidden', actor: 'BlackHelicopter0', fields: ['bHidden'] },
    { op: 'snap', label: 'd8-airfield' },

    // the hangar and the 747: Teleporter2 (in a doorway: walked into), the hangar's Teleporter10 to the 747's cargo hold, MeetLebedev, Anna's entrance
    { op: 'place', at: [3391, 2553, 334], view: [0, 49152], harness: true, turnFirst: true, note: '200 units north of Teleporter2 (3391,2353,294, radius 64), facing it: the walk enters it' },
    { op: 'walk', seconds: 2 },
    { op: 'travel', to: '03_NYC_Hangar', label: 'leg8' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [356, -854, 278], view: [0, 0], drop: true, harness: true, note: 'above Teleporter10 (356,-854,188, radius 110)' },
    { op: 'travel', to: '03_NYC_747', label: 'leg9' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'd9-747' },
    { op: 'place', at: [-249, -725, 355], view: [-6146, 32803], harness: true, turnFirst: true, note: '60 units east of JuanLebedev0 (-309,-725,354), facing him' },
    { op: 'conv', name: 'MeetLebedev', watch: ['JuanLebedev0'], timeout: 300 },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'd10-lebedev' },
    { op: 'conv', name: 'AnnaEntrance', watch: ['AnnaNavarre0'], timeout: 300 },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'd11-anna' },

    // back to the airfield: the 747's Teleporter13 and the hangar's Teleporter2 (doorways: walked into)
    { op: 'place', at: [1521, -52, 386], view: [0, 49152], harness: true, turnFirst: true, note: '200 units north of Teleporter13 (1521,-252,346, radius 50), facing it: the walk enters it' },
    { op: 'walk', seconds: 2 },
    { op: 'travel', to: '03_NYC_Hangar', label: 'leg10' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [3217, 1201, 278], view: [0, 16384], harness: true, turnFirst: true, note: '200 units south of Teleporter2 (3217,1401,238, radius 64), facing it: the walk enters it' },
    { op: 'walk', seconds: 2 },
    { op: 'travel', to: '03_NYC_Airfield', label: 'leg11' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'state', label: 'airfield-helicopter', actor: 'BlackHelicopter0', fields: ['bHidden'] },
    { op: 'snap', label: 'd12-airfield' },

    // the exit: M03JockLeave (Jock, the airfield's BlackHelicopter0, radius 240), its Ready branch fires HelicopterPickUp: the helicopter moves, Dispatcher0
    // fires MoveHelicopter, MapExit0 and its camera path to 04_NYC_UNATCOIsland
    { op: 'place', at: [3825, -2690, 200], view: [0, 32768], harness: true, turnFirst: true, note: '490 units east of BlackHelicopter0 (3335,-2690,155 once in the world, radius 461), facing it; the player lands' },
    { op: 'frob', target: 'BlackHelicopter0', watch: ['BlackHelicopter0'] },
    { op: 'conv', name: 'M03JockLeave', choose: [{ index: 0, label: 'Ready' }], watch: ['BlackHelicopter0'], timeout: 180 },
    { op: 'travel', to: '04_NYC_UNATCOIsland', label: 'exit', timeout: 240 },
    ...cheats,
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'd13-island' },
    // mission 4's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 103, label: 'exit' },
  ],
};
