import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlagBase,
  createScriptTriggers,
  prepareTriggerFunctions,
  resolveNativeGetPlayerPawn,
} from '../src/runtime/script-triggers.mjs';

test('FlagBase matches recovered SetBool/GetBool add, update, return, and expiration rules', () => {
  const flagBase = createFlagBase({
    initialFlags: { Existing: true, Expired: { value: true, expiration: 7 } },
  });
  assert.equal(flagBase.getBool('Existing'), true);
  assert.equal(flagBase.getBool('Missing'), false);
  assert.equal(flagBase.getBool('Expired'), true);
  assert.equal(flagBase.setBool('NoAdd', true, false), false);
  assert.equal(flagBase.getBool('NoAdd'), false);
  assert.equal(flagBase.setBool('MissionFlag', true), true);
  assert.deepEqual(flagBase.getEntry('MissionFlag'), {
    name: 'MissionFlag', type: 0, value: true, bAdd: true, expiration: 0, requestedExpiration: -1,
  });
  assert.equal(flagBase.setBool('MissionFlag', false, true, 42), true);
  assert.deepEqual(flagBase.getEntry('MissionFlag'), {
    name: 'MissionFlag', type: 0, value: false, bAdd: true, expiration: 42, requestedExpiration: 42,
  });
  // The native body preserves only bit 0 of a direct integer UBOOL word.
  assert.equal(flagBase.setBool('MissionFlag', 2), true);
  assert.equal(flagBase.getBool('MissionFlag'), false);
  assert.equal(flagBase.setBool('MissionFlag', 3), true);
  assert.equal(flagBase.getBool('MissionFlag'), true);
});

test('mission flag deletion preserves zero expiration and compares signed mission criteria', () => {
  // Original Extension.dll 10024b3b..10024b4d: zero is permanent; JG retains
  // only expirations strictly greater than criteria. Native 1121 is typed.
  const flags=createFlagBase({initialFlags:{
    Negative:{value:true,expiration:-1},Permanent:{value:true,expiration:0},
    Equal:{value:true,expiration:1},Future:{value:true,expiration:2},
  }});
  const actions=createScriptTriggers({flagBase:flags});
  const call=(index,...args)=>actions.handleNative({index,receiver:flags,argumentCount:args.length,
    evaluateArgument:i=>({reference:true,get:()=>args[i]})});
  assert.deepEqual(call(1124,0),{handled:true,value:undefined});
  assert.equal(flags.getEntry('Negative'),null);
  assert.ok(flags.getEntry('Permanent'));
  assert.ok(flags.getEntry('Equal'));
  assert.ok(flags.getEntry('Future'));
  call(1124,1);
  assert.equal(flags.getEntry('Equal'),null);
  assert.ok(flags.getEntry('Permanent'));
  assert.ok(flags.getEntry('Future'));
  assert.deepEqual(call(1121,'Future',2),{handled:true,value:false},'wrong type does not delete a bool');
  assert.deepEqual(call(1121,'FUTURE',0),{handled:true,value:true});
  assert.deepEqual(call(1121,'Future',0),{handled:true,value:false});
  call(1124,0x7fffffff);
  assert.ok(flags.getEntry('Permanent'),'zero survives every mission criterion');
});

test('native adapter unwraps VM references and leaves unrelated natives unclaimed', () => {
  const player = { name: 'JCDentonMale' };
  const viewport = { Actor: player };
  const client = { Viewports: { data: [viewport], count: 1 } };
  const engine = { Client: client };
  const level = { Engine: engine };
  const receiver = { XLevel: level };
  const actions = createScriptTriggers({
    player,
    flagBase: createFlagBase(),
    getPlayerPawnServices: { read: (object, name) => object[name] },
  });
  assert.deepEqual(actions.handleNative({ index: 720, argumentCount: 0, receiver }), {
    handled: true, value: player,
  });
  assert.equal(resolveNativeGetPlayerPawn(receiver, {
    read: (object, name) => object[name],
  }), player);
  client.Viewports.count = 0;
  assert.equal(resolveNativeGetPlayerPawn(receiver, {
    read: (object, name) => object[name],
  }), null);
  client.Viewports.count = 1;
  client.Viewports.data = [];
  assert.throws(() => resolveNativeGetPlayerPawn(receiver, {
    read: (object, name) => object[name],
  }), /count is positive but data is empty/);
  assert.deepEqual(actions.handleNative({
    index: 123,
    argumentCount: 2,
    receiver: {},
    evaluateArgument: index => index ? '' : 'EventName',
  }), { handled: true, value: true });
  assert.deepEqual(actions.handleNative({
    index: 123,
    argumentCount: 2,
    receiver: {},
    evaluateArgument: () => '',
  }), { handled: true, value: false });
  assert.throws(() => actions.handleNative({
    index: 123,
    argumentCount: 2,
    receiver: {},
    evaluateArgument: index => index ? '' : null,
  }), /typed string operands/);
  assert.deepEqual(actions.handleNative({
    index: 1100,
    argumentCount: 2,
    receiver: actions.flagBase,
    evaluateArgument: index => ({ reference: true, get: () => ['ReferenceFlag', false][index] }),
  }), { handled: true, value: true });
  assert.equal(actions.flagBase.getBool('ReferenceFlag'), false);
  assert.deepEqual(actions.handleNative({
    index: 1110,
    argumentCount: 1,
    receiver: actions.flagBase,
    evaluateArgument: () => 'ReferenceFlag',
  }), { handled: true, value: false });
  assert.throws(() => actions.handleNative({
    index: 1110,
    argumentCount: 1,
    receiver: {},
    evaluateArgument: () => 'ReferenceFlag',
  }), /unbound receiver/);
  assert.deepEqual(actions.handleNative({ index: 999, argumentCount: 0 }), { handled: false });
  assert.equal(actions.dispatch, undefined, 'event bodies remain original VM functions');
});

test('prepareTriggerFunctions covers original trigger bodies, inherited callbacks, and FlagBase natives', async () => {
  const prepared = [];
  const runtime = {
    prepareFunction: async (asset, index) => {
      const key = `${asset.name}.${index}`;
      prepared.push(key);
      return { key };
    },
  };
  const assets = {
    get: async name => ({
      name,
      exportsByPath: { get: path => path },
    }),
  };
  const records = await prepareTriggerFunctions(runtime, assets);
  for (const key of [
    'Engine.actor.trigger', 'Engine.actor.untrigger', 'Engine.trigger.touch',
    'Engine.trigger.untouch', 'Engine.trigger.isrelevant',
    'DeusEx.orderstrigger.touch', 'DeusEx.orderstrigger.trigger',
    'DeusEx.orderstrigger.startpatrolling', 'DeusEx.scriptedpawn.setorders',
    'DeusEx.scriptedpawn.followorders', 'DeusEx.flagtrigger.touch',
    'DeusEx.flagtrigger.trigger', 'DeusEx.damagetrigger.timer',
    'DeusEx.damagetrigger.touch', 'DeusEx.damagetrigger.untrigger',
    'DeusEx.deusexplayer.takedamage', 'DeusEx.deusexplayer.adddamagedisplay',
    'DeusEx.deusexplayer.dxreducedamage', 'DeusEx.deusexplayer.stoppoison',
    'DeusEx.deusexplayer.usingchargedpickup', 'DeusEx.deusexplayer.setdamagepercent',
    'DeusEx.deusexplayer.clientflash',
    'Extension.flagbase.setbool', 'Extension.flagbase.getbool',
  ]) assert.ok(records.has(key), `prepared ${key}`);
  assert.equal(records.size, prepared.length);
  assert.equal(records.size, 32);
});
