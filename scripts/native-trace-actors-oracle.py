"""Execute original execTraceActors (native 309, 0x103e4bc0) or, for cases with
exec='visible', execTraceVisibleActors (native 1003, 0x1036ec50); argument/body
evaluation and MultiLine results are explicit controlled callbacks. Iterator
decisions are original code. The 1003 body's executed addresses are recorded
for instruction coverage.
"""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
CLASSES={'Actor':0x1057cdf0,'Pawn':0x1058c660,'Mover':0x1058bb58,'LevelInfo':0x1057bf00}
EXECS={None:0x103e4bc0,'visible':0x1036ec50}
VISIBLE_BODY=(0x1036ec50,0x1036ef61)
class NativeTraceActors(m.NativeCollision):
 def __init__(self,root):
  self.argument=self.body=self.multi=None;self.visited=set()
  super().__init__(root);self.call(0x10102978,0x101b3218,b'');self.source=self.alloc(0x200);self.level=self.alloc(0x100);self.vtable=self.alloc(0x100);self.info=self.alloc(0x200)
  self.frame=self.alloc(0x40);self.node=self.alloc(0x80);self.code=self.alloc(32);self.outactor=self.alloc(4);self.outloc=self.alloc(12);self.outnorm=self.alloc(12)
  self.argument=0x700fc000;self.body=0x700fc010;self.multi=0x700fc020
  for a,code in [(self.argument,'c2 08 00'),(self.body,'c2 08 00'),(self.multi,'c2 34 00')]:self.cpu.mem_write(a,bytes.fromhex(code))
  self.natives=self.read(0x10599a38,'I')[0];self.property=self.read(0x10599aa0,'I')[0];self.memory=self.read(0x10599bd8,'I')[0]
  self.write(self.natives+254*4,'I',self.argument);self.write(self.natives+253*4,'I',self.body)
  self.write(self.source+0xac,'I',self.level);self.write(self.source+0xa8,'I',self.info);self.write(self.source+0x24,'I',CLASSES['Pawn']);self.write(self.info+0x24,'I',CLASSES['LevelInfo'])
  self.write(self.level,'I',self.vtable);self.write(self.vtable+0xc8,'I',self.multi)
  self.write(self.frame+4,'III',self.node,self.source,self.code);self.write(self.node+0x44,'I',self.code)
 def on_instruction(self,c,a,z,d):
  sp=c.reg_read(m.UC_X86_REG_ESP)
  if VISIBLE_BODY[0]<=a<VISIBLE_BODY[1]:self.visited.add(a)
  if a==self.argument:
   result=self.read(sp+8,'I')[0];i=self.argindex;self.argindex+=1
   if i==0:self.write(result,'I',CLASSES.get(self.case.get('baseClass'),0))
   elif i in [1,2,3]:self.write(self.property,'I',[self.outactor,self.outloc,self.outnorm][i-1])
   elif i==4:self.write(result,'3f',*self.case['end'])
   elif i==5 and 'start'in self.case:self.write(result,'3f',*self.case['start'])
   elif i==6 and 'extent'in self.case:self.write(result,'3f',*self.case['extent'])
   return
  if a==self.multi:
   memory=self.read(sp+4,'I')[0]
   if memory!=self.memory:raise RuntimeError('Unexpected memory argument')
   self.query={'end':self.read(sp+8,'3f'),'start':self.read(sp+20,'3f'),'extent':self.read(sp+32,'3f'),'checkActors':self.read(sp+44,'I')[0],'world':self.read(sp+48,'I')[0]==self.info,'extra':self.read(sp+52,'I')[0]}
   c.reg_write(m.UC_X86_REG_EAX,self.hitptrs[0]if self.hitptrs else 0);return
  if a==self.body:
   self.yields.append({'actor':self.ids[self.read(self.outactor,'I')[0]],'location':self.read(self.outloc,'3f'),'normal':self.read(self.outnorm,'3f')})
   if self.case.get('breakAfter')==len(self.yields):self.write(self.frame+12,'I',self.code+12)
   return
  return super().on_instruction(c,a,z,d)
 def run(self,case):
  if 'rotation' in case:
   rotation=self.alloc(12);result=self.alloc(12);self.write(rotation,'3i',*case['rotation']);self.call(0x1011d1c0,rotation,struct.pack('<I',result));return {'vector':self.read(result,'3f')}
  self.case=case;actors={'self':self.source,'world':self.info}
  for actor in case.get('actors',[]):actors[actor['id']]=self.alloc(0x200)
  for actor in case.get('actors',[]):
   self.write(actors[actor['id']]+0x24,'I',CLASSES[actor.get('kind','Actor')]);self.write(actors[actor['id']]+0x3c,'I',actors.get(actor.get('owner'),0));self.write(actors[actor['id']]+0x1dc,'I',actor.get('flags',0))
   # bHidden is AActor +0x28 bit 0x02 (VisibleActors' `test byte ptr [edi+0x28],2`).
   self.write(actors[actor['id']]+0x28,'I',2 if actor.get('hidden') else 0)
  self.ids={v:k for k,v in actors.items()};self.ids[0]=None
  self.hitptrs=[self.alloc(44)for _ in case['hits']]
  for i,hit in enumerate(case['hits']):self.write(self.hitptrs[i],'II6fIfi',self.hitptrs[i+1]if i+1<len(self.hitptrs)else 0,actors[hit['actor']],*hit.get('location',[i,2,3]),*hit.get('normal',[0,0,1]),0,hit.get('time',i/10),-1)
  self.write(self.source+0x114,'3f',*case.get('sourcePosition',[10,20,30]));self.write(self.outactor,'I',0);self.write(self.outloc,'3f',9,9,9);self.write(self.outnorm,'3f',8,8,8)
  self.cpu.mem_write(self.code,bytes([254]*7+[22])+struct.pack('<H',12)+bytes([253,49,48,0]));self.write(self.frame+12,'I',self.code)
  self.argindex=0;self.yields=[];self.query=None;self.call(EXECS[case.get('exec')],self.source,struct.pack('<II',self.frame,0))
  return {'query':self.query,'yields':self.yields,'finalActor':self.ids[self.read(self.outactor,'I')[0]],'finalLocation':self.read(self.outloc,'3f'),'finalNormal':self.read(self.outnorm,'3f')}
def coverage(n):
 from capstone import Cs,CS_ARCH_X86,CS_MODE_32
 code=bytes(n.cpu.mem_read(VISIBLE_BODY[0],VISIBLE_BODY[1]-VISIBLE_BODY[0]))
 body=[i.address for i in Cs(CS_ARCH_X86,CS_MODE_32).disasm(code,VISIBLE_BODY[0])if i.mnemonic!='nop']
 return {'total':len(body),'reached':sum(a in n.visited for a in body),'unreached':[hex(a)for a in body if a not in n.visited]}
if __name__=='__main__':
 n=NativeTraceActors(Path(sys.argv[1]));results=[n.run(c)for c in json.loads(Path(sys.argv[2]).read_text())]
 print(json.dumps({'hashes':m.HASHES,'results':results,'visibleCoverage':coverage(n)}))
