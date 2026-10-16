"""AActor::FindBase (Engine.dll 0x103c9470) executed unchanged: the SingleLineCheck it asks the level for (the arguments it builds) and what it does with the answer."""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('w',Path(__file__).with_name('native-walking-callbacks-oracle.py'));w=importlib.util.module_from_spec(s);s.loader.exec_module(w)
c=w.c
class FindBase(w.Native):
 def __init__(self,root):
  super().__init__(root)
  # ULevel at Actor+0xac; its vtable slot +0xc0 is SingleLineCheck(Hit, Source, End, Start, TraceFlags, Extent (3 floats by value), ExtraNodeFlags): ret 0x24
  lv=self.alloc(0x200);self.level=self.alloc(0x40);self.slc=0x700fc060;self.calls=[];self.hit_actor=0
  self.write(self.level,'I',lv);self.write(lv+0xc0,'I',self.slc);self.cpu.mem_write(self.slc,bytes.fromhex('c2 24 00'))
 def on_instruction(self,cpu,address,size,data):
  if self.active and address==self.slc:
   st=cpu.reg_read(c.UC_X86_REG_ESP)
   hit,source,end,start,flags=self.read(st+4,'5I');extent=self.read(st+0x18,'3f');extra=self.read(st+0x24,'I')[0]
   self.calls.append({'source':self.index(source),'end':list(self.read(end,'3f')),'start':list(self.read(start,'3f')),'flags':flags,'extent':list(extent),'extra':extra})
   self.write(hit+4,'I',self.hit_actor)   # FCheckResult.Actor
   return
  super().on_instruction(cpu,address,size,data)
 def run(self,x):
  self.events=[];self.calls=[];self.probing=False
  for p in self.actors:self.write(p+0xc4,'I',0);self.write(p+0xd8,'B',7)
  self.write(self.pawn+0xac,'I',self.level);self.write(self.pawn+0xa8,'I',self.world)
  self.write(self.pawn+0x114,'3f',*x['location']);self.write(self.pawn+0x1d4,'f',x['radius']);self.write(self.pawn+0x1d8,'f',x['height'])
  self.write(self.pawn+0xc4,'I',self.actors[x['base']] if x.get('base') is not None else 0)
  self.write(self.pawn+0x30,'B',1);self.write(self.pawn+0x318,'I',0x24);self.write(self.pawn+0x1ec,'I',0x100)
  self.write(self.pawn+0x24,'I',0x1058c660)
  self.hit_actor=self.actors[x['hit']] if x.get('hit') is not None else 0
  self.active=True
  self.call(0x103c9470,self.pawn,b'')
  self.active=False
  return {'calls':self.calls,'base':self.index(self.read(self.pawn+0xc4,'I')[0]),'physics':self.read(self.pawn+0x30,'B')[0],'events':self.events,
   'counts':[self.read(p+0xd8,'B')[0] for p in self.actors]}
if __name__=='__main__':
 n=FindBase(Path(sys.argv[1]));print(json.dumps({'hashes':c.HASHES,'results':[n.run(x) for x in json.loads(Path(sys.argv[2]).read_text())]}))
