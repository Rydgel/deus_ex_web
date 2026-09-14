import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata,readStateMetadata} from '../src/unreal/script-metadata.mjs';
import {decodeScript} from '../src/unreal/bytecode.mjs';
import {primitiveNativeIndices} from '../src/runtime/script-vm.mjs';
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
    {index:718,scope:'IsOverlapping strict horizontal/vertical cylinder test with Primitive+Brush and world-actor exclusions and the exec\'s null-checkActor short circuit'}],
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
const directNativeTotals=new Map();
for(const pkg of packages)for(const [index,count] of Object.entries(pkg.directNativeCalls))
  directNativeTotals.set(Number(index),(directNativeTotals.get(Number(index))??0)+count);
const supportedDirectNativeIndices=new Set(Object.values(bindings).flatMap(group=>
  group.map(entry=>typeof entry==='number'?entry:entry.index)));
const unsupportedDirectNativeCalls=[...directNativeTotals]
  .filter(([index])=>!supportedDirectNativeIndices.has(index))
  .sort((a,b)=>b[1]-a[1]||a[0]-b[0])
  .map(([index,count])=>({index,count}));
const report={packages,bindings,directNativeSummary:{
  totalCalls:[...directNativeTotals.values()].reduce((sum,count)=>sum+count,0),
  distinctIndices:directNativeTotals.size,
  supportedDistinctIndices:[...directNativeTotals.keys()].filter(index=>supportedDirectNativeIndices.has(index)).length,
  unsupportedDistinctIndices:unsupportedDirectNativeCalls.length,
  unsupportedDirectNativeCalls},finalNativeCalls:[...finalCalls].flatMap(([key,count])=>
  declarations.has(key)?[{...declarations.get(key),count}]:[]),
  note:'Declarations and decoded opcodes do not establish execution support. Bindings describe scoped branches only; directNativeSummary ranks unlisted direct indices by decoded call count; virtual dispatch and unindexed native hooks require separate coverage.'};
const output=path.resolve(process.argv[2]??'.cache/script-runtime-inventory.json');
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:output,packages:packages.map(p=>({name:p.name,classes:p.classes,
  functions:p.functions,states:p.states,nativeDeclarations:p.nativeDeclarations.length,
  directNativeIndices:Object.keys(p.directNativeCalls).length,decodeErrors:p.decodeErrors.length})),
  directNativeSummary:{totalCalls:report.directNativeSummary.totalCalls,
    distinctIndices:report.directNativeSummary.distinctIndices,
    supportedDistinctIndices:report.directNativeSummary.supportedDistinctIndices,
    unsupportedDistinctIndices:report.directNativeSummary.unsupportedDistinctIndices,
    topUnsupportedDirectNativeCalls:unsupportedDirectNativeCalls.slice(0,20)}},null,2));
if(packages.some(p=>p.decodeErrors.length))process.exitCode=1;
