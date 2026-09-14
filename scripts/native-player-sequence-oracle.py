"""Original dry physics + real level geometry; explicit script/zone boundaries.
No collision results or MoveActor poses are supplied by the harness.
"""
import importlib.util,json,struct,sys,hashlib
from pathlib import Path
s=importlib.util.spec_from_file_location('player_move',Path(__file__).with_name('native-player-move-oracle.py'));p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
m=p.m
ps=importlib.util.spec_from_file_location('oracle_pool',Path(__file__).with_name('oracle_pool.py'));oracle_pool=importlib.util.module_from_spec(ps);ps.loader.exec_module(oracle_pool)
class Native(p.Native):
 def alloc(self,size):return super().alloc(0x800 if size==0x100 else size)
 def __init__(self,root,scene):
  self.sequence_active=False;self.sequence_trace=[];self.moves=[]
  super().__init__(root,scene)
  self.pawn=self.player
  self.write(self.level_table+0xb0,'I',0x10398480);self.write(self.level_table+0xac,'I',0x1039b940)
  self.probe=0x700fa000;self.cpu.mem_write(self.probe,bytes.fromhex('c2 04 00'));self.write(0x1059a02c,'I',self.probe)
  for i,(address,name) in enumerate([(0x105836f0,'Detach'),(0x105836f4,'Attach'),(0x105836f8,'BaseChange'),(0x105835b4,'SupportActor')],30):self.write(address,'I',i);self.names[i]=name
  table=self.alloc(0x200);self.write(table+0x10,'I',self.event);self.write(table+0x88,'I',0x103ca540);self.write(self.pawn,'I',table)
  for offset in [0xc8,0x330,0x33c]:self.write(self.pawn+offset,'IiI',self.info,-1,1)
  self.write(self.pawn+0xc4,'I',self.info);self.write(self.pawn+0x31,'B',4)
  self.write(self.pawn+0x318,'I',0x1002)
  for off,value in [(0x378,scene['pawnValues']['GroundSpeed']),(0x384,scene['pawnValues']['AccelRate']),(0x38c,scene['pawnValues']['MaxStepHeight']),(0x390,scene['pawnValues']['AirControl']),(0x3f8,scene['pawnValues']['BaseEyeHeight']),(0x394,-.6)]:self.write(self.pawn+off,'f',value)
  worldmodel=self.read(self.level+0x98,'I')[0];self.write(worldmodel+0x100,'I',len(scene['zones']))
  for i,z in enumerate(scene['zones']):
   actor=0 if z is None else self.alloc(0x1000)
   if actor:self.actor_ids[actor]=z
   self.write(worldmodel+0x104+24*i,'I',actor)
  textures=scene['textures'];surfaces=self.alloc(len(textures)*64);model=self.read(self.level+0x98,'I')[0];self.write(model+0x98,'III',surfaces,len(textures),len(textures))
  groups=list(dict.fromkeys(t['outerName']for t in textures if t));names=self.alloc(4*(len(groups)+1));self.write(self.read(0x10599a70,'I')[0],'I',names);outers={}
  for i,name in enumerate(groups,1):
   entry=self.alloc(128);outer=self.alloc(64);self.cpu.mem_write(entry+12,(name+'\0').encode('utf-16-le'));self.write(names+4*i,'I',entry);self.write(outer+0x20,'I',i);outers[name]=outer
  cache={}
  for i,t in enumerate(textures):
   if not t:continue
   if t['key']not in cache:
    tex=self.alloc(128);self.write(tex+0x18,'I',outers[t['outerName']]);self.write(tex+0x70,'f',t['friction']);cache[t['key']]=tex
   self.write(surfaces+64*i,'I',cache[t['key']])
  self.write(self.info+0x31c,'3f',*scene['zoneValues']['ZoneGravity']);self.write(self.info+0x334,'f',scene['zoneValues']['ZoneGroundFriction']);self.write(self.info+0x33c,'f',scene['zoneValues']['ZoneTerminalVelocity'])
 def on_instruction(self,cpu,address,size,data):
  if self.sequence_active:
   sp=cpu.reg_read(m.UC_X86_REG_ESP)
   if self.moves and address==self.moves[-1]['return']:
    v=self.moves.pop();self.sequence_trace[v['index']]['result']={'success':bool(cpu.reg_read(m.UC_X86_REG_EAX)),**self.result(0,v['hit']),'position':self.read(self.pawn+0x114,'3f')}
   if address==0x103990e0:
    self.moves.append({'return':self.read(sp,'I')[0],'index':len(self.sequence_trace),'hit':self.read(sp+32,'I')[0]});self.sequence_trace.append({'move':self.read(sp+8,'3f')})
   if address==0x103cc519:raise RuntimeError('Unsupported original Ladder movement')
   if address==0x10145433:
    message=self.read(sp,'I')[0];raw=bytes(self.cpu.mem_read(message,2048));text=raw.decode('utf-16-le').split('\0')[0]
    if 'fell out of the world' in text:raise RuntimeError('Fixture enters native ZoneNumber0: '+text)
    self.sequence_trace.append({'nativeLog':text});cpu.reg_write(m.UC_X86_REG_ESP,sp+8);cpu.reg_write(m.UC_X86_REG_EIP,0x10145435);return
   if address==self.probe:cpu.reg_write(m.UC_X86_REG_EAX,0);return
   if address==self.event:
    token,params,_=self.read(sp+4,'III');self.sequence_trace.append({'scriptBoundary':{0x103cc820:'WalkTexture',0x103cc57c:'WalkTexture',0x103d0326:'Landed',0x10399e65:'BumpWall'}.get(self.read(sp,'I')[0],self.names.get(token)),'token':token,'caller':hex(self.read(sp,'I')[0]),'actor':self.actor_ids.get(cpu.reg_read(m.UC_X86_REG_ECX))});return
   if address in [0x103ca540,0x103d0a50,0x103cef60,0x103c95f0,0x103cecc0,0x103ce4a0,0x1039b940]:self.sequence_trace.append({'native':hex(address)})
  return super().on_instruction(cpu,address,size,data)
 def run(self,c):
  a=self.pawn
  self.call(0x103583a0,self.hash,struct.pack('<I',a));self.write(a+0x114,'3f',*c['position']);self.write(a+0x1d4,'2f',20,c.get('height',43));self.call(0x103580b0,self.hash,struct.pack('<I',a))
  if 'groundSpeed'in c:self.write(a+0x378,'f',c['groundSpeed'])
  self.write(a+0x30,'B',c.get('physics',1));self.write(a+0x144,'3f',*c.get('velocity',[0,0,0]));self.write(a+0x150,'3f',*c.get('acceleration',[0,0,0]))
  self.player_active=True;self.sequence_active=True;self.player_events=[];self.sequence_trace=[];self.moves=[];self.hits=[];self.events=[];frames=[]
  for i in range(c.get('frames',1)):
   physics=self.read(a+0x30,'B')[0]
   if physics not in [1,2]:raise RuntimeError(f'Unsupported physics {physics}')
   self.write(a+0x12c,'3f',*self.read(a+0x114,'3f'))
   try:self.call(0x103ca540 if physics==1 else 0x103d0a50,a,struct.pack('<fi',c.get('dt',1/60),0))
   except Exception as e:raise RuntimeError(f'{c.get("name")} frame{i}: {e}; {list(self.trace)}')from e
   if self.read(a+0xc8,'I')[0]!=self.info or self.read(a+0x330,'I')[0]!=self.info or self.read(a+0x33c,'I')[0]!=self.info:raise RuntimeError('Unsupported non-LevelInfo zone transition')
   frames.append({'position':self.read(a+0x114,'3f'),'velocity':self.read(a+0x144,'3f'),'physics':self.read(a+0x30,'B')[0],'acceleration':self.read(a+0x150,'3f'),'traceEnd':len(self.sequence_trace),'queryEnd':len(self.events),'sceneEventEnd':len(self.player_events)})
  self.sequence_active=False;self.player_active=False
  return {'frames':frames,'trace':self.sequence_trace,'sceneEvents':self.player_events,'queries':self.events}
_WORKER=None
def _worker_init(root,scene_path):
 """Per-worker scene; each case still builds its own probe below."""
 global _WORKER;_WORKER=(Path(root),json.loads(Path(scene_path).read_text()))
def _worker_case(c):
 root,scene=_WORKER
 try:return Native(root,scene).run(c)
 except Exception as e:return {'unsupported':str(e)}
if __name__=='__main__':
 scene_bytes=Path(sys.argv[2]).read_bytes();cases_bytes=Path(sys.argv[3]).read_bytes()
 # Every case builds a full level scene, so the few cases are sharded across
 # workers; results stay in input order — identical to the serial run.
 results=oracle_pool.pooled_map(_worker_case,_worker_init,(sys.argv[1],sys.argv[2]),json.loads(cases_bytes))
 print(json.dumps({'hashes':m.m.base.HASHES|{'MSVCRT.dll':m.m.hash_module.CRT_HASH},'sceneSha256':hashlib.sha256(scene_bytes).hexdigest(),'casesSha256':hashlib.sha256(cases_bytes).hexdigest(),'results':results}))
