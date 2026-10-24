/** Mission 12, Vandenberg (docs/stage-6-inventory.md 12.6, docs/stage-6-chains.md): from the arrival in 12_Vandenberg_Cmd through the bots, the comm center,
 * the computer room's uplink and Page's hostage call, Tong's lift to the gas station and Tiffany to the exit to 14_Vandenberg_sub. Placements from
 * scripts/chain-plan.mjs in Play's world (cold maps, `--aim` at a bot's frozen place; `face-chain` where the slot's or a restored level differs).
 *
 * The bots: Mission12.Timer counts the Robots tagged enemy_bot with EMPHitPoints left and plays DL_bots_left_3/2/1 and, at none, DL_command_bots_destroyed
 * (M12BotsDestroyed, comhqdoor). The map gives no EMP item (its three EMP grenades are carried by MJ12 troops). Its own means is the bot security system:
 * the backup power (Keypad0 behind its cover DeusExMover16 and Keypad1, code 5868 from Carla's note: Dispatcher7/8, LogicTrigger1, Dispatcher6 bot_power,
 * DL_override_activated, which completes ActivatePower) and the bunker switches Switch3/Switch4 (bunker_door1/2: OrdersTrigger0/1 send the salvaged X-51 bots
 * S_bot1/S_bot2 Patrolling, Bots_Salvagers against Bots_MJ12). The chain powers the system but does not release the salvaged bots: Play's run showed the
 * enemy bots pause at their first patrol point with bStasis set (ScriptedPawn state Patrolling, label Pausing, !bAlwaysPatrol) and stay there unseen, so the
 * salvaged bots fought only MilitaryBot4 (both destroyed) and 900 s passed without the rest; what the original's player sees decides that fight, which a placed
 * chain does not reproduce. The player destroys the four bots with the GEP gun the slot carries (belt 6), placed 300 units from each bot's paused place.
 *
 * Gates the placements pass: the control room's door_controlroom (locked, KeyIDNeeded control_room; MeetTonyMares' note puts the key in the utility tunnels, where
 * NanoKey0 lies by a scientist's body at 727,1516,-2589 of 12_Vandenberg_Tunnels, its KeyID not read: the chain does not visit the Tunnels, so neither the key nor
 * the Tunnels' DL_JockLeaving, which adds UplinkDaedalus, is on it), the comm center's comhqdoor (opened anyway by
 * DL_command_bots_destroyed). Tiffany: the chain picks "Go" with her guards alive and takes the Dead branch the mission provides (below).
 *
 * PROVISIONAL START: mission 11's chain has no exit save yet, so the chain starts from the real desktop slot nicouzouf Save0028 (12_Vandenberg_cmd, MeetCarlaBrown
 * played, goals DestroyBots and ActivatePower open, Ray_Dead set; its inventory has the GEP gun on belt 6 with 18 rockets). It becomes `{ op: 'start', kind:
 * 'slot', source: 'chain', chain: '11', slot: 'Save0111', index: 111 }` once mission 11's exit save exists; that start is the arrival at PlayerStart2
 * (657,2502,-909) and needs the steps the slot skips (below, commented out), the bots' paused places measured again from that arrival and a weapon that
 * start carries. */
export default {
  mission: '12',
  steps: [
    { op: 'start', kind: 'slot', source: 'nicouzouf', slot: 'Save0028', index: 28 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm12-1-start' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    // what the provisional start skips (the real arrival from 11_Paris_Everett's MapExit1): Carla's radius conversation next to PlayerStart2, which adds DestroyBots
    // and ActivatePower and gives the base's map (DL_no_carla's eleven triggers play it otherwise):
    // { op: 'place', at: [775, 2418, -895], view: [-4341, 57356], harness: true, turnFirst: true, note: '100 units north-west of CarlaBrown (ScientistFemale5 at 846,2347,-901; cold stand), facing her' },
    // { op: 'conv', name: 'MeetCarlaBrown', watch: ['ScientistFemale5'], timeout: 120, note: 'radius 160, WaitingFor; PlayerStart2 is 200 units from her' },

    // the bot security system's backup power: two keypads (code 5868, MeetCarlaBrown's note); both inputs of LogicTrigger1 fire test2 (Dispatcher6: bot_power, whose
    // DataLinkTrigger0 plays DL_override_activated, which needs !M12BotsDestroyed: the power precedes the bots)
    { op: 'place', at: [1677, 1320, -2031], view: [-4515, 32823], harness: true, note: '48 units east of Keypad1 (1629,1320,-2014; event overload2), aimed at it' },
    { op: 'frob', target: 'Keypad1', watch: ['Keypad1'] },
    { op: 'key', names: ['5', '8', '6', '8'], gap: 0.5 },
    { op: 'wait', flag: 'DL_override_activated_part_Played', timeout: 120 },
    { op: 'place', at: [-2431, -96, -2095], view: [-2423, 65505], harness: true, note: '60 units west of Keypad0 (-2371,-96,-2070), aimed at its cover DeusExMover16 (-2376,-110,-2050); on the floor (48 units lands on a box in the cold map, on the floor in the slot)' },
    { op: 'frob', target: 'DeusExMover16', watch: ['DeusExMover16'] },
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [-2399, -68, -2063], view: [-8965, 57305], harness: true, note: '40 units north-west of Keypad0 (-2371,-96,-2070), aimed at it, the cover open (face-chain 12 12 in the slot\'s level)' },
    { op: 'frob', target: 'Keypad0', watch: ['Keypad0'] },
    { op: 'key', names: ['5', '8', '6', '8'], gap: 0.5 },
    { op: 'wait', flag: 'DL_override_activated_Played', timeout: 120 },
    { op: 'snap', label: 'm12-2-power' },

    // the four enemy bots, each from 300 units east of its paused place (stand --aim, a clear line), the GEP gun until the Timer's InfoLink of the new count has played
    { op: 'belt', n: 6, note: 'the GEP gun (the slot\'s belt 6)' },
    { op: 'place', at: [-2000, 3489, -1999], view: [-1067, 32768], harness: true, note: '300 units east of SecurityBot0 paused at (-2300,3489,-1991), aimed at it' },
    { op: 'click', until: { flag: 'DL_bots_left_3_Played' }, gap: 2.5, max: 12, watch: ['SecurityBot0'] },
    { op: 'place', at: [676, 3436, -1999], view: [-1067, 32768], harness: true, note: '300 units east of SecurityBot2 paused at (376,3436,-1991), aimed at it' },
    { op: 'click', until: { flag: 'DL_bots_left_2_Played' }, gap: 2.5, max: 12, watch: ['SecurityBot2'] },
    { op: 'place', at: [486, 5679, -2149], view: [-86, 32768], harness: true, note: '300 units east of MilitaryBot4 paused at (186,5679,-2112), aimed at it' },
    { op: 'click', until: { flag: 'DL_bots_left_1_Played' }, gap: 2.5, max: 12, watch: ['MilitaryBot4'] },
    { op: 'place', at: [-974, 6166, -2142], view: [-306, 32768], harness: true, note: '300 units east of MilitaryBot5 paused at (-1274,6166,-2112), aimed at it' },
    { op: 'click', until: { flag: 'M12BotsDestroyed' }, gap: 2.5, max: 12, watch: ['MilitaryBot5'] },
    { op: 'wait', flag: 'DL_command_bots_destroyed_Played', timeout: 120 },
    { op: 'wait', seconds: 3 },
    { op: 'state', label: 'comhqdoor', actor: 'DeusExMover5', fields: ['KeyNum', 'bLocked'] },
    { op: 'snap', label: 'm12-3-bots' },

    // the comm center: Tony Mares (radius 100, WaitingFor) completes GoToCommunicationsCenter and adds FindGarySavage
    { op: 'place', at: [-1849, 5677, -2126], view: [-6443, 32786], harness: true, turnFirst: true, note: '60 units east of TonyMares (ScientistMale0 at -1909,5677,-2130), facing him' },
    { op: 'conv', name: 'MeetTonyMares', watch: ['ScientistMale0'], timeout: 180 },
    { op: 'wait', seconds: 5 },
    { op: 'snap', label: 'm12-4-tony' },

    // the control room's Teleporter2 to 12_Vandenberg_Computer#computer: behind door_controlroom, whose key the chain does not fetch from the tunnels (the
    // placement passes the locked door; 12_Vandenberg_Tunnels and its DL_JockLeaving, which adds UplinkDaedalus, are not on the chain)
    { op: 'place', at: [559, 2231, -1598], view: [0, 0], drop: true, harness: true, note: 'above Teleporter2 (559,2231,-1688, radius 128): the fall enters it' },
    { op: 'travel', to: '12_vandenberg_computer', label: 'leg1' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm12-5-computer' },

    // Gary Savage (bump/frob): FixComputer, the Milnet login's note, control_doors1
    { op: 'place', at: [620, 2716, -2161], view: [-6112, 32762], harness: true, turnFirst: true, note: '60 units east of GarySavage0 (560,2716,-2162), aimed at him' },
    { op: 'frob', target: 'GarySavage0', watch: ['GarySavage0'] },
    { op: 'conv', name: 'GaryComputerBriefing', watch: ['GarySavage0'], timeout: 180 },
    { op: 'wait', seconds: 3 },
    // ComputerPersonal1's one special option "Uplink Milnet" (login GSavage/Tiffany, its userList; GaryComputerBriefing's note): Daedalus_linked, FlagTrigger0 sets
    // Heliosborn (the one-option button at (641,329), chain-plan.mjs terminal)
    { op: 'watch', actors: ['ComputerPersonal1'] },
    { op: 'place', at: [2306, 2658, -1722], view: [-9285, 40873], harness: true, note: '60 units north-east of ComputerPersonal1 (2263,2616,-1757), aimed at it' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal1', watch: ['ComputerPersonal1'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'GSavage' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'Tiffany' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 329], note: 'the special option "Uplink Milnet"' },
    { op: 'wait', flag: 'Heliosborn', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    { op: 'snap', label: 'm12-6-uplink' },
    // DL_HeliosBorn (DataLinkTrigger0/1/3 by the uplink, checkFlag Heliosborn): its GaryWalksToPosition sends Gary on his patrol, whose Trigger1 (ClassProximity GarySavage)
    // fires bobtalk: FlagTrigger1 sets M12PageAppears and Mission12.Timer brings Bob Page in (MS_M12PageAppeared)
    { op: 'place', at: [2160, 2647, -1722], view: [0, 32768], harness: true, note: '190 units east of DataLinkTrigger1 (1970,2647,-1766, radius 128; a drop above it is outside the world), facing west' },
    { op: 'walk', seconds: 0.8 },
    { op: 'wait', flag: 'DL_HeliosBorn_Played', timeout: 120 },
    { op: 'snap', label: 'm12-7-heliosborn' },
    // Gary's patrol: PatrolPoint0 (629,2710) then PatrolPoint1 (1052,2661), beside Trigger1 (1043,2678) and the Earth (1077,2792) where Page appears; the player
    // stands in that room with Gary's path in view (a pawn pausing on a patrol point sets bStasis and waits to be seen) and within PageHostageBriefing's radius
    // (200) of PatrolPoint1; GaryTalksToPlayer then runs Gary to the player for GaryHostageBriefing (radius 120)
    { op: 'place', at: [1183, 2686, -2161], view: [0, 32500], harness: true, turnFirst: true, note: '133 units east of PatrolPoint1 (1052,2661,-2195), 150 from the Earth (stand), facing west along Gary\'s path from (560,2716)' },
    { op: 'conv', name: 'PageHostageBriefing', watch: ['GarySavage0'], timeout: 300 },
    { op: 'conv', name: 'GaryHostageBriefing', watch: ['GarySavage0'], timeout: 180 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm12-8-hostage' },
    { op: 'place', at: [171, 2745, -1900], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger2 (171,2745,-1990, radius 180; DL_JockBack, checkFlag GaryHostageBriefing_Played)' },
    { op: 'wait', flag: 'DL_JockBack_Played', timeout: 120 },
    { op: 'place', at: [592, 1984, -1566], view: [0, 0], drop: true, harness: true, note: 'above Teleporter2 (592,1984,-1656, radius 40): the fall enters it' },
    { op: 'travel', to: '12_vandenberg_cmd', label: 'leg2' },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'state', label: 'tong-in-world', actor: 'TracerTong0', fields: ['bHidden'] },
    { op: 'snap', label: 'm12-9-cmd-again' },

    // Mission12.FirstFrame on the return (GaryHostageBriefing_Played): the helicopter, Jock and Tong enter. TongTrigger (Tong, radius 300) jumps to TongSick (Jock's;
    // with Ray_Dead set and no EverettMechanicComment its Rattle branch), whose Map_Exit fires Dispatcher10: TongGO, then mission_done (MapExit0 to the gas station
    // along heli_camera)
    { op: 'place', at: [6286, 7622, -3059], view: [-2796, 0], harness: true, turnFirst: true, note: '150 units west of TracerTong0 (6436,7622,-3061 in the restored level; stand --aim), facing him' },
    { op: 'conv', watch: ['TracerTong0'], timeout: 240, note: 'TongTrigger, then TongSick' },
    { op: 'travel', to: '12_Vandenberg_gas', label: 'leg3', timeout: 240 },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'm12-10-gas' },

    // Tiffany (radius 70): the choice that sends her to the helicopter (ChoiceSpeechLabel_1 jumps to Go: TiffanyRunning, TiffanyGo sends her RunningTo Tiff_0).
    // Mission12.Timer, once MeetTiffanySavage has played, brings the helicopter in and blows the junkyard doors (TiffanyRescued, MS_ChopperGasUnhidden).
    // M12JockFinal (alive) needs TiffanyHeli, which FlagTrigger2 (ClassProximity TiffanySavage, -3254,-451,-959) sets when she reaches the helicopter; with her
    // guards alive (the chain does not fight them) MJ12Troop4 and MIB0, beside her, see her run and attack (Play: MIB0's plasma rifle kills her about 6 s
    // after the choice), so the chain takes the mission's other branch: TiffanySavage_Dead (ScriptedPawn.Died, bImportant), the Timer's DL_JockTiffanyDead
    // (ReturnToHelicopter), and M12JockFinal2's Dead branch at the helicopter. Whether the original's guards kill her as surely is for its capture to show
    { op: 'place', at: [109, 608, -973], view: [-6904, 65513], harness: true, turnFirst: true, note: '60 units west of TiffanySavage0 (169,608,-981), facing her' },
    { op: 'conv', name: 'MeetTiffanySavage', choose: [{ index: 1, label: 'Go' }], watch: ['TiffanySavage0'], timeout: 240 },
    { op: 'wait', flag: 'TiffanySavage_Dead', timeout: 120 },
    { op: 'wait', flag: 'DL_JockTiffanyDead_Played', timeout: 120 },
    { op: 'snap', label: 'm12-11-tiffany' },

    // Jock's helicopter (BlackHelicopter0, brought in at -3208,135,-906; radius 461, blocks players, so its radius conversations are frobbed): M12JockFinal2 (needs
    // TiffanySavage_Dead and TiffanyRescued), its Dead branch: UN_BlackHeli, MapExit0 along heli_camera to 14_Vandenberg_sub
    { op: 'place', at: [-2688, 135, -951], view: [125, 32761], harness: true, turnFirst: true, note: '520 units east of BlackHelicopter0 (-3208,135,-906), aimed at it (agentc ring search in the level the chain reaches)' },
    { op: 'frob', target: 'BlackHelicopter0', watch: ['BlackHelicopter0'] },
    { op: 'conv', name: 'M12JockFinal2', timeout: 180 },
    { op: 'travel', to: '14_Vandenberg_sub', label: 'exit', timeout: 240 },
    { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
    { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'm12-12-sub' },
    // mission 14's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 112, label: 'exit' },
  ],
};
