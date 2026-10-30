import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import { readObject, exportAt } from '../src/unreal/objects.mjs';
import {Reader} from '../src/unreal/package.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {prepareMapProperties} from '../src/runtime/script-map-properties.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['System','Textures','Sounds','Music','Maps'])for(const name of await readdir(`${root}/${directory}`)){
  const path=`${directory}/${name}`;files.push({path,read:()=>readFile(`${root}/${path}`)});
}
const assets=new AssetStore(files),asset=await assets.get('DeusEx'),runtime=new ScriptRuntime(assets);
let defaults=0;const structs=new Set();
for(const [index,entry] of asset.pkg.exports.entries())if(entry.className==='Class'){
  const metadata=readClass(asset,index+1),opaque=metadata.properties.filter(p=>p.type===10&&!p.decoded);
  if(!opaque.length)continue;
  const cls=await runtime.loadClass(asset,index+1);
  for(const property of opaque){
    const field=runtime.lookupMember(cls,'fields',property.name),value=runtime.defaultValue(cls,field);
    const selected=field.metadata.arrayDim>1?value[property.arrayIndex]:value;
    assert.ok(selected&&!selected.unsupported,`${entry.path}.${property.name}[${property.arrayIndex}]`);
    defaults++;structs.add(property.struct);
  }
}
assert.equal(defaults,364);assert.equal(structs.size,14);
async function originalCase(className,propertyName,index=0){
  const exportIndex=asset.exportsByPath.get(className),cls=await runtime.loadClass(asset,exportIndex);
  const field=runtime.lookupMember(cls,'fields',propertyName),value=runtime.defaultValue(cls,field);
  const selected=field.metadata.arrayDim>1?value[index]:value;
  const metadata=readClass(asset,exportIndex),reader=readObject(asset.pkg,asset.bytes,metadata.scriptText).reader;
  reader.u32();reader.u32();
  return {selected,field,source:reader.string(asset.pkg.version)};
}
const inventory=await originalCase('scriptedpawn','InitialInventory');
assert.deepEqual(Object.values(inventory.selected),[null,1]);
assert.ok(/InventoryItem\s*\{\s*var\(\) class<Inventory> Inventory;\s*var\(\) int\s+Count;/.test(inventory.source));
const vault=await originalCase('deusexrootwindow','DataVaultFunctions');
const [functionName,windowClass]=Object.values(vault.selected);
assert.equal(functionName,'ShowInventoryWindow');
assert.equal(windowClass.key,'deusex.personascreeninventory');
assert.equal(windowClass,await runtime.objects.resolve(asset,asset.exportsByPath.get('personascreeninventory')));
assert.ok(/S_DataVaultFunction\s*\{\s*var String function;\s*var Class<DeusExBaseWindow> winClass;/i.test(vault.source));
const key=await originalCase('menuscreencustomizekeys','keyDisplayNames');
assert.deepEqual(Object.values(key.selected),[1,'Left Mouse Button']);
assert.ok(/S_KeyDisplayItem\s*\{\s*var EInputKey inputKey;\s*var localized String DisplayName;/i.test(key.source));
const alliance=await originalCase('greasel','InitialAlliances');
assert.deepEqual(Object.values(alliance.selected),['Karkian',1,true]);
console.log(`Original DeusEx defaults: ${defaults} formerly opaque struct entries across ${structs.size} types decoded with exact payload consumption; inventory, UI class/string/key and alliance reference cases matched.`);

const mapAsset=await assets.get('00_Training'),map=decodeMap(mapAsset.bytes);
const actor=map.actors.find(a=>a.name==='UNATCOTroop2'),actors=new Map(map.actors.map(a=>[a.index,a]));
const cls=await runtime.loadClass(mapAsset,exportAt(mapAsset.pkg, actor.index).classIndex);
const initial=await prepareMapProperties(runtime,mapAsset,actor,cls,actors);
const inventoryField=runtime.lookupMember(cls,'fields','InitialInventory'),values=initial(inventoryField);
const raw=readObject(mapAsset.pkg,mapAsset.bytes,actor.index).properties.find(p=>p.name==='InitialInventory'&&p.arrayIndex===0);
const reader=new Reader(raw.data),classRef=reader.compact(),count=reader.i32();
assert.equal(reader.offset,raw.data.length);
assert.equal(Object.values(values[0])[0],await runtime.objects.resolve(mapAsset,classRef));
assert.equal(Object.values(values[0])[1],count);
assert.deepEqual(values[3],runtime.defaultValue(cls,inventoryField)[3]);
const regionField=runtime.lookupMember(cls,'fields','Region'),region=initial(regionField);
const rawRegion=readObject(mapAsset.pkg,mapAsset.bytes,actor.index).properties.find(p=>p.name==='Region');
const regionReader=new Reader(rawRegion.data),zoneIndex=regionReader.compact();
assert.equal(Object.values(region)[0],actors.get(zoneIndex));
assert.deepEqual(Object.values(region).slice(1),[regionReader.i32(),regionReader.u8()]);
console.log('Training UNATCOTroop2 map struct overrides preserve package-correct class/actor identities and untouched inherited array entries.');
