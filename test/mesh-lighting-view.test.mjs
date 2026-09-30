import assert from 'node:assert/strict';
import test from 'node:test';
import {createMeshLightingView} from '../src/viewer/mesh-lighting-view.mjs';

// Native candidate gates: Render.dll 0x10b230e8..0x10b2311c. This tests
// deferred host record construction and live edits; the real-data/native
// SetupForActor composition remains validate-mesh-lighting-play.mjs.
test('mesh light records remain live when static collection is deferred',()=>{
  const levelInfo={name:'LevelInfo',Brightness:1,TimeSeconds:0};
  const light={name:'Light0',LightType:1,LightBrightness:128,LightRadius:32,
    bStatic:true,bNoDelete:false,bDynamicLight:false,bDeleteMe:false,
    LightHue:0,LightSaturation:0,LightEffect:0,LightPeriod:0,LightPhase:0,
    bMovable:false,bSpecialLit:false,Location:[0,0,32]};
  const mesh={name:'Mesh0',Location:[0,0,0],ScaleGlow:1,AmbientGlow:0,
    Region:{'engine.actor.pointregion.ileaf':0,'engine.actor.pointregion.zonenumber':1}};
  const level={actors:[levelInfo,light,mesh],model:{nodes:[],leaves:[{permeating:0}],lights:[1,0],rootOutside:true}};
  const reads=[];
  const runtime={readNamed:(actor,name)=>{reads.push([actor,name]);return actor?.[name];},soundField:()=>1};
  const view=createMeshLightingView(runtime,()=>level,{exportName:()=>light.name});
  const begin=()=>{reads.length=0;view.beginFrame({location:[0,0,0],rotation:[0,0,0],seconds:levelInfo.TimeSeconds++});};
  begin();
  assert.equal(view.frame.lights.has(light),false,'static light is not eagerly materialized');
  assert.ok(!reads.some(([actor,name])=>actor===light&&name==='LightHue'));
  const result=view.lightMesh(mesh,[[0,0,0],[1,0,0],[0,1,0]],[{vertices:[0,1,2],flags:256}]);
  assert.equal(view.frame.lights.get(light).values.LightBrightness,128,'static permeating light is still available');
  assert.ok(result.setup.lights.some(info=>info.light.actor===light));
  light.bDynamicLight=true;light.LightBrightness=64;light.LightHue=25;
  begin();
  assert.equal(view.frame.lights.get(light).values.LightBrightness,64);
  assert.equal(view.frame.lights.get(light).values.LightHue,25,'fields refreshed this frame');
  for(const field of ['LightType','LightBrightness','LightRadius']){
    const previous=light[field];light[field]=0;begin();
    assert.equal(view.frame.lights.has(light),false,`${field} zero rejects the moving light`);
    light[field]=previous;
  }
  light.bStatic=false;light.bNoDelete=true;light.bDynamicLight=false;begin();
  assert.equal(view.frame.lights.has(light),false,'NoDelete without DynamicLight rejects');
  light.bNoDelete=false;begin();assert.equal(view.frame.lights.has(light),true,'ordinary movable light admitted');
  light.bDeleteMe=true;begin();assert.equal(view.frame.lights.has(light),false,'deleted light excluded');
});
