/** Mission 2, Battery Park, Hell's Kitchen and the warehouse district (docs/stage-6-inventory.md 02.6, docs/stage-6-chains.md): from mission 1's exit (the save its
 * chain pinned in 02_NYC_BatteryPark, after AnnaDock and Anna's run to the castle) through the subway, the Street's warehouse button, the generator and Jock's
 * helicopter to the exit to 03_NYC_UNATCOIsland. The maps' own means: SubwayControlPanel4 opens the train's doors (TrainDoors), Teleporter1 in the train leads to
 * the Street; Button3 (event ToWarehouse) fires the Street's MapExit0 to 02_NYC_Warehouse#ToRoofTop; the explosive crate CrateExplosiveSmall0 (tag BlowGenerator)
 * stands beside BreakableWall2: a pistol shot explodes it (300, Exploded), the wall breaks (minDamageThreshold 75) and its event Debris fires FlagTrigger0
 * (GeneratorBlown); Mission02.Timer then plays DL_Pickup and brings the helicopter and Gunther into the world; JockExit (the helicopter's, radius 240) and its Go
 * branch trigger ChopperExit: Dispatcher0 fires MapExit0 (not touchable: bCollideActors false) and its camera path. Placements from scripts/chain-plan.mjs. */
export default {
  mission: '02',
  steps: [
    { op: 'start', kind: 'slot', source: 'chain', chain: '01', slot: 'Save0101', index: 101 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'c1-loaded' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },

    // the subway: the panel opens the three TrainDoors (their event HostageActivation), the fall into Teleporter1 in the train goes to the Street
    { op: 'place', at: [-5358, 2989, -322], view: [-4090, 32733], harness: true, note: '40 units east of SubwayControlPanel4 (-5398,2989,-299), aimed at it' },
    { op: 'frob', target: 'SubwayControlPanel4', watch: ['SubwayControlPanel4'] },
    { op: 'wait', seconds: 5 },
    { op: 'state', label: 'train-door', actor: 'DeusExMover26', fields: ['KeyNum', 'bLocked'] },
    { op: 'place', at: [-5431, 3035, -244], view: [0, 0], drop: true, harness: true, note: 'above Teleporter1 (-5431,3035,-334, radius 30) in the train' },
    { op: 'travel', to: '02_NYC_Street', label: 'leg1' },
    // God mode and the cheats flag are not travel properties (docs/stage-6-chains.md "Rules")
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'c2-street' },

    { op: 'place', at: [439, 4533, -749], view: [-10926, 49109], harness: true, note: '40 units north of Button3 (439,4493,-778; event ToWarehouse), aimed at it' },
    { op: 'frob', target: 'Button3', watch: ['Button3'] },
    { op: 'travel', to: '02_NYC_Warehouse', label: 'leg2' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'c3-warehouse' },

    // the generator: the crate beside the wall, shot with the pistol until the wall is down (each shot's spread is the run's own)
    { op: 'place', at: [469, -404, 65], view: [-6290, 49204], harness: true, note: '100 units north of CrateExplosiveSmall0 (469,-504,35; tag BlowGenerator), aimed at it' },
    { op: 'belt', n: 1 },
    { op: 'click', until: { flag: 'GeneratorBlown' }, gap: 1.5, max: 10 },
    { op: 'snap', label: 'c4-generator' },
    { op: 'wait', flag: 'DL_Pickup_Played', timeout: 120 },
    { op: 'snap', label: 'c5-pickup' },

    // the roof: JockExit, the helicopter's conversation (radius 240), its Go branch: ChopperExit, Dispatcher0, MapExit0's camera path
    { op: 'watch', actors: ['BlackHelicopter1'] },
    { op: 'place', at: [-22, -295, 1040], view: [0, 32768], harness: true, note: 'on the roof 200 units east of BlackHelicopter1 (-222,-295,1133 in the world), facing it' },
    { op: 'frob', target: 'BlackHelicopter1' },
    { op: 'conv', name: 'JockExit', timeout: 120 },
    { op: 'travel', to: '03_NYC_UNATCOIsland', label: 'exit', timeout: 240 },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'c6-island' },
    // mission 3's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 102, label: 'exit' },
  ],
};
