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
add('6.1.6', 'every MenuMain entry reaches its screen or action (Multiplayer excluded)', 'O1',
  {proof: [v('validate-menu-main.mjs')],
    have: ['scripts/census-ui-menus.mjs (22 screens, only multiplayer stops: docs/native-census.md)', 'docs/host-services.md "Exit" (USystem::Exec EXIT, appRequestExit; the page ends the game)'],
    weak: 'the window stack after each entry is compared (New Game, Load Game, Settings, Credits and the Exit box on the logo map; Save Game, the Training and Intro boxes, Back to Game and Exit in a running game; the insensitive Save Game and Back to Game on the logo map), not the screens\' controls (docs/settings-menus.md, Play only) nor the entries that leave the menu (rows 6.1.2 to 6.1.4); Exit\'s Yes: the original\'s log and process end against Play\'s appRequestExit line and exit request, and the page ends the game in place of the process (a page cannot close itself: the presentation is the page\'s choice, for the user to confirm); a key bound to Exit stops by name (docs/host-services.md); the capture is the Mac bottle\'s (.work/travel/mm1)'});

// 6.2 Persistence ----------------------------------------------------------------------------------------------------------------------
add('6.2.1', 'a return visit within a mission restores the level as it was left (destroyed actors, items, movers, the level time; no begin-play pass)', 'O1',
  {proof: [v('validate-travel-restore.mjs'), v('validate-travel-restore-play.mjs'), v('validate-travel-restore-play.mjs', '--island')]});
add('6.2.2', 'a game saved in Play and loaded in Play is the saved game: flags, inventory, player, augmentations and skills, notes, goals, history, the actor census', 'O1',
  {proof: [v('validate-save-load-play.mjs'), v('validate-load-game.mjs', '--only', 'P')],
    have: ['validate-save-game.mjs (the slot\'s files and SaveInfo against the original\'s; the original loads Play\'s slots)', 'validate-load-game.mjs (Play loads the original\'s slots)'],
    weak: 'one played state: mission 1\'s chain to the commander (MeetPaul and MeetTerrorist with their history, goals and notes, the rifle) and the cheat lines\' augmentations, skills, images and key; a slot of one level (the Island, the campaign\'s first map: no other level filed in Current); the level frozen while it saves and loads in validate-save-load-play and in the original, not on validate-load-game\'s Play side (its c.exec of `set` reaches no script exec: docs/travel.md); the capture is the Mac bottle\'s (.work/travel/sl1, with the slot\'s files it loaded)'});
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
  {proof: [v('census-transitions.mjs')], have: ['docs/travel-transitions.md (2026-10-23: 198 of 198 arrive; 104 from real slots, 93 cold; 161 restores on the way back)', spec('browser-tests/transitions.spec.mjs').name],
    weak: 'the 22 triggered exits get their Trigger call, not the conversation or dispatcher chain that fires them in the original; 5 s of arrival ticks; the arrivals at dx, DXOnly and the endings are 6.1.4/6.5\'s'});
add('6.3.2', 'a sample of every family of transition equals the original: the log lines, the travel text, the flags, the arrival place and the Save\\Current listing', 'O1',
  {proof: [v('validate-travel-transitions.mjs'), v('validate-travel.mjs')],
    have: ['validate-travel-transitions A-F (the Hong Kong lifts and an empty SendPlayer, the Mission02/08 PreTravels, a portal no Teleporter names, a mission change with a #portal, the .dx URL forms, a start spot above water, two camera-path exits)'],
    weak: 'one sample per family; the camera-path rides are bounded by one sample each; the two scripted SendPlayers (Mission04, Mission11) are not measured in the original'});

// 6.4 The missions ----------------------------------------------------------------------------------------------------------------------
/** The chains that exist (scripts/chains/mission<NN>.mjs, docs/stage-6-chains.md): the row's proof is validate-stage6-chain.mjs for that mission. */
const CHAINS = {
  '00': {have: ['docs/stage-6-chains.md: the menu Training button; the key door, the crowbar and crates with the lockpick and the gun door, the data cube and Keypad0, the multitool and Keypad2, the body carried to the table; Teleporter0, DL_CombatEntry, the four LAMs defused, DL_DefuseFinish, Teleporter5; the stealth switches, the bridge keypad, M00MeetPage, MapExit0 to DX'],
    weak: 'the first and last maps\' gates and the two InfoLinks are the chain; the course (jump, ladder, crate stack, swim) and the dark doors are not driven (a door the original closes again by itself has no stable state to compare); the Final map\'s Soldiers are made harmless (God mode) because the player is placed in their view and the original\'s real seconds are longer than Play\'s; the LAMs are defused with the level held (their countdown is shorter than a console line takes)'},
  '01': {have: ['docs/stage-6-chains.md: New Game, MeetPaul (the rifle), MeetTerrorist (the questioning branch), the mission-complete pass (UN_maindoor and the Statue ruins\' doors), Teleporter3, MeetCarter, MeetJaime, M02Briefing, Teleporter2 (the filed Island restored), GotoM02 by frob, the police boat\'s camera path, 02_NYC_BatteryPark and Anna\'s dock conversation'],
    weak: 'one branch of the commander (the aggressive branch, and the kill, are 6.4.01.2\'s); the Statue\'s gates (Filben\'s key, the ruins\' doors, the lasers) are walked past by the placement; God mode on the Island (29 Terrorists patrol it); the boat is frobbed from the dock\'s edge because its blocking cylinder keeps a walking player outside the conversation\'s radius (measured in the original: the walk stops at x -4786.4 in both programs); a conversation\'s random-label speech may differ between two runs (the game\'s random stream is not shared) and is accepted as that conversation\'s alternative'},
  '05': {have: ['docs/stage-6-chains.md: from mission 4\'s exit save in the lab\'s cell; the equipment room\'s pistol and the armory\'s rockets (the lab\'s alarm sets doorclosed there, as in the original once the camera\'s zone is stamped), DL_Choice, Teleporter4 to the HQ, Anna\'s killphrase decrypted on Manderley\'s and Gunther\'s computers (KnowsAnnasKillphrase1/2), AnnaExitKillphrase and her death, M05MeetAlexJacobson and levelone\'s NanoKey, the island, M05MeetJock, 06_HongKong_Helibase'],
    weak: 'the lab\'s guards and bots and the HQ\'s staff are walked past by the placements (God mode); Alex is held still (GroundSpeed 0) while the frob is typed, then given his speed back; Anna\'s fight (the other way past her) is not driven; the start is Play\'s own save of mission 4\'s exit (whose exit text equals the original\'s)'},
  '04': {have: ['docs/stage-6-chains.md: from mission 3\'s exit save; DL_SeeManderley, the HQ\'s ManderleyDebriefing03, JockTellsAboutPaul by the right button from outside the helicopter\'s cylinder, the Street, the hotel\'s PaulInjured, the NSF headquarters\' two computers (the three dishes, CanSendSignal, the broadcast, NSFSignalSent, DL_PaulGoodJob), the return to Paul (FlagTrigger30, ApartmentEntered, the raid\'s TalkedToPaulAfterMessage and his two barks), the subway, GuntherShowdown\'s Surrender, 05_NYC_UNATCOMJ12lab'],
    weak: 'the NSF headquarters\' guards and doors, the hotel\'s raiders and the Street\'s troops are walked past by the placements (God mode); the capture by death (Mission04.Timer\'s SendPlayer) is the other exit and is not driven; the start is Play\'s own save of mission 3\'s exit (whose exit text equals the original\'s)'},
  '03': {have: ['docs/stage-6-chains.md: from mission 2\'s exit save; DL_WelcomeBack, Teleporter1 to the HQ, ManderleyDebriefing02, Teleporter3, JockBarks by the right button from outside the helicopter\'s blocking cylinder (Ready: ChopperExit, the camera path), Battery Park\'s dl_batterypark, the station\'s and the tunnels\' teleporters, the heli base\'s DL_Airfield and its elevator, the airfield, the hangar and the 747 (MeetLebedev, AnnaEntrance: Mission03.FirstFrame then brings the airfield\'s helicopter in), dl_gochopper in the hangar, M03JockLeave\'s Ready, 04_NYC_UNATCOIsland'],
    weak: 'the assassination is Anna\'s (the chain does not kill Lebedev); the station\'s, tunnels\' and airfield\'s gates and guards are walked past by the placements (God mode); Paul\'s hangar conversation is not on the chain (Mission03.FirstFrame removes him on the return once MeetLebedev_Played is set); the start is Play\'s own save of mission 2\'s exit (whose exit text equals the original\'s)'},
  '02': {have: ['docs/stage-6-chains.md: from mission 1\'s exit save; SubwayControlPanel4 and the train\'s doors, DL_SubwayComplete, Teleporter1 to the Street, Button3 (ToWarehouse), the explosive crate beside BreakableWall2 shot with the pistol (GeneratorBlown), DL_Pickup, JockExit\'s Go by its radius, 03_NYC_UNATCOIsland'],
    weak: 'the subway\'s terrorists, the street\'s gangs and the warehouse\'s guards are walked past by the placements (God mode); the warehouse\'s doors and the roof\'s way up are not driven; the start is Play\'s own save of mission 1\'s exit (whose exit text equals the original\'s)',
    // its first PASS had the subway's standing terrorists and hostages in stasis in Play (no zone stamped headless), awake in the original
    pending: 'FAILS since the camera\'s zone is stamped each headless frame (the original\'s rule): the subway\'s terrorists now wake as the original\'s do, and Play\'s hostages die (HostagesKilled) where the original\'s ran into the train (EscapeSuccessful, 200 skill points); a diagnostic capture of the scene in the original (.work/chains/diag/d02-subway.mjs) decides between an AI divergence and a perception one'},
};
for (const m of MISSIONS) {
  const chain = CHAINS[m];
  add(`6.4.${m}.1`, `mission ${Number(m)}: the required chain (docs/stage-6-inventory.md "Progression path"), each step placed, runs from the arrival to the exit; the flags, goals, notes and travel text at the exit equal the original's`, 'O1',
    chain ? {proof: [v('validate-stage6-chain.mjs', '--mission', m)], have: chain.have, weak: `${chain.weak}; the player is placed at each step, as Stage 5's placed approaches: the walk and the fights between the steps are not part of the row (the user's decision)`, pending: chain.pending ?? null}
      : {need: 'a placed-chain scene of the mission in Play and under Wine from the same start (a real slot of the mission, else the previous mission\'s exit), compared at the exit',
        weak: 'the player is placed at each step, as Stage 5\'s placed approaches: the walk and the fights between the steps are not part of the row (the user\'s decision)'});
  if (CHOICE_MISSIONS[m]) add(`6.4.${m}.2`, `mission ${Number(m)}: both sides of each of its ${CHOICE_MISSIONS[m]} carried flags, checked where the later mission reads them (the conversation branch, the pawn present or absent, the script's effect), equal to the original`, 'O1',
    {need: 'per carried flag: the two branches set in the mission (or a slot holding each), the reader\'s observable in the later mission, in Play and under Wine'});
  add(`6.4.${m}.3`, `mission ${Number(m)}: every conversation and InfoLink of its list starts and runs to its end in Play without a stop; those on the required chain are compared with the original by 6.4.${m}.1`, 'P',
    {proof: [SLOT_MISSIONS.has(m) ? v('validate-conversations-census.mjs', '--missions', m, '--slots') : v('validate-conversations-census.mjs', '--missions', m)],
      have: ['scripts/census-conversations.mjs (docs/census-conversations.md)'],
      weak: `Play against itself: a cold open of each owner's map${SLOT_MISSIONS.has(m) ? ', and the latest real slot of each of the mission\'s maps that has one (a refusal by the original\'s own code in the slot\'s played state, or an owner the played game no longer has, is that state\'s answer)' : ' (the mission has no real slot)'}; a refusal in the cold pass is started once more in a fresh child (the earlier conversations of the map had moved or killed a speaker), a Play stop never; the named boundaries (what the original's own code or data refuses) are listed in scripts/census-conversations-boundaries.mjs`});
}

// 6.5 The endings -----------------------------------------------------------------------------------------------------------------------
// Each ending is a placed chain from the real slot nicouzouf Save0042 (15_Area51_page, the other three levels filed in Current; MeetHelios played, no ending's flag set)
// through the maps' own actors to the ending's trigger, the endgame, the credits ended by a click and dxonly (scripts/chains/mission15e<n>.mjs, docs/stage-6-chains.md
// "Mission 15"). Every last trigger waits for state made in 15_Area51_Page: a cold open with a placement cannot reach it.
const ENDING_CHAINS = {
  1: 'Page\'s coolant Switch0 (coolantcut), Teleporter8 to the filed Final, the generator switches Switch10/16 once Mission15.Timer swapped them and one drop into the overlapping coolant FlagTriggers 2 and 4 (LogicTrigger1/2: ReactorSwitch1/2), a DL_Tong7 trigger (DL_tong7 sets ReactorReady), FlagTrigger5 (Generator_panel), the reactor buttons Switch1, Switch2 and Switch5 in turn (ReactorButton1..3, each opening the next one\'s cover), FlagTrigger9 (Generator_overload), Final\'s Switch4 (destroy_generator -> Dispatcher7 -> MapExit0); the coolant FlagTriggers are entered by one placed drop and FlagTrigger5, FlagTrigger9 and the DL_Tong7 trigger by placed walks (heavier placement than endings 2 and 3, which reach their triggers by the game\'s own gates); the Mechanic\'s overheard PowerGuyScared1 and 2 are waited for in their windows (each program starts them at its own pace; Scared3 started in neither, for a reason not resolved) and the endgame snapshot waits for Endgame1\'s EndgameExplosions',
  2: 'the uplink buttons Button18/19 (UplinkLock1/2), ComputerPersonal0 logged in (its one user, Icarus) and its special option "Engage Primary Router" clicked (Set_flag_helios: FlagTrigger1 sets HeliosFree; the option reads no uplink flag), Teleporter8 to the filed Final, FlagTrigger3 touched (Merge_helios_exit -> MapExit1)',
  3: 'the four node keypads (7243: Node1..4_Frobbed), each waiting for its DL_Blue<n> (Mission15.Timer plays the InfoLink of the count of set flags), DL_Blue4 opening Page_button, Page\'s Switch4 (kill_page -> Dispatcher1, start_endgame -> MapExit0); no data sets the flag killpage that Mission15.Timer also reads',
};
for (const [n, how] of [[1, 'the reactor switches (Tong\'s ending)'], [2, 'Helios\' hub'], [3, 'Page\'s bunker (killpage)']])
  add(`6.5.${n}`, `ending ${n} from its in-world trigger, ${how}: the endgame, the credits and the menu, equal to the original`, 'O1',
    {proof: [v('validate-stage6-chain.mjs', '--mission', `15e${n}`)],
      have: [`validate-travel-endings.mjs E${n} (from a LocalTravel into 99_Endgame${n}, O1) and M1-M3 (the triggers in Play only)`, spec('browser-tests/ending.spec.mjs').name],
      weak: `from the third-party slot nicouzouf Save0042 (one played game's state at the Page map); the chain: ${ENDING_CHAINS[n]}; each step placed and God mode (Page's respawning troops and turrets, the reactor's radiation; typed again after each map change: it does not travel), as the other chains${n === 2 ? '; the special option is clicked at its button\'s point of the original\'s viewport (the `point` op)' : ''}; the endgame's conversation, quote and credits are given 120 s and the credits ended by a click (their own run to the end, and the menu on dxonly, are validate-travel-endings\' E and W); a mission 15 run from its arrival is row 6.4.15.1's; the captures are the Linux host's (.work/chains/m15e${n})`});

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
