/** The debugging page's loadout (README "debugging page": `?loadout=1` at each Player start, Tools ▸ Give loadout now), on whichever
 * side runs the simulation (sim-worker.mjs `call`, or the page with ?sim=inline). Everything JC receives comes from the original's own
 * code, run through the recovered console command chain as view-probe.mjs `exec` runs it:
 *   - `bCheatsEnabled` is written first, the stand-in for typing `set DeusEx.JCDentonMale bCheatsEnabled True` (as view-probe.mjs does);
 *   - each item is `summon`ed (DeusExPlayer.Summon → PlayerPawn.Summon: Spawn in front of the player) and picked up by
 *     DeusExPlayer.ParseRightClick (HandleItemPickup, DoFrob, AddInventory: the inventory grid, the belt, a stack's NumCopies, a
 *     weapon's PickupAmmoCount). FrobTarget is written to the new item before ParseRightClick: the stand-in for aiming at it, which
 *     HighlightCenterObject would do (it writes FrobTarget from its trace every 0.1 s);
 *   - then the cheats AllAugs (AugmentationManager.AddAllAugs and SetAllAugsToMaxLevel), AllSkills, AllAmmo (each Ammo in the
 *     inventory to its MaxAmmo) and AllCredits (Credits = 100000).
 * The items fill the 5 × 6 inventory grid but one cell (measured: 29 cells) and the belt's slots 1 to 9 in this order. An item the
 * original refuses (no room to spawn it in front of the player, a full grid) stays where the original leaves it and is reported. */
export const LOADOUT_ITEMS = [
  'WeaponNanoSword', 'WeaponStealthPistol', 'WeaponAssaultGun', 'WeaponAssaultShotgun', 'WeaponRifle', 'WeaponGEPGun',
  ...Array(10).fill('Lockpick'), ...Array(10).fill('Multitool'), ...Array(5).fill('MedKit'), ...Array(5).fill('BioelectricCell'),
];
export const LOADOUT_CHEATS = ['AllAugs', 'AllSkills', 'AllAmmo', 'AllCredits'];

export function giveLoadout(game) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const commands = game.doors.scriptRuntime.windowHost?.consoleCommands;
  if (!commands) throw new Error('loadout: the console command chain needs the window host');
  const level = runtime.levelFor(player);
  runtime.writeNamed(player, 'bCheatsEnabled', true);
  const given = [], refused = [];
  for (const cls of LOADOUT_ITEMS) {
    const before = new Set(level.actors.map(actor => actor?.name));
    commands.consoleCommand(player, `summon DeusEx.${cls}`);
    const item = level.actors.find(actor => actor && !before.has(actor.name));
    if (!item) { refused.push({ cls, why: 'not spawned' }); continue; }
    const aimed = runtime.readNamed(player, 'FrobTarget');
    runtime.writeNamed(player, 'FrobTarget', item);
    commands.consoleCommand(player, 'ParseRightClick');
    // A stack's copy is destroyed into the item already held (DeusExPickup.HandlePickupQuery)
    if (runtime.readNamed(item, 'Owner') === player || runtime.readNamed(item, 'bDeleteMe')) given.push(cls);
    else refused.push({ cls, why: 'not picked up' });
    // A refused pickup leaves the item highlighted until the next trace: the aim it stood in for is given back
    if (runtime.readNamed(player, 'FrobTarget') === item) runtime.writeNamed(player, 'FrobTarget', aimed);
  }
  for (const cheat of LOADOUT_CHEATS) commands.consoleCommand(player, cheat);
  let augmentations = 0;
  for (let aug = runtime.readNamed(runtime.readNamed(player, 'AugmentationSystem'), 'FirstAug'); aug; aug = runtime.readNamed(aug, 'next'))
    if (runtime.readNamed(aug, 'bHasIt')) augmentations++;
  return { given, refused, augmentations, credits: runtime.readNamed(player, 'Credits') };
}
