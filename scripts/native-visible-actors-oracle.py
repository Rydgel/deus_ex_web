"""Execute original execVisibleActors (native 311, Engine.dll 0x103e5260).
Argument/body evaluation and the Level->Model->FastLineCheck call are
explicit controlled callbacks; actor-array scan order, the +0x28 bit-2 skip,
the Class ancestry filter, the zero-radius gate bypass and the strict x87
distance predicate are original code.
"""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
CLASSES={'Actor':0x1057cdf0,'Pawn':0x1058c660,'Mover':0x1058bb58,'LevelInfo':0x1057bf00,'Brush':0x10582a28}
class NativeVisibleActors(m.NativeCollision):
 def __init__(self,root):
  self.argument=self.body=None
  super().__init__(root);self.call(0x10102978,0x101b3218,b'')
  self.source=self.alloc(0x400);self.level=self.alloc(0x100);self.model=self.alloc(0x100)
  self.frame=self.alloc(0x40);self.node=self.alloc(0x80);self.code=self.alloc(32);self.outactor=self.alloc(4)
  self.argument=0x700fc000;self.body=0x700fc010;self.line=0x10301a37
  for a,code in [(self.argument,'c2 08 00'),(self.body,'c2 08 00')]:self.cpu.mem_write(a,bytes.fromhex(code))
  self.natives=self.read(0x10599a38,'I')[0];self.property=self.read(0x10599aa0,'I')[0]
  self.write(self.natives+254*4,'I',self.argument);self.write(self.natives+253*4,'I',self.body)
  self.write(self.source+0xac,'I',self.level);self.write(self.level+0x98,'I',self.model)
  for cls,super_ in [('Mover','Brush'),('Brush','Actor'),('Pawn','Actor'),('LevelInfo','Actor'),('Actor',None)]:
   self.write(CLASSES[cls]+0x28,'I',CLASSES.get(super_,0))
  self.write(self.frame+4,'III',self.node,self.source,self.code);self.write(self.node+0x44,'I',self.code)
 def on_instruction(self,c,a,z,d):
  sp=c.reg_read(m.UC_X86_REG_ESP)
  if a==self.argument:
   result=self.read(sp+8,'I')[0];i=self.argindex;self.argindex+=1
   if i==0:self.write(result,'I',CLASSES.get(self.case.get('baseClass'),0))
   elif i==1:self.write(self.property,'I',self.outactor)
   elif i==2 and 'radius'in self.case:self.write(result,'f',self.case['radius'])
   elif i==3 and 'loc'in self.case:self.write(result,'3f',*self.case['loc'])
   return
  if a==self.line:
   # FastLineCheck thunk entry: [esp]=ret, [esp+4]=First (candidate
   # Location), [esp+0x10]=Second (Loc), ecx=Model; the real callee ends
   # ret 0x18, emulated here.
   if c.reg_read(m.UC_X86_REG_ECX)!=self.model:raise RuntimeError('FastLineCheck called on the wrong model object')
   first=self.read(sp+4,'3f');second=self.read(sp+16,'3f')
   self.queries.append({'first':first,'second':second})
   c.reg_write(m.UC_X86_REG_EIP,self.read(sp,'I')[0]);c.reg_write(m.UC_X86_REG_ESP,sp+28)
   c.reg_write(m.UC_X86_REG_EAX,1 if self.positionId(first)in self.visible else 0)
   return
  if a==self.body:
   self.yields.append(self.ids[self.read(self.outactor,'I')[0]])
   if self.case.get('breakAfter')==len(self.yields):self.write(self.frame+12,'I',self.code+9)
   return
  return super().on_instruction(c,a,z,d)
 def positionId(self,point):
  f32=lambda v:struct.unpack('<f',struct.pack('<f',v))[0]
  key=tuple(f32(v) for v in point)
  for actor in self.case.get('actors',[]):
   if key==tuple(f32(v) for v in actor.get('position',[0,0,0])):return actor['id']
  if key==tuple(f32(v) for v in self.case.get('sourcePosition',[10,20,30])):return 'self'
  return None
 def run(self,case):
  self.case=case;actors={'self':self.source}
  for actor in case.get('actors',[]):actors[actor['id']]=self.alloc(0x400)
  self.ids={v:k for k,v in actors.items()};self.ids[0]=None
  self.visible=set(case.get('visible',[]))
  for actor in case.get('actors',[]):
   a=actors[actor['id']]
   self.write(a+0x24,'I',CLASSES[actor.get('kind','Actor')]);self.write(a+0x28,'I',actor.get('flags',0))
   self.write(a+0x114,'3f',*actor.get('position',[0,0,0]))
  array=self.alloc(4*max(1,len(case['array'])))
  for i,entry in enumerate(case['array']):self.write(array+4*i,'I',actors.get(entry,0))
  self.write(self.level+0x2c,'III',array,len(case['array']),len(case['array']))
  self.write(self.source+0x114,'3f',*case.get('sourcePosition',[10,20,30]));self.write(self.outactor,'I',0)
  self.cpu.mem_write(self.code,bytes([254]*4+[22])+struct.pack('<H',9)+bytes([253,49,48,0]))
  self.write(self.frame+12,'I',self.code)
  self.argindex=0;self.yields=[];self.queries=[]
  self.call(0x103e5260,self.source,struct.pack('<II',self.frame,0))
  return {'yields':self.yields,'queries':self.queries,'finalActor':self.ids[self.read(self.outactor,'I')[0]]}
if __name__=='__main__':
 n=NativeVisibleActors(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c)for c in json.loads(Path(sys.argv[2]).read_text())]}))
