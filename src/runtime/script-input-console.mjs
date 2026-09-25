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

export async function createInputConsole(runtime,assets,{config}={}){
  if(!runtime.classLoader)throw new Error('Input console requires the original native enum loader');
  config??=await readUserConfig(assets.configFiles??[]);
  if(!config.available)throw new Error('Input bindings require supplied User.ini or DefUser.ini');
  const engine=await assets.get('Engine');
  const identity=await runtime.objects.resolve(engine,engine.exportsByPath.get('actor.einputkey'));
  const record=await runtime.classLoader.load(identity);
  const table=runtime.classLoader.graph.slotOf(record,0x34);
  const names=table.data.map(name=>runtime.classLoader.graph.nameText(name));
  const bindings=names.map(name=>config.get('Engine.Input',name.slice(3))??'');
  const query=createInputBindingQueries(names,bindings);
  // UInput::StaticInitInput's LoadConfig reads Aliases[i] through GConfig
  // (script-console-command.mjs readInputAliases).
  const gconfig=await runtime.classLoader.prepareConfig();
  const aliasWarnings=[];
  const aliases=readInputAliases(key=>gconfig.getString('Engine.Input',key,'User',0x400),message=>aliasWarnings.push(message));
  return {...query,bindings,config,aliases,aliasWarnings,
    /** APlayerPawn::execConsoleCommand 0x103ba200 through `commands`
     * (createConsoleCommands). */
    playerConsoleCommand(call,commands){
      if(call.record?.key!=='engine.playerpawn.consolecommand')return {handled:false};
      if(call.argumentCount!==1)throw new Error('PlayerPawn.ConsoleCommand requires one string argument');
      const command=refValue(call.evaluateArgument(0));
      // The native consumes its argument before testing Player, and returns an
      // empty string for a PlayerPawn without a UPlayer/viewport.
      if(!runtime.namedReference(call.receiver,'Player').get())return {handled:true,value:''};
      if(!commands)return query.execute(command);
      return {handled:true,value:commands.consoleCommand(call.receiver,command)};
    },
  };
}
