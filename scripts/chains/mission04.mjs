/** Mission 4, UNATCO, Paul's hotel, the NSF headquarters and Battery Park (docs/stage-6-inventory.md 04.6, docs/stage-6-chains.md): from mission 3's exit (the save
 * its chain pinned in 04_NYC_UNATCOIsland) through the debriefing, Jock, the hotel's PaulInjured, the NSF headquarters' dishes and signal,
 * the raid's TalkedToPaulAfterMessage and Gunther's showdown to the exit to 05_NYC_UNATCOMJ12lab. The maps' own means: DataLinkTrigger0 (DL_SeeManderley),
 * Teleporter1 to the HQ, ManderleyDebriefing03 (radius 160), Teleporter3 back, JockTellsAboutPaul (Jock is the island's BlackHelicopter0, radius 250; it fires
 * TimeToGo: FlagTrigger1, ChopperExit, Dispatcher0, ChopperLeave, MapExit0 and its camera path to the Street); the Street's Teleporter20 to the hotel's front
 * door; PaulInjured (radius 100); the Street's Teleporter31 to the NSF headquarters; ComputerPersonal3 (MCOLLINS, REVOLUTION:
 * its userList) and its three dish options (TriggerEvent Dish1..3: FlagTriggers 3, 17, 18 set Dish1..3InPosition, Mission04.Timer turns the dishes and sets
 * CanSendSignal); ComputerPersonal4 (NAPOLEON, REVOLUTION) and its Broadcast Message (SendingSignal: DataLinkTrigger8 plays DL_PaulGoodJob, FlagTrigger10 sets
 * NSFSignalSent); back to Paul: FlagTrigger30 at Paul, touched with NSFSignalSent, fires PlayerSentSignal and FlagTrigger16 (not touchable) sets
 * ApartmentEntered; Mission04.Timer then starts TalkedToPaulAfterMessage by name (StartConversationByName needs Paul within 800 units); the
 * Street's subway (Teleporter13) to Battery Park; GuntherShowdown (sight/radius 300) and its Surrender branch: Mission4Exit, MapExit0/1 and the camera path.
 * Placements from scripts/chain-plan.mjs (`drop`, `approach`, `stand`, `face`, `terminal`) in Play's world. */
const cheats = [
  { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
  { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
];
export default {
  mission: '04',
  steps: [
    { op: 'start', kind: 'slot', source: 'chain', chain: '03', slot: 'Save0103', index: 103 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'e1-loaded' },
    ...cheats,
    { op: 'place', at: [-4688, 2712, -10], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger0 (-4688,2712,-100, radius 260; DL_SeeManderley)' },
    { op: 'wait', flag: 'DL_SeeManderley_Played', timeout: 120 },

    // the HQ: the debriefing
    { op: 'place', at: [-3336, 658, -401], view: [0, 0], drop: true, harness: true, note: 'above Teleporter1 (-3336,658,-511, radius 80)' },
    { op: 'travel', to: '04_NYC_UNATCOHQ', label: 'leg1' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'e2-hq' },
    { op: 'place', at: [369, -177, 289], view: [-7117, 32778], harness: true, turnFirst: true, note: '60 units east of JosephManderley0 at his place, facing him' },
    { op: 'conv', name: 'ManderleyDebriefing03', watch: ['JosephManderley0'], timeout: 300 },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'e3-debriefed' },
    { op: 'place', at: [-2348, 1793, 764], view: [0, 0], drop: true, harness: true, note: 'above Teleporter3 (-2348,1793,654, radius 80)' },
    { op: 'travel', to: '04_NYC_UNATCOIsland', label: 'leg2' },
    ...cheats,
    { op: 'wait', seconds: 3 },

    // Jock: JockTellsAboutPaul by its radius, the helicopter to the Street
    // the helicopter's cylinder (radius 300) blocks the player and is wider than JockTellsAboutPaul's radius (250): the right button from just outside it
    { op: 'place', at: [-5741, 2501, -79], view: [56, 32758], harness: true, turnFirst: true, note: '330 units east of BlackHelicopter0 (-6071,2501,-38; BindName Jock, radius 300), aimed at it (chain-plan.mjs face)' },
    { op: 'frob', target: 'BlackHelicopter0', watch: ['BlackHelicopter0'] },
    { op: 'conv', name: 'JockTellsAboutPaul', watch: ['BlackHelicopter0'], timeout: 180 },
    { op: 'travel', to: '04_NYC_Street', label: 'leg3', timeout: 240 },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'e4-street' },

    // the hotel: PaulInjured, then FlagTrigger16 (ApartmentEntered)
    { op: 'place', at: [386, 895, -355], view: [0, 0], drop: true, harness: true, note: 'above Teleporter20 (386,895,-445, radius 80; the front door)' },
    { op: 'travel', to: '04_NYC_Hotel', label: 'leg4' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [-319, -2948, 113], view: [-6971, 32843], harness: true, turnFirst: true, note: '40 units east of PaulDenton0 (-359,-2919,112), facing him' },
    { op: 'conv', name: 'PaulInjured', watch: ['PaulDenton0'], timeout: 300 },
    { op: 'wait', seconds: 10 },
    { op: 'snap', label: 'e5-paul' },
    { op: 'place', at: [-367, 306, 16], view: [0, 16384], harness: true, turnFirst: true, note: '120 units south of Teleporter19 (-367,426,-24, radius 80; the front door), facing it: the walk enters it' },
    { op: 'walk', seconds: 2 },
    { op: 'travel', to: '04_NYC_Street', label: 'leg5' },
    ...cheats,
    { op: 'wait', seconds: 3 },

    // the NSF headquarters: the dishes, then the signal
    { op: 'place', at: [-7813, 298, -379], view: [0, 0], drop: true, harness: true, note: 'above Teleporter31 (-7813,298,-469, radius 375)' },
    { op: 'travel', to: '04_NYC_NSFHQ', label: 'leg6' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'e6-nsfhq' },
    // a computer loads in state Off at its Begin code's FinishAnim (bAnimating): Frob does nothing until the animation ends, which needs it drawn (the
    // headless stand-in from the placement on, then 2 s; docs/stage-6-chains.md, ending 2)
    { op: 'watch', actors: ['ComputerPersonal3'] },
    { op: 'place', at: [232, 316, 1073], view: [-11052, 32865], harness: true, turnFirst: true, note: '45 units east of ComputerPersonal3 (187,316,1032), aimed at it' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal3', watch: ['ComputerPersonal3'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'mcollins' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'revolution' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 284], note: '"South Dish Rotation" (Play\'s terminal: the first of four buttons at (361,164) of its 720x480 root; chain-plan.mjs terminal)' },
    { op: 'wait', flag: 'Dish1InPosition', timeout: 30 },
    { op: 'point', at: [641, 314], note: '"North Dish Rotation" (the second button, (361,194))' },
    { op: 'wait', flag: 'Dish2InPosition', timeout: 30 },
    { op: 'point', at: [641, 344], note: '"West Dish Rotation" (the third button, (361,224))' },
    { op: 'wait', flag: 'Dish3InPosition', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    { op: 'wait', flag: 'CanSendSignal', timeout: 60 },
    { op: 'snap', label: 'e7-dishes' },
    // a computer loads in state Off at its Begin code's FinishAnim (bAnimating): Frob does nothing until the animation ends, which needs it drawn (the
    // headless stand-in from the placement on, then 2 s; docs/stage-6-chains.md, ending 2)
    { op: 'watch', actors: ['ComputerPersonal4'] },
    { op: 'place', at: [117, 445, 1073], view: [-11065, 49070], harness: true, turnFirst: true, note: '45 units north of ComputerPersonal4 (117,400,1032), aimed at it' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal4', watch: ['ComputerPersonal4'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'napoleon' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'revolution' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 329], note: '"Broadcast Message" (the one button, (361,209))' },
    { op: 'wait', flag: 'NSFSignalSent', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'] },
    { op: 'wait', flag: 'DL_PaulGoodJob_Played', timeout: 120 },
    { op: 'snap', label: 'e8-signal' },
    { op: 'place', at: [-239, -2403, 162], view: [0, 0], drop: true, harness: true, note: 'above Teleporter1 (-239,-2403,72, radius 375)' },
    { op: 'travel', to: '04_NYC_Street', label: 'leg7' },
    ...cheats,
    { op: 'wait', seconds: 3 },

    // back to Paul: FlagTrigger30 at Paul (touched with NSFSignalSent) fires PlayerSentSignal, FlagTrigger16 (not touchable) sets ApartmentEntered, and
    // Mission04.Timer starts the raid and TalkedToPaulAfterMessage
    { op: 'place', at: [386, 895, -355], view: [0, 0], drop: true, harness: true, note: 'above Teleporter20 (386,895,-445, radius 80; the front door)' },
    { op: 'travel', to: '04_NYC_Hotel', label: 'leg8' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [-209, -2932, 113], view: [0, 32768], harness: true, turnFirst: true, note: '150 units east of FlagTrigger30 (-359,-2932,105, radius 70; at Paul), facing it: the walk enters it' },
    { op: 'walk', seconds: 1 },
    { op: 'wait', flag: 'ApartmentEntered', timeout: 30 },
    { op: 'conv', name: 'TalkedToPaulAfterMessage', watch: ['PaulDenton0'], timeout: 120 },
    { op: 'wait', seconds: 10 },
    { op: 'snap', label: 'e9-raid' },
    { op: 'place', at: [-367, 306, 16], view: [0, 16384], harness: true, turnFirst: true, note: '120 units south of Teleporter19 (-367,426,-24, radius 80; the front door), facing it: the walk enters it' },
    { op: 'walk', seconds: 2 },
    { op: 'travel', to: '04_NYC_Street', label: 'leg9' },
    ...cheats,
    { op: 'wait', seconds: 3 },

    // Battery Park: the Street's subway, GuntherShowdown's Surrender
    { op: 'place', at: [1861, -686, -1128], view: [0, 0], harness: true, turnFirst: true, note: '120 units west of Teleporter13 (1981,-686,-1168, radius 30; in the train), facing it: the walk enters it' },
    { op: 'walk', seconds: 2 },
    { op: 'travel', to: '04_NYC_BatteryPark', label: 'leg10' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'e10-batterypark' },
    { op: 'place', at: [-3518, 1407, 365], view: [-5054, 32726], harness: true, turnFirst: true, note: '60 units east of GuntherHermann0 (-3578,1407,372), facing him' },
    { op: 'conv', name: 'GuntherShowdown', choose: [{ index: 0, label: 'Surrender' }], watch: ['GuntherHermann0'], timeout: 180 },
    { op: 'travel', to: '05_NYC_UNATCOMJ12lab', label: 'exit', timeout: 240 },
    ...cheats,
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'e11-lab' },
    // mission 5's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 104, label: 'exit' },
  ],
};
