import { exportAt } from '../unreal/objects.mjs';
/** Standalone ULevel::SpawnPlayActor (Engine.dll 0x10396bd0).
 * A cold direct entry has empty URL.Op/Portal and no travel data. A map entered by travel passes the `arrival` of the
 * travel step (travel.mjs: the URL's portal and options, TravelInfo), and `importer` (travel-import.mjs) applies the
 * travel text between the player's TravelPreAccept and AcceptInventory, as the native does (docs/travel.md).
 * The scene supplies pawn services before Login can Spawn; this module never
 * constructs a replacement player. Evidence: docs/script-player-login.md.
 */
export async function preparePlayerLogin({runtime,assets,level,levelInfo,viewport,prepareClass,arrival=null,importer=null,log=null}) {
  if(typeof prepareClass!=='function')throw new TypeError('Player login requires class preparation');
  const read=(actor,name)=>runtime.readNamed(actor,name);
  const write=(actor,name,value)=>runtime.writeNamed(actor,name,value);
  const config=await runtime.classLoader.prepareConfig();
  const candidates=[config.getString('DefaultPlayer','Class','User'),config.getString('URL','Class',null)];
  let spawnClass=null;
  for(const path of candidates) {
    if(!path)continue;
    const dot=path.indexOf('.');
    if(dot<=0||dot===path.length-1)continue;
    const packageName=path.slice(0,dot);
    if(!assets.files.has(packageName.toLowerCase()))continue;
    const asset=await assets.get(packageName),index=asset.exportsByPath.get(path.slice(dot+1).toLowerCase());
    if(!index||exportAt(asset.pkg, index).className!=='Class')continue;
    const cls=await runtime.loadClass(asset,index);
    for(let ancestor=cls;ancestor;ancestor=ancestor.base)
      if(ancestor.record.key==='engine.playerpawn'){spawnClass=cls;break;}
    if(spawnClass)break;
  }
  if(!spawnClass)throw new Error('SpawnPlayActor cannot load a PlayerPawn from installed DefaultPlayer.Class or URL.Class');
  await prepareClass(spawnClass);
  const pri=runtime.defaultValue(spawnClass,runtime.lookupMember(spawnClass,'fields','PlayerReplicationInfoClass'));
  if(pri)await prepareClass(await runtime.loadClass(pri.asset,pri.index));
  // A `loadonly` option skips the import (0x103971f7): the level is entered with no travel text read.
  const importing=Boolean(arrival&&importer&&!arrival.options.some(option=>option.toLowerCase()==='loadonly'));
  const prepared=importing?await importer.prepare(arrival):null;
  const portal=arrival?.portal??'',options=arrival?.optionsText??'';
  let error='';
  return {
    class:spawnClass,options,portal,remoteRole:2,
    /** Whether a travel text was imported (the player's subsystems are the travelling ones). */
    get imported(){return Boolean(prepared?.records.length);},
    get error(){return error;},
    login(){
      if(Number(read(levelInfo,'NetMode'))!==0||level.netDriver)
        throw new Error('SpawnPlayActor only supports a cold standalone level without NetDriver');
      if(!read(levelInfo,'bBegunPlay'))throw new Error('SpawnPlayActor requires completed LoadMap startup');
      const game=read(levelInfo,'Game');
      if(!game)throw new Error('SpawnPlayActor requires LevelInfo.Game');
      // The return field lives after the three FStrings and SpawnClass in the
      // original event record; it starts null independently of Error.
      error='';
      let player=null;
      const result={reference:true,get:()=>player,set:value=>{player=value;}};
      const args=[portal,options,error,spawnClass.record];
      log?.('Log',`Spawning new actor for Viewport ${viewport.name??'WindowsViewport0'}`);
      runtime.processEvent(game,'Login',args,result);
      error=args[2];
      if(!player)return null;
      log?.('Log',`Possessed PlayerPawn: ${runtime.instance(player).cls.record.name} ${runtime.instance(player).nativeObject?.outer?.name??'Level'}.${player.name}`);
      // APlayerPawn::SetPlayer, including its synchronous Possess callback.
      const old=read(viewport,'Actor');
      if(old){write(old,'Player',null);write(viewport,'Actor',null);}
      write(player,'Player',viewport);write(viewport,'Actor',player);
      runtime.processEvent(player,'Possess');
      write(player,'Role',4);write(player,'RemoteRole',2);
      write(player,'ShowFlags',0x480c);write(player,'RendMap',5);
      // No NetDriver is sufficient for this original bAdmin branch; no
      // command-line parsing is needed for the supported standalone input.
      write(player,'bAdmin',true);
      runtime.processEvent(player,'TravelPreAccept');
      // Without travel text the import loops are empty, while these callbacks are still unconditional. With it: the three passes,
      // then the imported actors' TravelPreAccept (last first) before AcceptInventory and their TravelPostAccept after it.
      const imported=prepared?importer.apply(prepared,player):null;
      imported?.preAccept();
      runtime.processEvent(game,'AcceptInventory',[player]);
      imported?.postAccept();
      runtime.processEvent(player,'TravelPostAccept');
      runtime.processEvent(game,'PostLogin',[player]);
      return player;
    },
  };
}
