"""Original callback bookkeeping; script events and IsProbing supplied explicitly."""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('c',Path(__file__).with_name('native-collision-oracle.py'));c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
spec = importlib.util.spec_from_file_location('native_o3_replay', Path(__file__).with_name('native-o3-replay.py'))
o3r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(o3r)
class Native(c.NativeCollision):
 def __init__(self,root):
  super().__init__(root);self.events=[];self.active=False
  self.actors=[self.alloc(0x1000) for _ in range(4)];self.pawn,self.world,self.old,self.new=self.actors
  # Non-Pawn source class: a self-contained class whose null SuperField (+0x28)
  # makes the inlined this->IsA(APawn) walk off the chain, selecting processHitWall's
  # non-Pawn branch (0x103cee37) instead of the Pawn branch (0x103ced3d).
  self.source_class=self.alloc(0x40);self.write(self.source_class+0x28,'I',0)
  vt=self.alloc(0x100);self.event=0x700fc000;self.find=0x700fc020;self.probe=0x700fc040
  for p in self.actors:self.write(p,'I',vt)
  self.write(vt+0x10,'I',self.event)
  self.cpu.mem_write(self.event,bytes.fromhex('c2 0c 00'));self.cpu.mem_write(self.find,bytes.fromhex('c2 08 00'));self.cpu.mem_write(self.probe,bytes.fromhex('c2 04 00'))
  self.write(0x10599a88,'I',self.find);self.write(0x1059a02c,'I',self.probe)
  self.names={}
  for i,(address,name) in enumerate([(0x105836f0,'Detach'),(0x105836f4,'Attach'),(0x105836f8,'BaseChange'),(0x105835b4,'SupportActor'),(0x10583714,'HitWall')]):
   self.write(address,'I',i+1);self.names[i+1]=name
 def on_instruction(self,cpu,address,size,data):
  if self.active and getattr(self,'o3_case',None) is not None and self.o3_service(cpu,address):return
  if self.active:
   stack=cpu.reg_read(c.UC_X86_REG_ESP)
   if address==self.find:cpu.reg_write(c.UC_X86_REG_EAX,self.read(stack+4,'I')[0]);return
   if address==self.probe:cpu.reg_write(c.UC_X86_REG_EAX,self.probing);return
   if address==self.event:
    token,params,_=self.read(stack+4,'III');event={'event':self.names[token],'target':self.actors.index(cpu.reg_read(c.UC_X86_REG_ECX)),
     'base':self.index(self.read(self.pawn+0xc4,'I')[0]),'physics':self.read(self.pawn+0x30,'B')[0]}
    if token==5:event['normal']=list(self.read(params,'3f'))
    self.events.append(event);return
  super().on_instruction(cpu,address,size,data)
 def index(self,p):return self.actors.index(p) if p else None
 def wall_state(self):
  p=self.pawn
  return {'position':list(self.read(p+0x114,'3f')),'acceleration':list(self.read(p+0x150,'3f')),'destination':list(self.read(p+0x354,'3f')),
   'physics':self.read(p+0x30,'B')[0],'moveTimer':self.read(p+0x348,'f')[0],'pawnFlags':self.read(p+0x318,'I')[0]}
 def o3(self,case):
  """A call Play recorded (scripts/o3-adapters.mjs, docs/stage-5-exit-criteria.md "O3"): processHitWall for the player or a decoration, from Play's entry state; the
  IsProbing answer is the recorded one and the script event is logged with its parameters."""
  cfg=case['config'];player=cfg['variant']=='player'
  if cfg['netMode']!=0:raise RuntimeError('a network-mode processHitWall was recorded')
  state=case['before']['state'];normal,wall=case['args'];recorded=case['events'];self.o3_events=[];self.o3_index=0
  self.o3_probe=[e for e in recorded if e['k']=='probe']
  for p in self.actors:self.write(p+0xc4,'I',0)
  self.write(self.pawn+0xa8,'I',self.world)
  self.write(self.pawn+0x24,'I',0x1058c660 if player else self.source_class);self.write(self.new+0x24,'I',0x1058c660 if cfg['wallIsPawn'] else 0)
  if player:
   self.write(self.pawn+0x114,'3f',*state['position']);self.write(self.pawn+0x150,'3f',*state['acceleration']);self.write(self.pawn+0x354,'3f',*state['destination'])
   self.write(self.pawn+0x30,'B',state['physics']);self.write(self.pawn+0x348,'f',state['moveTimer']);self.write(self.pawn+0x318,'I',state['pawnFlags']);self.write(self.pawn+0x394,'f',cfg['minHitWall'])
  self.active=True;self.o3_case=case
  try:
   self.call(0x103cecc0,self.pawn,struct.pack('<3fI',*normal,self.new))
   extra=len(recorded)-self.o3_index
   result={'events':self.o3_events,'after':self.wall_state() if player else {}}
   if extra:result={'diverged':f'Play made {extra} more service calls than the native','events':self.o3_events}
  except o3r.Divergence as error:result={'diverged':str(error),'events':self.o3_events}
  self.active=False;self.o3_case=None;return result
 def o3_service(self,cpu,address):
  """The IsProbing and ProcessEvent thunks of an O3 replay: each answered from, and checked against, the recorded call at this point of the sequence."""
  case,stack=self.o3_case,cpu.reg_read(c.UC_X86_REG_ESP)
  def take(kind,args,pre):
   self.o3_events.append({'k':kind,'args':args,'pre':pre})
   if self.o3_index>=len(case['events']):raise o3r.Divergence(f'the native made a {kind} call that Play did not')
   recorded=case['events'][self.o3_index];self.o3_index+=1
   if recorded['k']!=kind:raise o3r.Divergence(f'the native made a {kind} call where Play made a {recorded["k"]} call')
   return recorded
  player=case['config']['variant']=='player'
  pre=self.wall_state() if player else {}
  if address==self.find:cpu.reg_write(c.UC_X86_REG_EAX,self.read(stack+4,'I')[0]);return True
  if address==self.probe:
   token=self.read(cpu.reg_read(c.UC_X86_REG_ESP)+4,'I')[0] if False else 0x135
   recorded=take('probe',['HitWall'],pre);cpu.reg_write(c.UC_X86_REG_EAX,1 if recorded['res'] else 0);return True
  if address==self.event:
   token,params,_=self.read(stack+4,'III')
   wall=self.read(params+12,'I')[0]
   take('event',[self.names[token],list(self.read(params,'3f')),case['args'][1] if wall==self.new else None],pre);return True
  return False
 def capture(self,x):
  self.events=[];self.probing=x.get('probing',False)
  for p in self.actors:self.write(p+0xc4,'I',0);self.write(p+0xd8,'B',7)
  self.write(self.pawn+0xa8,'I',self.world);self.write(self.pawn+0xc4,'I',self.actors[x['base']] if x.get('base') is not None else 0)
  self.write(self.pawn+0x30,'B',x.get('physics',1));self.write(self.pawn+0x318,'I',0x24);self.write(self.pawn+0x1ec,'I',0x100)
  self.write(self.pawn+0x24,'I',0x1058c660 if x.get('sourcePawn',True) else self.source_class);self.write(self.new+0x24,'I',0x1058c660 if x.get('wallPawn') else 0)
  self.write(self.pawn+0x150,'3f',*x.get('acceleration',[1,0,0]));self.write(self.pawn+0x354,'3f',*x.get('destination',[10,0,0]))
  self.write(self.pawn+0x348,'f',3);self.write(self.pawn+0x394,'f',-.6)
  target=self.actors[x['target']] if x.get('target') is not None else 0
  self.active=True
  if x['type']=='base':self.call(0x10369c80,self.pawn,struct.pack('<II',target,1))
  elif x['type']=='physics':self.call(0x103c95f0,self.pawn,struct.pack('<II',x['next'],target))
  elif x['type']=='support':self.call(0x103c9390,self.pawn,struct.pack('<I',target))
  else:self.call(0x103cecc0,self.pawn,struct.pack('<3fI',*x['normal'],self.new))
  self.active=False
  return {'base':self.index(self.read(self.pawn+0xc4,'I')[0]),'physics':self.read(self.pawn+0x30,'B')[0],
   'counts':[self.read(p+0xd8,'B')[0] for p in self.actors],'events':self.events,'moveTimer':self.read(self.pawn+0x348,'f')[0],
   'pawnFlags':self.read(self.pawn+0x318,'I')[0],'justTeleported':bool(self.read(self.pawn+0x1ec,'I')[0]&0x100)}
if __name__=='__main__':
 n=Native(Path(sys.argv[1]))
 if '--o3' in sys.argv:
  print(json.dumps({'results':[n.o3(x) for x in json.loads(Path(sys.argv[2]).read_text())]}));sys.exit(0)
 print(json.dumps({'hashes':c.HASHES,'results':[n.capture(x) for x in json.loads(Path(sys.argv[2]).read_text())]}))
