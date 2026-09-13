"""Original callback bookkeeping; script events and IsProbing supplied explicitly."""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('c',Path(__file__).with_name('native-collision-oracle.py'));c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
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
 n=Native(Path(sys.argv[1]));print(json.dumps({'hashes':c.HASHES,'results':[n.capture(x) for x in json.loads(Path(sys.argv[2]).read_text())]}))
