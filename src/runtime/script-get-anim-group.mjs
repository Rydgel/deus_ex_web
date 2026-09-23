/** Original Engine execGetAnimGroup (native293), 10302ea0 ->103e1640.
 * Lookup and warning behavior: docs/script-get-anim-group.md. */
import {findAnimSeq} from './play-anim.mjs';
import {refValue} from './script-vm.mjs';

export function getAnimGroup(mesh, sequenceName, log = () => {}) {
  if (!mesh) {
    log('GetAnimGroupNoMesh', {sequence: sequenceName, message: 'GetAnimGroup: No mesh'});
    return 'None';
  }
  const sequence = findAnimSeq(mesh, sequenceName);
  if (!sequence) {
    log('GetAnimGroupUnknownSequence', {sequence: sequenceName, mesh: mesh.entry.name,
      message: `GetAnimGroup: Sequence '${sequenceName}' not found in Mesh '${mesh.entry.name}'`});
    return 'None';
  }
  return sequence.group;
}

export function execGetAnimGroup(call, {mesh, log}) {
  if (call.argumentCount !== 1) throw new Error('GetAnimGroup requires one sequence name');
  const name = refValue(call.evaluateArgument(0));
  return getAnimGroup(mesh(), name, log);
}
