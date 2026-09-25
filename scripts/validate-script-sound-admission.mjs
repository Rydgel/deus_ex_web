/** Original-package check for the Stage-4 discarded-result admission family.
 * Only facts/counts are retained; package bytecode stays outside Git. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata,readStateMetadata} from '../src/unreal/script-metadata.mjs';
import {decodeScript,discardedNativeCalls} from '../src/unreal/bytecode.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const name of await readdir(`${root}/System`))files.push({path:name,
  read:()=>readFile(`${root}/System/${name}`)});
const assets=new AssetStore(files),counts=[],consumed=[],frontier=[];
for(const name of ['Engine','DeusEx']) {
  const asset=await assets.get(name);let total=0,discarded=0;
  for(const [i,entry] of asset.pkg.exports.entries()) {
    if(!['Function','State'].includes(entry.className))continue;
    const script=(entry.className==='Function'?readFunctionMetadata:readStateMetadata)(asset,i+1,{includeChildren:false});
    const decoded=decodeScript(script),safe=discardedNativeCalls(decoded);
    for(const node of decoded.expressions.values()) {
      if(node.op!=='native'||node.index!==264)continue;
      total++;
      const key=`${entry.path}@${node.offset}`;
      if(safe.has(node))discarded++;else consumed.push(key);
      if(['Lamp.Frob','HUDMedBotHealthScreen.DestroyWindow','HUDMedBotAddAugsScreen.DestroyWindow',
        'HUDRechargeWindow.DestroyWindow'].includes(entry.path)) {
        assert.ok(safe.has(node),`${key} discards its result`);frontier.push(key);
      }
    }
  }
  counts.push({name,total,discarded});
}
assert.deepEqual(counts,[{name:'Engine',total:37,discarded:37},{name:'DeusEx',total:232,discarded:224}]);
assert.deepEqual(consumed,[
  'DeusExDecoration.Bump@730','DataLinkPlay.PlaySpeech@49','BarkManager.StartBark@382',
  'ConPlay.PlaySpeech@114','ConPlay.PlaySpeech@149','ConPlay.PlaySpeech@224',
  'ConPlay.PlaySpeech@259','DeusExWeapon.PlaySimSound@44',
]);
assert.equal(frontier.length,5);
console.log('Original PlaySound bytecode: 261 discarded-result sites; all 8 channel consumers excluded; Lamp and bot teardown admitted.');
