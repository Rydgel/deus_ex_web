/** Original native instruction/enum boundaries plus the real HUD RefreshKey
 * bytecode caller. No input aliases are executed by this read-only adapter. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readUserConfig} from '../src/unreal/user-config.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {createInputConsole} from '../src/runtime/script-input-console.mjs';
import {gameDirectory} from './game-directory.mjs';
const root=gameDirectory(),files=[];
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
 files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),runtime=new ScriptRuntime(assets,{nativeClassLoading:true});
assert.ok(assets.configFiles.some(file=>/user\.ini$/i.test(file.path)),'INI handles survive AssetStore');
const input=await createInputConsole(runtime,assets);
const query=text=>input.execute(text);
assert.equal(input.names.length,255);
assert.equal(input.names[0],'IK_None');assert.equal(input.names[13],'IK_Enter');
assert.equal(input.names[35],'IK_End');assert.equal(input.names[254],'IK_OEMClear');
for(const [command,value] of [['KEYNAME 0','None'],['KEYNAME 1','LeftMouse'],['KEYNAME 13','Enter'],
 ['keyname\t35','End'],[' \tKEYNAME +254','OEMClear'],['KEYNAME -1',''],['KEYNAME 255',''],
 ['KEYNAME words','None'],['KEYNAME+13','Enter']])assert.deepEqual(query(command),{handled:true,value});
// The original enum spells index 0xef with UK_, so GetKeyName's blind
// three-unit skip yields a name FindKeyName's IK_ prefix cannot resolve.
assert.equal(input.names[239],'UK_Unknown10F');
assert.equal(query('KEYNAME 239').value,'Unknown10F');
assert.equal(query('KEYBINDING Unknown10F').value,'');
assert.deepEqual(query('KEYNAME13'),{handled:false});
assert.deepEqual(query('OPEN Training'),{handled:false});
assert.deepEqual(query('KEYBINDING NotAnInputKey'),{handled:true,value:''});
assert.deepEqual(query('KEYBINDING LeftMouse '),{handled:true,value:''},'whole argument preserved');
assert.deepEqual(query('keybinding leftmouse'),query('KEYBINDING LeftMouse'));
assert.equal(query('KEYBINDING LeftMouse').value,input.config.get('Engine.Input','LeftMouse'));
assert.throws(()=>query('KEYNAME 2147483648'),/overflow/);

// Evidence guard: execute these bounds only against the independently inspected
// original binary. Byte checks pin branches and literals to this installation.
const binary=await readFile(`${root}/System/Engine.dll`);
assert.equal(createHash('sha256').update(binary).digest('hex'),'0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4');
const pe=binary.readUInt32LE(60),opt=pe+24,base=binary.readUInt32LE(opt+28);
const sections=opt+binary.readUInt16LE(pe+20),count=binary.readUInt16LE(pe+6);
function at(va,size){const rva=va-base;
 for(let i=0;i<count;i++){const p=sections+i*40,start=binary.readUInt32LE(p+12),n=binary.readUInt32LE(p+16);
  if(rva>=start&&rva<start+n)return binary.subarray(binary.readUInt32LE(p+20)+rva-start,binary.readUInt32LE(p+20)+rva-start+size);}
 throw Error('Unmapped binary address');
}
assert.deepEqual([...at(0x10394b55,6)],[0x81,0xfe,0xff,0,0,0],'GetKeyName compares with 255');
assert.deepEqual([...at(0x10394b9f,3)],[0x83,0xc0,0x12],'GetKeyName skips three UTF-16 units after FName header');
assert.equal(at(0x1047f3b4,14).toString('utf16le'),'KEYNAME');
assert.equal(at(0x1047f398,20).toString('utf16le'),'KEYBINDING');
assert.equal(at(0x1047f4b8,10).toString('utf16le'),'IK_%s');

// Execute the original caller in attached script storage, without claiming native
// Window construction. It must find the first configured BuySkills key in enum
// order, honoring a nonempty user override and a deliberately empty override.
const encode=text=>new TextEncoder().encode(text);
const config=await readUserConfig([
 {path:'System/User.ini',read:()=>encode('[Engine.Input]\nEnd=BuySkills\nA=BuySkills\nLeftMouse=\n[DeusEx.DeusExPlayer]\nbObjectBeltVisible=False\n')},
 {path:'System/DefUser.ini',read:()=>encode('[Engine.Input]\nEnd=Ignored\nLeftMouse=Fire\nRightMouse=ParseRightClick\n[DeusEx.DeusExPlayer]\nbCrosshairVisible=True\n')},
]);
assert.equal(config.get('Engine.Input','LeftMouse'),'');
assert.equal(config.get('Engine.Input','RightMouse'),'ParseRightClick');
assert.equal(config.get('DeusEx.DeusExPlayer','bObjectBeltVisible'),'False');
assert.equal(config.get('DeusEx.DeusExPlayer','bCrosshairVisible'),'True');
const fixture=await createInputConsole(runtime,assets,{config});
const engine=await assets.get('Engine'),deusEx=await assets.get('DeusEx');
const player={name:'InputConsolePlayer',kind:'PlayerPawn'},hud={name:'InputConsoleHUD',kind:'HUDMultiSkills'};
runtime.attach(player,await runtime.loadClass(engine,engine.exportsByPath.get('playerpawn')));
runtime.attach(hud,await runtime.loadClass(deusEx,deusEx.exportsByPath.get('hudmultiskills')));
runtime.namedReference(player,'Player').set({kind:'Viewport'});
runtime.namedReference(hud,'player').set(player);
await runtime.prepareFunction(deusEx,deusEx.exportsByPath.get('hudmultiskills.refreshkey'));
await runtime.prepareFunction(engine,engine.exportsByPath.get('playerpawn.consolecommand'));
runtime.native=call=>{const result=fixture.playerConsoleCommand(call);
 assert.equal(result.handled,true,`${call.record?.key}/${call.index}`);return result.value;};
runtime.callFunction(runtime.lookup(hud,'RefreshKey'),hud);
assert.equal(runtime.namedReference(hud,'curKeyName').get(),'End','first matching original enum index wins');
let evaluated=0;runtime.namedReference(player,'Player').set(null);
assert.deepEqual(fixture.playerConsoleCommand({record:{key:'engine.playerpawn.consolecommand'},receiver:player,
 argumentCount:1,evaluateArgument(){evaluated++;return 'KEYNAME 13';}}),{handled:true,value:''});
assert.equal(evaluated,1,'native evaluates the string before its null-Player branch');
console.log('input console: original enum/native bounds, installed INI binding queries, scalar fallback, HUDMultiSkills.RefreshKey and null Player passed');
