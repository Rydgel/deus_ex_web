/** Focused Play integration for Training's ladder (CoreTexMetal.Ladder group,
 * X 6960..7012, Y -3376..-3370, Z -191..-17). The player is placed on the pit
 * floor or on the rungs as fixture setup only; movement then runs through the
 * installed InputEvent bindings and the original Actor.Tick scheduler into the
 * walking/falling surface prelude's Ladder branch and physFlying. The branch
 * and physFlying are bit-exact against Engine.dll in validate-native-ladder and
 * validate-native-flying; this checks that Play reaches them on real BSP.
 * Evidence: docs/ladder-flying.md. */
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import {ladderScene} from './training-ladder-scene.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1});
const input = createPlayerInputFixture(game, {tickSeconds: 1 / 60});
console.log(JSON.stringify(ladderScene(game, input)));
