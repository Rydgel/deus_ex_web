/**
 * GetPlayerPawn (native 720) in the Rust interpreter (native/script-vm natives.rs PLAYER_PAWN, docs/firefox-60fps-plan.md "The
 * bunker bundle").
 *
 * The native's body is one pointer walk over the host's graph (script-triggers.mjs resolveNativeGetPlayerPawn: the level's engine,
 * its client, the first viewport's actor), and the answer is a handle. Rust reads PLAYER_PAWN_CELL = [graph epoch, the epoch the
 * handle is valid for, handle, verify]: `js_player_pawn` (below) runs the walk (script-vm-rust.mjs `playerPawn`, the resolver
 * `js_object`'s direct path asks), keeps its handle in the cell and marks it valid for the epoch the host holds. The host advances
 * that epoch (ScriptRuntime.notePlayerPawnGraph) on every write to a link of the walk (player-pawn-graph.mjs), so the cell is the
 * walk's answer for as long as the epoch is the one it was filled at.
 *
 * PLAYER_PAWN (DEUS_EX_PLAYER_PAWN, `?playerPawn=`): 'rust' (default) lowers the native to the Rust node where the runtime's
 * graph is watched and its own invokeNative would reach the resolver; 'direct' answers it in js_object (the walk at every call),
 * 'js' keeps the call through invokeNative and the native chain, 'verify' lowers it too but makes Rust cross at every call, where
 * the cell (when current) is compared with a fresh walk, and js_object's direct path is compared with the JavaScript VM's own.
 */
import {handleOf} from './script-object-handles.mjs';

const UNDEFINED = 0xffffffff;

export const playerPawnMode = () => (typeof process !== 'undefined' && process.env?.PLAYER_PAWN) || globalThis.DEUS_EX_PLAYER_PAWN || 'rust';

export class PlayerPawnHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.at = 0;
    this.mode = playerPawnMode();
    // the walks js_player_pawn ran (the cell is filled by each; Rust answers from it in between)
    this.walks = 0;
  }
  attach(x) {
    this.at = x.vm_player_pawn_ptr();
    this.runtime.playerPawnListener = () => this.publish();
    this.publish();
  }
  /** The graph epoch, and whether Rust may trust the cell at all (the graph is watched; not verify, which crosses at every call). */
  publish() {
    const view = this.vm.arena.view, at = this.at, runtime = this.runtime;
    view.setUint32(at, runtime.playerPawnGraphEpoch >>> 0, true);
    view.setUint32(at + 12, this.mode === 'verify' || !runtime.playerPawnGraphWatched ? 1 : 0, true);
  }
  /** Whether the lowering may emit the node for a call on this runtime: the graph is watched, there is a resolver and the call
   * would reach it (script-vm-rust.mjs `playerPawn`'s gates). */
  lowerable(services) {
    const runtime = this.runtime, m = runtime.constructor.originalMethods;
    if (this.mode === 'js' || this.mode === 'direct' || typeof runtime.playerPawnShortcut !== 'function' || !runtime.playerPawnGraphWatched) return false;
    return services.invokeNative === runtime.services.invokeNative && runtime.invokeNative === m.invokeNative && runtime.hostNative === m.hostNative;
  }
  /** js_player_pawn: the walk for the node's receiver, the cell filled. Under 'verify' a cell that is current is compared first. */
  cell(frame, node, handle) {
    this.walks++;
    const vm = this.vm, run = vm.run(frame), n = run.nodes[node];
    // (a host replaced a method after the lowering: the whole call goes through the JavaScript VM, and the cell is left as it is)
    const direct = vm.playerPawn(run, n, handle);
    if (direct === undefined) {
      const v = run.compiled.nodeValue(n, run.frame, handle === run.selfHandle ? run.self : vm.identity(handle));
      return v === undefined ? UNDEFINED : handleOf(v);
    }
    const view = vm.arena.view, at = this.at, epoch = view.getUint32(at, true);
    if (this.mode === 'verify' && view.getUint32(at + 4, true) === epoch && view.getUint32(at + 8, true) !== direct)
      throw new Error(`PLAYER_PAWN=verify: the cell holds handle ${view.getUint32(at + 8, true)} at epoch ${epoch}, the walk now gives ${direct}`);
    view.setUint32(at + 8, direct, true);
    view.setUint32(at + 4, epoch, true);
    return direct;
  }
}
