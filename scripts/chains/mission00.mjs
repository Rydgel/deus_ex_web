/** Mission 0, Training (docs/stage-6-inventory.md 00.6, docs/stage-6-chains.md): from the menu's Training button through the three maps to
 * 00_TrainingFinal's exit to DX. The placements come from scripts/chain-plan.mjs (`drop`, `face`, `approach`) in Play's world; both programs are given the same numbers. */

/** A LAM tagged DefuseLAM, frozen level: placed in view of it (chain-plan.mjs face), frobbed once to disarm it (ThrownProjectile.Frob: bArmed, skillTime >= 0) and once to pick it up. */
const defuse = (name, at, view) => [
  { op: 'place', at, view, harness: true, note: `in view of ${name}, outside no radius that matters: the level is held` },
  { op: 'frob', target: name, watch: [name], note: 'disarms it' },
  { op: 'frob', target: name, watch: [name], note: 'picks it up' },
];

export default {
  mission: '00',
  steps: [
    { op: 'start', kind: 'menu-training' },
    { op: 'wait', seconds: 5 },
    { op: 'snap', label: 'a1-training' },

    // the key and the key door: the Train key on the desk (NanoKey0, 415,1072,-145), picked up with the right button; the key ring taken in hand (belt 0) and used
    // on the door with the left button (ParseLeftClick: DoFrob(Self, inHand)) unlocks it, the right button opens it
    { op: 'place', at: [455, 1072, -99], view: [-11796, 32705], harness: true, note: '40 units from NanoKey0, aimed at it' },
    { op: 'frob', target: 'NanoKey0' },
    { op: 'belt', n: 0 },
    { op: 'place', at: [384, 636, -111], view: [6393, 49152], harness: true, note: 'in front of the keydoor pair (DeusExMover47/48 at 352..416,576), key room side' },
    { op: 'click' },
    { op: 'frob', target: 'keydoor' },
    { op: 'wait', seconds: 4 },
    { op: 'state', label: 'keydoor-47', actor: 'DeusExMover47', fields: ['KeyNum', 'bLocked'] },
    { op: 'state', label: 'keydoor-48', actor: 'DeusExMover48', fields: ['KeyNum', 'bLocked'] },

    // the crowbar and the crates: the crowbar (WeaponCrowbar1) taken, drawn and swung at the upper crate (Cratepick1) until Mission00.Timer sees a crate gone (MS_CratesBroken,
    // DL_Lockpick); the Lockpick the crate drops lies where this run's physics put it: the player is placed by it; the lockpick is used on the gundoor pair (strength 0.05)
    { op: 'place', at: [1166, 375, -47], view: [-9083, 32699], harness: true, note: '60 units from WeaponCrowbar1 (1106,375,-79), aimed at it' },
    { op: 'frob', target: 'WeaponCrowbar1' },
    { op: 'belt', n: 1 },
    { op: 'place', at: [1023, -204, -79], view: [-2221, 49171], harness: true, note: '70 units north of the Cratepick crates (1023,-274)' },
    { op: 'click', until: { flag: 'MS_CratesBroken' }, max: 10, gap: 2 },
    { op: 'wait', flag: 'DL_Lockpick_Played', timeout: 240 },
    { op: 'placeNear', class: 'Lockpick', distance: 40, bearing: 1.5707963267948966, harness: true, note: '40 units north of the dropped Lockpick, aimed at it' },
    { op: 'frob', target: 'Lockpick' },
    { op: 'belt', n: 2 },
    { op: 'place', at: [1252, 144, -79], view: [1756, 0], harness: true, note: '60 units west of the gundoor pair (DeusExMover45/46 at 1312,112..176), aimed at it' },
    { op: 'click', settle: 60 },
    { op: 'wait', seconds: 20 },
    { op: 'state', label: 'gundoor-picked-45', actor: 'DeusExMover45', fields: ['KeyNum', 'bLocked'] },
    { op: 'state', label: 'gundoor-picked-46', actor: 'DeusExMover46', fields: ['KeyNum', 'bLocked'] },
    { op: 'frob', target: 'gundoor' },
    { op: 'wait', seconds: 4 },
    { op: 'state', label: 'gundoor-open-45', actor: 'DeusExMover45', fields: ['KeyNum', 'bLocked'] },
    { op: 'state', label: 'gundoor-open-46', actor: 'DeusExMover46', fields: ['KeyNum', 'bLocked'] },

    // the data cube and the keypad: DataCube0 read (a note is added; a second frob closes it), Keypad0 opened with the code it names, 0012: the paddoor pair opens
    // (an event, not an unlock: bLocked stays)
    { op: 'place', at: [1536, 860, -143], view: [-8455, 32885], harness: true, note: '40 units from DataCube0 (1496,860,-147), aimed at it' },
    { op: 'frob', target: 'DataCube0' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'DataCube0', note: 'closes the reading window' },
    { op: 'place', at: [1998, 1000, -145], view: [7391, 49214], harness: true, note: '60 units from Keypad0 (1998,940,-55), aimed at it' },
    { op: 'frob', target: 'Keypad0', watch: ['Keypad0'] },
    { op: 'key', names: ['0', '0', '1', '2'], gap: 0.5 },
    { op: 'wait', seconds: 6 },
    { op: 'state', label: 'paddoor-26', actor: 'DeusExMover26', fields: ['KeyNum', 'bLocked'] },
    { op: 'state', label: 'paddoor-18', actor: 'DeusExMover18', fields: ['KeyNum', 'bLocked'] },

    // the multitool and Keypad2: the multitool (Multitool0) taken, drawn and used on Keypad2: the hack opens the hackdoor pair
    { op: 'place', at: [2271, 599, -99], view: [-11911, 32679], harness: true, note: '40 units from Multitool0 (2231,599,-147), aimed at it' },
    { op: 'frob', target: 'Multitool0' },
    { op: 'belt', n: 2 },
    { op: 'place', at: [2558, 1000, -145], view: [7391, 49214], harness: true, note: '60 units from Keypad2 (2558,940,-55), aimed at it' },
    { op: 'click', settle: 60, watch: ['Keypad2'] },
    { op: 'wait', seconds: 12 },
    { op: 'state', label: 'hackdoor-37', actor: 'DeusExMover37', fields: ['KeyNum', 'bLocked'] },
    { op: 'state', label: 'hackdoor-38', actor: 'DeusExMover38', fields: ['KeyNum', 'bLocked'] },
    { op: 'snap', label: 'a1b-gates' },

    // 00_Training to 00_TrainingCombat: Teleporter0
    { op: 'place', at: [4801, -4858, 125], view: [0, 49152], harness: true, drop: true, note: 'dropped onto Teleporter0 (4801,-4858,8; radius 100, height 40): the fall enters its cylinder' },
    { op: 'travel', to: '00_TrainingCombat', label: 'leg1' },
    { op: 'wait', seconds: 5 },
    { op: 'snap', label: 'a2-combat' },

    // the entry: the player walks from the arrival into DataLinkTrigger20 (-382,10,-39; radius 200); DL_CombatEntry opens `combatentry` at its end
    { op: 'walk', seconds: 4 },
    { op: 'wait', flag: 'DL_CombatEntry_Played', timeout: 180 },
    { op: 'snap', label: 'a3-combat-entry' },

    // the bombs: DL_DefuseFinish is Mission00.Timer's when no LAM tagged DefuseLAM is left; the level is held while the player disarms and picks up the four
    // (a pre-placed LAM arms its countdown, 1 s untrained, when the player comes within 128 units; the original's console lines take longer)
    { op: 'line', text: 'set LevelInfo bPlayersOnly True', harness: true },
    ...defuse('LAM1', [3350, 812, -47], [0, 32713]),
    ...defuse('LAM2', [3350, 1228, -47], [-599, 32780]),
    ...defuse('LAM0', [4278, 863, -47], [-2213, 49194]),
    ...defuse('LAM4', [4278, 1280, -47], [-2206, 49175]),
    { op: 'line', text: 'set LevelInfo bPlayersOnly False', harness: true },
    { op: 'wait', flag: 'DL_DefuseFinish_Played', timeout: 180 },
    { op: 'snap', label: 'a4-defused' },

    // 00_TrainingCombat to 00_TrainingFinal: Teleporter5
    { op: 'place', at: [5184, -254, 40], view: [0, 0], harness: true, drop: true, note: 'dropped onto Teleporter5 (5184,-254,-56)' },
    { op: 'travel', to: '00_TrainingFinal', label: 'leg2' },
    { op: 'wait', seconds: 5 },
    { op: 'snap', label: 'a5-final' },

    // the stealth maze's doors and the bridge: the wall buttons Switch1 and Switch2 (Switch1 actors tagged Switch1; events FirstStealthDoor and SecondStealthDoor) pressed with the
    // right button, and Keypad1 (code 0089, event bridge)
    { op: 'place', at: [-180, -1, 33], view: [-2731, 57325], harness: true, note: '35 units west of Switch1 (-145,-36,58), aimed at it' },
    { op: 'frob', target: 'Switch1' },
    { op: 'wait', seconds: 5 },
    { op: 'state', label: 'stealth-door-1', actor: 'DeusExMover0', fields: ['KeyNum', 'bLocked'] },
    { op: 'place', at: [107, 335, 33], view: [-3324, 32764], harness: true, note: '40 units east of Switch2 (67,335,58), aimed at it' },
    { op: 'frob', target: 'Switch2' },
    { op: 'wait', seconds: 5 },
    { op: 'state', label: 'stealth-door-2', actor: 'DeusExMover2', fields: ['KeyNum', 'bLocked'] },
    { op: 'place', at: [6032, -1459, -123], view: [-7072, 32883], harness: true, note: '40 units from Keypad1 (5992,-1459,-116), aimed at it' },
    { op: 'frob', target: 'Keypad1', watch: ['Keypad1'] },
    { op: 'key', names: ['0', '0', '8', '9'], gap: 0.5 },
    { op: 'wait', seconds: 6 },
    { op: 'state', label: 'bridge', actor: 'DeusExMover31', fields: ['KeyNum', 'bLocked'] },
    // the holo room: ConversationTrigger1 (6577,-5432, radius 96) starts M00MeetPage (Bob Page, five speeches) when a walking player touches it: placed outside its radius, landed, then walked in
    { op: 'place', at: [6577, -5282, 82], view: [0, 49152], harness: true, note: '150 units north of ConversationTrigger1, facing it' },
    { op: 'walk', seconds: 1.5 },
    { op: 'conv', name: 'M00MeetPage', watch: ['BobPage1'], timeout: 240 },
    { op: 'wait', seconds: 5 },
    { op: 'snap', label: 'a5b-final-gates' },

    // 00_TrainingFinal's exit: MapExit0 (6580,-5924,88; radius 150) to DX; the held key ends with the map
    { op: 'place', at: [6467, -5811, 88], view: [0, 57344], harness: true, note: 'in the holo room, 160 units from MapExit0, facing it' },
    { op: 'walk', seconds: 3 },
    { op: 'travel', to: 'DX', label: 'exit' },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'a6-dx' },
  ],
};
