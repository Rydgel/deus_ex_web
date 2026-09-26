import {readUserConfig} from '../unreal/user-config.mjs';
import {refValue} from './script-vm.mjs';
import {scriptStringText,scriptStringComplementEqual} from './script-string-operations.mjs';
import {parseCommand,readInputAliases} from './script-console-command.mjs';

/** UInput::GetKeyName 0x10394b20; names come from original EInputKey data. */
export function inputKeyName(names,index){
  if(!Number.isInteger(index)||index<0||index>=255)return '';
  const name=names[index];
  if(typeof name!=='string')throw new Error('Original EInputKey name is missing');
  return name.length>3?name.slice(3):'';
}

/** UInput::FindKeyName 0x10394c40: find-only FName("IK_%s"), then enum scan. */
export function findInputKeyName(names,key){
  const name='IK_'+scriptStringText(key);
  if(/[^\x00-\x7f]/.test(name))throw new Error('Non-ASCII input-key FName folding is not recovered');
  return names.findIndex(candidate=>scriptStringComplementEqual(candidate,name));
}

// Core ParseCommand 0x10147a20 (script-console-command.mjs).
const commandArgument=parseCommand;
function inputKeyInteger(text){
  // appAtoi -> original CRT _wtoi. Overflow has no host-defined substitution.
  const number=/^[\t\n\v\f\r ]*([+-]?\d+)/.exec(text);
  if(!number)return 0;
  const value=Number(number[1]);
  if(!Number.isInteger(value)||value< -0x80000000||value>0x7fffffff)
    throw new Error('Input KEYNAME decimal overflow is not recovered');
  return value;
}

/** Read-only selected UInput::Exec commands. Unknown commands remain unhandled.
 * Original call order, native addresses and bounds: docs/script-input-console.md. */
export function createInputBindingQueries(names,bindings){
  const keyName=index=>inputKeyName(names,index);
  const keyBinding=key=>{
    const index=findInputKeyName(names,key);
    return index<0?'':bindings[index]??'';
  };
  return {names,keyName,keyBinding,
    execute(command){
      const text=scriptStringText(command);
      let argument=commandArgument(text,'KEYNAME');
      if(argument!==null)return {handled:true,value:keyName(inputKeyInteger(argument))};
      argument=commandArgument(text,'KEYBINDING');
      if(argument!==null)return {handled:true,value:keyBinding(argument)};
      return {handled:false};
    },
  };
}

/** The selected Engine.Engine.Input class, Extension.InputExt: registered at
 * Extension 0x1002cf10 with UInput's size 0xfb0, flags 0x04084004 (Config),
 * config name "User" and UInput's empty StaticConstructor (0x10393570), so it
 * declares no config property of its own. docs/script-input-console.md. */
export const INPUT_EXT_CLASS=Object.freeze({path:'Extension.InputExt',superPath:'Engine.Input',
  configName:'User',defaultIni:'DefUser.ini',staticClass:0x100a2e00,constructor:0x1002cfb0});

/**
 * UObject::LoadConfig(1) of an InputExt object (script-config.mjs order):
 * the Engine.Input pass, then the InputExt pass over the same inherited
 * properties. UInput::StaticInitInput 0x103930c0 declares them on
 * Engine.Input, all CPF_Config (0x4000) without GlobalConfig: Aliases[40] and
 * one string per EInputKey whose FName is not None, named past its first
 * three characters. A missing key keeps the value; UStrProperty import keeps
 * the whole text. `bindingRead` replaces only the Engine.Input binding reads
 * (a supplied fixture); every other read is GConfig in User.ini.
 */
function loadInputConfig(target,names,gconfig,warn,bindingRead=null){
  for(const section of [INPUT_EXT_CLASS.superPath,INPUT_EXT_CLASS.path]){
    const read=key=>gconfig.getString(section,key,INPUT_EXT_CLASS.configName,0x400);
    readInputAliases(read,warn,target.aliases);
    for(let index=0;index<names.length;index++){
      if(names[index]==='None')continue;
      const key=names[index].slice(3);
      const text=bindingRead&&section===INPUT_EXT_CLASS.superPath?bindingRead(key)??null:read(key);
      if(text!==null)target.bindings[index]=text;
    }
  }
}

export async function createInputConsole(runtime,assets,{config}={}){
  if(!runtime.classLoader)throw new Error('Input console requires the original native enum loader');
  const fixture=config!==undefined;
  config??=await readUserConfig(assets.configFiles??[]);
  if(!config.available)throw new Error('Input bindings require supplied User.ini or DefUser.ini');
  const engine=await assets.get('Engine');
  const identity=await runtime.objects.resolve(engine,engine.exportsByPath.get('actor.einputkey'));
  const record=await runtime.classLoader.load(identity);
  const table=runtime.classLoader.graph.slotOf(record,0x34);
  const names=table.data.map(name=>runtime.classLoader.graph.nameText(name));
  const gconfig=await runtime.classLoader.prepareConfig();
  const aliasWarnings=[],warn=message=>aliasWarnings.push(message);
  const bindingRead=fixture?key=>config.get(INPUT_EXT_CLASS.superPath,key):null;
  const store=()=>({bindings:names.map(()=>''),aliases:readInputAliases(()=>null)});
  // XInputExt::XInputExt 0x1002cfb0 (outside GIsEditor): LoadConfig(1) on the
  // InputExt class defaults, then on the new object. The UViewport's Input
  // (+0x60) is this object; console commands read its arrays in place.
  const defaults=store(),instance=store();
  loadInputConfig(defaults,names,gconfig,warn,bindingRead);
  loadInputConfig(instance,names,gconfig,warn,bindingRead);
  const {bindings,aliases}=instance;
  const query=createInputBindingQueries(names,bindings);
  /** UObject::ResetConfig(InputExt) Core 0x10151ac0 (docs/script-player-login.md). */
  function resetConfig(){
    // Config name "User" selects DefUser.ini: copy its class section into
    // GConfig's User file. GetSection's buffer copy (+0x18) is not recovered;
    // the installed DefUser.ini has no InputExt section.
    if(gconfig.find(INPUT_EXT_CLASS.defaultIni,false)?.find(INPUT_EXT_CLASS.path))
      throw new Error('ResetConfig of a DefUser.ini [Extension.InputExt] section is not recovered');
    // Loaded classes under InputExt (only InputExt): LoadConfig(1) on defaults.
    loadInputConfig(defaults,names,gconfig,warn,bindingRead);
    // Objects that are an InputExt (the one Input): LoadConfig(1), then
    // PostEditChange. UObject::PostEditChange 0x1014f9c0 only calls Modify
    // 0x10150170, which records into GUndo; only Editor.dll sets GUndo, so the
    // game's Modify returns.
    loadInputConfig(instance,names,gconfig,warn,bindingRead);
  }
  return {...query,bindings,config,aliases,aliasWarnings,defaults,resetConfig,
    /** APlayerPawn::execConsoleCommand 0x103ba200 through `commands`
     * (createConsoleCommands). */
    playerConsoleCommand(call,commands){
      if(call.record?.key!=='engine.playerpawn.consolecommand')return {handled:false};
      if(call.argumentCount!==1)throw new Error('PlayerPawn.ConsoleCommand requires one string argument');
      const command=refValue(call.evaluateArgument(0));
      // The native consumes its argument before testing Player, and returns an
      // empty string for a PlayerPawn without a UPlayer/viewport.
      if(!runtime.readNamed(call.receiver,'Player'))return {handled:true,value:''};
      if(!commands)return query.execute(command);
      return {handled:true,value:commands.consoleCommand(call.receiver,command)};
    },
  };
}
