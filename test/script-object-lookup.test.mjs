import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptObjectRegistry} from '../src/runtime/script-object-construction.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {createScriptObjectLookup} from '../src/runtime/script-object-lookup.mjs';

test('Core lookup uses live hash/name tables, class ancestry and source-ordered path resolution', () => {
  const names=createScriptNames({allocator:{free:()=>{throw new Error('No deletion in lookup');}}});
  names.intern('None');
  const registry=new ScriptObjectRegistry();
  const coreObjectClass={nativeAddress:0x1029e0d0,superClass:null};
  const corePackageClass={nativeAddress:0x1029b8e0,superClass:coreObjectClass};
  const base={superClass:coreObjectClass},derived={superClass:base},unrelated={superClass:coreObjectClass};
  const add=(name,outer,objectClass)=>{
    const resolved=names.intern(name);
    const object={name:resolved.name,nameIndex:resolved.index,index:-1,outer,objectClass};
    registry.add(object);return object;
  };
  const pkg=add('Core',null,corePackageClass);
  const nested=add('Thing',pkg,derived);
  const root=add('Thing',null,base);
  const shadow=add('Thing',null,unrelated);
  const group=add('Group',pkg,base); // ResolveName falls back from Package to Object.
  const child=add('Child',group,derived);
  const aliasQueries=[];
  const lookup=createScriptObjectLookup({registry,names,coreObjectClass,corePackageClass,
    getConfigString:query=>{
      aliasQueries.push(query);
      return query.key==='Missing'?{found:false}:{found:true,value:'Core.Group.Child'};
    },
  });
  assert.equal(lookup.findObject(null,'Thing'),shadow); // Hash head wins.
  assert.equal(lookup.staticFindObject({classRef:base,outer:null,name:'Thing'}),root);
  assert.equal(lookup.staticFindObject({classRef:base,outer:pkg,name:'Thing'}),nested);
  assert.equal(lookup.staticFindObject({classRef:base,outer:pkg,name:'Thing',exactClass:1}),null);
  assert.equal(lookup.staticFindObject({classRef:base,outer:-1,name:'Thing'}),root); // Root bucket before array.
  assert.equal(lookup.staticFindObject({classRef:derived,outer:-1,name:'Thing'}),nested);
  assert.equal(lookup.findObject(null,'core.group.child'),child);
  assert.equal(lookup.findObject(null,'ini:Engine.Section.Value'),child);
  assert.deepEqual(aliasQueries[0],{section:'Engine.Section',key:'Value',file:'System',maxLength:1024});
  assert.equal(lookup.findObject(null,'usr:Engine.Missing'),null);
  assert.equal(aliasQueries[1].file,'User');
  const count=names.names.length;
  assert.equal(lookup.findObject(null,'NeverInterned'),null);
  assert.equal(names.names.length,count);
  add('None',null,base);
  assert.equal(lookup.findObject(null,'None'),null);
  let outer=null,name='Core.Unknown.Child';
  assert.equal(lookup.resolveName({get:()=>outer,set:value=>{outer=value;}},
    {get:()=>name,set:value=>{name=value;}}),false);
  assert.equal(outer,pkg);assert.equal(name,'Unknown.Child');
});
