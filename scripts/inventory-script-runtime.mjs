import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata,readStateMetadata} from '../src/unreal/script-metadata.mjs';
import {decodeScript} from '../src/unreal/bytecode.mjs';
import {primitiveNativeIndices} from '../src/runtime/script-vm.mjs';
import {TRIGGER_NATIVE_INDICES} from '../src/runtime/script-triggers.mjs';
import {RANDOM_LABEL_NATIVE} from '../src/runtime/script-conversation-random-label.mjs';
import {DEUSEX_VERSION_NATIVE} from '../src/runtime/script-deusex-version.mjs';
import {TEXT_PARSER_NATIVE} from '../src/runtime/script-text-parser.mjs';
import {gameDirectory} from './game-directory.mjs';

// Inspect the engine/game/UI script packages, without loading unrelated audio
// payloads or treating the existence of a declaration as native compatibility.
const packageNames=['Core','Engine','Extension','ConSys','DeusEx','UWindow','DeusExUI','Fire'];
const root=gameDirectory(),files=[];
for(const name of await readdir(path.join(root,'System')))files.push({path:name,
  read:()=>readFile(path.join(root,'System',name))});
const assets=new AssetStore(files),packages=[],declarations=new Map(),finalCalls=new Map();
const add=(counts,key)=>counts.set(key,(counts.get(key)??0)+1);
for(const name of packageNames){
  const asset=await assets.get(name),directCalls=new Map(),virtualCalls=new Map(),tokens=new Map();
  const result={name,version:asset.pkg.version,sha256:createHash('sha256').update(asset.bytes).digest('hex'),
    classes:0,functions:0,states:0,decodedScripts:0,nativeDeclarations:[],decodeErrors:[]};
  for(const [i,entry] of asset.pkg.exports.entries()){
    if(entry.className==='Class')result.classes++;
    if(!['Function','State'].includes(entry.className))continue;
    result[entry.className==='Function'?'functions':'states']++;
    const key=`${name}.${entry.path}`;
    try{
      const script=(entry.className==='Function'?readFunctionMetadata:readStateMetadata)(asset,i+1,{includeChildren:false});
      if(script.functionFlags&0x400){
        const native={function:key,index:script.nativeIndex,flags:script.functionFlags};
        result.nativeDeclarations.push(native);declarations.set(key.toLowerCase(),native);
      }
      const decoded=decodeScript(script);result.decodedScripts++;
      for(const node of decoded.expressions.values()){
        add(tokens,`0x${node.token.toString(16).padStart(2,'0')}`);
        if(node.op==='native')add(directCalls,node.index);
        if(node.op===0x1b||node.op===0x38)add(virtualCalls,node.name);
        if(node.op===0x1c){
          const target=await assets.resolve(asset,node.functionIndex);
          add(finalCalls,target.key.toLowerCase());
        }
      }
    }catch(error){result.decodeErrors.push({function:key,error:error.message});}
  }
  result.directNativeCalls=Object.fromEntries([...directCalls].sort((a,b)=>a[0]-b[0]));
  result.virtualCalls=Object.fromEntries([...virtualCalls].sort((a,b)=>b[1]-a[1]));
  result.opcodes=Object.fromEntries([...tokens].sort((a,b)=>a[0].localeCompare(b[0])));
  packages.push(result);
}
const bindings={
  primitives:primitiveNativeIndices,
  dynamicLoad:[{index:0,scope:'Core Object.DynamicLoadObject record only, through the prepared synchronous StaticLoadObject graph; other native-zero declarations remain unsupported'}],
  common:[{index:113,scope:'GotoState with linked class/state lookup and serialized-order Auto selection'},
    {index:117,scope:'Enable a declared probe on the current state frame'},
    {index:118,scope:'Disable a probe on the current state frame'},
    {index:167,scope:'Rand with an explicit shared original MSVCRT stream and signed int32 Max validation'},
    {index:195,scope:'FRand with the shared original MSVCRT random stream and float32 result'},
    {index:252,scope:'VRand with the original rejection-sampled unit-vector algorithm, shared MSVCRT stream and x87 reciprocal/float32 stores'},
    {index:320,scope:'RotRand: Yaw then Pitch = (2*rand())%65535, Roll only when the optional bRoll is true, on the shared MSVCRT stream'},
    {index:261,scope:'FinishAnim wrapper and latent action 0x181 poll over the linked animation view; animation-tick completion remains an explicit boundary'},
    {index:231,scope:'Core Object.Log with recovered argument/default-tag order and an explicit synchronous GLog output-device service'},
    {index:256,scope:'Sleep, finite actor state path'},
    {index:258,scope:'ClassIsChildOf through linked native class/super ancestry; selected Trigger.IsRelevant branch'},
    {index:272,scope:'SetOwner with linked actor fields and original LostChild/GainedChild events'},
    {index:278,scope:'CameraPoint native construction/startup in an explicitly supplied standalone world'},
    {index:279,scope:'Destroy with explicit world validation, collision/relationship services and native object registration'},
    {index:280,scope:'SetTimer, typed actor timer fields'},
    {index:281,scope:'IsInState with linked native state/super ancestry, including class sentinel'},
    {index:284,scope:'GetStateName from the native state node or class sentinel'},
    {index:267,scope:'SetLocation through an explicitly injected native-actor adapter and the recovered FarMoveActor(level,actor,location,0,0) route; missing adapter remains unsupported'},
    {index:299,scope:'SetRotation zero-delta short path; full rider/brush movement remains unsupported'},
    {index:303,scope:'IsA by original short class names for attached script instances'},
    {index:304,scope:'AllActors with an explicitly linked complete actor array'},
    {index:277,scope:'Trace through the recovered SingleLineCheck wrapper: GPropAddr out copyback, pre-stored Location/bCollideActors/zero-vector optional defaults, bTraceActors?0x37:6 flags and the zeroed FCheckResult miss shape'},
    {index:548,scope:'FastTrace through Level->Model->FastLineCheck with the pre-stored Location default and the exec\'s AL byte mask; geometry only, no hit outs'},
    {index:309,scope:'TraceActors MultiLineCheck iterator: checkActors=1, worldActor=this->+0xa8, BaseClass evaluated but non-filtering, Actor out cleared at natural exhaustion while the vector outs keep the last hit'},
    {index:1000,scope:'TraceTexture same MultiLineCheck iterator plus per-hit Item->Model->Nodes[i].iSurf->Surfs[s] texture/group/PolyFlags publish gated on the hit actor\'s LevelInfo ancestry'},
    {index:1024,scope:'Extension StringToName with explicit shared FName interning/error services'},
    {index:283,scope:'SetCollisionSize for collision-view actors: collide-bit-gated hash RemoveActor, raw f32 radius/height stores, AddActor re-add, unconditional result=1'},
    {index:310,scope:'RadiusActors iterator: BaseClass ancestry filter, pre-stored Loc optional default, strict (Radius+CollisionRadius)^2 > 3-axis dist^2 over the live Level.Actors array with no self-exclusion and per-resume out clear'},
    {index:311,scope:'VisibleActors iterator: BaseClass ancestry filter, +0x28 bit-2 hidden skip, pre-zeroed Radius with 0.0 distance-gate bypass else strict Radius^2 > dist^2, per-resume Level->Model->FastLineCheck(candidate.Location, Loc) visibility'},
    {index:718,scope:'IsOverlapping strict horizontal/vertical cylinder test with Primitive+Brush and world-actor exclusions and the exec\'s null-checkActor short circuit'},
    {index:298,scope:'SetBase for collision-view actors: NewBase self-ancestry guard, same-base early out, +0xa8 world exclusion, byte StandingCount detach/store/attach order and notify-gated BaseChange'},
    {index:306,scope:'BasedActors iterator: BaseClass ancestry filter, candidate->+0xc4==receiver Base test over the live Level.Actors array, per-resume out clear'},
    {index:266,scope:'Move wrapper: evaluated Delta, zeroed FCheckResult (Time=1.0f, Item=-1), raw Rotation copy and the Level->MoveActor vtable +0x88 call with four trailing zeros through an explicit live-level moveActor service; a scene without the service stays unsupported'},
    {index:512,scope:'MakeNoise: 0xf1/0xf2 LevelInfo warns on exec and body paths, NetMode==3 skip, instigator dual-slot suppression (strict T-0.2/T-0.18 f64 freshness, 2500 near, 0.9d loud) with f32(T) stamps, PawnList dispatch with PlayerPawn-skip for player noises else bidirectional IsA, and the 0x103bf7b0 hearing gate (4e6/1.6e7 ranges, zero-dist early out, Stimulus/threshold, Model FastLineCheck) ending in ProcessEvent(HearNoise,{L,this})'}],
  triggers:[{index:720,scope:'GetPlayerPawn through an explicit receiver XLevel→Engine→Client→first Viewport.Actor graph'},
    {index:1100,scope:'FlagBase.SetBool low-bit flag storage with explicit FlagBase/default-expiration service; expiration clock remains unsupported'},
    {index:1110,scope:'FlagBase.GetBool from explicit FlagBase storage; missing flags return false'}],
  sleep:[{index:384,scope:'Sleep latent poll with float32 remaining-time storage and strict half-DeltaSeconds wake threshold; actor state frame required'}],
  doors:[{index:264,scope:'Deferred sound boundary; audio playback is unimplemented'},
    {index:301,scope:'FinishInterpolation and latent poll302'},
    {index:724,scope:'Selected nonexact mover bounds'},
    {index:3970,scope:'Selected PHYS_MovingBrush mover and settled pushable-decoration rolling branches only'}],
  decorations:[{index:262,scope:'SetCollision boolean field/hash updates for selected one-shot trigger and decoration paths'},
    {index:265,scope:'Decoration StopSound deferred lifetime boundary; channel/audio transport remains unsupported'},
    {index:713,scope:'Decoration AISendEvent deferred AI/audio boundary'},
    {index:714,scope:'Decoration AIStartEvent deferred AI/audio boundary'},
    {index:715,scope:'Decoration AIEndEvent deferred AI/audio boundary'}],
  sound:[{index:264,scope:'Actor.PlaySound argument/default/channel/listener graph through explicit level/model/global-index/FastLineCheck services; selected door and LightSwitch routes may retain deferred effects and audio mixing remains unsupported'}],
  animation:[{index:259,scope:'Actor.PlayAnim sequence lookup and typed/raw animation state writes for prepared Mesh resources; selected LightSwitch and GM_Trench routes only, with rendering remaining unsupported'}],
  windows:[{index:1409,scope:'Window Destroy with recovered SafeDestroy/PreDestroy/KillAllChildren/CleanUp order; explicit native pointer/lifecycle services'},
    {index:1410,scope:'Window NewChild helper, exact lifecycle order; explicit construction, Init and visibility services'},
    {index:1411,scope:'Window Raise sibling reorder/reconfigure/focus path with explicit child-order services; null and last-child no-op branches covered'},
    {index:1413,scope:'Window Show/SetVisibility propagation with explicit parent callback and raw visibility flags'},
    {index:1414,scope:'Window Hide through the recovered SetVisibility path; same parent/effective visibility scope'},
    {index:1415,scope:'Window IsVisible recursive parent-chain query with explicit hierarchy services'},
    {index:1421,scope:'Window SetBackground identity write and parent reconfigure for canonical texture references'},
    {index:1422,scope:'Window SetBackgroundStyle plus XGC style/flag branch with explicit graphics/dirty services'},
    {index:1425,scope:'Window GetRootWindow through explicit native parent links and unsigned type byte'},
    {index:1431,scope:'Window SetSize/Resize float32 clamp/equality path with explicit reconfiguration service'},
    {index:1432,scope:'Window SetPos/Move alignment and float32 storage path with explicit reconfiguration service'},
    {index:1460,scope:'Window AskParentForReconfigure; explicit globals, diagnostic and virtual/ResizeChild leaves'},
    {index:1467,scope:'Window SetChildVisibility raw flag/effective visibility path with explicit parent/reconfigure services'},
    {index:1475,scope:'Window SetTileColor packed/normalized color path with explicit GC service'},
    {index:1476,scope:'Window SetTextColor packed/normalized color path with explicit GC service'},
    {index:1477,scope:'Window SetFont storage/GC propagation and parent reconfigure path with explicit font service'},
    {index:1550,scope:'TextWindow SetText case-insensitive guard, accelerator scan and parent reconfigure path'},
    {index:1556,scope:'TextWindow SetTextAlignments byte stores for prepared TextWindow controls'},
    {index:1557,scope:'TextWindow SetTextMargins float32 comparison/write and parent reconfigure path'},
    {index:1971,scope:'ComputerWindow SetTextSize storage and resize path with explicit window/GC services'},
    {index:1973,scope:'ComputerWindow SetTextFont storage and resize path with explicit window/GC services'},
    {index:1975,scope:'ComputerWindow SetTextTiming storage path for prepared ComputerWindow controls'},
    {index:1976,scope:'ComputerWindow SetFadeSpeed storage path for prepared ComputerWindow controls'},
    {index:1978,scope:'ComputerWindow SetCursorColor storage path for prepared ComputerWindow controls'},
    {index:1980,scope:'ComputerWindow ShowTextCursor state path for prepared ComputerWindow controls'},
    {index:1985,scope:'ComputerWindow ClearScreen queue/storage path with explicit memory service'},
    {index:1987,scope:'ComputerWindow Print text queue path with explicit text/storage services'},
    {index:2001,scope:'ComputerWindow EnableWordWrap flag path for prepared ComputerWindow controls'},
    {index:1416,scope:'Window SetSensitivity +0x30 bit 1 write with the recovered no-change early return, effective +0x138 walk and ordered CheckFocus/CheckGrabbed/Reconfigure leaves; optional default FALSE from the shipped immediate'},
    {index:1417,scope:'Window EnableWindow through the same XWindow::SetSensitivity body with optional default TRUE'},
    {index:1418,scope:'Window DisableWindow through the same body with the hardcoded 0 argument'},
    {index:1419,scope:'Window IsSensitive local dword read plus the +0x138 sensitive-bit ancestor walk'},
    {index:1455,scope:'Window GetTopChild +0x140 read with visible-bit early-out and GetLowerSibling delegation'},
    {index:1456,scope:'Window GetBottomChild +0x13c read with visible-bit early-out and GetHigherSibling delegation'},
    {index:1457,scope:'Window GetHigherSibling +0x148 walk skipping links whose visible bit is clear'},
    {index:1458,scope:'Window GetLowerSibling +0x144 walk skipping links whose visible bit is clear'},
    {index:1488,scope:'Window GetClientObject +0x118 read'}],
  conversation:[{index:2052,scope:'Conversation BindEvents; explicit GObjObjects; Speech, Animation/Trade and thirteen verified inherited BindActor classes'},
    {index:2053,scope:'Conversation BindActorEvents; same verified event-class dispatch as BindEvents'},
    {index:2054,scope:'Conversation ClearBindEvents original no-write event traversal'},
    {index:2055,scope:'Conversation GetSpeechAudio normal name/filename lookup and FString cleanup through explicit loader/heap services'},
    {index:2056,scope:'Conversation GetSpeechLength WAV/MP3 arithmetic with original lazy LoadSpecial and explicit speech lookup'},
    {index:2100,scope:'DeusExPlayer.ConBindEvents mission-list lookup/loading/bind path with explicit StaticLoadObject and ConversationList services'},
    {index:2101,scope:'DeusExDecoration.ConBindEvents same recovered mission-list path for the selected decoration route'},
    {index:2102,scope:'ScriptedPawn.ConBindEvents same recovered mission-list path for the selected scripted-pawn route'}],
};
// Support means a VM dispatch path: the primitive switch above, or an index that
// one of the runtime's native dispatch sites actually routes. Read each site's
// code with comments and string/template/regex contents blanked, so prose, error
// messages and module metadata cannot credit an index. A translated module
// (`nativeIndex: N`) that only its validator imports has no dispatch path; it is
// reported under translatedWithoutDispatch and not counted.
const nativeConstants={TRIGGER_NATIVE_INDICES,RANDOM_LABEL_NATIVE,DEUSEX_VERSION_NATIVE,TEXT_PARSER_NATIVE};
const nativeConstant=dotted=>{
  const [head,...rest]=dotted.split('.');
  const index=rest.reduce((value,key)=>value?.[key],nativeConstants[head]);
  if(!Number.isInteger(index))throw new Error(`Unresolved native index constant ${dotted}`);
  return index;
};
const dispatchSites=[
  {site:'ScriptRuntime.invokeNative',file:'src/runtime/script-runtime.mjs',start:/\n {2}invokeNative\(call\) \{/},
  {site:'ScriptRuntime latent poll',file:'src/runtime/script-runtime.mjs',start:/pollLatent:call=>\{/},
  {site:'ScriptRuntime.createIterator',file:'src/runtime/script-runtime.mjs',start:/\n {2}createIterator\(call\) \{/},
  {site:'window host natives',file:'src/runtime/script-window-host-natives.mjs',start:/export function dispatchWindowHostNative\(/},
  {site:'window host GC table',file:'src/runtime/script-window-gc-dispatch.mjs',start:/const natives\s*=\s*new Map\(/,table:true},
  {site:'window host sound',file:'src/runtime/script-window-sound.mjs',start:/export function dispatchWindowSoundNative\(/},
  {site:'window host actor references',file:'src/runtime/script-window-actor-refs.mjs',start:/const dispatch = call =>/},
  {site:'Play host nativeCall',file:'src/runtime/script-doors.mjs',start:/function nativeCall\(call\) \{/},
  {site:'Play host latent poll',file:'src/runtime/script-doors.mjs',start:/runtime\.pollLatent = \([^)]*\) => \{/},
  {site:'Play trigger natives',file:'src/runtime/script-triggers.mjs',start:/function handleNative\(call\) \{/},
  {site:'Play ConPlay natives',file:'src/runtime/script-conplay-live.mjs',start:/function handleNative\(call\)\{/},
  {site:'player log store',file:'src/runtime/script-player-log.mjs',start:/runtime\.native=call=>\{/},
  {site:'HUD background draw',file:'src/runtime/script-play-hud.mjs',start:/runtime\.native=call=>\{/},
  {site:'player overlay draw',file:'src/viewer/weapon-view-model.mjs',start:/runtime\.native=call=>\{/},
];
function blankNonCode(source){
  let out='',i=0,previous='';
  const regexAllowed=()=>/[=(,:;!&|?{}[]/.test(previous)||/\b(return|typeof|case|throw|in|of)\s*$/.test(out.slice(-16));
  while(i<source.length){
    const c=source[i],next=source[i+1];
    if(c==='/'&&next==='/'){while(i<source.length&&source[i]!=='\n'){out+=' ';i++;}continue;}
    if(c==='/'&&next==='*'){
      out+='  ';i+=2;
      while(i<source.length&&!(source[i]==='*'&&source[i+1]==='/')){out+=source[i]==='\n'?'\n':' ';i++;}
      out+='  ';i+=2;continue;
    }
    const quote=c==='"'||c==="'"||c==='`'?c:c==='/'&&regexAllowed()?'/':null;
    if(quote){
      out+=quote;i++;
      while(i<source.length&&source[i]!==quote){
        if(source[i]==='\\'){out+='  ';i+=2;continue;}
        if(quote==='/'&&source[i]==='['){while(i<source.length&&source[i]!==']'){out+=' ';i++;}}
        out+=source[i]==='\n'?'\n':' ';i++;
      }
      out+=quote;i++;previous=quote;continue;
    }
    out+=c;if(!/\s/.test(c))previous=c;i++;
  }
  return out;
}
function siteBody(text,{site,start,table}){
  const match=start.exec(text);
  if(!match)throw new Error(`Native dispatch site not found: ${site}`);
  const at=match.index;
  if(table)return text.slice(at,text.indexOf(']);',at)+3);
  // Anchors end at (or just before) the body brace; parameter braces precede it.
  for(let i=text.indexOf('{',at+match[0].length-1),depth=0;i<text.length;i++){
    if(text[i]==='{')depth++;
    else if(text[i]==='}'&&--depth===0)return text.slice(at,i+1);
  }
  throw new Error(`Native dispatch site is unterminated: ${site}`);
}
function routedIndices(body){
  const found=new Set();
  // A branch that only throws for its index refuses the native; it is no route.
  const code=body.replace(/if\s*\(\s*(?:call\.)?index\s*===\s*(?:0x[0-9a-fA-F]+|\d+)\s*\)\s*throw\b/g,'');
  for(const match of code.matchAll(/\bindex\s*[!=]==\s*(0x[0-9a-fA-F]+|\d+)\b/g))found.add(Number(match[1]));
  for(const match of code.matchAll(/\bindex\s*[!=]==\s*([A-Z_]+(?:\.\w+)+)/g))found.add(nativeConstant(match[1]));
  for(const match of code.matchAll(/\[([\d,\s]+)\]\.includes\(\s*(?:call\.)?index\s*\)/g))
    for(const item of match[1].split(','))if(item.trim())found.add(Number(item));
  for(const match of code.matchAll(/\bindex\s*>=\s*(\d+|[A-Z_]+(?:\.\w+)+)\s*&&\s*(?:call\.)?index\s*<=\s*(\d+|[A-Z_]+(?:\.\w+)+)/g)){
    const bound=text=>/^\d+$/.test(text)?Number(text):nativeConstant(text);
    for(let index=bound(match[1]);index<=bound(match[2]);index++)found.add(index);
  }
  for(const match of code.matchAll(/\bcase\s+(\d+)\s*:/g))found.add(Number(match[1]));
  for(const match of code.matchAll(/\[\s*(\d+)\s*,\s*gc\w+\s*\]/g))found.add(Number(match[1]));
  return found;
}
const dispatchedIndices=new Map(),sourceText=new Map();
for(const entry of dispatchSites){
  if(!sourceText.has(entry.file))sourceText.set(entry.file,blankNonCode(await readFile(path.resolve(entry.file),'utf8')));
  entry.indices=[...routedIndices(siteBody(sourceText.get(entry.file),entry))].sort((a,b)=>a-b);
  for(const index of entry.indices){
    if(!dispatchedIndices.has(index))dispatchedIndices.set(index,[]);
    dispatchedIndices.get(index).push(entry.site);
  }
}
const primitiveIndices=new Set(bindings.primitives);
const catalogued=new Set(),catalogueWithoutDispatch=[];
for(const [group,entries] of Object.entries(bindings)){
  if(group==='primitives')continue;
  for(const entry of entries){
    catalogued.add(entry.index);
    entry.sites=dispatchedIndices.get(entry.index)??[];
    if(!entry.sites.length&&!primitiveIndices.has(entry.index))catalogueWithoutDispatch.push({group,index:entry.index});
  }
}
bindings.dispatched=[...dispatchedIndices].filter(([index])=>!catalogued.has(index)&&!primitiveIndices.has(index))
  .sort((a,b)=>a[0]-b[0])
  .map(([index,sites])=>({index,sites,scope:'routed by the listed dispatch sites; branch scope not catalogued'}));
const translatedWithoutDispatch=[];
for(const directory of ['src/runtime','src/viewer'])for(const file of (await readdir(path.resolve(directory))).filter(name=>name.endsWith('.mjs'))){
  const text=await readFile(path.resolve(directory,file),'utf8');
  for(const match of text.matchAll(/nativeIndex:\s*(0x[0-9a-fA-F]+|\d+)/g)){
    const index=Number(match[1]);
    if(index>0&&!primitiveIndices.has(index)&&!dispatchedIndices.has(index)&&!translatedWithoutDispatch.some(item=>item.index===index))
      translatedWithoutDispatch.push({index,module:`${directory}/${file}`});
  }
}
translatedWithoutDispatch.sort((a,b)=>a.index-b.index);
const directNativeTotals=new Map();
for(const pkg of packages)for(const [index,count] of Object.entries(pkg.directNativeCalls))
  directNativeTotals.set(Number(index),(directNativeTotals.get(Number(index))??0)+count);
const supportedDirectNativeIndices=new Set([...primitiveIndices,...dispatchedIndices.keys()]);
const unsupportedDirectNativeCalls=[...directNativeTotals]
  .filter(([index])=>!supportedDirectNativeIndices.has(index))
  .sort((a,b)=>b[1]-a[1]||a[0]-b[0])
  .map(([index,count])=>({index,count}));
const report={packages,bindings,
  dispatchSites:dispatchSites.map(({site,file,indices})=>({site,file,indices})),
  catalogueWithoutDispatch,translatedWithoutDispatch,directNativeSummary:{
  totalCalls:[...directNativeTotals.values()].reduce((sum,count)=>sum+count,0),
  distinctIndices:directNativeTotals.size,
  supportedDistinctIndices:[...directNativeTotals.keys()].filter(index=>supportedDirectNativeIndices.has(index)).length,
  unsupportedDistinctIndices:unsupportedDirectNativeCalls.length,
  unsupportedDirectNativeCalls},finalNativeCalls:[...finalCalls].flatMap(([key,count])=>
  declarations.has(key)?[{...declarations.get(key),count}]:[]),
  note:'Declarations and decoded opcodes do not establish execution support. Supported direct indices are the VM primitives plus indices a runtime dispatch site routes; bindings describe scoped branches only and do not prove every branch. directNativeSummary ranks the remaining direct indices by decoded call count; translatedWithoutDispatch lists translated modules no dispatch site reaches; virtual dispatch and unindexed native hooks require separate coverage.'};
const output=path.resolve(process.argv[2]??'.cache/script-runtime-inventory.json');
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:output,packages:packages.map(p=>({name:p.name,classes:p.classes,
  functions:p.functions,states:p.states,nativeDeclarations:p.nativeDeclarations.length,
  directNativeIndices:Object.keys(p.directNativeCalls).length,decodeErrors:p.decodeErrors.length})),
  directNativeSummary:{totalCalls:report.directNativeSummary.totalCalls,
    distinctIndices:report.directNativeSummary.distinctIndices,
    supportedDistinctIndices:report.directNativeSummary.supportedDistinctIndices,
    unsupportedDistinctIndices:report.directNativeSummary.unsupportedDistinctIndices,
    unsupportedDirectNativeCalls:unsupportedDirectNativeCalls.reduce((sum,{count})=>sum+count,0),
    topUnsupportedDirectNativeCalls:unsupportedDirectNativeCalls.slice(0,20)},
  uncataloguedDispatchedIndices:bindings.dispatched.length,
  translatedWithoutDispatch:translatedWithoutDispatch.length,catalogueWithoutDispatch},null,2));
if(packages.some(p=>p.decodeErrors.length)||catalogueWithoutDispatch.length)process.exitCode=1;
