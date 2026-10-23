/** The Stage 6 criteria as data (docs/stage-6-exit-criteria.md): one row per criterion of the roadmap's section 6 "Done when", read by the
 * scoreboard (`node scripts/stage6-criteria.mjs`) and, once it exists, by the Stage 6 gate.
 *
 * A row is {id, clause, claim, ev, proof, have, need, weak, excluded} as in scripts/stage5-criteria.mjs:
 *   ev       the evidence class a passing proof would have (O1 Play against the original's own output for the same inputs; O2 a translation against
 *            the DLL's code; P Play against itself). A played result needs O1 (docs/stage-4-exit-criteria.md "How the gate judges").
 *   proof    the checks that, all passing, make the row PASS: [] while none exists (the row is then MISSING and `need` says what would prove it).
 *   have     existing checks that cover a part (named, not run, never enough alone).
 *   weak     why the choice of scenario or proof is weak, for the user to adopt or change.
 *   pending  work running now (the row is UNDRIVEN until it lands).
 * The user's decisions of 2026-10-23 (docs/stage-6-exit-criteria.md "What the user decided") shape clause 6.4 and row 6.6.1. */

export const CLAUSES = Object.freeze({
  1: 'The start and the menus', 2: 'Persistence', 3: 'Transitions', 4: 'The missions', 5: 'The endings', 6: 'The campaign in one run', 7: 'Excluded',
});

/** The missions of the campaign (docs/stage-6-inventory.md "The campaign at a glance"; there is no mission 7 or 13). */
export const MISSIONS = Object.freeze(['00', '01', '02', '03', '04', '05', '06', '08', '09', '10', '11', '12', '14', '15']);
/** The missions that set one of the 36 carried flags (docs/stage-6-inventory.md "The choices with lasting consequences across missions"). */
export const CHOICE_MISSIONS = Object.freeze({'01': 7, '02': 13, '03': 5, '04': 3, '05': 3, '08': 3, '10': 1, '11': 2});

/** The missions with a real desktop save slot (`.work/internet-saves`: the 41 slots cover missions 1 to 6, 8 to 10, 12, 14 and 15). */
const SLOT_MISSIONS = new Set(['01', '02', '03', '04', '05', '06', '08', '09', '10', '12', '14', '15']);

export const CRITERIA = [];
const clauseOf = id => Number(id.split('.')[1]);
const add = (id, claim, ev, extra = {}) => CRITERIA.push({id, clause: clauseOf(id), claim, ev, proof: [], have: [], need: null, weak: null, excluded: null, pending: null, ...extra});
const v = (name, ...args) => ({type: 'validator', name, args});
const spec = name => ({type: 'playwright', name});

// 6.1 The start and the menus -----------------------------------------------------------------------------------------------------------
add('6.1.1', 'the page starts as the original: the splash, the logo map with its camera flight, MenuMain on Escape or a click', 'O1',
  {proof: [v('validate-travel-play.mjs'), spec('browser-tests/original-start-input.spec.mjs')], have: ['docs/boot.md (the logo frames against the original\'s Shot, docs/umesh.md)']});
add('6.1.2', 'New Game: the difficulty and skill screens, the intro, then the Island with the starting items and flags', 'O1',
  {proof: [v('validate-travel-newgame.mjs'), v('validate-travel-newgame-play.mjs')]});
add('6.1.3', 'Training from the menu: 00_Training with the travel text and the arrival flags', 'O1', {proof: [v('validate-travel.mjs'), v('validate-travel-play.mjs')]});
add('6.1.4', 'Play Intro and Credits from the menu, to their ends and back to the menu', 'O1',
  {proof: [v('validate-travel-endings.mjs'), spec('browser-tests/original-start-intro-credits.spec.mjs')]});
add('6.1.5', 'the settings the menus write are kept across map loads and reloads, as the original writes DeusEx.ini and User.ini', 'O1',
  {proof: [v('validate-config-persistence.mjs'), spec('browser-tests/config-persistence.spec.mjs')]});
add('6.1.6', 'every MenuMain entry reaches its screen or action (Multiplayer excluded)', 'P',
  {have: ['scripts/census-ui-menus.mjs (22 screens, only multiplayer stops: docs/native-census.md)'],
    need: 'a check of each entry\'s screen against the original (the census is Play-only), and Exit: what the original does and what the page does instead (unmeasured)'});

// 6.2 Persistence ----------------------------------------------------------------------------------------------------------------------
add('6.2.1', 'a return visit within a mission restores the level as it was left (destroyed actors, items, movers, the level time; no begin-play pass)', 'O1',
  {proof: [v('validate-travel-restore.mjs'), v('validate-travel-restore-play.mjs'), v('validate-travel-restore-play.mjs', '--island')]});
add('6.2.2', 'a game saved in Play and loaded in Play is the saved game: flags, inventory, player, augmentations and skills, notes, goals, history, the actor census', 'O1',
  {have: ['validate-save-game.mjs (the slot\'s files and SaveInfo against the original\'s; the original loads Play\'s slots)', 'validate-load-game.mjs (Play loads the original\'s slots)'],
    need: 'a validator that saves in Play at a played state and loads the slot in Play, comparing the loaded state with the saved one, and with the original\'s state after loading the same slot'});
add('6.2.3', 'real desktop saves load in Play with the state the original loads from them', 'O1',
  {proof: [v('validate-load-game.mjs'), v('validate-load-saves.mjs')], weak: 'the state comparison against the original covers 6 slots; the other 35 are checked for loading and running only'});
add('6.2.4', 'a slot Play writes loads in the original with the saved player, items and flags', 'O1', {proof: [v('validate-save-game.mjs'), v('validate-save-info-corpus.mjs')]});
add('6.2.5', 'QuickSave and QuickLoad, the Load Game screen in a running game, and Load Game after the player\'s death', 'O1',
  {proof: [v('validate-load-ui.mjs'), spec('browser-tests/load-game.spec.mjs'), spec('browser-tests/save-game.spec.mjs')]});
add('6.2.6', 'saves are kept in the browser or a folder the player picked, can be exported and imported, and a storage failure is said and leaves the game running', 'P',
  {proof: [spec('browser-tests/save-folder.spec.mjs'), spec('browser-tests/save-game.spec.mjs')],
    weak: 'the folder picker of a real (headed) browser and persist() were not run; Firefox and Safari are Stage 7\'s'});

// 6.3 Transitions -----------------------------------------------------------------------------------------------------------------------
add('6.3.1', 'every MapExit, Teleporter and scripted travel of the single-player maps arrives (198 transitions), from a real save of its mission where one exists', 'P',
  {pending: 'scripts/census-transitions.mjs (travel step 5, second part: running)', need: 'the census with every transition arriving, or each stop an explicit named boundary'});
add('6.3.2', 'a sample of every family of transition equals the original: the log lines, the travel text, the flags, the arrival place and the Save\\Current listing', 'O1',
  {proof: [v('validate-travel-transitions.mjs'), v('validate-travel.mjs')], pending: 'the census names the families; one Wine capture per family not yet sampled',
    have: ['validate-travel-transitions A-D (the Hong Kong lifts, the Mission02/08 PreTravels, a portal no Teleporter names, the mission-14 URL forms)']});

// 6.4 The missions ----------------------------------------------------------------------------------------------------------------------
for (const m of MISSIONS) {
  add(`6.4.${m}.1`, `mission ${Number(m)}: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's`, 'O1',
    {need: 'a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission\'s exit), compared at the exit',
      weak: 'the player is placed at each step, as Stage 5\'s placed approaches: the walk and the fights between the steps are not part of the row (the user\'s decision)'});
  if (CHOICE_MISSIONS[m]) add(`6.4.${m}.2`, `mission ${Number(m)}: both sides of each of its ${CHOICE_MISSIONS[m]} carried flags, checked where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original`, 'O1',
    {need: 'per carried flag: the two branches set in the mission (or a slot holding each), the reader\'s observable in the later mission, in Play and under Wine'});
  add(`6.4.${m}.3`, `mission ${Number(m)}: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.${m}.1`, 'P',
    {proof: [v('validate-conversations-census.mjs', '--missions', m)], have: ['scripts/census-conversations.mjs (docs/census-conversations.md)'],
      weak: 'Play against itself: a cold open of each owner\'s map; the named boundaries (what the original\'s own code or data refuses) are listed in scripts/census-conversations-boundaries.mjs',
      pending: SLOT_MISSIONS.has(m) ? 'the second pass from the mission\'s real slots (`validate-conversations-census.mjs --slots`): started 2026-10-23, not finished; its stops so far are the restored-level PlaySound object index of the placed-chain worker (missions 1 and 3)' : null});
}

// 6.5 The endings -----------------------------------------------------------------------------------------------------------------------
for (const [n, how] of [[1, 'the reactor switches (Tong\'s ending)'], [2, 'Helios\' hub'], [3, 'Page\'s bunker (killpage)']])
  add(`6.5.${n}`, `ending ${n} from its in-world trigger, ${how}: the endgame, the credits and the menu, equal to the original`, 'O1',
    {have: [`validate-travel-endings.mjs E${n} (from a LocalTravel into 99_Endgame${n}, O1) and M1-M3 (the triggers in Play only)`, spec('browser-tests/ending.spec.mjs').name],
      need: 'the original driven through the same trigger (Final\'s MapExit0 sits in solid space: the trigger, not the exit actor, is the way)'});

// 6.6 The campaign in one run -----------------------------------------------------------------------------------------------------------
add('6.6.1', 'one run in Play from New Game to an ending, each mission entered from the previous mission\'s exit (no save loaded), every required step placed; the travel text at each mission change equals the original\'s for the same run', 'O1',
  {need: 'the chained run in Play, and the original\'s texts at each mission change from the same chained steps (the 6.4.*.1 captures chained)'});

// 6.7 Excluded --------------------------------------------------------------------------------------------------------------------------
const excluded = (id, claim, reason) => CRITERIA.push({id, clause: 7, claim, ev: '-', proof: [], have: [], need: null, weak: null, excluded: reason, pending: null});
excluded('6.7.1', 'multiplayer: the DXMP_* maps, the Multiplayer menu, server travel', 'multiplayer is the last priority (AGENTS.md)');
excluded('6.7.2', 'missions 7 and 13', 'the installed game has no maps, scripts or conversation lists of their own (ConList_Mission07 duplicates 06)');
excluded('6.7.3', 'Firefox and Safari, a headed browser\'s folder picker', 'Stage 7 (browser reliability)');

/** PASS when a proof exists and nothing is pending; UNDRIVEN while work runs; MISSING without a proof (the scoreboard before a gate exists: it names, it does not run). */
export const statusOf = row => row.excluded ? 'EXCLUDED' : row.pending && !row.proof.length ? 'UNDRIVEN' : row.proof.length && !row.pending ? 'PASS' : row.proof.length ? 'PARTIAL' : 'MISSING';

if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = {};
  for (const row of CRITERIA) { const s = statusOf(row); (counts[row.clause] ??= {})[s] = (counts[row.clause][s] ?? 0) + 1; }
  const kinds = ['PASS', 'PARTIAL', 'UNDRIVEN', 'MISSING', 'EXCLUDED'];
  console.log(`| Clause | ${kinds.join(' | ')} |\n| --- | ${kinds.map(() => '---:').join(' | ')} |`);
  const total = {};
  for (const [c, name] of Object.entries(CLAUSES)) {
    const k = counts[c] ?? {};
    for (const s of kinds) total[s] = (total[s] ?? 0) + (k[s] ?? 0);
    console.log(`| 6.${c} ${name} | ${kinds.map(s => k[s] ?? 0).join(' | ')} |`);
  }
  console.log(`| **Total** | ${kinds.map(s => total[s]).join(' | ')} |`);
  if (process.argv.includes('--list')) for (const row of CRITERIA) console.log(`${row.id}\t${statusOf(row)}\t${row.claim}`);
  // --markdown: the criteria tables of docs/stage-6-exit-criteria.md, one per clause
  if (process.argv.includes('--markdown')) for (const [c, name] of Object.entries(CLAUSES)) {
    const cell = text => String(text ?? '').replaceAll('|', '\\|');
    const check = item => typeof item === 'string' ? item : [item.name, ...(item.args ?? [])].join(' ');
    console.log(`\n### 6.${c} ${name}\n\n| Row | Criterion | Evidence | Proof | Needed / weak / pending | Status |\n| --- | --- | --- | --- | --- | --- |`);
    for (const row of CRITERIA.filter(row => row.clause === Number(c)))
      console.log(`| ${row.id} | ${cell(row.claim)} | ${row.ev} | ${cell(row.proof.map(check).join(', ') || '-')} | ${cell([row.need, row.weak && `weak: ${row.weak}`, row.pending && `pending: ${row.pending}`, row.excluded].filter(Boolean).join('; ') || '-')} | ${statusOf(row)} |`);
  }
}
