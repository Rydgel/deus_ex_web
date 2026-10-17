/** The ?easter=1 mod, simulation side (docs/easter-egg.md). Everything here runs only when the page asks for it (sim-worker.mjs
 * `call easter`, which imports this module on demand); a page without ?easter=1 never loads it and no faithful path calls into it.
 *
 * `setup` spawns, through the runtime's own SpawnActor (script-spawn.mjs, what `summon` reaches), stock classes only:
 *  - Claudia: DeusEx.Female1 (HumanCivilian, mesh GFM_TShirtPants) with Orders Sitting on a Chair1 (a Seat) kept hidden on the lid
 *    of a CrateBreakableMedGeneral, so ScriptedPawn.Sitting's own bytecode walks her to it, plays SitBegin and loops SitBreathe;
 *  - Rydgel: DeusEx.Businessman2 (HumanCivilian, mesh GM_Suit) with Orders Standing at the bar, ScriptedPawn.Standing's idle loop.
 * Their skins are the page's (easter-skins.mjs); here only the stock glasses slots and the ponytail slot are switched on through
 * the actors' own MultiSkins. A frob (the player's RightMouse binding with FrobTarget on one of them) shows the speaker's line
 * through the player's own ClientMessage (PlayerPawnExt.ClientMessage -> DeusExRootWindow.ClientMessage -> the HUD log), and
 * the other answers `replyDelay` level seconds later.
 *
 * Fidelity: none of this is original behavior. The pieces are original (classes, meshes, animations, states, the message path);
 * the arrangement, names and lines are ours. */
import { EASTER } from './easter-config.mjs';

const lower = text => String(text).toLowerCase();
const prepared = new WeakSet();

/** The class's script bodies and default mesh made ready for a synchronous spawn: script-doors.mjs prepareNpcClass and
 * prepareSpawnClosure do this at map load for the classes a map's actors name; a class the map does not name (none here, by
 * choice of the classes) needs the same two steps before its first SpawnActor. */
async function prepareClass(runtime, cls) {
  const member = async node => {
    if (node.kind === 'State' || node.function) return;
    const index = node.asset?.exportsByPath?.get(node.key.slice(node.key.indexOf('.') + 1));
    if (index != null) await runtime.prepareFunction(node.asset, index);
  };
  for (let node = cls; node && node.record.key !== 'core.object'; node = node.base) {
    if (prepared.has(node)) continue;
    prepared.add(node);
    for (const method of node.methods?.values() ?? []) await member(method);
    for (const state of node.states?.values() ?? []) {
      if (state.kind !== 'State') continue;
      const index = state.asset?.exportsByPath?.get(state.key.slice(state.key.indexOf('.') + 1));
      const body = index != null ? await runtime.prepareState(state.asset, index) : null;
      for (const method of body?.methods?.values() ?? []) await member(method);
    }
  }
  const field = runtime.lookupMember(cls, 'fields', 'Mesh'), mesh = field ? runtime.defaultValue(cls, field) : null;
  if (mesh && ['LodMesh', 'Mesh'].includes(mesh.kind)) await runtime.prepareResource(mesh);
}

async function stockClass(runtime, name) {
  const asset = await runtime.objects.assets.get('DeusEx'), index = asset.exportsByPath.get(lower(name));
  if (!index) throw new Error(`easter: DeusEx.${name} is not in DeusEx.u`);
  const cls = await runtime.loadClass(asset, index);
  await prepareClass(runtime, cls);
  return cls;
}

/** A stock skin object (DeusExCharacters/DeusExItems Skins) by package path, as a MultiSkins entry. */
async function stockTexture(runtime, packageName, path) {
  const asset = await runtime.objects.assets.get(packageName), index = asset.exportsByPath.get(lower(path));
  if (!index) throw new Error(`easter: ${packageName}.${path} is not in the package`);
  return runtime.objects.resolve(asset, index);
}

/** The state the hooks share: the two pawns by actor, and the speech queue. */
const state = { active: false, actors: new Map(), next: { claudia: 0, rydgel: 0 }, queue: [], names: {} };

export async function easterCall(game, args = {}) {
  switch (args.op ?? 'setup') {
    case 'setup': return setup(game, args);
    case 'status': return status(game);
    default: throw new Error(`easter: unknown call ${args.op}`);
  }
}

async function setup(game) {
  const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor, level = runtime.levelFor(player);
  if (live()) return summary(game);
  // A Player start (the page's Reset) reloads the level and purges the old generation: the actors of an earlier setup are gone with it.
  state.active = false; state.actors.clear(); state.queue.length = 0; state.next = { claudia: 0, rydgel: 0 };
  const { claudia, rydgel, place } = EASTER;
  const [pawnC, pawnR, seatClass, crateClass] = [await stockClass(runtime, claudia.pawnClass), await stockClass(runtime, rydgel.pawnClass),
    await stockClass(runtime, claudia.seatClass), await stockClass(runtime, claudia.crateClass)];
  const read = (actor, name) => runtime.readNamed(actor, name), write = (actor, name, value) => runtime.writeNamed(actor, name, value);
  const spawn = (cls, location, yaw, options = {}) => {
    const actor = runtime.spawnActor({ cls: cls.record, level, name: 'None', owner: null, instigator: null,
      location: location.map(Math.fround), rotation: [0, yaw & 0xffff, 0], ...options });
    if (!actor) throw new Error(`easter: SpawnActor refused ${cls.record.name}`);
    return actor;
  };
  // The crate: wooden, the stock General Supply Crate (a half-height 24 box), set down on the floor; invincible and not
  // pushable so neither a blow nor a bump moves her seat out from under her.
  const crateHeight = runtime.defaultValue(crateClass, runtime.lookupMember(crateClass, 'fields', 'CollisionHeight'));
  const crate = spawn(crateClass, [place.crate.x, place.crate.y, place.floor + crateHeight + 0.5], place.crate.yaw);
  write(crate, 'bInvincible', true);
  write(crate, 'bPushable', false);
  // The seat: a stock Chair1, hidden, on the floor at the crate's centre, found by Tag through the pawn's own OrderTag. Its first
  // sit point is put at the crate lid (below). The seat is not for walking to: Sitting would walk a spawned pawn with MoveActor, which
  // Play has only for map pawns (script-runtime.mjs movePawn), and its SetBasedPawnSize Move is the same call. Claudia is
  // spawned already seated instead (below), the state Sitting's own sit-down reaches.
  const seatHeight = runtime.defaultValue(seatClass, runtime.lookupMember(seatClass, 'fields', 'CollisionHeight'));
  const seatAt = [place.crate.x, place.crate.y, place.floor + seatHeight + 0.5];
  const seat = spawn(seatClass, seatAt, place.claudiaYaw + 16384, { noCollisionFail: true });
  write(seat, 'Tag', 'EasterSeat');
  write(seat, 'bHidden', true);
  write(seat, 'Physics', 0);
  // Claudia's metrics first (ScriptedPawn.Sitting's end state: SitPosition = seat + sit point - (0,0,1) * newAssHeight, the sit-height collision
  // box, SetBasedPawnSize(radius, GetSitHeight()) applied without its Move: CollisionHeight, PrePivot, DesiredPrePivot, PrePivotOffset,
  // BaseEyeHeight as that function leaves them), because the sit point is derived from them below.
  const field = name => runtime.lookupMember(pawnC, 'fields', name), defaults = name => runtime.defaultValue(pawnC, field(name));
  const full = defaults('CollisionHeight'), baseAss = defaults('BaseAssHeight'), defaultEye = defaults('BaseEyeHeight');
  const standHeight = full - 4.5, sitHeight = standHeight + baseAss * 0.5, assHeight = standHeight + baseAss;
  // Where the pose's seat plane meets the lid. The mesh is drawn from Location + PrePivot (lodmesh-frame.mjs), and GFM_TShirtPants'
  // SitBreathe frame has its lowest seat vertex place.hipDrop below that origin (docs/easter-egg.md "Her seat"), so her Location is
  // set so the seat plane lies place.lidEmbed under the lid's top surface; the sit point is whatever puts SitPosition there.
  // (the live crate's collision height: a spawned decoration's CollisionHeight is not always its class default)
  const lidTop = read(crate, 'Location')[2] + read(crate, 'CollisionHeight');
  const pivot = standHeight - sitHeight;
  const claudiaZ = lidTop - place.lidEmbed + place.hipDrop - pivot;
  const sitPoint = read(seat, 'sitPoint').map(point => [...point]);
  // The sit point also moves toward the room (the pawn's facing, Seat.Rotation + (0,-16384,0) turned back: local (0, -sitForward)), so
  // she sits on the front part of the lid with her lower legs hanging in front of the crate.
  sitPoint[0] = [0, -place.sitForward, claudiaZ - seatAt[2] - (sitHeight - assHeight)];
  const facing = place.claudiaYaw / 65536 * 2 * Math.PI, toward = [Math.cos(facing) * place.sitForward, Math.sin(facing) * place.sitForward];
  write(seat, 'sitPoint', sitPoint);
  runtime.callFunction(runtime.lookup(seat, 'SetCollision'), seat, 3, () => false);
  const sitZ = seatAt[2] + sitPoint[0][2] + (sitHeight - assHeight);
  const claudiaActor = spawn(pawnC, [place.crate.x + toward[0], place.crate.y + toward[1], sitZ], place.claudiaYaw, { noCollisionFail: true });
  write(claudiaActor, 'CollisionHeight', sitHeight);
  write(claudiaActor, 'PrePivotOffset', [0, 0, standHeight - sitHeight]);
  // PrePivot is the value the state's own LoopAnimPivot('SitBreathe') tweens it to (DesiredPrePivot = NewPrePivot + PrePivotOffset, with
  // no NewPrePivot): SetBasedPawnSize first leaves full - sitHeight and the first pivot call moves it to PrePivotOffset, so a pawn spawned
  // in the steady state starts at that value and does not drop by the difference in its first 0.15 s.
  write(claudiaActor, 'PrePivot', [0, 0, pivot]);
  write(claudiaActor, 'DesiredPrePivot', [0, 0, pivot]);
  write(claudiaActor, 'BaseEyeHeight', sitHeight - (standHeight - defaultEye));
  // PHYS_Flying, which Sitting sets (SetPhysics, native 3970) as it sits down: no gravity under a pawn on a crate.
  runtime.callFunction(runtime.lookup(claudiaActor, 'SetPhysics'), claudiaActor, 1, () => 4);
  write(claudiaActor, 'bSitting', true);
  write(claudiaActor, 'SeatActor', seat);
  write(claudiaActor, 'SeatSlot', 0);
  const sitters = [...read(seat, 'sittingActor')];
  sitters[0] = claudiaActor;
  write(seat, 'sittingActor', sitters);
  // Rydgel at the counter.
  const rydgelActor = spawn(pawnR, [place.rydgel.x, place.rydgel.y, place.floor + 47.5 + 0.5], place.rydgel.yaw);
  for (const [actor, who] of [[claudiaActor, claudia], [rydgelActor, rydgel]]) {
    write(actor, 'FamiliarName', who.name);
    write(actor, 'UnfamiliarName', who.name);
    write(actor, 'bInvincible', true);
    write(actor, 'bImportant', false);
    // ScriptedPawn.Frob asks DeusExPlayer.StartConversation(self, IM_Frob), which returns at once for a pawn with no ConListItems: a frob
    // here only reaches the mod's line, never an original conversation (this class's bark list is bound at spawn).
    write(actor, 'ConListItems', null);
    // They stay where they are: no fear or alarm reactions, no wandering (Orders below).
    for (const flag of ['bFearShot', 'bFearIndirectInjury', 'bFearCarcass', 'bFearDistress', 'bFearAlarm', 'bFearHacking', 'bFearWeapon', 'bFearInjury',
      'bReactAlarm', 'bReactCarcass', 'bReactLoudNoise', 'bReactProjectiles', 'bReactFutz', 'bReactShot', 'bReactDistress', 'bHateHacking'])
      write(actor, flag, false);
  }
  // Stock slots switched on through the actors' own MultiSkins: the glasses (FramesTex1 and LensesTex2, the pair this map's own Female1
  // wears on GFM_SuitSkirt) in GFM_TShirtPants' glasses slots 3 and 4, and the ponytail (PonytailTex1) in GM_Suit's slot 7.
  const skins = async (actor, slots) => {
    const multiSkins = [...read(actor, 'MultiSkins')];
    for (const [slot, path] of Object.entries(slots)) multiSkins[slot] = await stockTexture(runtime, 'DeusExCharacters', path);
    write(actor, 'MultiSkins', multiSkins);
  };
  await skins(claudiaActor, { 3: 'Skins.FramesTex1', 4: 'Skins.LensesTex2' });
  await skins(rydgelActor, { 7: 'Skins.PonytailTex1' });
  write(claudiaActor, 'Orders', 'Sitting');
  write(claudiaActor, 'OrderTag', 'EasterSeat');
  write(rydgelActor, 'Orders', 'Standing');
  Object.assign(state, { active: true, runtime, game, player, level, crate, seat, names: { claudia: claudiaActor.name, rydgel: rydgelActor.name } });
  state.actors.set(claudiaActor, 'claudia');
  state.actors.set(rydgelActor, 'rydgel');
  installHooks(game);
  return summary(game);
}

function summary(game) {
  const runtime = state.runtime, read = (actor, name) => runtime.readNamed(actor, name);
  const who = actor => ({ name: actor.name, location: [...read(actor, 'Location')], orders: read(actor, 'Orders') });
  return { claudia: who([...state.actors].find(([, id]) => id === 'claudia')[0]), rydgel: who([...state.actors].find(([, id]) => id === 'rydgel')[0]),
    crate: state.crate.name, seat: state.seat.name };
}

/** Whether the setup's level is still the live one: a Player start (Reset) purges it and everything the setup spawned. */
function live() {
  if (!state.active) return false;
  try { return state.runtime.levelFor(state.game.player.collisionActor) === state.level && state.game.player.collisionActor === state.player; } catch { return false; }
}

function status(game) {
  if (!live()) return { active: false };
  const runtime = state.runtime, read = (actor, name) => runtime.readNamed(actor, name);
  const nm = value => (value && typeof value === 'object' ? value.name ?? value.key ?? null : value);
  const describe = actor => {
    const instance = runtime.instance(actor);
    return { name: actor.name, className: instance?.cls?.record?.key ?? null, mesh: nm(read(actor, 'Mesh')), location: [...read(actor, 'Location')].map(Math.fround), rotation: [...read(actor, 'Rotation')], orders: read(actor, 'Orders'),
      state: instance?.state?.stateNode?.record?.name ?? null, physics: read(actor, 'Physics'), sitting: read(actor, 'bSitting'),
      anim: read(actor, 'AnimSequence'), familiar: read(actor, 'FamiliarName'), unfamiliar: read(actor, 'UnfamiliarName'),
      collisionHeight: read(actor, 'CollisionHeight'), collisionRadius: read(actor, 'CollisionRadius'), prePivot: [...read(actor, 'PrePivot')], drawScale: read(actor, 'DrawScale'),
      conList: nm(read(actor, 'ConListItems')), seat: nm(read(actor, 'SeatActor')), base: nm(read(actor, 'Base')), health: read(actor, 'Health'), invincible: read(actor, 'bInvincible'),
      multiSkins: [0, 1, 2, 3, 4, 5, 6, 7].map(i => nm(read(actor, 'MultiSkins')[i])) };
  };
  // The player's own log (DeusExPlayer.AddLog, which ClientMessage reaches): its entries, oldest first.
  const log = [];
  for (let entry = read(state.player, 'FirstLog'); entry && log.length < 64; entry = read(entry, 'Next')) log.push(read(entry, 'Text'));
  const out = { active: true, time: read(state.level.actors[0], 'TimeSeconds'), pending: state.queue.length, log, frobTarget: nm(read(state.player, 'FrobTarget')) };
  for (const [actor, id] of state.actors) out[id] = describe(actor);
  out.crate = { name: state.crate.name, location: [...read(state.crate, 'Location')], physics: read(state.crate, 'Physics'),
    collisionHeight: read(state.crate, 'CollisionHeight'), collisionRadius: read(state.crate, 'CollisionRadius') };
  out.seat = { name: state.seat.name, location: [...read(state.seat, 'Location')], hidden: read(state.seat, 'bHidden') };
  return out;
}

/** The hooks, installed on this game object only: a frob (RightMouse press on one of them) and the reply timer. */
function installHooks(game) {
  if (game.easterHooks) return;
  game.easterHooks = true;
  const button = game.inputButton, tick = game.tick;
  game.inputButton = function inputButton(name, pressed) {
    const target = pressed && lower(name) === 'rightmouse' && live() ? state.runtime.readNamed(state.player, 'FrobTarget') : null;
    const result = button.apply(this, arguments);
    const who = target ? state.actors.get(target) : null;
    if (who) frobbed(who);
    return result;
  };
  game.tick = function tick() {
    const result = tick_.apply(this, arguments);
    if (state.queue.length) { if (live()) deliver(); else state.queue.length = 0; }
    return result;
  };
  const tick_ = tick;
}

const now = () => state.runtime.readNamed(state.level.actors[0], 'TimeSeconds');

function say(who, text) {
  const { runtime, player } = state;
  runtime.processEvent(player, 'ClientMessage', [`${EASTER[who].name}: ${text}`, 'None', false]);
}

/** The speaker's next pair: its line now, the other's answer after `replyDelay`. */
export function frobbed(who) {
  const pairs = EASTER.pairs[who], index = state.next[who]++ % pairs.length, other = who === 'claudia' ? 'rydgel' : 'claudia';
  say(who, pairs[index][0]);
  state.queue.push({ at: now() + EASTER.replyDelay, who: other, text: pairs[index][1] });
}

function deliver() {
  const time = now();
  while (state.queue.length && state.queue[0].at <= time) { const item = state.queue.shift(); say(item.who, item.text); }
}
