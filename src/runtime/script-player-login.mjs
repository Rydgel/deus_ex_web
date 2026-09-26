/** Cold standalone ULevel::SpawnPlayActor (Engine.dll 0x10396bd0).
 * Only direct entry with empty URL.Op/Portal and no travel data is supported.
 * The scene supplies pawn services before Login can Spawn; this module never
 * constructs a replacement player. Evidence: docs/script-player-login.md.
 */
export async function preparePlayerLogin({runtime,assets,level,levelInfo,viewport,prepareClass}) {
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
    if(!index||asset.pkg.exports[index-1].className!=='Class')continue;
    const cls=await runtime.loadClass(asset,index);
    for(let ancestor=cls;ancestor;ancestor=ancestor.base)
      if(ancestor.record.key==='engine.playerpawn'){spawnClass=cls;break;}
    if(spawnClass)break;
  }
  if(!spawnClass)throw new Error('SpawnPlayActor cannot load a PlayerPawn from installed DefaultPlayer.Class or URL.Class');
  await prepareClass(spawnClass);
  const pri=runtime.defaultValue(spawnClass,runtime.lookupMember(spawnClass,'fields','PlayerReplicationInfoClass'));
  if(pri)await prepareClass(await runtime.loadClass(pri.asset,pri.index));
  let error='';
  return {
    class:spawnClass,options:'',portal:'',remoteRole:2,
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
      const args=['','',error,spawnClass.record];
      runtime.processEvent(game,'Login',args,result);
      error=args[2];
      if(!player)return null;
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
      // Explicit cold input: no travel text/imported actors. Their loops are
      // empty, while these three callbacks are still unconditional.
      runtime.processEvent(game,'AcceptInventory',[player]);
      runtime.processEvent(player,'TravelPostAccept');
      runtime.processEvent(game,'PostLogin',[player]);
      return player;
    },
  };
}
