/** Stage 6, rows 6.4.NN.2 (docs/stage-6-exit-criteria.md, docs/stage-6-flag-census.md): the carried-flag census. The 37 carried flags of
 * docs/stage-6-inventory.md ("The choices with lasting consequences across missions"; PlayerMetFilben counts once for mission 1 and once for mission 3), each
 * checked where a later mission reads it, on the Stage 6 chain harness (docs/stage-6-chains.md):
 *
 *   - a unit is a short chain from a base save: a chain's pinned save (.work/chains/exits/m<NN>/exit), the chain's own steps up to the reader's map (the prefix),
 *     the unit's flags written into the player's FlagBase with the expiration their setter gives them (and the flags the same setter branch sets with them), and
 *     the console's SaveGame, all in Play; pinned at .work/chains/exits/census/<unit>/Save0NNN (indexes from 201: no chain uses them). Both programs load it.
 *   - the unit's steps bring the reader (the reading mission's chain steps, or placed steps for a reader off the chains) and end with a snapshot and a map change
 *     after it: the flags, the conversation history of the travel text (ConPlayBase.SetupHistory) and, for a mission script's reader, a `state` of the pawn.
 *   - the side the chain line already has is the line's own capture when the reader is on the chain; a reader off the chains has a `line` unit too (the base with
 *     no flag changed), since the line's capture never ran it.
 *   - a family is the units that share a prefix and steps; one Play run of the prefix saves every unit's base (flags applied, SaveGame, flags put back).
 *
 * The unit files (.work/chains/census/<unit>.mjs, mission `c<NN>-<flag>-<side>`) run in both drivers:
 *   node scripts/chain-play.mjs --file .work/chains/census/<unit>.mjs
 *   node scripts/chain-original.mjs --file .work/chains/census/<unit>.mjs       (the Wine lock; the capture is .work/chains/m<unit>/)
 *   node scripts/validate-stage6-chain.mjs --file .work/chains/census/<unit>.mjs
 *
 *   node scripts/stage6-flag-census.mjs --list                        the table: flag, setters, expiration, the line's side, the reader run per reading mission (or why none)
 *   node scripts/stage6-flag-census.mjs --write [unit|family]         the unit files only
 *   node scripts/stage6-flag-census.mjs --bases <family> [--keep]     the base saves of a family, in Play (one prefix run), pinned
 *   node scripts/stage6-flag-census.mjs --play [unit|family] [--rebuild]   bases (when missing), unit files, then each unit in Play, one child process each (Linux host,
 *                                                                     --max-old-space-size=12288); writes .work/chains/census/play-summary.json
 * Never run on the 16 GB Mac (AGENTS.md, the memory budget). */
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { slotDirectory, slotName, flagsOfPlay } from './chain-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CENSUS = `${ROOT}/.work/chains/census`;
const CHEATS = [
  { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
  { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
];
const FIRST_INDEX = 201;

// ---- chain steps ------------------------------------------------------------------------------------------------------------------------------------------
const chainSteps = {};
async function load(mission) { return chainSteps[mission] ??= (await import(`./chains/mission${mission}.mjs`)).default.steps; }
const matches = (step, sel) => Object.entries(sel).every(([k, v]) => JSON.stringify(step[k]) === JSON.stringify(v));
function find(list, sel, from = 0) {
  const i = list.findIndex((s, n) => n >= from && matches(s, sel));
  if (i < 0) throw new Error(`no chain step ${JSON.stringify(sel)}`);
  return i;
}
/** The chain's steps from `from` to `to` (both selectors match a step by its fields; 'start' is the step after the start op, 'end' the last), `to` exclusive
 * with { before: true }. */
const span = (mission, from, to, { before = false } = {}) => ({ span: [mission, from, to, before] });
async function resolve(list) {
  const out = [];
  for (const item of list) {
    if (!item.span) { out.push(item); continue; }
    const [mission, from, to, before] = item.span, steps = await load(mission);
    const a = from === 'start' ? 1 : find(steps, from), b = to === 'end' ? steps.length - 1 : find(steps, to, a) - (before ? 1 : 0);
    out.push(...steps.slice(a, b + 1).map(s => ({ ...s })));
  }
  return out;
}

// ---- reader blocks ------------------------------------------------------------------------------------------------------------------------------------------
/** A conversation reader with an owner: placed `distance` units from the owner where it stands (placeNear: each program reads the owner's place, the view
 * aimed at it; turnFirst: ghosted until the last line, so the conversation starts after the placement), started by the right button (`frob`) or by its own
 * radius, played as it comes (`conv`) or, for a first-person one (overheard: no key is the conversation's; the chain's Enter would fire the weapon in hand),
 * waited for by its _Played flag. */
const talk = ({ owner, conv, distance = 60, bearing = 0, frob = false, firstPerson = false, choose, timeout = 240 }) => [
  { op: 'placeNear', actor: owner, distance, bearing, turnFirst: true, harness: true, note: `the reader ${conv}: ${distance} units from ${owner}` },
  ...(frob ? [{ op: 'frob', target: owner, watch: [owner] }] : []),
  firstPerson ? { op: 'wait', flag: `${conv}_Played`, timeout } : { op: 'conv', name: conv, watch: [owner], timeout, ...(choose ? { choose } : {}) },
  { op: 'wait', seconds: 3 },
];
/** A DataLinkTrigger reader: the fall into its cylinder (a placement inside raises no Touch), then its _Played flag. */
const datalink = ({ trigger, at, conv, timeout = 120 }) => [
  { op: 'place', at: [at[0], at[1], at[2] + 90], view: [0, 0], drop: true, harness: true, note: `above ${trigger} (${at.join(',')}; ${conv})` },
  { op: 'wait', flag: `${conv}_Played`, timeout },
  { op: 'wait', seconds: 3 },
];
/** A pawn a mission script enters, hides or destroys: its presence (chain-lib.mjs `state` presence) and hiding. */
const pawnState = (label, actor) => ({ op: 'state', label, actor, fields: ['bHidden', 'bInWorld'], presence: true });
const arrive = (to, label, extra = {}) => [{ op: 'travel', to, label, ...extra }, ...CHEATS, { op: 'wait', seconds: 3 }];

// ---- the families -------------------------------------------------------------------------------------------------------------------------------------------
/** base: the chain save it starts from and the chain's steps run before the flags are written (the prefix); body: the unit's steps after its start (the
 * reader blocks by name: a unit runs the blocks its `readers` list, all of them by default). */
export const FAMILIES = {
  '02-street': {
    mission: '02', note: 'the Street of mission 2 from the subway (the chain\'s leg1): PaulBarricade gives PaulGaveGrenades, which PaulLeaving needs',
    base: { from: { chain: '01', slot: 'Save0101', index: 101 }, prefix: [span('02', 'start', { op: 'snap', label: 'c2-street' }, { before: true })] },
    body: ['snap:c2-street', 'paul', span('02', { op: 'place', at: [439, 4533, -749] }, { op: 'snap', label: 'c3-warehouse' })],
    blocks: {
      paul: [
        ...talk({ owner: 'PaulDenton0', conv: 'PaulBarricade', distance: 80 }),
        { op: 'wait', flag: 'PaulGaveGrenades', timeout: 30 },
        { op: 'frob', target: 'PaulDenton0', watch: ['PaulDenton0'] },
        { op: 'wait', flag: 'PaulLeaving_Played', timeout: 120 },
        { op: 'wait', seconds: 3 },
        { op: 'snap', label: 'r-paul' },
      ],
    },
  },
  '03-hq': {
    mission: '03', note: 'UNATCO HQ in mission 3 (the chain\'s leg1): the debriefing as the chain plays it, then Shannon and Carter, Teleporter3 back',
    base: { from: { chain: '02', slot: 'Save0102', index: 102 }, prefix: [span('03', 'start', { op: 'snap', label: 'd2-hq' }, { before: true })] },
    body: ['snap:d2-hq', span('03', { op: 'watch', actors: ['JosephManderley0'] }, { op: 'snap', label: 'd3-debriefed' }), 'shannon', 'carter',
      span('03', { op: 'place', at: [-2271, 1795, 764] }, { op: 'snap', label: 'd4-island' })],
    blocks: {
      shannon: [...talk({ owner: 'Female0', conv: 'M03ShannonBarks', frob: true, firstPerson: true, timeout: 120 }), { op: 'snap', label: 'r-shannon' }],
      carter: [...talk({ owner: 'SamCarter0', conv: 'CarterGreeting03', distance: 60 }), { op: 'snap', label: 'r-carter' }],
    },
  },
  '03-batterypark': {
    mission: '03', note: 'Battery Park in mission 3 (the chain\'s leg3, Jock\'s helicopter): Filben, then the chain\'s Teleporter2 to the station',
    base: { from: { chain: '02', slot: 'Save0102', index: 102 }, prefix: [span('03', 'start', { op: 'snap', label: 'd5-batterypark' }, { before: true })] },
    body: ['snap:d5-batterypark', 'filben', span('03', { op: 'place', at: [-4015, 3265, -598] }, { op: 'travel', to: '03_NYC_BrooklynBridgeStation', label: 'leg4' }),
      ...CHEATS, { op: 'wait', seconds: 3 }, { op: 'snap', label: 'r-station' }],
    blocks: {
      // the commander alive on the line: Choices jumps to CheapChoices; "I'm not interested" (ChoiceSpeechLabel_3 -> sorry) changes no credits
      filben: [...talk({ owner: 'HarleyFilben0', conv: 'M03MeetFilben', frob: true, choose: [{ index: 1, label: 'sorry' }] }), { op: 'snap', label: 'r-filben' }],
    },
  },
  '03-747': {
    mission: '03', note: 'the 747 in mission 3 (the chain\'s leg9): MeetLebedev and AnnaEntrance as the chain plays them, then the walk back to the hangar',
    base: { from: { chain: '02', slot: 'Save0102', index: 102 }, prefix: [span('03', 'start', { op: 'snap', label: 'd9-747' }, { before: true })] },
    body: [span('03', { op: 'snap', label: 'd9-747' }, { op: 'travel', to: '03_NYC_Hangar', label: 'leg10' }), ...CHEATS, { op: 'wait', seconds: 3 }, { op: 'snap', label: 'r-hangar' }],
    blocks: {},
  },
  '04-island-hq': {
    mission: '04', note: 'mission 4\'s arrival on the island (the chain\'s start): Lloyd\'s barks, DL_SeeManderley, the HQ: Shannon, ManderleyDebriefing03, Teleporter3 back',
    base: { from: { chain: '03', slot: 'Save0103', index: 103 }, prefix: [] },
    body: ['snap:e1-loaded', 'lloyd', span('04', { op: 'place', at: [-4688, 2712, -10] }, { op: 'snap', label: 'e2-hq' }), 'shannon',
      span('04', { op: 'place', at: [369, -177, 289] }, { op: 'travel', to: '04_NYC_UNATCOIsland', label: 'leg2' }), ...CHEATS, { op: 'wait', seconds: 3 }, { op: 'snap', label: 'r-island' }],
    blocks: {
      // M04LloydBarks: PrivateLloyd is UNATCOTroop13 (Sitting); radius 350, first person
      lloyd: [...talk({ owner: 'UNATCOTroop13', conv: 'M04LloydBarks', distance: 120, firstPerson: true, timeout: 120 }), { op: 'snap', label: 'r-lloyd' }],
      shannon: [...talk({ owner: 'Female0', conv: 'M04ShannonBarks', frob: true, firstPerson: true, timeout: 120 }), { op: 'snap', label: 'r-shannon' }],
    },
  },
  '04-street-bar': {
    mission: '04', note: 'the Street of mission 4 (the chain\'s leg3): the bar\'s front door (Teleporter3), Joe Greene and Filben, the bar\'s Teleporter2 back',
    base: { from: { chain: '03', slot: 'Save0103', index: 103 }, prefix: [span('04', 'start', { op: 'snap', label: 'e4-street' }, { before: true })] },
    body: ['snap:e4-street',
      { op: 'place', at: [-703, -675, -417], view: [0, 0], harness: true, turnFirst: true, note: '200 units west of Teleporter3 (-503,-675,-457, radius 60; the bar\'s front door), facing it: the walk enters it (mission 8\'s chain, the same street)' },
      { op: 'walk', untilTravel: true, seconds: 2 }, ...arrive('04_NYC_Bar', 'bar'), 'joe', 'filben',
      { op: 'place', at: [731, 850, 92], view: [0, 0], harness: true, turnFirst: true, note: '200 units west of Teleporter2 (930,849,37; to the Street), facing it: the walk enters it (mission 8\'s chain)' },
      { op: 'walk', untilTravel: true, seconds: 2 }, ...arrive('04_NYC_Street', 'street'), { op: 'snap', label: 'r-street' }],
    blocks: {
      joe: [...talk({ owner: 'JoeGreene0', conv: 'M04MeetJoeGreen', distance: 70 }), { op: 'snap', label: 'r-joe' }],
      filben: [...talk({ owner: 'HarleyFilben0', conv: 'M04MeetFilben', distance: 70, firstPerson: true, timeout: 120 }), { op: 'snap', label: 'r-filben' }],
    },
  },
  '04-street-gunther': {
    mission: '05', note: 'mission 4\'s Street after the raid (the chain\'s leg9): the subway, GuntherShowdown\'s Surrender and the exit; Paul in the MJ12 lab',
    base: { from: { chain: '03', slot: 'Save0103', index: 103 }, prefix: [span('04', 'start', { op: 'place', at: [1861, -686, -1128] }, { before: true })] },
    body: [span('04', { op: 'place', at: [1861, -686, -1128] }, { op: 'wait', seconds: 15 }), pawnState('lab-paul', 'PaulDenton0'), { op: 'snap', label: 'e11-lab' }],
    blocks: {},
  },
  '06-tongbase': {
    mission: '06', note: 'mission 6 from its arrival to Tong\'s base (the chain\'s leg2): Alex in the base, M06MeetAlexJacobson, the base\'s Teleporter0 to the market',
    base: { from: { chain: '05', slot: 'Save0105', index: 105 }, prefix: [] },
    body: [span('06', { op: 'snap', label: 'g1-loaded' }, { op: 'snap', label: 'g5-tongbase' }), pawnState('tongbase-alex', 'AlexJacobson0'), 'alex',
      span('06', { op: 'place', at: [1241, -886, 386] }, { op: 'travel', to: '06_HongKong_WanChai_Market', label: 'leg3' }), ...CHEATS, { op: 'wait', seconds: 3 }, { op: 'snap', label: 'r-market' }],
    blocks: { alex: [...talk({ owner: 'AlexJacobson0', conv: 'M06MeetAlexJacobson', frob: true }), { op: 'snap', label: 'r-alex' }] },
  },
  '08-bar': {
    mission: '08', note: 'mission 8\'s arrival through the bar (the chain\'s leg1 and leg2): Sandra in the bar',
    base: { from: { chain: '06', slot: 'Save0106', index: 106 }, prefix: [] },
    body: [span('08', { op: 'snap', label: 'h1-loaded' }, { op: 'travel', to: '08_NYC_Bar', label: 'leg1' }), ...CHEATS, { op: 'wait', seconds: 3 }, pawnState('bar-sandra', 'SandraRenton0'),
      span('08', { op: 'place', at: [-1679, 340, 49] }, { op: 'travel', to: '08_NYC_Street', label: 'leg2' }), ...CHEATS, { op: 'wait', seconds: 3 }, { op: 'snap', label: 'r-street' }],
    blocks: {},
  },
  '08-smug': {
    mission: '08', note: 'mission 8\'s smuggler (the chain\'s leg3 and leg4, after Stanton Dowd): Ford Schick in the lair',
    base: { from: { chain: '06', slot: 'Save0106', index: 106 }, prefix: [span('08', 'start', { op: 'snap', label: 'h3-stanton' })] },
    body: [span('08', { op: 'place', at: [3171, -872, -1309] }, { op: 'travel', to: '08_NYC_Smug', label: 'leg3' }), ...CHEATS, { op: 'wait', seconds: 3 }, pawnState('smug-ford', 'FordSchick0'),
      span('08', { op: 'place', at: [-890, 1493, -47] }, { op: 'travel', to: '08_NYC_Street', label: 'leg4' }), ...CHEATS, { op: 'wait', seconds: 3 }, { op: 'snap', label: 'r-street' }],
    blocks: {},
  },
  '09-dockyard': {
    mission: '09', note: 'mission 9\'s arrival in the dockyard: DL_Insertion, the front guard, DL_BadNews\'s DataLinkTrigger4, Teleporter6 into the ship',
    base: { from: { chain: '08', slot: 'Save0108', index: 108 }, prefix: [] },
    body: [span('09', { op: 'snap', label: 'f1-loaded' }, { op: 'snap', label: 'f2-insertion' }), 'guard', 'badnews',
      span('09', { op: 'place', at: [4480, 6743, 280] }, { op: 'snap', label: 'f3-ship' })],
    blocks: {
      // the front guards are Soldier0 and Soldier1 (BindName FrontGuard, Patrolling): placed by the first where he is
      guard: [...talk({ owner: 'Soldier0', conv: 'MeetFrontGuard', distance: 100 }), { op: 'snap', label: 'r-guard' }],
      badnews: [...datalink({ trigger: 'DataLinkTrigger4', at: [3989, 3287, 88], conv: 'DL_BadNews' }), { op: 'snap', label: 'r-badnews' }],
    },
  },
  '10-metro': {
    mission: '10', note: 'mission 10 to the metro (the chain\'s leg2): Jaime at the cafe, DL_metrosewer, Teleporter7 to the club',
    base: { from: { chain: '09', slot: 'Save0109', index: 109 }, prefix: [] },
    body: [span('10', { op: 'snap', label: 'g1-loaded' }, { op: 'snap', label: 'g3-metro' }), pawnState('metro-jaime', 'JaimeReyes1'), 'jaime', 'metrosewer',
      span('10', { op: 'place', at: [1195, 950, 259] }, { op: 'snap', label: 'g4-club' })],
    blocks: {
      jaime: [...talk({ owner: 'JaimeReyes1', conv: 'M10MeetJaime', frob: true }), { op: 'snap', label: 'r-jaime' }],
      metrosewer: [...datalink({ trigger: 'DataLinkTrigger0', at: [1705, -4236, -248], conv: 'DL_metrosewer' }), { op: 'snap', label: 'r-metrosewer' }],
    },
  },
  '11-cathedral': {
    mission: '11', note: 'mission 11\'s arrival in the cathedral: M11MeetGunther (radius 280, which the chain stays out of), then the chain to the metro (leg1)',
    base: { from: { chain: '10', slot: 'Save0110', index: 110 }, prefix: [] },
    body: ['snap:h1-loaded', 'gunther', span('11', { op: 'place', at: [3672, -1233, -303] }, { op: 'snap', label: 'h4-underground' })],
    blocks: { gunther: [...talk({ owner: 'GuntherHermann0', conv: 'M11MeetGunther', distance: 150 }), { op: 'wait', seconds: 5 }, { op: 'snap', label: 'r-gunther' }] },
  },
  '12-cmd': {
    mission: '12', note: 'mission 12\'s return to the command centre (the chain\'s leg2): TongSick as the chain plays it, the gas station (leg3): Sandra',
    base: { from: { chain: '11', slot: 'Save0111', index: 111 }, prefix: [span('12', 'start', { op: 'snap', label: 'm12-9-cmd-again' }, { before: true })] },
    body: [span('12', { op: 'snap', label: 'm12-9-cmd-again' }, { op: 'travel', to: '12_Vandenberg_gas', label: 'leg3' }), ...CHEATS, { op: 'wait', seconds: 3 },
      pawnState('gas-sandra', 'SandraRenton0'), { op: 'snap', label: 'm12-10-gas' }],
    blocks: {},
  },
  '14-lab': {
    mission: '14', note: 'mission 14\'s return to the Ocean Lab (the chain\'s leg3): Walton enters (Mission14.Timer), DL_Simons2, WaltonShowdown, Teleporter2 to the UC',
    base: { from: { chain: '12', slot: 'Save0112', index: 112 }, prefix: [span('14', 'start', { op: 'snap', label: 'm14-7-lab-again' }, { before: true })] },
    body: [{ op: 'wait', flag: 'MS_UnhideSub', timeout: 30 }, 'snap:m14-7-lab-again', 'simons', 'walton',
      span('14', { op: 'place', at: [908, 3792, -4126] }, { op: 'travel', to: '14_OceanLab_UC', label: 'leg2' }), ...CHEATS, { op: 'wait', seconds: 3 }, { op: 'snap', label: 'r-uc' }],
    blocks: {
      simons: [...datalink({ trigger: 'DataLinkTrigger6', at: [3291, 3528, -2207], conv: 'DL_Simons2' }), { op: 'snap', label: 'r-simons' }],
      walton: [...talk({ owner: 'WaltonSimons0', conv: 'WaltonShowdown', distance: 200 }), { op: 'snap', label: 'r-walton' }],
    },
  },
  '14-silo': {
    mission: '14', note: 'the silo after Howard Strong (the chain\'s m14-11-howard): JockArea51 as the chain plays it, the exit to Area 51',
    base: { from: { chain: '12', slot: 'Save0112', index: 112 }, prefix: [span('14', 'start', { op: 'snap', label: 'm14-11-howard' }, { before: true })] },
    body: [span('14', { op: 'snap', label: 'm14-11-howard' }, { op: 'snap', label: 'm14-12-area51' })],
    blocks: {},
  },
  '15-entrance': {
    mission: '15', note: 'Area 51\'s entrance (the chain\'s leg1): FlagTrigger11 (EverettAppears), Mission15.Timer brings Everett in, M15MeetEverett, Teleporter0 to the Final',
    base: { from: { chain: '14', slot: 'Save0114', index: 114 }, prefix: [span('15', 'start', { op: 'snap', label: 'm15-2-entrance' }, { before: true })] },
    body: ['snap:m15-2-entrance', 'everett', span('15', { op: 'place', at: [-2101, -56, -1934] }, { op: 'snap', label: 'm15-3-final' })],
    blocks: {
      everett: [
        { op: 'place', at: [1452, -1546, -94], view: [0, 0], drop: true, harness: true, note: 'above FlagTrigger11 (1452,-1546,-184; EverettAppears)' },
        { op: 'wait', flag: 'MS_EverettAppeared', timeout: 30 },
        ...talk({ owner: 'MorganEverett0', conv: 'M15MeetEverett', distance: 150 }), { op: 'snap', label: 'r-everett' }],
    },
  },
};

// ---- the units ----------------------------------------------------------------------------------------------------------------------------------------------
/** set: [name, value, expiration] written as the setter writes them (a conversation's SetFlag: expiration 0, ConPlayBase.SetFlag; a script's SetBool: its
 * fourth argument), with the flags the same setter branch sets beside the census's flag; clear: flags deleted (the side "absent"). readers: the family's
 * blocks this unit runs (all by default; a pawn a flag keeps out of the world has no conversation to run). */
export const UNITS = [
  // mission 2 reads mission 1's M01PlayerAggressive (Mission01.Timer:91, expiration 6)
  { id: 'c02-street-line', family: '02-street', flag: null, side: 'line' },
  { id: 'c02-M01PlayerAggressive-1', family: '02-street', flag: 'M01PlayerAggressive', side: '1', set: [['M01PlayerAggressive', true, 6]] },
  // mission 3, UNATCO HQ: ManderleyDebriefing02 (on the chain), M03ShannonBarks, CarterGreeting03
  { id: 'c03-hq-line', family: '03-hq', flag: null, side: 'line' },
  { id: 'c03-AmbrosiaTagged-1', family: '03-hq', flag: 'AmbrosiaTagged', side: '1', set: [['AmbrosiaTagged', true, 0]] },
  { id: 'c03-EscapeSuccessful-absent', family: '03-hq', flag: 'EscapeSuccessful', side: 'absent', clear: ['EscapeSuccessful'] },
  { id: 'c03-HeardGrenadeTalk-1', family: '03-hq', flag: 'HeardGrenadeTalk', side: '1', set: [['HeardGrenadeTalk', true, 0]] },
  { id: 'c03-KnowsOfJoJo-1', family: '03-hq', flag: 'KnowsOfJoJo', side: '1', set: [['KnowsOfJoJo', true, 0]] },
  { id: 'c03-M02QuestionedGreen-1', family: '03-hq', flag: 'M02QuestionedGreen', side: '1',
    set: [['PlayerKnowsJoeGreen', true, 0], ['MeetJoeGreen_Played', true, 0], ['M02QuestionedGreen', true, 0]] },
  { id: 'c03-M02ViolenceInBar-1', family: '03-hq', flag: 'M02ViolenceInBar', side: '1', set: [['M02ViolenceInBar', true, 4]] },
  { id: 'c03-SubTerroristsDead-1', family: '03-hq', flag: 'SubTerroristsDead', side: '1', set: [['SubTerroristsDead', true, 6]] },
  { id: 'c03-TenderloinSlaughter-1', family: '03-hq', flag: 'TenderloinSlaughter', side: '1', set: [['TenderloinSlaughter', true, 6]] },
  { id: 'c03-BatteryParkSlaughter-1', family: '03-hq', flag: 'BatteryParkSlaughter', side: '1', set: [['BatteryParkSlaughter', true, 6]] },
  { id: 'c03-BathroomBarks_Played-1', family: '03-hq', flag: 'BathroomBarks_Played', side: '1', set: [['BathroomBarks_Played', true, 0]] },
  // mission 3, Battery Park: M03MeetFilben
  { id: 'c03-batterypark-line', family: '03-batterypark', flag: null, side: 'line' },
  { id: 'c03-M01PlayerMetFilben-1', family: '03-batterypark', flag: 'M01PlayerMetFilben', side: '1', setter: 'MeetFilbenAfterStatue',
    set: [['M01PlayerMetFilben', true, 0], ['PlayerMetFilben', true, 0]] },
  { id: 'c03-FilbenGaveKey-1', family: '03-batterypark', flag: 'FilbenGaveKey', side: '1', setter: 'MeetFilben@GetKeyB',
    set: [['M01PlayerMetFilben', true, 0], ['PlayerMetFilben', true, 0], ['FilbenGaveKey', true, 0]] },
  // mission 3, the 747: AnnaEntrance (on the chain)
  { id: 'c03-M02MechSlur-1', family: '03-747', flag: 'M02MechSlur', side: '1', setter: 'AnnaThanks@Cocky', set: [['M02MechSlur', true, 0]] },
  // mission 4, the island and the HQ: M04LloydBarks, DL_SeeManderley and ManderleyDebriefing03 (on the chain), M04ShannonBarks
  { id: 'c04-island-hq-line', family: '04-island-hq', flag: null, side: 'line' },
  { id: 'c04-PlayerKilledLebedev-1', family: '04-island-hq', flag: 'PlayerKilledLebedev', side: '1', setter: 'Mission03.Timer:309 (his carcass, killer JCDenton)',
    set: [['JuanLebedev_Dead', true, 0], ['PlayerKilledLebedev', true, 6]] },
  { id: 'c04-AnnaKilledLebedev-1', family: '04-island-hq', flag: 'AnnaKilledLebedev', side: '1', setter: 'Mission03.Timer:312 (his carcass, killer AnnaNavarre)',
    set: [['JuanLebedev_Dead', true, 0], ['AnnaKilledLebedev', true, 6]] },
  { id: 'c04-M03PlayerKilledAnna-1', family: '04-island-hq', flag: 'M03PlayerKilledAnna', side: '1', setter: 'DL_AlexShocked (after AnnaNavarre_Dead, ScriptedPawn.Died)',
    set: [['AnnaNavarre_Dead', true, 0], ['M03PlayerKilledAnna', true, 0]] },
  { id: 'c04-BathroomBarks_Played-1', family: '04-island-hq', flag: 'BathroomBarks_Played', side: '1', set: [['BathroomBarks_Played', true, 0]] },
  // mission 4, the bar: M04MeetJoeGreen, M04MeetFilben
  { id: 'c04-bar-line', family: '04-street-bar', flag: null, side: 'line' },
  { id: 'c04-MeetJoeGreen_Played-1', family: '04-street-bar', flag: 'MeetJoeGreen_Played', side: '1', setter: 'MeetJoeGreen (main)',
    set: [['PlayerKnowsJoeGreen', true, 0], ['MeetJoeGreen_Played', true, 0]] },
  { id: 'c04-M02QuestionedGreen-1', family: '04-street-bar', flag: 'M02QuestionedGreen', side: '1', setter: 'MeetJoeGreen2@GreenQuestioned (needs MeetJoeGreen_Played)',
    set: [['PlayerKnowsJoeGreen', true, 0], ['MeetJoeGreen_Played', true, 0], ['M02QuestionedGreen', true, 0]] },
  { id: 'c04-PlayerMetFilben-1', family: '04-street-bar', flag: 'PlayerMetFilben', side: '1', setter: 'mission 1: MeetFilbenAfterStatue',
    set: [['M01PlayerMetFilben', true, 0], ['PlayerMetFilben', true, 0]] },
  { id: 'c04-PlayerMetFilben-1-m03', family: '04-street-bar', flag: 'PlayerMetFilben', side: '1', setter: 'mission 3: M03MeetFilben@FirstMeeting',
    set: [['KnowsAboutUnderworld', true, 0], ['PlayerMetFilben', true, 0]] },
  // mission 5 reads mission 4's PlayerBailedOutWindow (04_NYC_Hotel/FlagTrigger9, expiration 6) at the lab's FirstFrame
  { id: 'c05-lab-line', family: '04-street-gunther', flag: null, side: 'line' },
  { id: 'c05-PlayerBailedOutWindow-1', family: '04-street-gunther', flag: 'PlayerBailedOutWindow', side: '1', set: [['PlayerBailedOutWindow', true, 6]] },
  // mission 6 reads mission 5's JacobsonRecruited (Mission06.FirstFrame:86) and JaimeRecruited (M06MeetAlexJacobson)
  { id: 'c06-tongbase-line', family: '06-tongbase', flag: null, side: 'line' },
  { id: 'c06-JacobsonRecruited-absent', family: '06-tongbase', flag: 'JacobsonRecruited', side: 'absent', clear: ['JacobsonRecruited'], readers: [] },
  { id: 'c06-JaimeRecruited-1', family: '06-tongbase', flag: 'JaimeRecruited', side: '1', setter: 'M05MeetJaime@Recruit', set: [['JaimeRecruited', true, 0]] },
  // mission 8 reads SandraWentToCalifornia (mission 4) and FordSchickRescued (mission 2) at its FirstFrame
  { id: 'c08-bar-line', family: '08-bar', flag: null, side: 'line' },
  { id: 'c08-SandraWentToCalifornia-1', family: '08-bar', flag: 'SandraWentToCalifornia', side: '1', setter: 'SandraAttackedByJoJoThanks (main)',
    set: [['PlayerKnowsSandraRenton', true, 0], ['SandraWentToCalifornia', true, 0]] },
  { id: 'c08-smug-line', family: '08-smug', flag: null, side: 'line' },
  { id: 'c08-FordSchickRescued-1', family: '08-smug', flag: 'FordSchickRescued', side: '1', setter: 'Mission02.PreTravel:122 (unreachable in the data: MS_FordFollowing is set nowhere)',
    set: [['FordSchickRescued', true, 9]] },
  // mission 9 reads mission 8's HelpSailor (MeetFrontGuard) and M08WarnedSmuggler (DL_BadNews)
  { id: 'c09-dockyard-line', family: '09-dockyard', flag: null, side: 'line' },
  { id: 'c09-HelpSailor-1', family: '09-dockyard', flag: 'HelpSailor', side: '1', setter: 'M08MeetSailor@GetPass', set: [['HelpSailor', true, 0]] },
  { id: 'c09-M08WarnedSmuggler-1', family: '09-dockyard', flag: 'M08WarnedSmuggler', side: '1', setter: 'M08SmugglerConvos@GiveWarning',
    set: [['M08WarnSmugglerQuestion', true, 0], ['M08WarnedSmuggler', true, 0]] },
  // mission 10 reads mission 5's JaimeRecruited (Mission10.FirstFrame:31, DL_metrosewer) and KnowsAboutKillphrase (M10MeetJaime)
  { id: 'c10-metro-line', family: '10-metro', flag: null, side: 'line' },
  { id: 'c10-JaimeRecruited-1', family: '10-metro', flag: 'JaimeRecruited', side: '1', setter: 'M05MeetJaime@Recruit', set: [['JaimeRecruited', true, 0]], readers: ['metrosewer'] },
  { id: 'c10-KnowsAboutKillphrase-1', family: '10-metro', flag: 'KnowsAboutKillphrase', side: '1', setter: 'PaulInMedLab@Killphrase', set: [['KnowsAboutKillphrase', true, 0]] },
  // mission 11 reads GuntherFreed and GuntherRespectsPlayer (mission 1) and KnowsGuntherKillphrase (mission 10) in M11MeetGunther
  { id: 'c11-cathedral-line', family: '11-cathedral', flag: null, side: 'line' },
  { id: 'c11-GuntherFreed-1', family: '11-cathedral', flag: 'GuntherFreed', side: '1', setter: '01_NYC_UNATCOIsland/FlagTrigger2 (no GuntherRescued after it)',
    set: [['GuntherFreed', true, 12]] },
  { id: 'c11-GuntherRespectsPlayer-1', family: '11-cathedral', flag: 'GuntherRespectsPlayer', side: '1', setter: 'GuntherRescued@GiveSpeech (needs GuntherFreed)',
    set: [['GuntherFreed', true, 12], ['GuntherRespectsPlayer', true, 0]] },
  { id: 'c11-KnowsGuntherKillphrase-1', family: '11-cathedral', flag: 'KnowsGuntherKillphrase', side: '1', setter: 'M10MeetJaime@Continue (its Knows branch: KnowsAboutKillphrase)',
    set: [['KnowsAboutKillphrase', true, 0], ['KnowsGuntherKillphrase', true, 0]], choose: { gunther: [{ index: 0, label: 'Kill' }] } },
  // mission 12 reads EverettMechanicComment (mission 11; TongSick, on the chain) and SandraWentToCalifornia (mission 4; Mission12.FirstFrame:37)
  { id: 'c12-cmd-line', family: '12-cmd', flag: null, side: 'line' },
  { id: 'c12-EverettMechanicComment-1', family: '12-cmd', flag: 'EverettMechanicComment', side: '1', setter: 'MeetEverett2@RayComment',
    set: [['NeedRayComment', false, 0], ['EverettMechanicComment', true, 0]] },
  { id: 'c12-SandraWentToCalifornia-1', family: '12-cmd', flag: 'SandraWentToCalifornia', side: '1', setter: 'SandraAttackedByJoJoThanks (main)',
    set: [['PlayerKnowsSandraRenton', true, 0], ['SandraWentToCalifornia', true, 0]] },
  // mission 14 reads SimonsAssassination (mission 3; DL_Simons2), M04MetWalton and M11MetWalton (WaltonShowdown), EverettMechanicComment (JockArea51, on the chain)
  { id: 'c14-lab-line', family: '14-lab', flag: null, side: 'line' },
  { id: 'c14-SimonsAssassination-1', family: '14-lab', flag: 'SimonsAssassination', side: '1', setter: 'SimonsBarks@A4', set: [['SimonsAssassination', true, 0]] },
  { id: 'c14-M04MetWalton-1', family: '14-lab', flag: 'M04MetWalton', side: '1', setter: 'M04MeetWalton (main)', set: [['M04MetWalton', true, 0]] },
  { id: 'c14-M11MetWalton-1', family: '14-lab', flag: 'M11MetWalton', side: '1', setter: 'M11WaltonHolo (main; needs GuntherHermann_Dead)',
    set: [['GuntherHermann_Dead', true, 0], ['M11MetWalton', true, 0]] },
  { id: 'c14-EverettMechanicComment-1', family: '14-silo', flag: 'EverettMechanicComment', side: '1', setter: 'MeetEverett2@RayComment',
    set: [['NeedRayComment', false, 0], ['EverettMechanicComment', true, 0]] },
  // mission 15 reads EverettMechanicComment (M15MeetEverett)
  { id: 'c15-entrance-line', family: '15-entrance', flag: null, side: 'line' },
  { id: 'c15-EverettMechanicComment-1', family: '15-entrance', flag: 'EverettMechanicComment', side: '1', setter: 'MeetEverett2@RayComment',
    set: [['NeedRayComment', false, 0], ['EverettMechanicComment', true, 0]] },
];
UNITS.forEach((unit, i) => { unit.index = FIRST_INDEX + i; unit.slot = slotName(unit.index); });
const unitById = new Map(UNITS.map(u => [u.id, u]));

// ---- the carried flags --------------------------------------------------------------------------------------------------------------------------------------
/** Per carried flag (the inventory's table): its setters (branch: value, expiration), the line's side at the reader, and per reading mission the reader run (the
 * unit) or why none, with the readers not run. "line" sides were read from the chains' captures (missions 1 to 4) and the chains' own conversation choices. */
export const FLAGS = [
  { flag: 'BathroomBarks_Played', row: '01', setters: 'BathroomBarks SetFlag (1, never)', line: 'absent (BathroomBarks not on the chain)',
    reads: [{ m: '03', reader: 'M03ShannonBarks (? BathroomBarks_Played -> Fresh)', units: ['c03-BathroomBarks_Played-1', 'c03-hq-line'] },
      { m: '04', reader: 'M04ShannonBarks (? BathroomBarks_Played -> StillPissed)', units: ['c04-BathroomBarks_Played-1', 'c04-island-hq-line'] }] },
  { flag: 'FilbenGaveKey', row: '01', setters: 'MeetFilben@GetKeyB (1, never), @NoKeyB (0, never)', line: 'absent (MeetFilben not on the chain; absent reads as false: XFlagBase::GetBool)',
    reads: [{ m: '03', reader: 'M03MeetFilben (NotAggressive: ? !FilbenGaveKey -> NoKey1; only after a first meeting)', units: ['c03-FilbenGaveKey-1', 'c03-batterypark-line'],
      notRun: 'FilbenAngryBarks (needs TerroristCommander_Dead; the line\'s commander lives)' }] },
  { flag: 'GuntherFreed', row: '01', setters: '01_NYC_UNATCOIsland/FlagTrigger2 (1, mission 12)', line: 'absent',
    reads: [{ m: '11', reader: 'M11MeetGunther (? !GuntherFreed -> NotRescued; ? GuntherFreed & !GuntherRespectsPlayer -> PlayerRefusedToArmGunther)', units: ['c11-GuntherFreed-1', 'c11-cathedral-line'] }] },
  { flag: 'GuntherRespectsPlayer', row: '01', setters: 'GuntherRescued@GiveSpeech (1), @GiveNothingNicely (1), @GiveNothing (0), all never; GuntherRescued needs GuntherFreed', line: 'absent',
    reads: [{ m: '02', reader: null, notRun: 'GuntherHermann_BarkFutz only: an AI bark (<Owner>_Bark*: the bark manager starts it, no ConHistory)' },
      { m: '03', reader: null, notRun: 'GuntherHermann_BarkFutz (an AI bark); TroopBarks2 requires NeverTrue (set nowhere)' },
      { m: '11', reader: 'M11MeetGunther', units: ['c11-GuntherRespectsPlayer-1', 'c11-cathedral-line'] }] },
  { flag: 'M01PlayerAggressive', row: '01', setters: 'Mission01.Timer:91 (1, mission 6)', line: 'absent',
    reads: [{ m: '02', reader: 'PaulLeaving (needs PaulGaveGrenades: PaulBarricade first; A1: ? M01PlayerAggressive -> aggressive)', units: ['c02-M01PlayerAggressive-1', 'c02-street-line'] },
      { m: '03', reader: null, notRun: 'TroopBarks1 and TroopBarks2 require NeverTrue (set nowhere): no reader can start' }] },
  { flag: 'M01PlayerMetFilben', row: '01', setters: 'MeetFilbenAfterStatue, MeetFilben (main) (1, never; both set PlayerMetFilben too)', line: 'absent',
    reads: [{ m: '03', reader: 'M03MeetFilben (? !M01PlayerMetFilben & !PlayerMetFilben -> FirstMeeting)', units: ['c03-M01PlayerMetFilben-1', 'c03-batterypark-line'] }] },
  { flag: 'PlayerMetFilben', row: '01', setters: 'MeetFilbenAfterStatue, MeetFilben (main) (1, never)', line: 'absent',
    reads: [{ m: '04', reader: 'M04MeetFilben (A1: ? PlayerMetFilben -> KnowsFilben)', units: ['c04-PlayerMetFilben-1', 'c04-bar-line'] }] },
  { flag: 'AmbrosiaTagged', row: '02', setters: 'DL_AmbrosiaFound (1, never); 02_NYC_BatteryPark/FlagTrigger1 (1, mission 6)', line: 'absent',
    reads: [{ m: '03', reader: 'ManderleyDebriefing02 (? !AmbrosiaTagged -> NotTagged, NotTagged2)', units: ['c03-AmbrosiaTagged-1'], notRun: 'CarterGreeting03, AnnaManderley1, AnnaAtUNATCO (one reader per mission)' }] },
  { flag: 'BatteryParkSlaughter', row: '02', setters: 'Mission02.Timer:178 (1, mission 6)', line: 'absent',
    reads: [{ m: '03', reader: 'CarterGreeting03 (? BatteryParkSlaughter -> Slaughter)', units: ['c03-BatteryParkSlaughter-1', 'c03-hq-line'],
      notRun: 'CarterBarks (needs M03CarterDone), AnnaManderley1/2 (Anna\'s radius after the debriefing; not on the line), TroopBarks1/2 (NeverTrue)' }] },
  { flag: 'EscapeSuccessful', row: '02', setters: '02_NYC_BatteryPark/FlagTrigger7, FlagTrigger8 (1, mission 7)', line: '1, expiration 7 (the chain\'s subway)',
    reads: [{ m: '03', reader: 'ManderleyDebriefing02 (? EscapeSuccessful & hostages alive -> Rescue)', units: ['c03-EscapeSuccessful-absent'], notRun: 'AnnaAtUNATCO (one reader per mission)' }] },
  { flag: 'FordSchickRescued', row: '02', setters: 'Mission02.PreTravel:122 (1, mission 9; needs MS_FordFollowing, which nothing sets: the side 1 is not reachable from the data)', line: 'absent (the only side the data can give)',
    reads: [{ m: '03', reader: null, notRun: 'SmugglerThanks, MeetSmuggler, SckickThanks, FordBarks: their owners (the Smuggler, Ford) are in no map of mission 3' },
      { m: '04', reader: null, notRun: 'M04MeetSmuggler (04_NYC_Smug, off the chain, 14 choices): the side 1 cannot be set by the data' },
      { m: '08', reader: 'Mission08.FirstFrame:28 (08_NYC_Smug: Ford enters the world)', units: ['c08-FordSchickRescued-1', 'c08-smug-line'] }] },
  { flag: 'FordSchickRescueDone', row: '02', setters: 'Mission02.Timer:439 (1, mission 9)', line: 'absent',
    reads: [{ m: '03', reader: null, notRun: 'SmugglerWaiting and SmugglerThanks (the only readers) belong to the Smuggler, in no map of mission 3' }] },
  { flag: 'HeardGrenadeTalk', row: '02', setters: 'UNATCOGrenade1Meet (main) (1, never)', line: 'absent',
    reads: [{ m: '03', reader: 'ManderleyDebriefing02 (resume2: ? HeardGrenadeTalk -> Grenades)', units: ['c03-HeardGrenadeTalk-1'] }] },
  { flag: 'KnowsOfJoJo', row: '02', setters: 'CounselWorker@Curious, MeetSandraRenton@CResume (1, never)', line: 'absent',
    reads: [{ m: '03', reader: 'ManderleyDebriefing02 (ReturnFromInterrupted: ? KnowsOfJoJo -> KnowsJoJo)', units: ['c03-KnowsOfJoJo-1'] }] },
  { flag: 'M02MechSlur', row: '02', setters: 'AnnaThanks@Cocky (1), @TeamPlayer (0), never', line: 'absent',
    reads: [{ m: '03', reader: 'AnnaEntrance (on the chain; its ? M02MechSlur follows ? !AnnaThanks_Played -> NoComment2, and AnnaThanks_Played has the default expiration 3: deleted at mission 3\'s entry, so the branch is unreachable)', units: ['c03-M02MechSlur-1'],
      notRun: 'AnnaAtUNATCO (the same gate), TroopBarks2 (NeverTrue)' }] },
  { flag: 'M02QuestionedGreen', row: '02', setters: 'MeetJoeGreen2@GreenQuestioned (1, never; needs MeetJoeGreen_Played)', line: 'absent',
    reads: [{ m: '03', reader: 'ManderleyDebriefing02 (bye: ? M02QuestionedGreen -> TalkedToPress)', units: ['c03-M02QuestionedGreen-1'] },
      { m: '04', reader: 'M04MeetJoeGreen (DeadContinue: ? M02QuestionedGreen -> GotChewedOut; after ? !MeetJoeGreen_Played -> FirstMeeting)', units: ['c04-M02QuestionedGreen-1', 'c04-bar-line'] }] },
  { flag: 'M02ViolenceInBar', row: '02', setters: 'Mission02.Timer:416 (1, mission 4)', line: 'absent',
    reads: [{ m: '03', reader: 'ManderleyDebriefing02 (bye, TalkedToPress: ? M02ViolenceInBar -> Violence)', units: ['c03-M02ViolenceInBar-1'] }] },
  { flag: 'MeetJoeGreen_Played', row: '02', setters: 'MeetJoeGreen (main) SetFlag (1, never; the _Played flag exists before ConPlayBase.SetPlayedFlag)', line: 'absent',
    reads: [{ m: '04', reader: 'M04MeetJoeGreen (? !MeetJoeGreen_Played -> FirstMeeting)', units: ['c04-MeetJoeGreen_Played-1', 'c04-bar-line'] }] },
  { flag: 'SubTerroristsDead', row: '02', setters: 'Mission02.Timer:196 (1, mission 6)', line: 'absent',
    reads: [{ m: '03', reader: 'ManderleyDebriefing02 (? SubTerroristsDead & hostages alive -> Rescue)', units: ['c03-SubTerroristsDead-1'], notRun: 'AnnaAtUNATCO (one reader per mission)' }] },
  { flag: 'TenderloinSlaughter', row: '02', setters: 'Mission02.Timer:285 (1, mission 6)', line: 'absent',
    reads: [{ m: '03', reader: 'ManderleyDebriefing02 (resume2: ? TenderloinSlaughter -> Slaughter)', units: ['c03-TenderloinSlaughter-1'],
      notRun: 'CarterGreeting03, PrivateLloydBark (one reader per mission), TroopBarks1/2 (NeverTrue)' }] },
  { flag: 'AnnaKilledLebedev', row: '03', setters: 'Mission03.Timer:312 (1, mission 6; Lebedev\'s carcass killed by Anna: JuanLebedev_Dead by ScriptedPawn.Died)', line: 'absent (Lebedev lives on the chain)',
    reads: [{ m: '04', reader: 'M04LloydBarks (A1: ? AnnaKilledLebedev -> Dead)', units: ['c04-AnnaKilledLebedev-1', 'c04-island-hq-line'] }] },
  { flag: 'M03PlayerKilledAnna', row: '03', setters: 'DL_AlexShocked (1, never; started once AnnaNavarre_Dead)', line: 'absent',
    reads: [{ m: '04', reader: 'ManderleyDebriefing03 (on the chain; ? M03PlayerKilledAnna -> KilledAnna)', units: ['c04-M03PlayerKilledAnna-1'], notRun: 'GuntherShowdown (AnnaDead2 on Surrender), CokeTroopBarks (one reader per mission)' }] },
  { flag: 'PlayerKilledLebedev', row: '03', setters: 'Mission03.Timer:309, :322 (1, mission 6)', line: 'absent',
    reads: [{ m: '04', reader: 'DL_SeeManderley and ManderleyDebriefing03 (both on the chain, in one unit)', units: ['c04-PlayerKilledLebedev-1'],
      notRun: 'M04TroopBarks, M04ScottBarks, M04MeetCarter, M04LloydBarks (run by the unit, line state), M04MeetJaime2, CokeTroopBarks, M04MeetAlex' }] },
  { flag: 'PlayerMetFilben', row: '03', setters: 'M03MeetFilben@FirstMeeting (1, never)', line: 'absent',
    reads: [{ m: '04', reader: 'M04MeetFilben', units: ['c04-PlayerMetFilben-1-m03', 'c04-bar-line'] }] },
  { flag: 'SimonsAssassination', row: '03', setters: 'SimonsBarks@A4 (1, never)', line: 'absent',
    reads: [{ m: '14', reader: 'DL_Simons2 (14_OceanLab_Lab/DataLinkTrigger6, needs schematic_downloaded; ? SimonsAssassination -> Assassination)', units: ['c14-SimonsAssassination-1', 'c14-lab-line'] }] },
  { flag: 'M04MetWalton', row: '04', setters: 'M04MeetWalton (main) (1, never)', line: 'absent',
    reads: [{ m: '14', reader: 'WaltonShowdown (? !M04MetWalton -> try2)', units: ['c14-M04MetWalton-1', 'c14-lab-line'] }] },
  { flag: 'PlayerBailedOutWindow', row: '04', setters: '04_NYC_Hotel/FlagTrigger9 (1, mission 6)', line: 'absent',
    reads: [{ m: '05', reader: 'Mission05.FirstFrame:37 (05_NYC_UNATCOMJ12LAB: Paul destroyed)', units: ['c05-PlayerBailedOutWindow-1', 'c05-lab-line'] }] },
  { flag: 'SandraWentToCalifornia', row: '04', setters: 'SandraAttackedByJoJoThanks, FamilySquabbleWrapUpGilbertDead (main), FamilySquabbleWrapUp@Hop (1, never)', line: 'absent',
    reads: [{ m: '08', reader: 'Mission08.FirstFrame:19 (Sandra destroyed in every map)', units: ['c08-SandraWentToCalifornia-1', 'c08-bar-line'], notRun: 'M08MeetSailor (one reader per mission)' },
      { m: '12', reader: 'Mission12.FirstFrame:37 (12_VANDENBERG_GAS: Sandra enters the world)', units: ['c12-SandraWentToCalifornia-1', 'c12-cmd-line'], notRun: 'MeetBum_M, BumsOverheard, BumsOverheard2 (one reader per mission)' }] },
  { flag: 'JacobsonRecruited', row: '05', setters: 'M05MeetAlexJacobson (main) (1, never)', line: '1 (the chain\'s M05MeetAlexJacobson)',
    reads: [{ m: '06', reader: 'Mission06.FirstFrame:86 (06_HONGKONG_TONGBASE: Alex enters the world)', units: ['c06-JacobsonRecruited-absent', 'c06-tongbase-line'] }] },
  { flag: 'JaimeRecruited', row: '05', setters: 'M05MeetJaime@Recruit (1, never)', line: 'absent',
    reads: [{ m: '06', reader: 'M06MeetAlexJacobson (? JaimeRecruited -> Recruited)', units: ['c06-JaimeRecruited-1', 'c06-tongbase-line'],
      notRun: 'Mission06.FirstFrame:76 (needs Versalife_Done: the second visit), Base_Guard_MiddleBarks, M07AlexJacobsonBarks, M06AlexJacobsonBarks' },
      { m: '10', reader: 'Mission10.FirstFrame:31 (10_PARIS_METRO: Jaime enters unless recruited) and DL_metrosewer (? !JaimeRecruited -> Jaime)', units: ['c10-JaimeRecruited-1', 'c10-metro-line'] }] },
  { flag: 'KnowsAboutKillphrase', row: '05', setters: 'PaulInMedLab@Killphrase (1, never)', line: 'absent',
    reads: [{ m: '10', reader: 'M10MeetJaime (? KnowsAboutKillphrase -> Knows: sets KnowsGuntherKillphrase)', units: ['c10-KnowsAboutKillphrase-1', 'c10-metro-line'] }] },
  { flag: 'GreenKnowsAboutDowd', row: '08', setters: 'M08MeetJoeGreen@TellsAboutDowd (1, never)', line: 'absent',
    reads: [{ m: '09', reader: null, notRun: 'Mission09.Timer:170 also needs suprisePoint (set nowhere) and acts on MJ12Commandos tagged paratroop (no map has one): no observable on either side' }] },
  { flag: 'HelpSailor', row: '08', setters: 'M08MeetSailor@GetPass (1, never)', line: 'absent',
    reads: [{ m: '09', reader: 'MeetFrontGuard (? HelpSailor & !Sailor_Dead -> Friendly)', units: ['c09-HelpSailor-1', 'c09-dockyard-line'],
      notRun: 'FrontGuardBarks, DoorGuardBarks, CafWorker1Help/Barks/Barks2, 09_NYC_Dockyard/FlagTrigger0, 09_NYC_Ship/FlagTrigger0 (one reader per mission)' }] },
  { flag: 'M08WarnedSmuggler', row: '08', setters: 'M08SmugglerConvos@GiveWarning (1, never)', line: 'absent (the chain picks NoWarning)',
    reads: [{ m: '09', reader: 'DL_BadNews (09_NYC_Dockyard/DataLinkTrigger4; ? M08WarnedSmuggler -> Warned)', units: ['c09-M08WarnedSmuggler-1', 'c09-dockyard-line'] }] },
  { flag: 'KnowsGuntherKillphrase', row: '10', setters: 'M10MeetJaime@Continue (1, never)', line: 'absent',
    reads: [{ m: '11', reader: 'M11MeetGunther (Continue: ? !KnowsGuntherKillphrase -> NoKillswitch; else the Kill/Gentleman choice)', units: ['c11-KnowsGuntherKillphrase-1', 'c11-cathedral-line'] }] },
  { flag: 'EverettMechanicComment', row: '11', setters: 'MeetEverett2@RayComment, @deadset (1, never)', line: 'absent',
    reads: [{ m: '12', reader: 'TongSick (on the chain; one CheckFlag of !Ray_Dead and !EverettMechanicComment -> Rattle)', units: ['c12-EverettMechanicComment-1'] },
      { m: '14', reader: 'JockArea51 (on the chain; the same check)', units: ['c14-EverettMechanicComment-1'] },
      { m: '15', reader: 'M15MeetEverett (the same check -> Dead)', units: ['c15-EverettMechanicComment-1', 'c15-entrance-line'] }] },
  { flag: 'M11MetWalton', row: '11', setters: 'M11WaltonHolo (main) (1, never; needs GuntherHermann_Dead)', line: 'absent',
    reads: [{ m: '14', reader: 'WaltonShowdown (try2: ? !M11MetWalton -> try3)', units: ['c14-M11MetWalton-1', 'c14-lab-line'] }] },
];

// ---- unit files ---------------------------------------------------------------------------------------------------------------------------------------------
export async function unitChain(unit) {
  const family = FAMILIES[unit.family];
  const runs = unit.readers ?? Object.keys(family.blocks);
  const body = [];
  for (const item of family.body) {
    if (typeof item === 'string' && item.startsWith('snap:')) body.push({ op: 'snap', label: item.slice(5) });
    else if (typeof item === 'string') {
      if (!family.blocks[item]) throw new Error(`${unit.family}: no block ${item}`);
      if (!runs.includes(item)) continue;
      body.push(...family.blocks[item].map(step => step.op === 'conv' && unit.choose?.[item] ? { ...step, choose: unit.choose[item] } : step));
    } else body.push(item);
  }
  return {
    mission: unit.id,
    census: { flag: unit.flag, side: unit.side, family: unit.family, set: unit.set ?? [], clear: unit.clear ?? [], readers: runs },
    steps: [{ op: 'start', kind: 'slot', source: 'census', unit: unit.id, slot: unit.slot, index: unit.index }, ...CHEATS, { op: 'wait', seconds: 3 }, ...await resolve(body)],
  };
}
async function writeUnit(unit) {
  mkdirSync(CENSUS, { recursive: true });
  const chain = await unitChain(unit);
  const file = `${CENSUS}/${unit.id}.mjs`;
  writeFileSync(file, `/** Carried-flag census unit ${unit.id} (generated by scripts/stage6-flag-census.mjs; do not edit). */\nexport default ${JSON.stringify(chain, null, 1)};\n`);
  return file;
}

// ---- base saves (Play) --------------------------------------------------------------------------------------------------------------------------------------
async function buildBases(familyId, only = null) {
  const family = FAMILIES[familyId];
  const units = UNITS.filter(u => u.family === familyId && (!only || only.includes(u.id)));
  const { runChainInPlay } = await import('./chain-play.mjs');
  const prefix = await resolve(family.base.prefix);
  const steps = [{ op: 'start', kind: 'slot', source: 'chain', chain: family.base.from.chain, slot: family.base.from.slot, index: family.base.from.index },
    ...CHEATS, { op: 'wait', seconds: 3 }, ...prefix];
  // per unit: its flags written, SaveGame at once (no frame between), its flags put back; the line's base first, a unit that deletes a flag last (put back,
  // the flag is a new entry at the end of the store's insertion order)
  const rank = u => (u.side === 'line' ? 0 : u.clear?.length ? 2 : 1);
  for (const unit of [...units].sort((a, b) => rank(a) - rank(b)))
    steps.push({ op: 'wait', seconds: 0, census: { apply: unit.id } }, { op: 'save', index: unit.index, label: unit.id }, { op: 'wait', seconds: 0, census: { undo: unit.id } });
  const undo = new Map(), manifest = { family: familyId, made: new Date().toISOString(), units: {} };
  const onStep = (step, { c, map }) => {
    if (!step.census) return;
    const store = c.read(c.player(), 'FlagBase');
    if (step.census.apply) {
      const unit = unitById.get(step.census.apply), before = [];
      for (const [name] of [...(unit.set ?? []), ...(unit.clear ?? []).map(n => [n])]) {
        const e = store.entries.get(name.toLowerCase());
        before.push([name, e ? { name: e.name, value: e.value, expiration: e.expiration } : null]);
      }
      undo.set(unit.id, before);
      for (const [name, value, expiration] of unit.set ?? []) store.setBool(name, value, true, expiration);
      for (const name of unit.clear ?? []) store.deleteFlag(name, 0);
      const flags = flagsOfPlay(c);
      manifest.units[unit.id] = { map, slot: unit.slot, flags: flags.flags, defaultExpiration: flags.defaultExpiration,
        written: [...(unit.set ?? []).map(([n, v, x]) => `${n}=${v ? 1 : 0}/${x}`), ...(unit.clear ?? []).map(n => `-${n}`)] };
      console.log(`${unit.id}: in ${map}, ${manifest.units[unit.id].written.join(' ') || 'no flag written (the line)'}`);
    } else if (step.census.undo) {
      for (const [name, prev] of undo.get(step.census.undo)) {
        if (prev) store.setBool(prev.name, prev.value, true, prev.expiration); else store.deleteFlag(name, 0);
      }
    }
  };
  const result = await runChainInPlay({ mission: `${familyId}-base`, steps }, { log: line => console.log(`  ${line}`), onStep });
  for (const unit of units) {
    const save = result.saves?.[unit.id];
    if (!save) throw new Error(`${unit.id}: no save`);
    const target = slotDirectory({ source: 'census', unit: unit.id, slot: unit.slot });
    rmSync(new URL('..', `file://${target}/`).pathname, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const file of save.files) writeFileSync(`${target}/${file.name}`, file.bytes);
    console.log(`pinned ${unit.id}: ${target} (${save.files.length} files)`);
  }
  mkdirSync(`${CENSUS}/bases`, { recursive: true });
  writeFileSync(`${CENSUS}/bases/${familyId}.json`, JSON.stringify(manifest, null, 1));
}

// ---- the runner ---------------------------------------------------------------------------------------------------------------------------------------------
function select(arg) {
  if (!arg || arg.startsWith('--')) return UNITS;
  if (FAMILIES[arg]) return UNITS.filter(u => u.family === arg);
  const units = arg.split(',').map(id => unitById.get(id) ?? (() => { throw new Error(`no unit or family ${id}`); })());
  return units;
}
const node = (args, log) => {
  const run = spawnSync(process.execPath, ['--max-old-space-size=12288', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  appendFileSync(log, `$ node ${args.join(' ')}\n${run.stdout}${run.stderr}\nexit ${run.status}\n`);
  return { ok: run.status === 0, out: `${run.stdout}${run.stderr}` };
};
const lastError = text => (text.split('\n').reverse().find(line => /Error|error:|step \d+/.test(line)) ?? '').slice(0, 400);

async function play(units, { rebuild = false } = {}) {
  mkdirSync(`${CENSUS}/results`, { recursive: true });
  mkdirSync(`${ROOT}/.work/chains/logs`, { recursive: true });
  const summaryFile = `${CENSUS}/play-summary.json`;
  const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : {};
  const families = [...new Set(units.map(u => u.family))];
  for (const familyId of families) {
    const members = units.filter(u => u.family === familyId);
    const missing = members.filter(u => rebuild || !existsSync(`${slotDirectory({ source: 'census', unit: u.id, slot: u.slot })}/SaveInfo.dxs`));
    if (missing.length) {
      const log = `${ROOT}/.work/chains/logs/agentf-base-${familyId}.log`;
      console.log(`base ${familyId}: ${missing.length} save(s) (log ${log})`);
      const run = node(['scripts/stage6-flag-census.mjs', '--bases', familyId, '--only', missing.map(u => u.id).join(',')], log);
      if (!run.ok) {
        for (const u of missing) summary[u.id] = { base: false, play: false, error: `base: ${lastError(run.out)}`, at: new Date().toISOString() };
        console.log(`  FAILED: ${lastError(run.out)}`);
        writeFileSync(summaryFile, JSON.stringify(summary, null, 1));
        continue;
      }
    }
    for (const unit of members) {
      if (summary[unit.id]?.base === false && !existsSync(`${slotDirectory({ source: 'census', unit: unit.id, slot: unit.slot })}/SaveInfo.dxs`)) continue;
      const file = await writeUnit(unit);
      const log = `${ROOT}/.work/chains/logs/agentf-${unit.id}.log`;
      const json = `${CENSUS}/results/${unit.id}.play.json`;
      const t0 = Date.now();
      const run = node(['scripts/chain-play.mjs', '--file', file, '--json', json], log);
      let reads = null;
      if (run.ok && existsSync(json)) {
        const r = JSON.parse(readFileSync(json, 'utf8'));
        reads = { snaps: Object.keys(r.snaps), legs: r.legs.map(l => `${l.label}:${l.to}`), states: r.states ?? {}, conversations: (r.conversations ?? []).map(c => `${c.name}: ${c.trace.join(' ')}`) };
      }
      summary[unit.id] = { base: true, play: run.ok, seconds: Math.round((Date.now() - t0) / 1000), error: run.ok ? null : lastError(run.out), reads, at: new Date().toISOString() };
      console.log(`${unit.id}: ${run.ok ? 'runs end to end' : `STOPS: ${summary[unit.id].error}`} (${summary[unit.id].seconds} s)`);
      writeFileSync(summaryFile, JSON.stringify(summary, null, 1));
    }
  }
  return summary;
}

function list() {
  const pad = (s, n) => String(s).padEnd(n);
  for (const f of FLAGS) {
    console.log(`${f.flag} (set in mission ${f.row}: ${f.setters}); the line: ${f.line}`);
    for (const r of f.reads) {
      console.log(`  M${r.m}: ${r.reader ?? '(no reader run)'}`);
      for (const id of r.units ?? []) { const u = unitById.get(id); console.log(`    ${pad(u.id, 34)} ${pad(u.side, 7)} ${pad(u.family, 18)} ${u.slot}  ${(u.set ?? []).map(([n, v, x]) => `${n}=${v ? 1 : 0}/${x}`).concat((u.clear ?? []).map(n => `-${n}`)).join(' ')}`); }
      if (r.notRun) console.log(`    not run: ${r.notRun}`);
    }
  }
  console.log(`\n${FLAGS.length} flag rows, ${UNITS.length} units (${UNITS.filter(u => u.side === 'line').length} line units) in ${Object.keys(FAMILIES).length} families`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1] ?? null; };
  if (args.includes('--list')) list();
  else if (args.includes('--write')) for (const u of select(option('write'))) console.log(await writeUnit(u));
  else if (args.includes('--bases')) await buildBases(option('bases'), option('only')?.split(','));
  else if (args.includes('--play')) {
    if (process.platform === 'darwin' && !process.env.CENSUS_ALLOW_MAC) throw new Error('the census runs Play: not on the 16 GB Mac (the Linux host)');
    const summary = await play(select(option('play')), { rebuild: args.includes('--rebuild') });
    const done = Object.entries(summary);
    console.log(`\n${done.filter(([, s]) => s.play).length} of ${done.length} units run end to end in Play`);
  } else console.log('usage: --list | --write [unit|family] | --bases <family> [--only a,b] | --play [unit|family|a,b] [--rebuild]');
  process.exit(0);
}
