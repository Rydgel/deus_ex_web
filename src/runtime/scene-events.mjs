const isA = (actor, name) => actor?.lineage?.includes(name) ?? false;
const hasName = name => Boolean(name) && String(name).toLowerCase() !== 'none';

/** Original bodies for the declared JC/TriggerToggle dry scene subset.
 * Native event ordering is owned by movement/touch/zone callers. */
export function createSceneEvents(player,{deferMissionEvent}={}) {
  const unsupported = (target,event) => { throw Error(`Unsupported original scene event: ${target?.name ?? 'actor'}.${event}`); };
  return function dispatch(target,event,args) {
    if (isA(target,'engine.triggers') && ['Touch','UnTouch'].includes(event) && deferMissionEvent) {
      deferMissionEvent(target,event,args);
      return;
    }
    if (target === player) {
      if (['Bump','BumpWall','HitWall','Touch','UnTouch','UnderLift','EncroachedByMover','BeginEvent','EndEvent'].includes(event)) return;
      const other = args[0];
      if (event === 'EncroachedBy') { if (isA(other,'engine.pawn')) return unsupported(target,'gibbedBy'); return; }
      if (event === 'EncroachingOn') return Boolean(other?.model || isA(other,'engine.brush') || (player.warping && isA(other,'engine.pawn')));
      return unsupported(target,event);
    }
    if (isA(target,'deusex.deusexmover') && target.values.InitialState === 'TriggerToggle') {
      const v = target.values, other = args[0];
      if (['Touch','UnTouch','Attach','Detach'].includes(event)) return;
      if (event === 'Bump') {
        if (other !== player) return unsupported(target,event);
        if (v.BumpType === 1 && player.mass < 10) return;
        if (hasName(v.BumpEvent) || hasName(v.PlayerBumpEvent)) return unsupported(target,'Bump named Trigger');
        if (player.specialGoal === target) player.specialGoal = null;
        return;
      }
      if (event === 'EncroachingOn') {
        if (other !== player) return unsupported(target,event);
        if (player.base === target) return false;
        if (v.EncroachDamage) return unsupported(target,'EncroachDamage');
        if (hasName(v.PlayerBumpEvent)) dispatch(target,'Bump',[player]);
        if (v.MyMarker) return unsupported(target,'MyMarker UnderLift');
        if (v.MoverEncroachType !== 3) return unsupported(target,'MoverEncroachType');
        return false;
      }
    }
    return unsupported(target,event);
  };
}
