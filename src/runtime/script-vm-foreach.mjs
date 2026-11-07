/**
 * The host of the Rust interpreter's CycleActors foreach and struct out arguments (native/script-vm iter.rs, docs/firefox-60fps-plan.md
 * "The bunker bundle"). The lowering is script-vm-lower.mjs (`foreachCycle`, `call`, `callSignature`).
 *
 * FOREACH_START (DEUS_EX_FOREACH_START, `?foreachStart=`): 'rust' (default) starts the CycleActors loop of a callee run in Rust and steps
 * it there (the scan is render.rs cycle_scan, as the JavaScript iterator's is); 'js' keeps createCycleActorsIterator's iterator on the
 * frame; 'verify' runs the Rust loop and a shadow JavaScript iterator (the pure JavaScript scan) beside it, and throws when a step
 * finds another actor or leaves another cursor. OUT_STRUCT (`?outStruct=`): 'rust' (default) copies a struct out argument in and
 * back in Rust, 'js' keeps such calls whole in callFunction, 'verify' compares every copy with the cell codecs (readCell, copyValue)
 * member by member.
 *
 * The imports run no script: `list` is the receiver's level's actor list (script-vm-render.mjs listFor), `classTest` classIsA.
 */
import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {readCell} from './script-object-image.mjs';
import {copyValue} from './script-values.mjs';
import {outStructMode, foreachStartMode, structArraysMode, setRotationMode} from './script-vm-lower.mjs';
import {cycleScanMode, createCycleActorsIterator} from './script-iterators.mjs';

const f32 = new DataView(new ArrayBuffer(4));
const bitsOf = value => { f32.setFloat32(0, value, true); return f32.getUint32(0, true); };

export class ForeachHost {
  constructor(vm) {
    this.vm = vm;
    this.at = 0;
    // what the imports served (a validator or a scenario reads them: the Rust paths ran when these are not zero)
    this.counts = {lists: 0, classTests: 0, foreachChecks: 0, outChecks: 0, rotationChecks: 0};
  }
  attach(x) {
    this.at = x.vm_features_ptr();
    const view = this.vm.arena.view;
    view.setUint32(this.at, outStructMode() === 'verify' || structArraysMode() === 'verify' ? 1 : 0, true);
    view.setUint32(this.at + 4, foreachStartMode() === 'verify' ? 1 : 0, true);
    view.setUint32(this.at + 8, structArraysMode() === 'verify' ? 1 : 0, true);
    view.setUint32(this.at + 12, setRotationMode() === 'verify' ? 1 : 0, true);
  }
  /** Whether the lowering may emit the Rust foreach: not the JavaScript reference (FOREACH_START=js, CYCLE_SCAN=js). */
  get ready() { return foreachStartMode() !== 'js' && cycleScanMode() !== 'js'; }
  get outStructReady() { return outStructMode() !== 'js'; }

  /** js_cycle_list: the receiver's level's actor list, as createCycleActorsIterator's actors() reads it. */
  list(frame, node, handle) {
    this.counts.lists++;
    const vm = this.vm, run = vm.run(frame);
    const receiver = handle === run.selfHandle ? run.self : vm.identity(handle);
    const array = vm.runtime.levelFor(receiver)?.actors;
    if (!array || typeof array.length !== 'number') throw new TypeError('CycleActors levelFor(receiver) must provide an actors array');
    return vm.render.listFor(array);
  }
  /** js_cycle_class_test: createCycleActorsIterator's isA for an actor the class table does not describe. */
  classTest(frame, node, handle) {
    this.counts.classTests++;
    const vm = this.vm, runtime = vm.runtime, info = vm.run(frame).lowered.foreachNodes.get(node);
    const actor = identityOfHandle(handle);
    return runtime.classIsA(runtime.instance(actor).cls, info.target) ? 1 : 0;
  }
  /** js_foreach_check (FOREACH_START=verify): phase 0 starts a shadow iterator at Index `start`, every phase steps it. */
  foreachCheck(frame, node, phase, start, found, cursor) {
    this.counts.foreachChecks++;
    const vm = this.vm, runtime = vm.runtime, run = vm.run(frame);
    if (phase === 0) {
      const info = run.lowered.foreachNodes.get(node), slots = {actor: null, index: start | 0};
      const slot = key => ({reference: true, get: () => slots[key], set: value => { slots[key] = value; }});
      const args = [info.target, slot('actor'), slot('index')];
      run.shadowForeach = {slots, iterator: createCycleActorsIterator({index: 1002, receiver: run.self, script: run.compiled.script,
        frame: null, argumentCount: 3, evaluateArgument: index => args[index], actorClass: runtime.actorClass.record,
        levelFor: runtime.levelFor, isA: (actor, base) => runtime.classIsA(runtime.instance(actor).cls, base), scan: null})};
    }
    const shadow = run.shadowForeach;
    if (!shadow) throw new Error(`FOREACH_START=verify: a step of ${run.compiled.displayName} without a start`);
    const more = shadow.iterator.next(), expected = more ? handleOf(shadow.slots.actor) : 0;
    if (expected !== found || shadow.slots.index !== cursor)
      throw new Error(`FOREACH_START=verify: ${run.compiled.displayName} step ${phase} found handle ${found} at cursor ${cursor} in Rust, ${expected} at ${shadow.slots.index} in JavaScript`);
  }
  /** js_set_rotation_check (SET_ROTATION=verify): the decision Rust made for a SetRotation statement on `handle` (0 left alone, 1 unchanged, 2 runs in
   * JavaScript, 3 stored) against script-set-rotation.mjs setScriptRotation's branches decided from readNamed on the same state. */
  rotationCheck(frame, node, handle, decision, pitch, yaw, roll) {
    this.counts.rotationChecks++;
    const vm = this.vm, runtime = vm.runtime, run = vm.run(frame);
    const actor = handle === run.selfHandle ? run.self : identityOfHandle(handle);
    const read = name => runtime.readNamed(actor, name), level = runtime.levelFor(actor), requested = [pitch | 0, yaw | 0, roll | 0];
    const expected = !level.editor && (read('bStatic') || !read('bMovable')) ? 0
      : read('Rotation').every((value, index) => value === requested[index]) ? 1
        : read('Brush') !== null || read('StandingCount') !== 0 ? 2 : 3;
    if (expected !== decision)
      throw new Error(`SET_ROTATION=verify: ${run.compiled.displayName} node ${node} on handle ${handle}: Rust decided ${decision}, setScriptRotation's branches ${expected}`);
  }
  /** js_out_struct_check (OUT_STRUCT=verify): the struct Rust copied from `from` to `to` (dir 0 into the callee's parameter, 1 back
   * into the caller's variable) against what the JavaScript codecs make of the source, member by member. */
  outCheck(frame, node, index, dir, from, to) {
    this.counts.outChecks++;
    const vm = this.vm, run = vm.run(frame), info = run.lowered.outCalls.get(node)?.find(item => item.index === index);
    if (!info) throw new Error(`OUT_STRUCT=verify: no struct out argument ${index} on node ${node}`);
    const [srcCell, srcField, dstField] = dir === 0
      ? [info.callerCell, info.callerField, info.calleeField]
      : [info.calleeCell, info.calleeField, info.callerField];
    const view = vm.arena.view, value = readCell(srcCell, view, [], from - srcCell.offset);
    const expected = copyValue(dstField, copyValue(srcField, value));
    for (const member of info.members) {
      // (a leaf of a nested struct, fixed array or vector: the steps from the struct to it, as flatStructMembers lists them)
      const want = member.path ? member.path.reduce((value, step) => value[step], expected) : expected[member.key], at = to + member.offset;
      let got, ok;
      switch (member.kind) {
        // the stored bits of a float (a NaN's included), the masked bit of a bool, the handle of an object
        case 'float': got = view.getUint32(at, true); ok = got === bitsOf(want); break;
        case 'bool': got = (view.getUint32(at, true) & member.mask) !== 0; ok = got === want; break;
        case 'int': got = view.getInt32(at, true); ok = got === want; break;
        case 'byte': got = view.getUint8(at); ok = got === want; break;
        default: got = view.getUint32(at, true); ok = got === handleOf(want);
      }
      if (!ok) throw new Error(`OUT_STRUCT=verify: ${run.compiled.displayName} node ${node} ${dir ? 'back' : 'in'} member ${member.key}: Rust ${got}, JavaScript ${want}`);
    }
  }
}
