import { interpolateMoverTo, tickMoverInterpolation } from './mover-interpolation.mjs';
import { createDoorState, triggerFrobbedDoor, processDoorState } from './door-state.mjs';
const zero = [0, 0, 0];
const f = Math.fround;
const closed = mover => mover.interpolation.key === 0 && mover.interpolation.previousKey === 0;
const named = value => Boolean(value) && String(value).toLowerCase() !== 'none';

/** Original two-key translating TriggerToggle subset, including like-tagged
 * panels and smooth reversal. Full state/event execution belongs to the VM. */
export class Doors {
  constructor(movers, maxDistance, collision = null, {eventHasRecipients = null} = {}) {
    this.movers = movers; this.maxDistance = maxDistance; this.collision = collision;
    this.eventHasRecipients = eventHasRecipients; this.reset();
  }
  setOffset(mover, offset) {
    if (this.collision) this.collision.setMoverOffset(mover, offset); else mover.collider.offset = offset;
  }
  reset() {
    this.uses = 0;
    for (const mover of this.movers) {
      mover.alpha = 0; mover.target = 0; mover.active = false; mover.delay = 0;
      mover.supported = mover.values.InitialState === 'TriggerToggle' && mover.values.NumKeys === 2 &&
        mover.values['KeyPos[1]']?.some(v => v !== 0) && !(mover.values['KeyRot[1]'] ?? zero).some(Boolean) &&
        !(mover.values.KeyRot ?? zero).some(Boolean) && !mover.values.bSlave && !mover.values.bTriggerOnceOnly &&
        !(mover.values.DelayTime ?? 0) && !(mover.values.KeyNum ?? 0) && !(mover.values.KeyPos ?? zero).some(Boolean) &&
        (!named(mover.values.Event) || this.eventHasRecipients?.(mover.values.Event) === false);
      if (mover.collider.offset.some(v => v !== 0)) this.setOffset(mover, [...zero]);
      const base = mover.values.Location.map(f);
      mover.interpolation = { position: [...base], basePosition: [...base], oldPosition: [...base],
        keyPositions: [mover.values.KeyPos ?? zero, mover.values['KeyPos[1]'] ?? zero].map(p => p.map(f)),
        rotation: mover.values.Rotation ?? zero, key: 0, previousKey: 0, alpha: 0, rate: 0,
        glideType: mover.values.MoverGlideType, interpolating: false,
        move: delta => {
          if (this.collision?.moveMover) {
            const success = this.collision.moveMover(mover,delta);
            mover.interpolation.position = mover.position.slice();
            return success;
          }
          // Synthetic fixtures do not supply the compiled scene adapter.
          const state = mover.interpolation;
          state.position = state.position.map((v,i) => f(v + delta[i]));
          if (this.collision) this.collision.setMoverPosition(mover,state.position);
          else this.setOffset(mover, state.position.map((v,i) => f(v - base[i])));
          return true;
        },
      };
      mover.clientUpdate = 0;
      mover.scriptState = this.collision?.queries && mover.supported
        ? createDoorState(mover.interpolation,{...mover.values,Event:undefined}) : null;
      if (mover.scriptState) {
        mover.scriptState.actor = mover;
        mover.interpolation.onInterpolateEnd = () => {
          mover.clientUpdate = (mover.clientUpdate - 1) | 0;
          mover.scriptState.ambientSound = null;
          if (mover.clientUpdate === 0) {
            mover.realPosition = mover.position.slice();mover.realRotation = mover.rotation.slice();
          }
        };
      }
    }
    this.scriptRuntime?.reset();
  }
  target(collision, eye, forward) {
    const hit = collision.sweep(eye, forward.map(v => v * this.maxDistance));
    const mover = hit?.actor;
    if (!mover?.collider || !mover.values.bFrobbable) return null;
    return { ...this.describe(mover), distance: hit.time * this.maxDistance };
  }
  describe(mover) {
    return { mover, label: !mover.supported ? 'Door behavior not supported yet' : mover.values.bLocked && closed(mover) ? "It's locked" : mover.target === 1 ? 'Close door' : 'Open door' };
  }
  use(target, playerPosition) {
    if (!target) return { ok: false, message: 'No door in reach' };
    const mover = target.mover, v = mover.values;
    if (!mover.supported) return { ok: false, message: target.label };
    // The original DeusExMover.Frob owns every gate below once the script
    // runtime is linked: frobbable/destroyed/slave, lock and one-way state, the
    // localized refusal message and the Tag fanout are its decisions, not ours.
    if (this.scriptRuntime) {
      const outcome = this.scriptRuntime.frob(mover);
      const opened = outcome.triggered.length > 0;
      if (opened) this.uses++;
      return { ok: opened,
        // The body's own localized ClientMessage when it refused or reported;
        // otherwise the viewer's own label for a door it just retargeted.
        message: outcome.messages.find(text => text !== '') ??
          (opened ? (mover.target ? 'Opening door' : 'Closing door') : ''),
        actors: outcome.triggered.map(m => m.name) };
    }
    if (!v.bFrobbable || v.bDestroyed) return { ok: false, message: 'This door cannot be used' };
    if (closed(mover) && v.bLocked) return { ok: false, message: v.msgLocked ?? "It's locked" };
    if (closed(mover) && v.bOneWay) {
      const yaw = (v.Rotation?.[1] ?? 0) * Math.PI / 32768;
      if ((v.Location[0] - playerPosition[0]) * Math.cos(yaw) + (v.Location[1] - playerPosition[1]) * Math.sin(yaw) > 0) return { ok: false, message: v.msgOneWayFail };
    }
    const tag = (v.Tag ?? '').toLowerCase();
    const group = this.movers.filter(m => m === mover || tag && !['none','deusexmover'].includes(tag) && (m.values.Tag ?? '').toLowerCase() === tag);
    if (group.some(m => !m.supported)) return { ok: false, message: 'Linked door behavior not supported yet' };
    if (mover.scriptState) {
      triggerFrobbedDoor(mover.scriptState,this.collision.playerActor,this.collision.playerActor,group.map(m=>m.scriptState),this.collision.doorCallbacks);
      for (const m of group) { m.target=m.scriptState.code==='open'?1:0;m.active=Boolean(m.scriptState.code); }
      this.uses++;
      return { ok:true,message:mover.target?'Opening door':'Closing door',actors:group.map(m=>m.name) };
    }
    for (const m of group) {
      const state = m.interpolation;
      m.target = state.key === 0 || state.key < state.previousKey ? 1 : 0;
      interpolateMoverTo(state, m.target, m.values.MoveTime);
      m.active = true;
    }
    this.uses++;
    return { ok: true, message: mover.target ? 'Opening door' : 'Closing door', actors: group.map(m => m.name) };
  }
  tick(dt) {
    if(this.scriptRuntime)return this.scriptRuntime.tick(dt);
    for (const m of this.movers) {
      if (!m.active) continue;
      if (m.scriptState) processDoorState(m.scriptState,{
        ...this.collision.doorCallbacks,
        interpolateTo:(door,key,seconds)=>{
          const state=m.interpolation;
          if (m.physics !== 9) throw Error('Unsupported mover physics transition');
          interpolateMoverTo(state,key,seconds);
          m.clientUpdate=(m.clientUpdate+1)|0;
          m.simOldPosition=state.oldPosition.slice();m.simOldRotation=state.rotation.slice();
          m.simInterpolate=[f(100*state.alpha),f(100*Math.max(f(.01),state.rate)),f(256*state.previousKey+state.key)];
        },
      });
      tickMoverInterpolation(m.interpolation, dt);
      const state = m.interpolation;
      m.active = state.interpolating || Boolean(m.scriptState?.code);
      // UI openness is separate from native PhysAlpha, which resets at an end.
      m.alpha = state.interpolating ? state.key === 1 ? state.alpha : f(1-state.alpha) : state.key;
    }
  }
  status() {
    return { uses: this.uses, movers: this.movers.map(m => ({ name: m.name, supported: Boolean(m.supported),
      tag: m.values.Tag, locked: Boolean(m.values.bLocked), alpha: m.alpha, target: m.target, moving: m.active, offset: [...m.collider.offset] })) };
  }
}
