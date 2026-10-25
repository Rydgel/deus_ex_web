/** Mission 6, Hong Kong (docs/stage-6-inventory.md 06.6, docs/stage-6-chains.md): from mission 5's exit (the save its chain pinned in 06_HongKong_Helibase,
 * 15 s after the arrival) to the exit to 08_NYC_Street. The maps' own means: on the helibase DL_Jock_01 (the ring of DataLinkTriggers around PlayerStart2),
 * the weapon lock Button8 (jockweapons: FlagTrigger0 sets helicopter_armed, Mission06.Timer plays DL_Jock_02), FlagTrigger1 (touched with helicopter_armed:
 * make_a_break, Dispatcher5's fire_missile: FlagTrigger2 sets helicopter_fire, and the Timer fires the chopper's tracking RocketLAWs at the Blast_doors until
 * none stands: MS_DoorsBlown, DL_Jock_03), the elevator's Button3 (change_floors: MapExit0); in the Market DL_Jock_05 and Teleporter11 in the compound's
 * basement; in Tong's base MeetTracerTong (radius 90; To_Operating_Room), the operating theater's Trigger0 (Killswitch_Sequence: Dispatcher0's Operation2
 * after 29 s plays DL_TongFixesKillswitch2, KillswitchFixed) and MeetTracerTong2 (radius 90; GetROM and the VersaLife employee ID 06288); the VersaLife
 * elevator north of the market (Keypad3 06288, Button4), VersaLife's upper elevator (Keypad1 6512, Button8) to the MJ12 lab, its ComputerPersonal0
 * (MCHOW/DAMOCLES: its userList) and "Upload Nanotech Blade ROM" (TongHasRom: FlagTrigger0 sets Have_ROM), DL_Tong_07 (UniteTriads), back by the lab's
 * Button23 and VersaLife's Button12; the Market's FirstFrame (Have_ROM, MeetTracerTong_Played) puts Quick and Chen in the temple: TriadCeremony (radius 160);
 * M07Briefing (Tong, frob; the Level 2 code 55655); the lab's elevator (Keypad0 55655, Button44) to the Storage: DL_Daedalus_04, ComputerPersonal0
 * (MCHOW/DAMOCLES) "Upload Virus Schematics" (VirusUploaded: VL_Got_Schematic) and "Open UC Chamber", FlagTrigger5 (TongDataLink4: DL_Tong_04), FlagTrigger8
 * and 9 (the cascade shutdown console raised), Keypad2 on it (525: Self_Destruct: VL_UC_Destroyed, DL_Daedalus_05 sets Versalife_Done), the water pipe's
 * Teleporter4 to the canal and its Teleporter11 to the Market; M08Briefing (Tong, frob, needs Versalife_Done); the Market's FirstFrame (M08Briefing_Played)
 * brings Jock's helicopter into the compound: M06JockExit (radius 240; Jock_Chopper: Dispatcher1, outro_trigger, MapExit2 and its camera path).
 *
 * Not taken: the triads' side of the story (Maggie Chow, the sword's evidence, Max Chen, Gordon Quick's QuickLetPlayerIn). No conversation or trigger of this
 * chain needs its flags (TriadCeremony needs Have_ROM and MeetTracerTong_Played). QuickLetPlayerIn shows the compound gate's and basement's real keypads and
 * keeps the compound's Breakintocompound FlagTriggers (radius 630, LumpathPissed) and the Tong base's TracerGone ones quiet: the placements reach Teleporter11
 * under the compound and Tong without them, and the Jock placement stands inside the compound's FlagTrigger1 without a Touch (placed inside its cylinder: it
 * stays collidable in Play). The placements also walk past VersaLife's floors between its two elevators and the Storage's doors. DL_Tong_05 (the Storage's
 * bottom, EscapeVersaLife and ReportToTong2) is not needed by M08Briefing and is not played. Placements from scripts/chain-plan.mjs (`drop`, `approach`,
 * `stand`, `face`, `face-chain`, `terminal`) in Play's world, and around a pawn in the level the chain reaches (Tong, the helicopter). */
const cheats = [
  { op: 'line', text: 'set DeusEx.JCDentonMale bCheatsEnabled True', harness: true },
  { op: 'line', text: 'set DeusEx.JCDentonMale ReducedDamageType All', harness: true },
];
export default {
  mission: '06',
  steps: [
    { op: 'start', kind: 'slot', source: 'chain', chain: '05', slot: 'Save0105', index: 105 },
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g1-loaded' },
    ...cheats,

    // the helibase: DL_Jock_01 from the ring of DataLinkTriggers around PlayerStart2 (the save's player stands between them)
    { op: 'place', at: [1928, 60, 571], view: [0, 0], drop: true, harness: true, note: 'above DataLinkTrigger1 (1928,60,457, radius 36; DL_Jock_01): chain-plan.mjs drop, lifted 50' },
    { op: 'wait', flag: 'DL_Jock_01_Played', timeout: 120 },
    // the weapon lock: Button8 (event jockweapons: FlagTrigger0, not touchable, sets helicopter_armed), Mission06.Timer plays DL_Jock_02
    { op: 'place', at: [1438, 607, 649], view: [-7222, 40866], harness: true, note: '55 units north-east of Button8 (1399,568,642), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Button8' },
    { op: 'wait', flag: 'helicopter_armed', timeout: 30 },
    { op: 'wait', flag: 'DL_Jock_02_Played', timeout: 120 },
    { op: 'snap', label: 'g2-armed' },
    // FlagTrigger1 (touched with helicopter_armed): make_a_break, Dispatcher5's takeoff and fire_missile 4 s later (FlagTrigger2 sets helicopter_fire); the Timer
    // then fires the chopper's RocketLAWs at the Blast_doors every 3 s until none stands (MS_DoorsBlown, DL_Jock_03)
    { op: 'place', at: [570, 620, 514], view: [0, 0], drop: true, harness: true, note: 'above FlagTrigger1 (570,620,424, radius 96): chain-plan.mjs drop, lifted 50' },
    { op: 'wait', flag: 'helicopter_fire', timeout: 30 },
    { op: 'wait', flag: 'MS_DoorsBlown', timeout: 120 },
    { op: 'wait', flag: 'DL_Jock_03_Played', timeout: 120 },
    { op: 'snap', label: 'g3-doors' },
    // the elevator behind the blast doors: Button3 (change_floors: MapExit0 to the Market's cargoup)
    { op: 'place', at: [-1901, -8, 476], view: [-10237, 57396], harness: true, note: '40 units north-west of Button3 (-1872,-36,455) in the elevator, aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Button3' },
    { op: 'travel', to: '06_HongKong_WanChai_Market', label: 'leg1' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g4-market' },

    // the Market: DL_Jock_05 (FindTracerTong, CheckCompound) on the way out of the cargo lift, then Teleporter11 under the compound to Tong's base
    { op: 'place', at: [-906, -1344, 80], view: [0, 0], harness: true, note: '150 units west of DataLinkTrigger2 (-756,-1344,40, radius 96; DL_Jock_05), facing it: chain-plan.mjs approach' },
    { op: 'walk', seconds: 1 },
    { op: 'wait', flag: 'DL_Jock_05_Played', timeout: 120 },
    { op: 'place', at: [2089, 290, -400], view: [0, 16384], harness: true, note: '150 units south of Teleporter11 (2089,440,-440, radius 55), facing it: chain-plan.mjs approach' },
    { op: 'walk', untilTravel: true, seconds: 2 },
    { op: 'travel', to: '06_HongKong_TongBase', label: 'leg2' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g5-tongbase' },

    // Tong: MeetTracerTong by its radius (90); its To_Operating_Room sends him RunningTo TongOperates (PatrolPoint4) over the operating theater
    { op: 'place', at: [128, -143, 49], view: [-6313, 16409], turnFirst: true, harness: true, note: '60 units south of TracerTong0 (128,-83,46), facing him: chain-plan.mjs stand' },
    { op: 'conv', name: 'MeetTracerTong', watch: ['TracerTong0'], timeout: 300 },
    { op: 'snap', label: 'g6-tong' },
    // the centre of the operating theater: Trigger0 (Killswitch_Sequence) and DataLinkTrigger0 (DL_TongFixesKillswitch1); Dispatcher0's last event (Operation2,
    // 0+2+10+5+0+12 s) is DataLinkTrigger1's: DL_TongFixesKillswitch2 sets KillswitchFixed
    { op: 'place', at: [1510, 125, -179], view: [0, 0], harness: true, note: '120 units west of Trigger0 (1630,125,-184, radius 36), facing it: chain-plan.mjs approach; the walk stops near the centre' },
    { op: 'walk', seconds: 0.45 },
    { op: 'wait', flag: 'KillswitchFixed', timeout: 120 },
    { op: 'wait', flag: 'DL_TongFixesKillswitch2_Played', timeout: 60 },
    { op: 'snap', label: 'g7-killswitch' },
    // MeetTracerTong2 by its radius (90, needs KillswitchFixed): GetROM and the notes (the VersaLife employee ID); its TracerWanders sets him Patrolling
    { op: 'place', at: [1106, 128, 113], view: [-7263, 0], turnFirst: true, harness: true, note: '50 units west of TracerTong0 at PatrolPoint4 TongOperates (1156,128,110 in Play), facing him: chain-plan.mjs stand --aim' },
    { op: 'conv', name: 'MeetTracerTong2', watch: ['TracerTong0'], timeout: 300 },
    { op: 'snap', label: 'g8-tong2' },
    { op: 'place', at: [1241, -886, 386], view: [0, 0], drop: true, harness: true, note: 'above Teleporter0 (1241,-886,296, radius 55): chain-plan.mjs drop, lifted 50' },
    { op: 'travel', to: '06_HongKong_WanChai_Market', label: 'leg3' },
    ...cheats,
    { op: 'wait', seconds: 3 },

    // the VersaLife elevator north of the market: Keypad3 with the employee ID MeetTracerTong2's note gives (elevator_door01: TriggerOpenTimed, 6 s), Button4
    // (change_floors01: MapExit1 to VersaLife's lobby)
    { op: 'place', at: [1791, -585, -60], view: [-11546, 49112], harness: true, note: '40 units north of Keypad3 (1791,-625,-100), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Keypad3', watch: ['Keypad3'] },
    { op: 'key', names: ['0', '6', '2', '8', '8'], gap: 0.5, note: 'Keypad3 validCode 06288' },
    { op: 'wait', seconds: 3 },
    { op: 'state', label: 'market-elevator', actor: 'DeusExMover4', fields: ['KeyNum', 'bLocked'] },
    { op: 'place', at: [1860, -795, -111], view: [-2158, 32851], harness: true, note: '35 units east of Button4 (1825,-795,-80), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Button4' },
    { op: 'travel', to: '06_HongKong_VersaLife', label: 'leg4' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g9-versalife' },
    // VersaLife's upper elevator: Keypad1 (elevator_door, TriggerOpenTimed 6 s), Button8 (change_floors: MapExit3 to the MJ12 lab's cathedral)
    { op: 'place', at: [169, 344, 465], view: [-1921, 32788], harness: true, note: '40 units east of Keypad1 (129,344,496), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Keypad1', watch: ['Keypad1'] },
    { op: 'key', names: ['6', '5', '1', '2'], gap: 0.5, note: 'Keypad1 validCode 6512' },
    { op: 'wait', seconds: 3 },
    { op: 'state', label: 'versalife-elevator', actor: 'DeusExMover2', fields: ['KeyNum', 'bLocked'] },
    { op: 'place', at: [36, 347, 465], view: [-2803, 65463], harness: true, note: '60 units west of Button8 (96,347,487), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Button8' },
    { op: 'travel', to: '06_HongKong_MJ12lab', label: 'leg5' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g10-lab' },

    // the ROM: ComputerPersonal0 (MCHOW/DAMOCLES: its userList) and its one special option (TongHasRom: FlagTrigger0 sets Have_ROM, GoalCompleteTrigger0 GetROM)
    // a computer loads in state Off at its Begin code's FinishAnim (bAnimating): Frob does nothing until the animation ends, which needs it drawn (the
    // headless stand-in from the placement on, then 2 s; docs/stage-6-chains.md, ending 2)
    { op: 'watch', actors: ['ComputerPersonal0'] },
    { op: 'place', at: [31, -229, -270], view: [-11032, 40907], harness: true, note: '45 units north-east of ComputerPersonal0 (-1,-261,-311), aimed at it: chain-plan.mjs terminal' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal0', watch: ['ComputerPersonal0'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'mchow' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'damocles' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 329], note: '"Upload Nanotech Blade ROM" (the one button at (361,209) of Play\'s 720x480 root; chain-plan.mjs terminal)' },
    { op: 'wait', flag: 'Have_ROM', timeout: 30 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    // DL_Tong_07 (needs Have_ROM): DataLinkTrigger5, one of the four around the computer's room (DataLinkTrigger6's centre is over the shaft)
    { op: 'place', at: [156, 53, -339], view: [0, 49152], harness: true, note: '130 units north of DataLinkTrigger5 (156,-77,-344, radius 96; DL_Tong_07), facing it: chain-plan.mjs approach' },
    { op: 'walk', seconds: 1 },
    { op: 'wait', flag: 'DL_Tong_07_Played', timeout: 120 },
    { op: 'snap', label: 'g11-rom' },
    // back to the Market: the lab's Button23 (change_floors01: MapExit2 to VersaLife's secret elevator), VersaLife's Button12 (change_floors01: MapExit2)
    { op: 'place', at: [91, 1629, 177], view: [-1381, 49131], harness: true, note: '60 units north of Button23 (91,1569,208), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Button23' },
    { op: 'travel', to: '06_HongKong_VersaLife', label: 'leg6' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [72, 527, -111], view: [-4509, 32648], harness: true, note: '35 units east of Button12 (37,527,-88), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Button12' },
    { op: 'travel', to: '06_HongKong_WanChai_Market', label: 'leg7' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g12-market' },

    // the ceremony: the Market's FirstFrame (Have_ROM, MeetTracerTong_Played, not TriadCeremony_Played) teleported Quick to QuickInTemple and Chen to
    // ChenInTemple; TriadCeremony by its radius (160)
    { op: 'place', at: [-791, 829, 49], view: [-4919, 0], turnFirst: true, harness: true, note: '80 units west of PatrolPoint15 QuickInTemple (-711,829,47), facing it: chain-plan.mjs stand --aim' },
    { op: 'conv', name: 'TriadCeremony', watch: ['GordonQuick0', 'MaxChen0'], timeout: 300 },
    { op: 'snap', label: 'g13-ceremony' },
    { op: 'place', at: [2089, 290, -400], view: [0, 16384], harness: true, note: '150 units south of Teleporter11 (2089,440,-440, radius 55), facing it: chain-plan.mjs approach' },
    { op: 'walk', untilTravel: true, seconds: 2 },
    { op: 'travel', to: '06_HongKong_TongBase', label: 'leg8' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g14-tongbase' },
    // M07Briefing (frob, needs TriadCeremony_Played): Tong patrols TongStation01..03 (pauses 10, 8, 10 s); undrawn since the last visit, he stands at
    // TongStation01 in Play
    // the right button reaches a moving NPC only if he stands still: the original types the release of a held level and ParseRightClick over about 1.5 s
    // (mission 5's Alex walked out of the view in that time): his GroundSpeed is 0 for the conversation, then his class's 250 again
    { op: 'line', text: 'set DeusEx.TracerTong GroundSpeed 0', harness: true },
    { op: 'wait', seconds: 2 },
    { op: 'placeNear', actor: 'TracerTong0', distance: 40, bearing: 0, harness: true, turnFirst: true, note: '40 units east of TracerTong0 where he is (at TongStation01 (742,-32,15) in Play), aimed at him' },
    { op: 'frob', target: 'TracerTong0' },
    { op: 'conv', name: 'M07Briefing', watch: ['TracerTong0'], timeout: 300 },
    { op: 'line', text: 'set DeusEx.TracerTong GroundSpeed 250', harness: true },
    { op: 'snap', label: 'g15-briefing' },
    { op: 'place', at: [1241, -886, 386], view: [0, 0], drop: true, harness: true, note: 'above Teleporter0 (1241,-886,296, radius 55): chain-plan.mjs drop, lifted 50' },
    { op: 'travel', to: '06_HongKong_WanChai_Market', label: 'leg9' },
    ...cheats,
    { op: 'wait', seconds: 3 },

    // the Storage by the lab (M07Briefing's note: the Level 2 code 55655): the Market's and VersaLife's elevators again
    { op: 'place', at: [1791, -585, -60], view: [-11546, 49112], harness: true, note: '40 units north of Keypad3 (1791,-625,-100), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Keypad3', watch: ['Keypad3'] },
    { op: 'key', names: ['0', '6', '2', '8', '8'], gap: 0.5, note: 'Keypad3 validCode 06288' },
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [1860, -795, -111], view: [-2158, 32851], harness: true, note: '35 units east of Button4 (1825,-795,-80), aimed at it: chain-plan.mjs face' },
    // the button the first trip pressed was filed with isPressed and its 0.5 s timer (buttonLitTime) pending; an actor in stasis (bStasis, not drawn for 5 s:
    // Actor.Tick) runs no timer, and only the drawing of the button the player faces releases it: the headless stand-in, then the timer's 0.5 s
    { op: 'watch', actors: ['Button4'] },
    { op: 'wait', seconds: 1 },
    { op: 'frob', target: 'Button4' },
    { op: 'travel', to: '06_HongKong_VersaLife', label: 'leg10' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [169, 344, 465], view: [-1921, 32788], harness: true, note: '40 units east of Keypad1 (129,344,496), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Keypad1', watch: ['Keypad1'] },
    { op: 'key', names: ['6', '5', '1', '2'], gap: 0.5, note: 'Keypad1 validCode 6512' },
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [36, 347, 465], view: [-2803, 65463], harness: true, note: '60 units west of Button8 (96,347,487), aimed at it: chain-plan.mjs face' },
    { op: 'watch', actors: ['Button8'], note: 'pressed on the first trip: its timer waits for the drawing (above, Button4)' },
    { op: 'wait', seconds: 1 },
    { op: 'frob', target: 'Button8' },
    { op: 'travel', to: '06_HongKong_MJ12lab', label: 'leg11' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g16-lab' },
    // the lab's elevator to the Storage: Keypad0 (elevator_door, TriggerOpenTimed 4 s), Button44 (change_floors: MapExit0 to the Storage's basement)
    { op: 'place', at: [-1462, 766, -79], view: [-2011, 32725], harness: true, note: '40 units east of Keypad0 (-1502,766,-48), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Keypad0', watch: ['Keypad0'] },
    { op: 'key', names: ['5', '5', '6', '5', '5'], gap: 0.5, note: 'Keypad0 validCode 55655 (M07Briefing\'s note)' },
    { op: 'wait', seconds: 3 },
    { op: 'state', label: 'lab-elevator', actor: 'DeusExMover53', fields: ['KeyNum', 'bLocked'] },
    { op: 'place', at: [-1333, 861, -79], view: [-2795, 49169], harness: true, note: '60 units north of Button44 (-1333,801,-57), aimed at it: chain-plan.mjs face' },
    { op: 'frob', target: 'Button44' },
    { op: 'travel', to: '06_HongKong_Storage', label: 'leg12' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g17-storage' },

    // the Storage: DL_Daedalus_04 (needs M07Briefing_Played; DestroyUniversalConstructor) by the elevator
    { op: 'place', at: [-733, -724, 1069], view: [0, 49152], harness: true, note: '150 units north of DataLinkTrigger9 (-733,-874,1064, radius 96; DL_Daedalus_04), facing it: chain-plan.mjs approach' },
    { op: 'walk', seconds: 0.6 },
    { op: 'wait', flag: 'DL_Daedalus_04_Played', timeout: 120 },
    // the schematics: ComputerPersonal0 (MCHOW/DAMOCLES: its userList), "Upload Virus Schematics" (VirusUploaded: FlagTrigger0 sets VL_Got_Schematic), "Open UC
    // Chamber" (UC_Chamber_Door, TriggerToggle); the computer drawn from the placement on (the lab's computer, above)
    { op: 'watch', actors: ['ComputerPersonal0'] },
    { op: 'place', at: [44, -533, 609], view: [-11016, 32694], harness: true, note: '45 units east of ComputerPersonal0 (-1,-533,569), aimed at it: chain-plan.mjs terminal' },
    { op: 'wait', seconds: 2 },
    { op: 'frob', target: 'ComputerPersonal0', watch: ['ComputerPersonal0'] },
    { op: 'wait', seconds: 2 },
    { op: 'type', text: 'mchow' },
    { op: 'key', names: ['TAB'] },
    { op: 'type', text: 'damocles' },
    { op: 'key', names: ['ENTER'] },
    { op: 'wait', seconds: 2 },
    { op: 'point', at: [641, 314], note: '"Upload Virus Schematics" (the first of two buttons at (361,194) of Play\'s 720x480 root; chain-plan.mjs terminal)' },
    { op: 'wait', flag: 'VL_Got_Schematic', timeout: 30 },
    { op: 'point', at: [641, 344], note: '"Open UC Chamber" (the second button, (361,224))' },
    { op: 'wait', seconds: 2 },
    { op: 'key', names: ['ESC', 'ESC'], note: 'the first Escape logs out to the login screen, the second closes the terminal' },
    { op: 'state', label: 'uc-chamber', actor: 'DeusExMover15', fields: ['KeyNum', 'bLocked'] },
    // DL_Tong_04 (needs M07Briefing_Played): FlagTrigger5, touched with VL_Got_Schematic, fires TongDataLink4
    { op: 'place', at: [11, -849, 642], view: [0, 0], drop: true, harness: true, note: 'above FlagTrigger5 (11,-849,552, radius 96): chain-plan.mjs drop, lifted 50' },
    { op: 'wait', flag: 'DL_Tong_04_Played', timeout: 120 },
    { op: 'snap', label: 'g18-schematic' },
    // the cascade shutdown console: FlagTrigger8 and FlagTrigger9 (touched with VL_Got_Schematic) raise control_platform (Keypad2 rides on it) and open control_cover
    { op: 'place', at: [-6, 599, -890], view: [0, 0], drop: true, harness: true, note: 'above FlagTrigger8 (-6,599,-1000, radius 80) and FlagTrigger9 (radius 220): chain-plan.mjs drop, lifted 70 (50 starts inside)' },
    { op: 'wait', seconds: 5 },
    { op: 'state', label: 'control-platform', actor: 'DeusExMover34', fields: ['KeyNum', 'bLocked'] },
    // Keypad2 (Self_Destruct: Dispatcher3's Control_Rod (FlagTrigger1 sets VL_UC_Destroyed), ..., Destroy_AUC (ReadyToDestroyAUC), Shocker, CongratsJC
    // (DataLinkTrigger4: DL_Daedalus_05, needs M07Briefing_Played; with VL_Got_Schematic it sets Versalife_Done)
    { op: 'place', at: [24, 589, -975], view: [-9063, 40997], harness: true, note: '40 units north-east of Keypad2 on the raised platform (-4,561,-983 in Play), aimed at it: chain-plan.mjs face-chain' },
    { op: 'frob', target: 'Keypad2', watch: ['Keypad2'] },
    { op: 'key', names: ['5', '2', '5'], gap: 0.5, note: 'Keypad2 validCode 525' },
    { op: 'wait', flag: 'VL_UC_Destroyed', timeout: 60 },
    { op: 'wait', flag: 'DL_Daedalus_05_Played', timeout: 120 },
    { op: 'wait', flag: 'Versalife_Done', timeout: 30 },
    { op: 'snap', label: 'g19-uc' },
    // out through the water pipe to the canal, and the canal's Teleporter11 to the Market
    { op: 'place', at: [-1791, -1707, 1661], view: [0, 32768], harness: true, note: '140 units east of Teleporter4 (-1931,-1707,1656, radius 80; the water pipe), facing it: chain-plan.mjs approach' },
    { op: 'walk', untilTravel: true, seconds: 2 },
    { op: 'travel', to: '06_HongKong_WanChai_Canal', label: 'leg13' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [1232, 1700, 68], view: [0, 16384], harness: true, note: '120 units south of Teleporter11 (1232,1820,63, radius 56), facing it: chain-plan.mjs approach' },
    { op: 'walk', untilTravel: true, seconds: 2 },
    { op: 'travel', to: '06_HongKong_WanChai_Market', label: 'leg14' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'place', at: [2089, 290, -400], view: [0, 16384], harness: true, note: '150 units south of Teleporter11 (2089,440,-440, radius 55), facing it: chain-plan.mjs approach' },
    { op: 'walk', untilTravel: true, seconds: 2 },
    { op: 'travel', to: '06_HongKong_TongBase', label: 'leg15' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g20-tongbase' },

    // M08Briefing (frob, needs Versalife_Done): undrawn since M07Briefing, Tong stopped on his way to TongStation02; the player waits at that station, facing
    // it and off his way, with Tong drawn (the headless stand-in), until he stands there for its 8 s (5 s: he arrives after about 3 s in Play)
    { op: 'place', at: [529, 243, 47], view: [-5866, 8192], turnFirst: true, harness: true, note: '65 units south-west of PatrolPoint1 TongStation02 (575,289,15) on the floor, aimed at where Tong stands (46 high): placements around the station in the level the chain reaches' },
    { op: 'watch', actors: ['TracerTong0'] },
    { op: 'wait', seconds: 5 },
    { op: 'frob', target: 'TracerTong0' },
    { op: 'conv', name: 'M08Briefing', watch: ['TracerTong0'], timeout: 300 },
    { op: 'snap', label: 'g21-briefing' },
    { op: 'place', at: [1241, -886, 386], view: [0, 0], drop: true, harness: true, note: 'above Teleporter0 (1241,-886,296, radius 55): chain-plan.mjs drop, lifted 50' },
    { op: 'travel', to: '06_HongKong_WanChai_Market', label: 'leg16' },
    ...cheats,
    { op: 'wait', seconds: 3 },
    { op: 'snap', label: 'g22-market' },

    // Jock: the Market's FirstFrame (M08Briefing_Played) put BlackHelicopter0 in the world in the compound; M06JockExit by its radius (240): Jock_Chopper,
    // Dispatcher1's outro_trigger 0.65 s later (InterpolateTrigger1, MapExit2 and its camera path) to 08_NYC_Street
    { op: 'place', at: [500, 657, 56], view: [-2336, 0], turnFirst: true, harness: true, note: '180 units west of BlackHelicopter0 (680,657,96 in the world), facing it: placements around it in the level the chain reaches' },
    { op: 'conv', name: 'M06JockExit', watch: ['BlackHelicopter0'], timeout: 180 },
    { op: 'travel', to: '08_NYC_Street', label: 'exit', timeout: 240 },
    ...cheats,
    { op: 'wait', seconds: 15 },
    { op: 'snap', label: 'g23-newyork' },
    // mission 8's chain starts here, in both programs (docs/stage-6-chains.md "Starts")
    { op: 'save', index: 106, label: 'exit' },
  ],
};
