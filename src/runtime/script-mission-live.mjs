/** Live Mission00 timer for ordinary Play.
 *
 * Training's DeusExLevelInfo0 carries Script = class'Mission00'. The original
 * DeusExLevelInfo.PostBeginPlay calls SpawnScript, which — after an
 * AllActors(class'MissionScript') dedup check — Spawn()s the mission actor.
 * MissionScript.PostPostBeginPlay enrols SetTimer(checkTime, True) (checkTime
 * = 1.0), so the shared Actor.Tick scheduler fires Mission00.Timer once a
 * second. On the first tick, base Timer's `flags == None` runs InitStateMachine
 * (GetPlayerPawn, AllActors(DeusExLevelInfo), flags = Player.FlagBase,
 * SetDefaultExpiration(missionNumber+1), localURL = Caps(mapName)); then
 * Mission00.Timer removes the player's remaining inventory while
 * MunitionsTrooperReady is true (RemoveAllInventory → Player.DeleteInventory +
 * item.Destroy). This is the mission-side enforcement that pairs with the
 * MunitionsTrooperTake conversation confiscation.
 *
 * The mission actor is spawned through the original SpawnScript bytecode
 * (a prepared Spawn route for the Info-derived, script-only Mission00), runs its
 * PostPostBeginPlay startup, and ticks through the same processActorTick path as
 * the map pawns — no substitute timer loop. Evidence:
 * docs/script-mission-timer.md.
 */
import {spawnScriptActor} from './script-spawn.mjs';
import {SCRIPTED_ACTOR_CONSTRUCTION} from './script-scripted-actor-construction.mjs';

const MISSION00_PROPERTIES_SIZE = 0x334; // Actor 0x318 + Mission00 script fields

function isDeusExLevelInfo(runtime, actor) {
  if (!actor) return false;
  if (String(actor.className ?? '').toLowerCase() === 'deusexlevelinfo') return true;
  let cls = null; try { cls = runtime.instance(actor).cls; } catch { return false; }
  for (let c = cls; c; c = c.base) if (c.record.key === 'deusex.deusexlevelinfo') return true;
  return false;
}

export async function createLiveMissionRuntime({runtime, assets, level, player}) {
  const get = (o, k) => runtime.namedReference(o, k).get();
  const dx = await assets.get('DeusEx');
  const load = (asset, path) => runtime.loadClass(asset, asset.exportsByPath.get(path));
  const missionClass = await load(dx, 'mission00');
  const levelInfoClass = await load(dx, 'deusexlevelinfo');

  // Prepare the mission state machine and the level-info spawner bytecode.
  for (const entry of dx.pkg.exports) {
    if (entry.className !== 'Function' && entry.className !== 'State') continue;
    const path = entry.path.toLowerCase();
    if (path.startsWith('mission00.') || path.startsWith('missionscript.') ||
        path === 'deusexlevelinfo.spawnscript' || path === 'deusexlevelinfo.postbeginplay') {
      const index = dx.exportsByPath.get(path);
      if (entry.className === 'State') await runtime.prepareState(dx, index);
      else await runtime.prepareFunction(dx, index);
    }
  }
  const spawnScript = runtime.lookup(
    level.actors.find(a => isDeusExLevelInfo(runtime, a)) ?? player, 'SpawnScript');

  const graphSize = runtime.classLoader.graph.slotOf(missionClass.loadRecord, 0x3c);
  if (graphSize !== MISSION00_PROPERTIES_SIZE)
    throw new Error(`Mission00 layout changed: PropertiesSize ${graphSize?.toString?.(16)}`);
  const actor = SCRIPTED_ACTOR_CONSTRUCTION.engineActor;
  const selection = {classKey: missionClass.record.key, inherited: true,
    constructor: actor.internalConstructor, constructorBody: actor.constructorBody,
    nativeVtable: actor.vtable, propertiesSize: MISSION00_PROPERTIES_SIZE};

  const levelInfoActor = () => level.actors.find(a => isDeusExLevelInfo(runtime, a));
  let missionActor = null;

  function spawn() {
    const dli = levelInfoActor();
    // Only Training carries Script = Mission00; another map's level info leaves
    // Script None and SpawnScript is a no-op, exactly as the original.
    if (!dli || !get(dli, 'Script')) return;
    const previous = runtime.actorLifecycle;
    runtime.actorLifecycle = {...previous,
      validateSpawn: args => args.cls === missionClass ? args.level === level : previous.validateSpawn(args),
      construction: {...previous.construction,
        validate: args => args.cls === missionClass
          ? args.template === null : previous.construction.validate(args)},
      resolveConstructor: cls => cls === missionClass ? selection : previous.resolveConstructor(cls),
      spawnActor: (args, services) => {
        if (args.cls !== missionClass) return previous.spawnActor(args, services);
        const spawned = spawnScriptActor(args, services,
          {kind: 'MissionScript', key: missionClass.record.key, nativeConstructorSelection: selection});
        if (spawned) missionActor = spawned;
        return spawned;
      }};
    try { runtime.callFunction(spawnScript, dli, 0); }
    finally { runtime.actorLifecycle = previous; }
    // LoadMap's PostPostBeginPlay pass reaches the freshly spawned mission actor
    // (the pass re-reads the actor array); run that startup so SetTimer enrols.
    if (missionActor) runtime.processEvent(missionActor, 'PostPostBeginPlay', []);
  }

  function destroy() {
    if (!missionActor) return;
    if (!runtime.instance(missionActor).pendingKill) runtime.destroyActor(missionActor, true);
    missionActor = null;
  }

  return {
    class: missionClass, levelInfoClass,
    active: () => missionActor,
    has: candidate => candidate != null && candidate === missionActor,
    tick: (seconds, options) => {
      if (missionActor && !runtime.instance(missionActor).pendingKill)
        runtime.processActorTick(missionActor, seconds, options);
    },
    spawn,
    destroy,
    reset: () => { destroy(); spawn(); },
  };
}
