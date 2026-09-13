/** Focused original-bytecode integration for the visible InfoLink shell. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {createInfoLinkShellPreview} from '../src/runtime/script-infolink-shell.mjs';
import {createNativeRng} from '../src/runtime/rng.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['System','Textures'])for(const name of await readdir(path.join(root,directory)))
  files.push({path:`${directory}/${name}`,read:()=>readFile(path.join(root,directory,name))});
const assets=new AssetStore(files),deusEx=await assets.get('DeusEx');
const rng=createNativeRng(1),initialRngState=rng.state;
const runtime=new ScriptRuntime(assets,{rng});
const player={name:'JCDentonMaleInfoLinkFixture'};
runtime.attach(player,await runtime.loadClass(deusEx,deusEx.exportsByPath.get('jcdentonmale')));
const shell=await createInfoLinkShellPreview({runtime,assets,player});

assert.equal(shell.width,431);assert.equal(shell.height,114);
assert.equal(shell.title,'INCOMING TRANSMISSION...');
assert.equal(shell.content.conversationName,'DL_Start');
assert.equal(shell.content.speakerDisplayName,'Jaime Reyes');
assert.equal(shell.content.portrait.key,'InfoPortraits.JaimeReyes');
assert.deepEqual(shell.colors.background,{r:127,g:127,b:127,a:0});
assert.deepEqual(shell.colors.border,{r:255,g:255,b:255,a:0});
assert.deepEqual(shell.colors.text,{r:200,g:200,b:200,a:0});
assert.deepEqual(shell.colors.header,{r:255,g:255,b:255,a:0});
assert.deepEqual(shell.colors.line,{r:200,g:200,b:200,a:0});
assert.deepEqual(shell.controls,['winPortrait','winStatic','winName','winQueued','winText','winLine']);
assert.deepEqual(shell.initializedControls,[{
  name:'winPortrait',x:20,y:25,width:64,height:64,backgroundStyle:1,visible:true,
},{name:'winStatic',x:20,y:25,width:64,height:64,backgroundStyle:4,visible:false,
  bLineVisible:false,lineInterval:0.037572357803583145,linePauseDelay:0.8466521501541138,
  currentLinePosY:-6},{name:'winName',x:94,y:15,width:293,height:15,visible:true,
  horizontalAlignment:0,verticalAlignment:1,horizontalMargin:0,verticalMargin:0,
  text:'INCOMING TRANSMISSION...',font:'deusexui.fontmenuheaders_ds',
  boldFont:'deusexui.fontmenuheaders_ds',textColor:{r:255,g:255,b:255,a:0},
  wordWrap:true,textIsAccelerator:true,acceleratorKey:0},{
  name:'winQueued',x:187,y:15,width:200,height:15,visible:true,
  horizontalAlignment:2,verticalAlignment:1,horizontalMargin:0,verticalMargin:0,
  text:'',font:'deusexui.fontmenuheaders_ds',boldFont:'deusexui.fontmenuheaders_ds',
  textColor:{r:200,g:200,b:200,a:0},wordWrap:true,textIsAccelerator:true,acceleratorKey:0},{
  name:'winText',x:94,y:36,width:294,height:60,visible:true,columns:42,rows:6,
  font:'deusexui.fontfixedwidthsmall_ds',fontWidth:7,fontHeight:10,
  textTiming:0.029999999329447746,fadeSpeed:0.75,cursorColor:{r:255,g:255,b:255,a:0},
  wordWrap:true,queuedEvents:[{type:1,time:0,color:13158600,colorWord:13158600,
    fields:{type:1,time:0,color:13158600,colorWord:13158600}}]},{
  name:'winLine',x:94,y:32,width:293,height:1,visible:true,backgroundStyle:1,
  background:'extension.solid',tileColor:{r:200,g:200,b:200,a:0}}]);
assert.equal(rng.state,initialRngState,'diagnostic preview restores the shared original RNG state');
assert.match(shell.boundary,/completed all six authored controls/i);
assert.deepEqual(shell.events,[
  'HUDInfoLinkDisplay StaticConstructObject','HUDInfoLinkDisplay XWindow::Init',
  'winPortrait StaticConstructObject','winPortrait XWindow::Init','winPortrait SetVisibility',
  'winPortrait GeneratePolyFlags',
  'winStatic StaticConstructObject','winStatic XWindow::Init','winStatic SetVisibility',
  'winStatic GeneratePolyFlags','winName StaticConstructObject','winName XTextWindow::Init',
  'winName SetVisibility','winQueued StaticConstructObject','winQueued XTextWindow::Init',
  'winQueued SetVisibility','winText StaticConstructObject','winText XComputerWindow::Init',
  'winText SetVisibility','winLine StaticConstructObject','winLine XWindow::Init',
  'winLine SetVisibility','winPortrait GeneratePolyFlags','winLine AskParentForReconfigure',
  'HUDInfoLinkDisplay SetVisibility',
]);
assert.deepEqual(shell.native,{lockCount:0,visible:true,parent:true});
assert.equal(runtime.namedReference(shell.object,'player').get(),player);
runtime.namedReference(shell.hud,'infoLink').set(shell.object);
const destroyInfoLink=runtime.lookup(shell.hud,'DestroyInfoLinkWindow');
shell.withLifecycle(()=>runtime.callFunction(destroyInfoLink,shell.hud,0));
assert.equal(runtime.namedReference(shell.hud,'infoLink').get(),null,
  'original DeusExHUD.DescendantRemoved clears its InfoLink reference');
assert.equal(shell.isDestroyed(shell.object),true);
for(const object of Object.values(shell.objects))assert.equal(shell.isDestroyed(object),true,
  `${object.name} follows the native recursive destruction path`);
const recreated=shell.recreate();
assert.notEqual(recreated.object,shell.object,'fresh construction creates a new HUDInfoLinkDisplay');
assert.equal(recreated.root,shell.root);assert.equal(recreated.hud,shell.hud);
assert.deepEqual(recreated.initializedControls,shell.initializedControls);
assert.equal(recreated.native.parent,true);
assert.equal(recreated.isDestroyed(recreated.object),false);
for(const object of Object.values(recreated.objects))assert.equal(recreated.isDestroyed(object),false);
console.log('InfoLink shell passed: original CreateControls initializes all six controls; DeusExHUD destruction recursively removes them and a fresh child reconstructs on the same root/HUD graph.');
