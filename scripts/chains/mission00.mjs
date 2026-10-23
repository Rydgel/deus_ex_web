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

    // 00_TrainingFinal's exit: MapExit0 (6580,-5924,88; radius 150) to DX; the held key ends with the map
    { op: 'place', at: [6467, -5811, 88], view: [0, 57344], harness: true, note: 'in the holo room, 160 units from MapExit0, facing it' },
    { op: 'walk', seconds: 3 },
    { op: 'travel', to: 'DX', label: 'exit' },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'a6-dx' },
  ],
};
