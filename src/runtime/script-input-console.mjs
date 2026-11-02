import {readUserConfig} from '../unreal/user-config.mjs';
import {refValue} from './script-vm.mjs';
import {scriptStringText,scriptStringComplementEqual} from './script-string-operations.mjs';
import {parseCommand,readInputAliases,ALIAS_MEMBERS,ALIAS_COUNT,consoleOutputDevice} from './script-console-command.mjs';

/** UInput::GetKeyName 0x10394b20; names come from original EInputKey data. */
export function inputKeyName(names,index){
  if(!Number.isInteger(index)||index<0||index>=255)return '';
  const name=names[index];
  if(typeof name!=='string')throw new Error('Original EInputKey name is missing');
  return name.length>3?name.slice(3):'';
}

/** The name UInput::StaticInitInput 0x103930c0 gives an EInputKey's UStrProperty: the enum name past "IK_" (the FName built at 0x1039329e).
 * IK_None's is "None", which is NAME_None, so its property takes the unique name its class numbers: StrProperty0 (the key the original's
 * User.ini holds for it, measured: docs/config-persistence.md). */
export function configKeyName(enumName){
  const key=enumName.slice(3);
  return key.toLowerCase()==='none'?'StrProperty0':key;
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
      const key=configKeyName(names[index]);
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
  // Engine.Input's native properties in TFieldIterator order: StaticInitInput
  // creates Aliases, then one string per named key ascending, and
  // UStruct::AddCppProperty 0x10125fd0 prepends each, so the keys come
  // first in descending order and Aliases last.
  const keyProperties=names.map((name,index)=>({name:configKeyName(name),index})).filter((_,index)=>names[index]!=='None').reverse();
  /** FindField 0x101011db over InputExt: FName compare, case-insensitive. */
  function findField(name){
    const wanted=scriptStringText(name);
    if(scriptStringComplementEqual(wanted,'Aliases'))return {kind:'aliases'};
    const key=keyProperties.find(property=>scriptStringComplementEqual(property.name,wanted));
    return key?{kind:'binding',index:key.index,name:key.name}:null;
  }
  // UStructProperty::ExportTextItem 0x10169710 over the Alias struct: every
  // member exports (Data == Delta), delimited: the string quoted with no
  // escaping (UStrProperty 0x101678a0, "\"%s\""), the name bare.
  const aliasText=alias=>'('+ALIAS_MEMBERS.map(member=>member.kind==='string'
    ?`${member.name}="${alias[member.name]??''}"`:`${member.name}=${alias[member.name]??'None'}`).join(',')+')';
  /** UObject::SaveConfig(CPF_Config, null) 0x10151540 on the InputExt class
   * defaults: every config property into [Extension.InputExt] of User.ini,
   * Flush(0), then the reload of the class defaults (LoadConfig(1)). */
  function saveDefaults(){
    for(const property of keyProperties)
      gconfig.setString(INPUT_EXT_CLASS.path,property.name,defaults.bindings[property.index]??'',INPUT_EXT_CLASS.configName);
    for(let index=0;index<ALIAS_COUNT;index++)
      gconfig.setString(INPUT_EXT_CLASS.path,`Aliases[${index}]`,aliasText(defaults.aliases[index]),INPUT_EXT_CLASS.configName);
    gconfig.flush(false,null);
    loadInputConfig(defaults,names,gconfig,warn,bindingRead);
  }
  /** GlobalSetProperty 0x101523a0 (immediate) of one InputExt property: the
   * live InputExt (the viewport's Input) imports the text, PostEditChange
   * (Modify, which returns in the game), then the class defaults import it
   * and SaveConfig(0x4000) runs on them. A key binding is a UStrProperty:
   * the whole remaining text. */
  function globalSetProperty(field,value){
    if(field.kind!=='binding')throw new Error('SET of InputExt Aliases (UStructProperty import of a fixed array) is not recovered');
    instance.bindings[field.index]=String(value);
    defaults.bindings[field.index]=String(value);
    saveDefaults();
  }
  return {...query,bindings,config,aliases,aliasWarnings,defaults,resetConfig,findField,globalSetProperty,
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
    /** UConsole::execConsoleCommand 0x10379900, the typed line's Enter (Console.Typing.KeyEvent): P_GET_STR S, P_FINISH, then
     * Viewport (+0x2c) -> its FExec (+0x2c) slot 0, UWindowsViewport::Exec, with the Console's own FOutputDevice (+0x28,
     * UConsole::Serialize) as Ar; the result is Exec's. */
    consoleConsoleCommand(call,commands){
      if(call.record?.key!=='engine.console.consolecommand')return {handled:false};
      if(call.argumentCount!==1)throw new Error('Console.ConsoleCommand requires one string argument');
      const command=scriptStringText(refValue(call.evaluateArgument(0)));
      if(!commands)throw new Error('Console.ConsoleCommand requires the console command chain');
      return {handled:true,value:Boolean(commands.viewportExec(command,consoleOutputDevice(runtime,call.receiver)))};
    },
  };
}
