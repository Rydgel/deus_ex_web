/** Player start on 01_NYC_UNATCOIsland after Play has drawn frames, headless.
 *
 * Play's frames run the page's own simulation steps (sim-session.mjs): the
 * tick, SetupDynamics' sprite scan, which builds each LaserEmitter's
 * LaserIterator and each ParticleGenerator's ParticleIterator
 * (script-render-iterator.mjs), and the HUD draw. Once the opening InfoLink is
 * up (walking into its trigger), game.reset() reloads the map: LoadMap's
 * collection purges the old iterators through their recovered Destroy,
 * UObject::Destroy, reached from
 * the purge or from AActor::Destroy's RenderInterface (+0x314) release
 * (docs/script-loadmap-gc.md). Play then continues with the new player's HUD.
 *
 * The DLL facts (vtable slots, AActor::Destroy, URenderIterator's
 * constructor) are pinned in validate-loadmap-gc.mjs; this check pins the
 * reflected property offsets they name and the live Player start. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', { value: () => simulatedMs, configurable: true });

const { gameDirectory } = await import('./game-directory.mjs');
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-island-player-start: no installed game data'); process.exit(0); }
const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createGame } = await import('../src/viewer/game.mjs');
const { createSimSession } = await import('../src/viewer/sim-session.mjs');
const { RENDER_ITERATOR_NATIVE } = await import('../src/runtime/script-render-iterator.mjs');
const { createPlayerInputFixture } = await import('./player-input-fixture.mjs');

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const sim = createSimSession(game, { assets });
const scripts = game.doors.scriptRuntime, runtime = scripts.runtime;
const read = (object, name) => runtime.readNamed(object, name);
const offset = (cls, name) => runtime.classLoader.graph.slotOf(runtime.lookupMember(cls, 'fields', name).loadRecord, 0x48);
const message = errors => errors.map(error => error.message).join('; ');

// One page frame's simulation steps, in sim-session frame() order.
let infoLinkUp = false;
function frame() {
  simulatedMs += 1000 / 60;
  game.tick(1 / 60);
  const sprites = sim.sprites();
  assert.equal(message(sprites.errors), '', 'the sprite scan runs');
  const hud = sim.hud({ width: 1440, height: 960, view: game.view() });
  assert.equal(message(hud.errors), '', 'the HUD draws');
  infoLinkUp = Boolean(hud.infoLink?.visible);
}
// Each actor's RenderInterface with the scan's construction facts, as scalars.
function iterators() {
  const level = runtime.levelFor(game.player.collisionActor), out = [];
  for (const actor of level.actors) {
    if (!actor || !read(actor, 'RenderIteratorClass')) continue;
    const iterator = read(actor, 'RenderInterface');
    if (!iterator) continue;
    const instance = runtime.instance(iterator), key = instance.cls.record.key, object = instance.nativeObject;
    out.push({ actor, iterator, key, vtable: object.nativeVtable, wanted: RENDER_ITERATOR_NATIVE.classes[key]?.vtable,
      destroy: typeof object.destroy, outerIsActor: object.outer === runtime.instance(actor).nativeObject });
  }
  return out;
}
function checkIterators(list, label) {
  for (const entry of list) {
    assert.equal(entry.vtable, entry.wanted, `${label}: ${entry.iterator.name} carries its class vtable`);
    assert.equal(entry.destroy, 'function', `${label}: ${entry.iterator.name} has its Destroy`);
    assert.ok(entry.outerIsActor, `${label}: ${entry.iterator.name}'s Outer is its actor`);
  }
}

// Reflected properties at the native offsets the recovered bodies use.
assert.equal(offset(runtime.actorClass, 'RenderInterface'), 0x314, 'Actor.RenderInterface is AActor +0x314');

// The opening transmission's trigger is a few steps ahead of the start; it
// is still playing when Player start runs.
const input = createPlayerInputFixture(game);
let frames = 0;
input.key('KeyW', true);
while (!infoLinkUp && frames < 600) { frame(); frames++; }
input.key('KeyW', false);
assert.ok(infoLinkUp, `the opening InfoLink is up (${frames} frames)`);
for (let i = 0; i < 30; i++) frame();
assert.ok(infoLinkUp, 'the InfoLink is still up at Player start');
const before = iterators(), oldPlayer = game.player.collisionActor;
const lasers = before.filter(entry => entry.key === 'deusex.laseriterator').length;
const particles = before.filter(entry => entry.key === 'deusex.particleiterator').length;
assert.ok(lasers >= 5, `each LaserTrigger's emitter has its LaserIterator (${lasers})`);
checkIterators(before, 'before');
const iteratorClass = runtime.instance(before[0].iterator).cls;
assert.equal(offset(iteratorClass, 'Index'), 0x2c, 'RenderIterator.Index is +0x2c');
assert.equal(offset(iteratorClass, 'Observer'), 0x30, 'RenderIterator.Observer is +0x30');

const resets = [];
for (let reset = 0; reset < 2; reset++) {
  const old = reset ? iterators() : before, previous = game.player.collisionActor;
  game.reset();
  // The page reads status() right after Player start (main.mjs showStats).
  const status = game.status();
  assert.ok(status.hud?.native, 'game.status() reads the new HUD');
  assert.notEqual(game.player.collisionActor, previous, 'Player start logs in a new player');
  assert.equal(game.hud.player, game.player.collisionActor, 'the HUD follows the new player');
  assert.equal(game.hud.root, scripts.windowHost.root, 'the HUD draws the new root window');
  assert.ok(runtime.isReleased(previous), 'the old player is released');
  assert.equal(old.filter(entry => !runtime.isReleased(entry.iterator)).length, 0, 'the collection releases every old iterator');
  assert.equal(iterators().length, 0, 'the reloaded level has no RenderInterface before its first frame');
  for (let i = 0; i < 120; i++) frame();
  const after = iterators();
  checkIterators(after, `reset ${reset + 1}`);
  assert.equal(after.filter(entry => old.some(o => o.iterator === entry.iterator)).length, 0, 'the new frames build new iterators');
  resets.push({ released: old.length, rebuilt: after.length });
}
assert.ok(runtime.isReleased(oldPlayer));
console.log(`PASS validate-island-player-start: InfoLink up after ${frames} frames; ${lasers} LaserIterators and ${particles} ParticleIterators before Player start; resets ${JSON.stringify(resets)}`);
