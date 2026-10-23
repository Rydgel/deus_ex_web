/** Mission 1, Liberty Island and UNATCO HQ (docs/stage-6-inventory.md 01.6, docs/stage-6-chains.md): from New Game's arrival on the Island (the intro left by
 * Escape) through the commander, the HQ's briefing and the police boat to the exit to 02_NYC_BatteryPark. The placements come from scripts/chain-plan.mjs
 * (`stand`, `drop`) in Play's world. Choices are named by the label their branch jumps to (the conversation's own data), with their order. */
export default {
  mission: '01',
  steps: [
    { op: 'start', kind: 'new-game', difficulty: 1 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'b1-island' },
    { op: 'gobjects', label: 'b1' },
    // 29 Terrorists patrol the Island and the run places the player at the Statue (the walk and the fights between the steps are not part of the row): God mode, so that what the
    // player is shot for in the original's longer real seconds is not compared
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'God', harness: true },

    // DL_StartGame fires PaulRunningToPlayer when the player has walked a little; MeetPaul starts when Paul reaches him (radius 180, third person)
    { op: 'walk', seconds: 1.5 },
    { op: 'conv', name: 'MeetPaul', choose: [{ index: 0, label: 'GiveRifle' }], watch: ['PaulDenton0'], timeout: 240 },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'b2-meetpaul' },

    // the Statue's top: the commander's radius conversation (140); the questioning branch leaves him alive and sets StatueMissionComplete; Mission01.Timer's
    // mission-complete pass and DL_LeaderNotKilled follow
    { op: 'place', at: [2886, 27, 2529], view: [-7549, 114], harness: true, note: '45 units west of TerroristCommander0 (2931,27,2528), facing him' },
    { op: 'conv', name: 'MeetTerrorist', choose: [{ index: 1, label: 'Curious' }], watch: ['TerroristCommander0'], timeout: 240 },
    { op: 'wait', flag: 'StatueMissionComplete', timeout: 60 },
    { op: 'wait', flag: 'MS_MissionComplete', timeout: 60 },
    { op: 'wait', flag: 'DL_LeaderNotKilled_Played', timeout: 240 },
    // what Mission01.Timer's mission-complete pass opens: UN_maindoor (the HQ's door, unlocked and triggered) and the Statue ruins' doors (unlocked)
    { op: 'wait', seconds: 5 },
    { op: 'state', label: 'un-maindoor-16', actor: 'DeusExMover16', fields: ['bLocked', 'KeyNum'] },
    { op: 'state', label: 'un-maindoor-17', actor: 'DeusExMover17', fields: ['bLocked', 'KeyNum'] },
    ...['DeusExMover12', 'DeusExMover6', 'DeusExMover22', 'DeusExMover23', 'DeusExMover10'].map(actor => ({ op: 'state', label: `ruins-${actor}`, actor, fields: ['bLocked'] })),
    { op: 'snap', label: 'b3-commander' },

    // Island to HQ: Teleporter3 (-3375,704,-536; radius 80, height 40), the same mission, so the level is filed in Save\Current
    { op: 'place', at: [-3375, 704, -446], view: [0, 0], harness: true, drop: true, note: 'dropped onto Teleporter3' },
    { op: 'travel', to: '01_NYC_UNATCOHQ', label: 'leg1' },
    { op: 'wait', seconds: 5 },
    { op: 'snap', label: 'b4-hq' },
    // Paul (PaulDenton0, out of the world until Mission01.Timer's HQ pass lets him in once M01ReadyForBriefing is set) barks PaulFinalBark at a player within 70 units: rendered in the original's frames
    { op: 'watch', actors: ['PaulDenton0'] },

    // HQ: MeetCarter (SamCarter0, radius 160; one of its three offers, then it ends), MeetJaime (JaimeReyes0, radius 100; sets M01ReadyForBriefing now that the
    // Carter conversation is done), M02Briefing (JosephManderley0, sight and radius 240, needs M01ReadyForBriefing)
    { op: 'place', at: [949, -932, -15], view: [-5406, 32766], harness: true, note: '70 units east of SamCarter0 (879,-932,-16), facing him' },
    { op: 'conv', name: 'MeetCarter', choose: [{ index: 0, label: 'Picks' }], watch: ['SamCarter0'], timeout: 240 },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'b5-carter' },
    { op: 'place', at: [1136, 1056, -15], view: [-6234, 32786], harness: true, note: '70 units east of JaimeReyes0 at his seat (1066,1056,-24)' },
    { op: 'conv', name: 'MeetJaime', watch: ['JaimeReyes0'], timeout: 240 },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'b6-jaime' },
    { op: 'place', at: [369, -170, 289], view: [-6389, 32830], harness: true, note: '70 units east of JosephManderley0 at his place (299,-170,288)' },
    { op: 'conv', name: 'M02Briefing', watch: ['JosephManderley0'], timeout: 240 },
    // Paul, let into the HQ, wanders to the player and barks PaulFinalBark (a first-person conversation, radius 70, once; needs M02Briefing_Played): how long he takes is each run's own
    { op: 'wait', flag: 'PaulFinalBark_Played', timeout: 240 },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'b7-briefed' },

    // HQ to the Island again: Teleporter2 (-2344,1791,582) to tunnel_drop_nyc; the Island is restored from Save\Current
    { op: 'place', at: [-2344, 1791, 672], view: [0, 0], harness: true, drop: true, note: 'dropped onto Teleporter2' },
    { op: 'travel', to: '01_NYC_UNATCOIsland', label: 'leg2' },
    { op: 'wait', seconds: 5 },
    { op: 'snap', label: 'b8-island-again' },
    { op: 'gobjects', label: 'b8' },

    // the police boat: GotoM02 (first person, needs M02Briefing_Played) starts when the player frobs the boat from the dock's edge (the boat's blocking cylinder, radius 314,
    // keeps the player 20 units outside it, so the radius of 240 is out of reach); its Trigger event fires MapExit0 (tag Dock_boat), which plays the camera path
    // Dock_boatpath and then sends the player to 02_NYC_BatteryPark
    { op: 'place', at: [-4780, 10139, -250], view: [0, 32768], harness: true, note: 'on the dock at the boat\'s cylinder (NYPoliceBoat0 at -5122,10139,-270), facing it' },
    { op: 'frob', target: 'NYPoliceBoat0' },
    { op: 'conv', name: 'GotoM02', timeout: 60 },
    { op: 'travel', to: '02_NYC_BatteryPark', label: 'exit', timeout: 240 },
    { op: 'watch', actors: ['AnnaNavarre0'] },
    // AnnaDock (Anna's radius conversation, which she walks to the player for) and her run to the castle: set by the map's own events, in either program's time
    { op: 'wait', flag: 'AnnaDock_Played', timeout: 240 },
    { op: 'wait', flag: 'AnnaReachedCastle', timeout: 240 },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'b9-batterypark' },
  ],
};
