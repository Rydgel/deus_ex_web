"""Original PlaySound exec/body, with argument evaluation and audio as leaves."""
import importlib.util,json,struct,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP,UC_X86_REG_EIP
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'))
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
HASH='93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'

class Probe(native.NativeCollision):
 def __init__(self,root):
  super().__init__(Path(root),{'Extension.dll':HASH});self.stubs={};self.audio=0;self.events=[]
  self.call(0x10102978,0x101b3218,b'')
  table=self.alloc(0x400);self.write(0x10059064,'I',table)
  for i in range(5):
   stub=self.alloc(16);self.stubs[stub]=i;self.write(table+(0xf0+i)*4,'I',stub)
  self.audio=self.alloc(16)
 def ret(self,cpu,sp,bytes):
  cpu.reg_write(UC_X86_REG_EIP,self.read(sp,'I')[0]);cpu.reg_write(UC_X86_REG_ESP,sp+4+bytes)
 def on_instruction(self,cpu,address,size,data):
  sp=cpu.reg_read(UC_X86_REG_ESP)
  if address in self.stubs:
   i=self.stubs[address];out=self.read(sp+8,'I')[0]
   self.events.append(['argument',i,self.read(out,'I')[0]])
   if i==0:self.write(out,'I',0 if self.case.get('nullSound') else self.sound)
   elif i-1<len(self.case.get('args',[])) and self.case['args'][i-1] is not None:self.write(out,'f',self.case['args'][i-1])
   if i==1 and 'resizeOnVolume' in self.case:self.write(self.window+0x80,'2f',*self.case['resizeOnVolume'])
   self.ret(cpu,sp,8);return
  if address==0x10050050:
   self.body_args=list(self.read(sp+8,'4I'))
  if address==self.audio:
   values=self.read(sp+4,'9I');self.audio_calls.append([values[0],values[1],values[2]==self.sound,*values[3:]])
   self.ret(cpu,sp,36);return
  super().on_instruction(cpu,address,size,data)
 def run(self,s):
  self.case=s;self.events=[];self.audio_calls=[];self.body_args=[]
  root=self.alloc(0x800);window=self.alloc(0x200);pawn=self.alloc(0xa00);parent=self.alloc(0x200)
  self.window=window;self.sound=self.alloc(16)
  self.write(root+0x28,'B',3);self.write(root+0x588,'I',0 if s.get('noPawn') else pawn)
  self.write(window+0x138,'I',0 if s.get('noRoot') else parent);self.write(parent+0x138,'I',root)
  for obj in [window,parent,root]:self.write(obj+0x30,'I',1)
  if s.get('hidden'):self.write(parent+0x30,'I',0)
  self.write(root+0x5c0,'B',s.get('stereo',1));self.write(root+0x80,'f',s.get('rootWidth',640))
  self.write(root+0xd4,'f',s.get('rootX',0));self.write(window+0xd4,'f',s.get('windowX',0))
  self.write(window+0x80,'2f',*s.get('size',[100,50]));self.write(window+0x114,'f',s.get('volume',.5))
  self.write(pawn+0x114,'3f',*s.get('location',[10,20,30]));self.write(pawn+0x3dc,'3i',*s.get('rotation',[2000,1000,4000]))
  level=self.alloc(0x100);engine=self.alloc(0x100);audio=self.alloc(0x100);vt=self.alloc(0x100)
  self.write(pawn+0xac,'I',level);self.write(level+0x40,'I',engine);self.write(engine+0x4c,'I',audio);self.write(audio,'I',vt);self.write(vt+0x74,'I',self.audio)
  frame=self.alloc(0x20);code=self.alloc(16);self.cpu.mem_write(code,bytes([0xf0,0xf1,0xf2,0xf3,0xf4,0x16]));self.write(frame+8,'2I',window,code)
  self.call(0x10053820,window,struct.pack('<2I',frame,0))
  return {'events':self.events,'bodyArgs':self.body_args,'audio':self.audio_calls,'codeOffset':self.read(frame+0xc,'I')[0]-code}
if __name__=='__main__':
 req=json.load(sys.stdin);p=Probe(req['gameRoot']);print(json.dumps({'hash':HASH,'cases':[p.run(s) for s in req['samples']]}))
