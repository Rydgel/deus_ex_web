/** Mission 5, the MJ12 lab, UNATCO and the island (docs/stage-6-inventory.md 05.6, docs/stage-6-chains.md): from mission 4's exit (the save its chain pinned in
 * 05_NYC_UNATCOMJ12lab, the player in the cell) through the lab's DL_Choice and its teleporter to the HQ, Anna's killphrase (the two parts decrypted on
 * ComputerPersonal0 and ComputerPersonal3 as demiurge/archon: their special options fire know1 and know2, whose FlagTriggers set KnowsAnnasKillphrase1/2;
 * AnnaExitKillphrase (radius 475, needs both and DL_Choice_Played) fires AnnaDies: FlagTrigger3 sets annadies and Mission05.Timer kills her), Alex's
 * M05MeetAlexJacobson (the NanoKey of levelone, DeusExMover29), Teleporter3 to the island and M05MeetJock (radius 240; its continue branch fires ChopperExit,
 * MapExit1 and the camera path) to the exit to 06_HongKong_Helibase. Placements from scripts/chain-plan.mjs (`drop`, `approach`, `stand`, `face`, `terminal`). */
const cheats = [
  { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
  { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
];
export default {
  mission: '05',
  steps: [
    { op: 'start', kind: 'slot', source: 'chain', chain: '04', slot: 'Save0104', index: 104 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'f1-loaded' },
    ...cheats,

    // the lab's equipment room: Mission05.FirstFrame took the player's inventory and dropped it at the SpawnPoints tagged player_inv (Mission05.uc:52-95); the
    // pistol taken back (the chains after this one have no other gun: mission 9's EM device, mission 12's bots)
    { op: 'place', at: [-8426, 1409, -191], view: [-1767, 32836], harness: true, turnFirst: true, note: '65 units east of the player\'s pistol on its shelf (-8491,1409,-163, by a player_inv SpawnPoint), aimed at it (a ring search in the chain\'s level: the pistol is dropped at the arrival)' },
    { op: 'frob', target: 'WeaponPistol' },
    { op: 'wait', seconds: 2 },
    { op: 'snap', label: 'f1b-pistol' },

    // the lab: DL_Choice (AnnaExitKillphrase needs it), then Teleporter4 to the HQ's medical wing
    { op: 'place', at: [-1385, 1600, -46], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger2 (-1385,1600,-136, radius 96; DL_Choice)' },
    { op: 'wait', flag: 'DL_Choice_Played', timeout: 120 },
    { op: 'snap', label: 'f2-choice' },
    { op: 'place', at: [704, -2117, -2], view: [0, 0], drop: true, harness: true, note: 'above Teleporter4 (704,-2117,-112, radius 100)' },
    { op: 'travel', to: '05_NYC_UNATCOHQ', label: 'leg1' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'f3-hq' },

    // the killphrase: part 1 on Manderley's computer, part 2 on Gunther's (both as demiurge, archon: their userLists)
    // a computer loads in state Off at its Begin code's FinishAnim (bAnimating): Frob does nothing until the animation ends, which needs it drawn (the
    // headless stand-in from the placement on, then 2 s; docs/stage-6-chains.md, ending 2)
    { op: 'watch', actors: ['ComputerPersonal0'] },
    { op: 'place', at: [330, -97, 337], view: [-10997, 32865], harness: true, turnFirst: true, note: '45 units east of ComputerPersonal0 (285,-97,297), aimed at it' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal0', watch: ['ComputerPersonal0'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'demiurge' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'archon' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 314], note: '"Decrypt Agent ANavarre Killphrase" (the first of two buttons at (361,194) of Play\'s 720x480 root; chain-plan.mjs terminal)' },
    { op: 'wait', flag: 'KnowsAnnasKillphrase1', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    // a computer loads in state Off at its Begin code's FinishAnim (bAnimating): Frob does nothing until the animation ends, which needs it drawn (the
    // headless stand-in from the placement on, then 2 s; docs/stage-6-chains.md, ending 2)
    { op: 'watch', actors: ['ComputerPersonal3'] },
    { op: 'place', at: [-317, -1105, 31], view: [-11011, 32834], harness: true, turnFirst: true, note: '45 units east of ComputerPersonal3 (-362,-1105,-9), aimed at it' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal3', watch: ['ComputerPersonal3'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'demiurge' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'archon' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 314], note: '"Decrypt Agent ANavarre Killphrase" (the first of two buttons)' },
    { op: 'wait', flag: 'KnowsAnnasKillphrase2', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'] },
    { op: 'snap', label: 'f4-killphrase' },

    // Anna at the exit: AnnaExitKillphrase by its radius (475)
    { op: 'place', at: [-589, 450, 470], view: [0, 32768], harness: true, turnFirst: true, note: '200 units east of AnnaNavarre0 (-789,450,464), facing her' },
    { op: 'conv', name: 'AnnaExitKillphrase', watch: ['AnnaNavarre0'], timeout: 180 },
    { op: 'wait', flag: 'AnnaNavarre_Dead', timeout: 60 },
    { op: 'snap', label: 'f5-anna' },

    // Alex: the NanoKey of levelone, then the door
    { op: 'place', at: [2061, -801, -15], view: [-6167, 32779], harness: true, turnFirst: true, note: '60 units east of AlexJacobson0 (2002,-801,-16), facing him' },
    { op: 'frob', target: 'AlexJacobson0' },
    { op: 'conv', name: 'M05MeetAlexJacobson', watch: ['AlexJacobson0'], timeout: 180 },
    { op: 'wait', seconds: 5 },
    { op: 'snap', label: 'f6-alex' },
    // the key ring in hand (belt 0) used on the door with the left button unlocks it (DeusExMover.Frob with a NanoKeyRing holding KeyIDNeeded toggles bLocked),
    // the right button (nothing in use) opens it, as mission 0's key door
    { op: 'place', at: [-868, 320, 457], view: [-9672, 32768], harness: true, turnFirst: true, note: '60 units east of DeusExMover29 (levelone, -928,320,416), aimed at it' },
    { op: 'belt', n: 0 },
    { op: 'click' },
    { op: 'frob', target: 'DeusExMover29' },
    { op: 'wait', seconds: 3 },
    { op: 'state', label: 'levelone', actor: 'DeusExMover29', fields: ['KeyNum', 'bLocked'] },
    { op: 'place', at: [-2357, 1793, 764], view: [0, 0], drop: true, harness: true, note: 'above Teleporter3 (-2357,1793,654, radius 80)' },
    { op: 'travel', to: '05_NYC_UNATCOIsland', label: 'leg2' },
    ...cheats,
    { op: 'wait', seconds: 3 },

    // Jock: M05MeetJock by its radius, its continue branch
    // the helicopter's cylinder (radius 461) blocks the player and is wider than M05MeetJock's radius (240): the right button from just outside it
    { op: 'place', at: [-5571, 2520, -79], view: [280, 32775], harness: true, turnFirst: true, note: '490 units east of BlackHelicopter0 (-6061,2520,-27; BindName Jock, radius 461), aimed at it (chain-plan.mjs face)' },
    { op: 'frob', target: 'BlackHelicopter0', watch: ['BlackHelicopter0'] },
    { op: 'conv', name: 'M05MeetJock', watch: ['BlackHelicopter0'], timeout: 180 },
    { op: 'travel', to: '06_HongKong_Helibase', label: 'exit', timeout: 240 },
    ...cheats,
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'f7-hongkong' },
    // mission 6's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 105, label: 'exit' },
  ],
};
