import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptObjects} from '../src/runtime/script-objects.mjs';
import {compileFunction} from '../src/runtime/script-vm.mjs';
import {createGarbageArchive,GC_FLAGS} from '../src/runtime/script-gc.mjs';
import {createScriptGcBridge} from '../src/runtime/script-gc-bridge.mjs';

test('GC writes an individual bytecode operand and execution reads the same live slot',async()=>{
  const entry={name:'Shared',path:'Shared',className:'Object'};
  const asset={name:'Fixture',pkg:{version:68,exports:[entry],imports:[],names:[]}};
  const objects=new ScriptObjects({resolve:async(source,index)=>{
    assert.equal(source,asset);assert.equal(index,1);
    return {asset,index,entry,key:'Fixture.Shared'};
  }});
  // Original Core native119 compares UObject identity for inequality. Two
  // ObjectConst operands contain the same package index but occupy distinct
  // native four-byte pointer slots in this Return expression.
  const script={asset,pkg:asset.pkg,entry:{path:'SharedReferences'},
    bytes:Uint8Array.from([0x04,0x77,0x20,1,0x20,1,0x16]),size:13};
  const compiled=compileFunction(script);
  await objects.link(script,compiled.decoded);
  const nodes=[...compiled.decoded.expressions.values()].filter(node=>node.op===0x20);
  const shared=objects.operand(script,nodes[0]);
  assert.equal(objects.operand(script,nodes[1]),shared);
  const services={objectReference:(source,index,node)=>objects.operand(source,node)};
  assert.equal(compiled.run({}, {},services),false);
  const native={identity:shared,index:0,flags:GC_FLAGS.archiveExcluded};
  const registry={objects:[native],names:[],rootSet:[]};
  const archive=createGarbageArchive(registry,{serializeObject:()=>{
    throw new Error('An excluded object must not enter native Serialize');
  }});
  const bridge=createScriptGcBridge(archive,{registry,resolveObject:identity=>identity===shared?native:null,
    resolveName:()=>{throw new Error('This expression has no FName operands');}});
  assert.equal(objects.serializeExpression(script,nodes[0].offset,bridge),nodes[0].end);
  assert.equal(objects.operand(script,nodes[0]),null);
  assert.equal(objects.operand(script,nodes[1]),shared);
  assert.equal(objects.reference(script,1),shared);
  assert.equal(compiled.run({}, {},services),true);
});
