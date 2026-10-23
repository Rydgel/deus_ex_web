/** The named boundaries of the conversation census (scripts/census-conversations.mjs, rows 6.4.*.3 of docs/stage-6-exit-criteria.md): own conversations of the
 * mission lists that do not start in Play, each with the family of its reason. Names of conversations only (the game's text stays out of Git).
 *
 * A boundary is not a Play stop: in each family the ORIGINAL's own code or data refuses the start, and Play runs that code. Two kinds:
 *   data   the refusal follows from the installed data alone; the census finds the same family on every run.
 *   state  the refusal follows from what the pawns do in the first seconds (an AI state in which ScriptedPawn.CanConverse is false, speakers farther apart than 300
 *          units); the census accepts any refusal of this kind for a name listed here, because the pawns' reactions to the player vary from run to run.
 * scripts/validate-conversations-census.mjs fails on a conversation that neither runs nor is named here with a family the census still finds; a name here that runs
 * is reported, not failed (the table can shrink). Regenerate with `node scripts/census-conversations.mjs --boundaries <census json>` after a census. */

export const FAMILIES = {
  'unbound: no actor carries the owner name': {
    kind: 'data',
    reason: 'the conversation list of the mission holds a conversation whose owner (conOwnerName) is the BindName or BarkBindName of no actor in any installed map of that mission, so '
      + 'ConBindEvents attaches it to nothing and nothing in the original can start it (the owner exists in other missions\' maps only, or in none)',
    evidence: 'scripts/inventory-campaign.mjs maps (every pawn\'s BindName and BarkBindName, every other actor\'s stored or class-default BindName, over the mission\'s maps); '
      + 'ConSys BindConversations 10010b70, docs/script-native-conversation-list.md',
  },
  'unbound: the native bind gate excludes it': {
    kind: 'data',
    reason: 'every actor named by the owner has a non-empty BarkBindName and the conversation\'s name contains "_Bark": the native binds it only to an actor whose BarkBindName is the owner, '
      + 'so it binds to nobody (Disgruntled_Guy_Final_Barks, Canal_Pilot_Barks)',
    evidence: 'ConSys BindConversations 10010b70 gates 10010bb3-10010c86 (docs/script-native-conversation-list.md); the pawns\' BarkBindNames from the inventory; Play\'s bound ConListItems of the actor lack the conversation',
  },
  'refused: a speaker has no actor in the map': {
    kind: 'data',
    reason: 'a Speech event\'s speaker or listener is the BindName of no actor in the level (Jock in the Hong Kong helibase, the MJ12 troop of the Mamasan ambush, MJ12Lab_Assistant_Level2, '
      + 'Ops2Dummy): Conversation.CheckActors is false and ConPlayBase.StartConversation refuses before the first line',
    evidence: 'ConSys Conversation.uc CheckActors; ConPlayBase.uc StartConversation; the live actors of the session carry no such BindName (the census scans them)',
  },
  'refused: speakers not together (CheckActorDistances)': {
    kind: 'state',
    reason: 'Conversation.CheckActorDistances refuses a pair of speakers more than 300 units apart (ConPlayBase.StartConversation); the census sets the other speakers beside the owner '
      + 'and the start still fails, or the owner is in a state that cannot converse at that moment',
    evidence: 'ConSys Conversation.uc CheckActorDistances; DeusExPlayer.uc StartConversation',
  },
  'refused: owner authored with Orders Idle': {
    kind: 'state',
    reason: 'the pawn is authored with Orders Idle: state Idle sets bCanConverse false and ignores bump and frob, until a trigger or script gives it orders; the map has no OrdersTrigger for it',
    evidence: 'ScriptedPawn.uc state Idle (BeginState bCanConverse = False; ignores bump, frob); DeusExPlayer.uc StartConversation (CanConverse)',
  },
  'refused: owner in an AI state that cannot converse': {
    kind: 'state',
    reason: 'the pawn is Alerting, Attacking, Fleeing, TakingHit, Dying or Paralyzed (it saw the player, or is authored so): ScriptedPawn.CanConverse is false in those states',
    evidence: 'ScriptedPawn.uc CanConverse (bCanConverse && bInterruptState && walking or flying) and the states that clear bCanConverse; DeusExPlayer.uc StartConversation',
  },
  'refused: the player cannot start a conversation': {
    kind: 'state',
    reason: 'DeusExPlayer.CanStartConversation is false at that moment (another conversation on the screen, the player swimming or falling)',
    evidence: 'DeusExPlayer.uc CanStartConversation',
  },
  'refused: no conversation of the owner is valid': {
    kind: 'state',
    reason: 'GetActiveConversation finds no valid conversation of the owner for the invocation (its flags, the one-second and ten-second gaps, the height check)',
    evidence: 'DeusExPlayer.uc GetActiveConversation',
  },
  'travel: the map was left before the conversation\'s end': {
    kind: 'state',
    reason: 'the conversation\'s own events (or the mission script for a dying player) travel to the next map before its end (GuntherShowdown: Mission04.Timer sends a dying player to 05_NYC_UNATCOMJ12Lab)',
    evidence: 'Mission04.uc Timer; the travel request the census records (a session with a travel host)',
  },
};

export const kindOfFamily = family => FAMILIES[family]?.kind ?? null;

export const BOUNDARIES = {
  '00': {
    "refused: owner in an AI state that cannot converse": ["AnnaNavarre_BarkFutz"],
    "unbound: no actor carries the owner name": ["GuntherHermann_BarkAllianceFriendly","GuntherHermann_BarkAllianceHostile","GuntherHermann_BarkFutz"],
  },
  '01': {
    "refused: speakers not together (CheckActorDistances)": ["TerroristsOverheard"],
    "unbound: no actor carries the owner name": ["WaltonSimons_BarkAllianceFriendly","WaltonSimons_BarkAllianceHostile","WaltonSimons_BarkFutz"],
  },
  '02': {
    "refused: a speaker has no actor in the map": ["OverhearAlleyThug"],
    "refused: speakers not together (CheckActorDistances)": ["ReconciledBarksHack","WorkerOverheardHack","WorkerReconciledHack"],
    "refused: the player cannot start a conversation": ["GuntherHermann_BarkFutz"],
    "unbound: no actor carries the owner name": ["BoatLeaving","BoatWaiting","JosephManderley_BarkAllianceFriendly","JosephManderley_BarkAllianceHostile","JunkieBarks","WaltonSimons_BarkAllianceFriendly","WaltonSimons_BarkAllianceHostile","WaltonSimons_BarkFutz"],
  },
  '03': {
    "refused: owner in an AI state that cannot converse": ["CleanupTroopBarksHack","Crate1Surrender","Crate2Surrender","MoleTerroristBarks"],
    "refused: speakers not together (CheckActorDistances)": ["AnnaManderley2","Crate1SurrenderFrob","Crate2SurrenderFrob","OverhearLebedev","TroopBarks1"],
    "unbound: no actor carries the owner name": ["FordBarks","M03AnsweringMachineMessage","M03SallyBarks","MeetFordSchickQuestion","MeetFordSchickRescue","MeetSmuggler","SckickThanks","SmugglerDoneVending","SmugglerLamenting","SmugglerThanks","SmugglerVending","SmugglerWaiting"],
  },
  '04': {
    "refused: owner in an AI state that cannot converse": ["AnnaBadMama"],
    "unbound: no actor carries the owner name": ["ClinicSecretaryBarks","CokeTroopBarks","Doctor1Barter","M04ClintonGuardBarks","M04ParkBum1Barks","M04ParkBum2Barks","M04ParkBumFemale1","Nurse1Barks","Nurse2Barks","SendingSignal"],
  },
  '05': {
    "refused: owner in an AI state that cannot converse": ["M05AnnaAtExit","M05AnnaAtExit2"],
    "refused: speakers not together (CheckActorDistances)": ["AnnaExitKillphrase","ChattingMJ12Overheard","M05SecretaryScared","ScientistsConsulting"],
  },
  '06': {
    "refused: a speaker has no actor in the map": ["M06JockTrappedBarksFrob","M06JockTrappedBarksRadius","MJ12Lab_BioWeapons_Overheard","MamasanAfterAmbush","MamasanAmbushBarks"],
    "refused: owner authored with Orders Idle": ["MeetRed_Arrow_01","MeetRed_Arrow_01_2","Red_Arrow_01Barks"],
    "refused: owner in an AI state that cannot converse": ["MaySungWhupass","Storage_ComputerTechBarks"],
    "refused: speakers not together (CheckActorDistances)": ["MaySungIntroHack"],
    "unbound: no actor carries the owner name": ["ClubLumpathBarks","ClubTriadAmbushBarks","ClubTriadBarks","ClubTriadFinalBarks","MJ12Lab_Assistant_Level2Barks"],
    "unbound: the native bind gate excludes it": ["Canal_Pilot_Barks","Disgruntled_Guy_Final_Barks"],
  },
  '08': {
    "refused: the player cannot start a conversation": ["M08JockMiddle0"],
    "unbound: no actor carries the owner name": ["ClinicSecretaryBarks","Doctor1Barter","Nurse1Barks","Nurse2Barks"],
  },
  '09': {
    "refused: a speaker has no actor in the map": ["Ops1DummyOverheard"],
    "refused: owner in an AI state that cannot converse": ["DoorGuardBarks","Ops1Bump","Ops2Bump"],
    "refused: speakers not together (CheckActorDistances)": ["Guard1Overheard","Guard3Overheard"],
  },
  '10': {
    "refused: owner authored with Orders Idle": ["Hostage_FemaleBarks","Hostage_Female_RunningBarks"],
    "refused: owner in an AI state that cannot converse": ["HostageBarks"],
    "refused: speakers not together (CheckActorDistances)": ["SpecialGuardsChatting","SpecialGuys"],
    "unbound: no actor carries the owner name": ["MetroJanitorConvos"],
  },
  '11': {
    "refused: speakers not together (CheckActorDistances)": ["FirePlaceBarks"],
  },
  '12': {
    "refused: speakers not together (CheckActorDistances)": ["StephanieBarks"],
    "unbound: no actor carries the owner name": ["M12MiBOverheard"],
  },
  '14': {
    "refused: the player cannot start a conversation": ["JockBarks"],
    "unbound: no actor carries the owner name": ["TiffanyGuardsOverheard"],
  },
  '15': {
    "refused: owner in an AI state that cannot converse": ["PowerGuyScared3"],
    "unbound: no actor carries the owner name": ["HangarOverheard","HangarOverheard2"],
  },
};
