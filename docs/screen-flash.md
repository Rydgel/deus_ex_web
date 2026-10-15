# Player alterations and the viewport flash

Stage 4 item (2026-10-15): drunk, drugs, poison and the other alterations the player's scripts apply, and the
full-screen flash the original draws for them (damage, zone tints, underwater). Authority: the retail GOTY
DeusEx.u/Engine.u bytecode (`scripts/dump-script-function.mjs`), `.cache/reference/*.uc` where it has the class,
and the unchanged Engine.dll / D3DDrv.dll / Extension.dll bodies cited below.

## Census (step 1)

`scripts/census-player-alterations.mjs` gives the player each effect the way the game does and plays it for a few
seconds of Level time through Play's own frame (tick, sprite scan, HUD draw), headless, one session per map. Items
(`item`) are the map's own pickups frobbed, put in hand with the digit key User.ini binds to `ActivateBelt` and used with
the left mouse button; a thrown weapon (`throw`) is picked up the same way and fired for ten frames; `hit` is the
`TakeDamage(Damage, Instigator, HitLocation, Momentum, DamageType)` call every damage source makes into the player
(`Cloud.Timer`, `DamageTrigger`, `HurtRadius`, a projectile), made on the player's own bytecode: the sources themselves
(a Greasel's spit, a dart, a flame) are not simulated. A paused scenario's session is built again (a pause leaves the
runtime unusable; Player start is the way out in Play). `EXPECTED` in the script is the outcome of the last run and the
script fails when a scenario differs, so a regrown boundary cannot go unnoticed and a fixed one must be recorded.
Run it as `node scripts/census-player-alterations.mjs [--only id,id] [--json out]` (8 GB heap, about 8 minutes).

| Effect (scenario) | Map | Stopped at before this work | Now |
| --- | --- | --- | --- |
| drink wine (`drink-wine`), 40oz liquor, liquor bottle, Zyme (`take-zyme`, VialCrack) | Island, Bar, Hotel | `Window.SetBackgroundSmoothing` (native 1423) in `DeusExPlayer.DrugEffects` (`root.hud.SetBackground(DrunkFX)`, `SetBackgroundSmoothing(true)`, `SetBackgroundStretching`, `SetBackgroundStyle`) | see below |
| poison (`hit-poison`: `StartPoison` adds 4 s to `drugEffectTimer`) | Island | the same native, from `DrugEffects` | see below |
| tear gas grenade, EMP grenade (`throw`) | Island | `Actor.HurtRadius` in `ThrownProjectile.Explode`: `foreach VisibleCollidingActors` = iterator native 312, exec `0x103e55b0` (`Original iterator native is not implemented: 312`) | see below |
| cigarettes (5 `PoisonGas` damage, smoke puff, cough) | Island | plays | plays |
| ambrosia (message only, no alteration) | Ship | plays | plays |
| `TakeDamage` of PoisonGas, TearGas, Radiation, HalonGas, Flamed (CatchFire, burning), Burned, Drowned, EMP (EnergyDrain), Shocked, Shot (bleeding, BloodDrop spawns) | Island | plays | plays |

"plays" means no pause. Every one of them computes the flash in script (`ClientFlash` adds to `DesiredFlashScale` and
`DesiredFlashFog`, `ViewFlash` integrates `FlashScale` and `FlashFog` each tick, the census records the peaks) and **none of
it is drawn**: nothing in Play reads `FlashScale`/`FlashFog`, zone `ViewFlash`/`ViewFog` or draws D3DDrv's `EndFlash`.
The player in water is outside the census: "the player (JC) has no swimming path: runPlayerPhysics refuses water regions"
([swimming](swimming.md#unsupported-and-unresolved)), so drowning and the underwater tint (the head in a `WaterZone`)
cannot be reached by walking in; the zone tint is reached with `ghost` (the capture scripts' camera).

`summon` of a class no actor of the map loaded (`VialCrack` on Island) pauses in `Object.castObject`
(`Class-object ancestry is not prepared`): DynamicLoadObject hands back a class object without a linked class. No
player reaches an item the map does not hold, so the census picks each class from a map that holds it.
