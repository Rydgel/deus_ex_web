"""Original Actor.Trace native wrapper with explicit argument/query callbacks."""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ScriptTrace(m.NativeCollision):
 def __init__(self,root):
  self.argument=self.single=None
  super().__init__(root)
  self.source=self.alloc(0x400);self.level=self.alloc(0x100);self.table=self.alloc(0x100)
  self.frame=self.alloc(0x40);self.code=self.alloc(16);self.outloc=self.alloc(12);self.outnorm=self.alloc(12);self.outactor=self.alloc(4);self.other=self.alloc(0x100)
  self.argument=0x700fc000;self.single=0x700fc020
  self.cpu.mem_write(self.argument,bytes.fromhex('c2 08 00'));self.cpu.mem_write(self.single,bytes.fromhex('c2 24 00'))
  natives=self.read(0x10599a38,'I')[0];self.property=self.read(0x10599aa0,'I')[0]
  self.write(natives+254*4,'I',self.argument);self.write(self.level,'I',self.table);self.write(self.table+0xc0,'I',self.single)
  self.write(self.source+0xac,'I',self.level);self.write(self.frame+8,'2I',self.source,self.code)
 def on_instruction(self,c,a,z,d):
  sp=c.reg_read(m.UC_X86_REG_ESP)
  if a==self.argument:
   result=self.read(sp+8,'I')[0];i=self.argindex;self.argindex+=1
   if i in [0,1]:self.write(self.property,'I',[self.outloc,self.outnorm][i])
   elif i==2:self.write(result,'3f',*self.case['end'])
   elif i==3 and 'start' in self.case:self.write(result,'3f',*self.case['start'])
   elif i==4 and 'traceActors' in self.case:self.write(result,'I',self.case['traceActors'])
   elif i==5 and 'extent' in self.case:self.write(result,'3f',*self.case['extent'])
   return
  if a==self.single:
   hit,source,end,start,flags=self.read(sp+4,'5I')
   self.query={'source':source==self.source,'end':self.read(end,'3f'),'start':self.read(start,'3f'),'flags':flags,
    'extent':self.read(sp+24,'3f'),'extra':self.read(sp+36,'I')[0]}
   self.write(hit,'II6fIfi',0,self.other if self.case.get('hit') else 0,9,8,7,0,0,1,0,.25 if self.case.get('hit') else 1,-1)
   c.reg_write(m.UC_X86_REG_EAX,0 if self.case.get('hit') else 1);return
  return super().on_instruction(c,a,z,d)
 def run(self,case):
  self.case=case;self.argindex=0;self.query=None
  self.write(self.source+0x1dc,'I',case.get('collisionFlags',1));self.write(self.source+0x114,'3f',*case.get('position',[10,20,30]))
  self.cpu.mem_write(self.code,bytes([254]*6+[22]));self.write(self.frame+12,'I',self.code)
  self.call(0x103e3330,self.source,struct.pack('<II',self.frame,self.outactor))
  return {'query':self.query,'hit':self.read(self.outactor,'I')[0]==self.other,'location':self.read(self.outloc,'3f'),'normal':self.read(self.outnorm,'3f')}

if __name__=='__main__':
 n=ScriptTrace(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c) for c in json.loads(Path(sys.argv[2]).read_text())]}))
