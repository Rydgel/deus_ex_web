/** DDeusExGameEngine::PruneTravelActors (DeusEx.dll 0x1000f9b0) and SaveCurrentLevel(-2) (0x1000fac0) over Play's level (docs/travel.md "Browse: the
 * DeusEx override"). Both run in the tick's travel step, after the player's travel text is exported and before the next level loads.
 *
 * PruneTravelActors, for the viewport's actor: each Augmentation of its AugmentationSystem's list, then the manager, DestroyActor'd, and the property
 * set to None; the same for the SkillSystem and its Skills; the FlagBase's DeleteAllFlags, the FlagBase destroyed and the property None; the
 * carried decoration DestroyActor'd and None. (The player, its inventory and key ring stay in the level that is filed: measured.)
 *
 * SaveCurrentLevel(-2): LevelInfo.LevelAction = 2; the moving brush tracker is shut down (log); CleanupDestroyed(1); the file name is
 * `<DeusExLevelInfo.MapName>.dxs` in Save\Current; SavePackage writes `Save.tmp`, which is then moved over it (level-save.mjs); every mover's
 * SavedPos goes to (-1,-1,-1); the tracker is recreated (log); LevelAction = 0. Without a DeusExLevelInfo it logs `WARNING!  DeusExLevelInfo MISSING!`
 * and saves nothing. The log lines are the measured ones (docs/travel.md "What each travel did"); `Save=` is the elapsed time in milliseconds. */
import { serializeLevel } from './level-save.mjs';

const lower = value => String(value ?? '').toLowerCase();

export function createLevelSaver({ runtime, level, asset, store, log, viewport, modelIndex, arrival, restoredObjects, now = () => performance.now() }) {
  const read = (object, name) => runtime.readNamed(object, name);
  const write = (object, name, value) => runtime.writeNamed(object, name, value);
  const destroy = actor => runtime.destroyActor(actor, false);
  const levelInfo = () => level.actors[0];
  const deusExLevelInfo = () => level.actors.find(actor => actor && runtime.attachedInstance(actor)?.cls.record.key === 'deusex.deusexlevelinfo') ?? null;

  /** PruneTravelActors. */
  function pruneTravelActors() {
    const player = read(viewport(), 'Actor');
    if (!player) return;
    const chain = (manager, head, link) => {
      for (let item = read(manager, head), next; item; item = next) { next = read(item, link); destroy(item); }
    };
    const augmentations = read(player, 'AugmentationSystem');
    if (augmentations) { chain(augmentations, 'FirstAug', 'next'); destroy(augmentations); write(player, 'AugmentationSystem', null); }
    const skills = read(player, 'SkillSystem');
    if (skills) { chain(skills, 'FirstSkill', 'next'); destroy(skills); write(player, 'SkillSystem', null); }
    const flags = read(player, 'FlagBase');
    if (flags) { flags.deleteAllFlags(); write(player, 'FlagBase', null); }
    const carried = read(player, 'carriedDecoration');
    if (carried) { destroy(carried); write(player, 'carriedDecoration', null); }
  }

  /** SaveCurrentLevel(position): only -2 (Save\Current) is part of a level change. */
  function saveCurrentLevel(position) {
    if (position !== -2) throw new Error(`SaveCurrentLevel(${position}): only Save\\Current is implemented here (slots are travel step 4)`);
    const info = deusExLevelInfo();
    const packageName = asset.name;
    const setAction = value => { try { write(levelInfo(), 'LevelAction', value); } catch { /* an unlinked property */ } };
    setAction(2);
    log('Init', `Shut down moving brush tracker for Level ${packageName}.MyLevel`);
    runtime.cleanupDestroyed(level, true);
    if (!info) { log('Log', 'WARNING!  DeusExLevelInfo MISSING!'); setAction(0); return null; }
    const mapName = String(read(info, 'MapName'));
    const started = now();
    store.releaseLoaders();
    const events = runtime.scriptVm?.aiEvents;
    const saved = serializeLevel({ runtime, level, asset, modelIndex, restoredObjects,
      levelUrl: { map: arrival?.map ?? asset.name, portal: arrival?.portal ?? '', options: arrival?.options ?? [] },
      ai: events?.active ? { words: events.snapshot(), spelling: id => events.spelling(id) } : null,
      guid: globalThis.crypto.getRandomValues(new Uint8Array(16)) });
    log('Log', `Save=${(now() - started).toFixed(6)}`);
    log('Log', `Moving '..\\Save\\Current\\Save.tmp' to '..\\Save\\Current\\${mapName}.dxs'`);
    store.write(`${mapName}.dxs`, saved.bytes);
    for (const actor of level.actors) {
      if (!actor) continue;
      const instance = runtime.attachedInstance(actor);
      if (instance && instance.cls && classIsMover(instance.cls)) { try { write(actor, 'SavedPos', [-1, -1, -1]); } catch { /* a mover without the property */ } }
    }
    log('Init', `Initialized moving brush tracker for Level ${packageName}.MyLevel`);
    setAction(0);
    return saved;
  }
  const classIsMover = cls => { for (let c = cls; c; c = c.base) if (c.record.key === 'engine.mover') return true; return false; };
  void lower;
  return { pruneTravelActors, saveCurrentLevel };
}
