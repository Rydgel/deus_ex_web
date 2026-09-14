"""Execute original execSetBase (native 298, Engine.dll 0x103e1a90) through
the real AActor::SetBase body (0x10369c80 via thunk 0x10301285). The
argument expression, the FName lookup (0x10599a88) and the vtable +0x10
event dispatch are explicit controlled callbacks; the NewBase self-ancestry
guard, the +0xa8 world exclusion, the +0xd8 byte standing counts, the
+0xc4 store order and the notify-flag BaseChange gate are original code.
"""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class NativeSetBase(m.NativeCollision):
 def __init__(self,root):
  self.argument=None
  super().__init__(root)
  self.source=self.alloc(0x400);self.world=self.alloc(0x400)
  self.frame=self.alloc(0x40);self.code=self.alloc(16);self.result=self.alloc(4)
  self.argument=0x700fc000;self.find=0x700fc010;self.event=0x700fc020
  for a,code in [(self.argument,'c2 08 00'),(self.find,'c2 04 00'),(self.event,'c2 0c 00')]:self.cpu.mem_write(a,bytes.fromhex(code))
  natives=self.read(0x10599a38,'I')[0]
  self.write(natives+254*4,'I',self.argument);self.write(0x10599a88,'I',self.find)
  self.vtable=self.alloc(0x40);self.write(self.vtable+0x10,'I',self.event)
  for p in (self.source,self.world):self.write(p,'I',self.vtable)
  self.names={}
  for i,(address,name) in enumerate([(0x105836f0,'Detach'),(0x105836f4,'Attach'),(0x105836f8,'BaseChange')]):
   self.write(address,'I',i+1);self.names[i+1]=name
  self.write(self.source+0xa8,'I',self.world)
  self.write(self.frame+8,'2I',self.source,self.code)
 def on_instruction(self,c,a,z,d):
  sp=c.reg_read(m.UC_X86_REG_ESP)
  if a==self.argument:
   result=self.read(sp+8,'I')[0]
   self.write(result,'I',self.newbase)
   return
  if a==self.find:
   c.reg_write(m.UC_X86_REG_EAX,self.read(sp+4,'I')[0]);return
  if a==self.event:
   token,params,_=self.read(sp+4,'III')
   self.events.append({'event':self.names[token],'target':self.index(c.reg_read(m.UC_X86_REG_ECX)),
    'base':self.index(self.read(self.source+0xc4,'I')[0]),
    'param':self.index(self.read(params,'I')[0]) if params else None})
   return
  return super().on_instruction(c,a,z,d)
 def index(self,p):
  if p==self.source:return 'self'
  if p==self.world:return 'world'
  for i,a in enumerate(self.case_actors):
   if p==a:return i
  return None
 def run(self,case):
  self.case_actors=[self.alloc(0x400) for _ in range(case.get('extraActors',0))]
  for p in self.case_actors:self.write(p,'I',self.vtable)
  # Base chains: 'chain' builds a->Base->b->Base->... including through the
  # receiver itself for the self-ancestry guard case.
  for chain in case.get('chains',[]):
   prev=None
   for entry in chain:
    a=self.source if entry=='self' else self.case_actors[entry]
    if prev is not None:self.write(prev+0xc4,'I',a)
    prev=a
  self.write(self.source+0xc4,'I',self.world if case.get('old')=='world'
   else self.case_actors[case['old']] if case.get('old') is not None else 0)
  for p in self.case_actors+[self.source,self.world]:self.write(p+0xd8,'B',case.get('countSeed',7))
  self.newbase=self.world if case.get('new')=='world' else self.case_actors[case['new']] if case.get('new') is not None else 0
  self.argindex=0;self.events=[]
  self.cpu.mem_write(self.code,bytes([254,22]));self.write(self.frame+12,'I',self.code)
  self.call(0x103e1a90,self.source,struct.pack('<II',self.frame,self.result))
  return {'base':self.index(self.read(self.source+0xc4,'I')[0]),
   'counts':[self.read(p+0xd8,'B')[0] for p in self.case_actors+[self.source,self.world]],
   'events':self.events,'result':self.read(self.result,'I')[0]}
if __name__=='__main__':
 n=NativeSetBase(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c)for c in json.loads(Path(sys.argv[2]).read_text())]}))
