/** GC's authored class default and the underlines it draws (docs/interface-frames.md "The underlined accelerator letters").
 *
 * The original draws an underline under the accelerator letter of a button's text ("I̲nventory"): GC.DrawText's second emit
 * (script-gc-draw-text.mjs, drawGlyph 0x10029e40) runs when the GC's underline texture (+0x84) is set. XGC::XGC (0x10026ad0) never
 * writes that slot; XGC::operator new (0x10002c40) is StaticConstructObject, whose InitProperties copies the class's authored
 * defaults first, and Extension.u's GC class has exactly one: underlineTexture, reference 20, Texture Extension.Solid. Play's
 * allocation of a GC used to leave the slot zero, so no underline was drawn; the first frame comparison with the original
 * (scripts/interface-acceptance.mjs, ui-inv: eight tab letters underlined in the original only) found it.
 *
 * Checks: (1) the package's tagged defaults of GC; (2) the GC the window host allocates for the root and for a HUD window holds the
 * Solid texture's image at +0x84, in the template (gGc) and the working (wGc) context; (3) the inventory screen paints one
 * underline tile (Solid, one pixel high) per accelerator letter of its tab row. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {parsePackage} from '../src/unreal/package.mjs';
import {objectAt} from '../src/unreal/objects.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory();

// (1) Extension.u's GC class: the tagged defaults.
{
  const bytes = await readFile(path.join(root, 'System/Extension.u')), pkg = parsePackage(bytes);
  const index = pkg.exports.findIndex(entry => entry.className === 'Class' && entry.name === 'GC');
  const cls = readClass({pkg, bytes}, index + 1);
  assert.deepEqual(cls.properties.map(p => [p.name, p.type, p.arrayIndex]), [['underlineTexture', 5, 0]], 'GC has one authored default');
  const target = objectAt(pkg, cls.properties[0].value);
  assert.equal(`${target.className} ${target.name}`, 'Texture Solid', 'its value is Texture Extension.Solid');
}

const files = [];
for (const dir of ['System', 'Textures', 'Maps', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, dir))) files.push({path: `${dir}/${name}`, read: () => readFile(path.join(root, dir, name))});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const {hud} = game, host = game.doors.scriptRuntime.windowHost, W = host.W, runtime = game.doors.scriptRuntime.runtime;
const player = game.player.collisionActor;

// (2) The allocated GCs hold the Solid texture.
const solid = pointer => {
  const resource = host.resourceImages.get(pointer);
  return resource?.kind === 'texture' ? String(resource.ref.key) : null;
};
const checked = [];
for (const [label, window] of [['root', hud.root], ['hud', hud.hud], ['belt', hud.read(hud.hud, 'belt')]]) {
  for (const [slot, offset] of [['gGc', 0x130], ['wGc', 0x134]]) {
    const gc = W.ptr(window, offset);
    assert.ok(gc, `${label} has a ${slot}`);
    const pointer = host.heap.addressOf(host.heap.read(gc, 0x84, 'ptr'));
    assert.equal(solid(pointer), 'extension.solid', `${label} ${slot} +0x84 is Texture Extension.Solid`);
    checked.push(`${label}.${slot}`);
  }
}

// (3) The inventory screen: one underline per accelerator letter of the tab row (Inventory, Health, Augs, Skills, Goals/Notes,
// Conversations, Images, Logs) and Exit, and one under each of the item buttons' letters (the frame's pixels:
// y 140 and y 514 at the 1280x720 root).
game.hud.scoped(() => runtime.scriptConsoleExec(player, 'ShowInventoryWindow'));
const paint = () => hud.commands(1280, 720, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
for (let i = 0; i < 20; i++) { game.tick(1 / 60); paint(); }
const commands = paint();
const underlines = commands.filter(c => c.texture?.name === 'Solid' && c.height === 1 && c.width <= 12);
const lines = underlines.filter(c => c.y === 140);
assert.equal(lines.length, 9, `the tab row (Inventory, Health, Augs, Skills, Goals/Notes, Conversations, Images, Logs, Exit) has an underline under each accelerator letter`);
assert.equal(underlines.length, 13, 'and the four item buttons (Equip, Use, Drop, Change Ammo) one each');
console.log(`GC underline default: Extension.u tags underlineTexture = Texture Solid (ref 20); ${checked.length} GCs hold it (${checked.join(' ')}); the inventory screen draws ${lines.length} underline tiles in the tab row (${lines.slice(0, 3).map(c => `${c.x},${c.y} ${c.width}x${c.height}`).join(' | ')} ...)`);
process.exit(0);
