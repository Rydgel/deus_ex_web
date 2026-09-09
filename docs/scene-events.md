# Selected scene event bodies

Source-first scope: ordinary JC PlayerWalking and Training's two TriggerToggle
panels. Original Actor declares empty HitWall, BumpWall, Touch, UnTouch,
BeginEvent and EndEvent. Pawn declares empty UnderLift and EncroachedByMover.
PlayerWalking explicitly ignores Bump; the audited JC ancestors do not override
the other listed empty bodies. Pawn.EncroachedBy calls gibbedBy only for a Pawn
argument, so receiving a mover has no body effects. Pawn.EncroachingOn rejects
an actor with Brush, a Brush subclass, or another Pawn when !bIsPlayer/bWarping.

Original Mover.Bump654–680 filters BumpType, triggers nonempty BumpEvent and
PlayerBumpEvent, then clears the pawn's SpecialGoal when it equals the mover.
For the two selected panels both event names are empty. TriggerToggle does not
override Bump. Do not generalize this absence to arbitrary movers or events.

Mover.EncroachingOn584–651 has destructive Decoration/Carcass/Fragment branches,
then accepts a based actor, applies nonzero EncroachDamage, optionally Bumps a
player, checks the MyMarker under-lift condition, and finally applies its policy.
The selected pair has no EncroachDamage, PlayerBumpEvent or MyMarker and uses
IgnoreWhenEncroach3. Pawn.UnderLift is empty for JC if a marker branch is later
reached, but unknown mover values/classes must not be silently accepted.

This body adapter will cover only these evidenced empty or simple source
branches. Damage, gibbing, arbitrary scripted Touch/Bump/Trigger and other mover
policies remain explicit unsupported events. It is independent from native
dispatch ordering, which has original MoveActor/CheckEncroachment captures.

Registering the player exposes original mission trigger contacts, beginning with
Training DataLinkTrigger23.Touch. Its original source sets a player reference,
checks mission flags and calls StartDataLinkTransmission; success controls later
trigger fields and its eventual parent Touch. General Trigger.Touch can dispatch
named events and disable collision. These are mission/script systems assigned to
Stage3, with conversation/audio presentation in Stage4. The Play scene records
trigger Touch/UnTouch in `deferredEffects` without inventing their outcomes or
claiming their side effects. Native reciprocal touching bookkeeping still runs.
This is an explicit script boundary and a remaining whole-game fidelity gap;
physics/door tests do not establish mission trigger behavior. Other unsupported
physical scene callbacks still fail explicitly.
