import { scriptGetStateName } from '../runtime/script-state-queries.mjs';

/** Validation only (scripts/conversation-acceptance.mjs, docs/conversation-camera.md "Frames"): where the player's
 * conversation stands, on the simulation side (sim-worker.mjs `call`, or the page with ?sim=inline). Reads only.
 *
 * `conPlay` is DeusExPlayer.conPlay (None outside a conversation): the conversation's name, ConPlay's state, the event it
 * is on (its class, label and, for a speech, the speaker, listener and text), the camera's pose and position enum and the
 * letterbox window's place in its slide. `level` is the level's clock and the player's state and pose. */
export function conversationProbe(game, args = {}) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
  const read = (object, name) => (object ? runtime.readNamed(object, name) : null);
  const nameOf = object => (object ? (read(object, 'Name') ?? object.name ?? null) : null);
  const classOf = object => (object ? runtime.instance(object).cls.record.name : null);
  const stateOf = object => { const instance = object ? runtime.instance(object) : null; return instance?.state ? scriptGetStateName(instance.state.stateNode ?? instance.cls) : null; };
  const info = runtime.levelFor(player).actors[0];
  const conPlay = read(player, 'conPlay');
  const out = { level: { time: read(info, 'TimeSeconds'), dilation: read(info, 'TimeDilation'), playersOnly: read(info, 'bPlayersOnly'),
    player: { state: stateOf(player), location: [...read(player, 'Location')], viewRotation: [...read(player, 'ViewRotation')], physics: read(player, 'Physics'),
      behindView: read(player, 'bBehindView') } }, conPlay: null };
  // `offsets`: the linked offsets (and bool masks) of properties of the conversation objects, for tools/dump-actor-win.c on the original
  // (docs/conversation-camera.md "Frames"): { camera: {name: [offset, mask]}, actors: {name: {property: [offset, mask]}} }.
  if (args.offsets) {
    const { slotOf } = runtime.classLoader.graph;
    const camera = conPlay ? read(conPlay, 'cameraInfo') : null;
    const find = (object, name) => { const member = runtime.lookupMember(runtime.instance(object).cls, 'fields', name);
      return member ? [slotOf(member.loadRecord, 0x48), (v => typeof v === 'number' ? v : null)(slotOf(member.loadRecord, 0x5c))] : null; };
    out.offsets = { camera: camera ? Object.fromEntries((args.offsets.camera ?? []).map(name => [name, find(camera, name)])) : null,
      conPlay: conPlay ? Object.fromEntries((args.offsets.conPlay ?? []).map(name => [name, find(conPlay, name)])) : null,
      actors: Object.fromEntries(Object.entries(args.offsets.actors ?? {}).map(([actorName, names]) => {
        const actor = runtime.levelFor(player).actors.find(a => a?.name === actorName);
        return [actorName, actor ? Object.fromEntries(names.map(name => [name, find(actor, name)])) : null]; })) };
  }
  if (!conPlay) return out;
  const event = read(conPlay, 'currentEvent'), con = read(conPlay, 'con');
  const speech = event && classOf(event) === 'ConEventSpeech' ? read(event, 'conSpeech') : null;
  const camera = read(conPlay, 'cameraInfo'), window = read(conPlay, 'conWinThird');
  out.conPlay = { con: con ? read(con, 'conName') : null, state: stateOf(conPlay),
    event: event ? { cls: classOf(event), label: read(event, 'label') || null,
      speaker: speech ? nameOf(read(event, 'speaker')) : null, speakingTo: speech ? nameOf(read(event, 'speakingTo')) : null,
      soundID: speech ? read(speech, 'soundID') : null, text: speech ? read(speech, 'speech') : null } : null,
    speaker: nameOf(read(conPlay, 'currentSpeaker')), speakingTo: nameOf(read(conPlay, 'currentSpeakingTo')),
    camera: camera ? { position: read(camera, 'cameraPosition'), mode: read(camera, 'cameraMode'), fallback: read(camera, 'bUsingFallback'),
      location: read(camera, 'LastLocation') ? [...read(camera, 'LastLocation')] : null, rotation: read(camera, 'LastRotation') ? [...read(camera, 'LastRotation')] : null,
      // what CalculateCameraPosition reads: the two actors, the position's modifiers and the 180-degree bookkeeping
      first: nameOf(read(camera, 'firstActor')), second: nameOf(read(camera, 'secondActor')), heightModifier: read(camera, 'heightModifier'),
      centerModifier: read(camera, 'centerModifier'), distanceMultiplier: read(camera, 'distanceMultiplier'), offset: [...read(camera, 'cameraOffset')],
      rotationOffset: [...read(camera, 'rotation')], setActorCount: read(camera, 'setActorCount'), firstActorRotation: read(camera, 'firstActorRotation'),
      saved: read(camera, 'bCameraLocationSaved'), currentFallback: read(camera, 'currentFallback') } : null,
    // the actors the camera places itself by: their pose and the heights it reads (Pawn.BaseEyeHeight, the collision cylinder)
    actors: Object.fromEntries([['player', player], ['first', read(camera, 'firstActor')], ['second', read(camera, 'secondActor')]].filter(([, actor]) => actor).map(([role, actor]) => {
      const f = name => { const v = read(actor, name); return Array.isArray(v) ? [...v] : v; };
      return [role, { name: nameOf(actor), location: f('Location'), rotation: f('Rotation'), desiredRotation: f('DesiredRotation'), baseEyeHeight: f('BaseEyeHeight'), eyeHeight: f('EyeHeight'),
        collisionHeight: f('CollisionHeight'), collisionRadius: f('CollisionRadius'), physics: f('Physics'), animSequence: f('AnimSequence'), animFrame: f('AnimFrame') }]; })),
    window: window ? { pos: read(window, 'currentWindowPos'), mode: read(window, 'moveMode'), restrictInput: read(window, 'bRestrictInput') } : null };
  return out;
}
