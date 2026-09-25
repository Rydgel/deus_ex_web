const isA = (actor, name) => actor?.lineage?.includes(name) ?? false;
const hasName = name => Boolean(name) && String(name).toLowerCase() !== 'none';

/** Original bodies for the declared JC/TriggerToggle dry scene subset.
 * Native event ordering is owned by movement/touch/zone callers. */
export function createSceneEvents(playerIdentity,{deferMissionEvent,dispatchEvent}={}) {
  const unsupported = (target,event) => { throw Error(`Unsupported original scene event: ${target?.name ?? 'actor'}.${event}`); };
  return function dispatch(target,event,args) {
    const player = typeof playerIdentity === 'function' ? playerIdentity() : playerIdentity;
    if (isA(target,'engine.triggers') && ['Touch','UnTouch','Timer'].includes(event)) {
      // Run the trigger's real Touch/UnTouch bytecode through the VM router
      // (docs/scene-events.md, item #2 M3). A body that reaches a not-yet-built
      // subsystem (unprepared helper, or an unimplemented/boundary native) is
      // recorded as a deferred mission-script effect instead of pausing play —
      // the record-as-boundary approach. Handled types (datalinks) run to
      // the host boundary; earlier script writes are not rolled back on deferral.
      if (dispatchEvent) {
        try {
          const outcome = dispatchEvent(target,event,args);
          if (outcome?.handled) return outcome.result;
        } catch (error) {
          if (!/not prepared|Unsupported original door native|Unimplemented original native|does not support native/.test(error.message)) throw error;
        }
      }
      if (deferMissionEvent) deferMissionEvent(target,event,args);
      return;
    }
    if (target === player) {
      if (['Bump','BumpWall','HitWall','Touch','UnTouch','UnderLift','EncroachedByMover','BeginEvent','EndEvent','Attach','Detach'].includes(event)) return;
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
    // General VM router: any other attached actor's event runs its real bytecode
    // through the linked VM (docs/scene-events.md). `handled:false` means the class
    // ancestry has no such function — the original empty-event no-op. A prepared
    // body that reaches an unbuilt native/subsystem still surfaces the original
    // pause, but now from the real bytecode rather than this adapter.
    if (dispatchEvent) {
      const outcome = dispatchEvent(target,event,args);
      return outcome?.handled ? outcome.result : undefined;
    }
    return unsupported(target,event);
  };
}
