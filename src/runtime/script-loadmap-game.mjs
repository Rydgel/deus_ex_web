/** Cold standalone LoadMap GameInfo branch, before the shared startup passes.
 * Original instructions and input contract: docs/script-loadmap-gameinfo.md.
 * Direct local map entry supplies URL.Op=[]; travel options remain unsupported.
 */
export async function prepareLoadMapGame({runtime, assets, level, levelInfo, prepareClass}) {
  const read=(actor,name)=>runtime.readNamed(actor,name);
  const write=(actor,name,value)=>runtime.writeNamed(actor,name,value);
  const configured=await runtime.classLoader.prepareConfig();
  const defaultType=read(levelInfo,'DefaultGameType');
  const path=defaultType?.key ?? configured.getString('Engine.Engine',
    level.engine?.client ? 'DefaultGame' : 'DefaultServerGame',null,256);
  if (!path) throw new Error('LoadMap GameInfo selection requires the installed Engine.Engine game class');
  const dot=path.indexOf('.'), asset=await assets.get(path.slice(0,dot));
  const index=asset.exportsByPath.get(path.slice(dot+1).toLowerCase());
  if (!index) throw new Error(`LoadMap selected missing GameInfo class: ${path}`);
  const cls=await runtime.loadClass(asset,index);
  if (!function(){for(let c=cls;c;c=c.base)if(c.record.key==='engine.gameinfo')return true;return false;}())
    throw new Error(`LoadMap class is not a GameInfo: ${path}`);
  await prepareClass(cls);
  for(const name of ['MutatorClass','GameReplicationInfoClass']) {
    const ref=runtime.defaultValue(cls,runtime.lookupMember(cls,'fields',name));
    if(ref) await prepareClass(await runtime.loadClass(ref.asset,ref.index));
  }
  const actors=new Set();
  const track=body=>{
    const from=level.actors.length;
    try{return body();}finally{for(const a of level.actors.slice(from))if(a)actors.add(a);}
  };
  let game=null, initialized=false;
  return {
    actors, options:'', class:cls,
    spawn(){
      if(game && level.actors.includes(game)) return game;
      // 0x1038d59d: NAME_None, null Owner/Instigator/Template, zero transform.
      // 0x1038d5a8 assigns Game only AFTER the unconditional SpawnActor chain.
      write(levelInfo,'Game',null);
      game=track(()=>runtime.spawnActor({cls:cls.record,level,name:'None',owner:null,
        instigator:null,location:[0,0,0],rotation:[0,0,0]}));
      if(!game)throw new Error('Original LoadMap GameInfo spawn assertion failed');
      write(levelInfo,'Game',game);
      return game;
    },
    reload(){
      // A reload is not a DestroyActor: the previous GameInfo, Mutator and
      // GameReplicationInfo belong to the unloaded level, which LoadMap's
      // collection has already purged (docs/script-loadmap-gc.md).
      if (initialized) { actors.clear(); game=null; initialized=false; }
      write(levelInfo,'bBegunPlay',false);write(levelInfo,'bStartup',false);
      const actor=this.spawn();write(levelInfo,'Game',actor);return actor;
    },
    init(){
      const args=['',''];
      track(()=>runtime.processEvent(game,'InitGame',args));
      initialized=true;
      return args[1];
    },
    active:()=>game,
  };
}
