"""Original moveSmooth/TwoWallAdjust; explicitly controlled MoveActor+script calls."""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('n',Path(__file__).with_name('native-collision-oracle.py'));n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
class Native(n.NativeCollision):
 def __init__(self,root):
  super().__init__(root);self.actor=self.alloc(0x1000);self.level=self.alloc(0x200);vt=self.alloc(0x100);at=self.alloc(0x100);self.other=self.alloc(0x1000)
  self.move=0x700fa000;self.event=0x700fa020;self.find=0x700fa040;self.active=False
  for p,code in [(self.move,'c2 30 00'),(self.event,'c2 0c 00'),(self.find,'c2 08 00')]:self.cpu.mem_write(p,bytes.fromhex(code))
  self.write(self.actor,'I',at);self.write(at+0x10,'I',self.event);self.write(self.actor+0xac,'I',self.level);self.write(self.level,'I',vt);self.write(vt+0x88,'I',self.move);self.write(0x10599a88,'I',self.find)
 def on_instruction(self,cpu,address,size,data):
  if self.active:
   sp=cpu.reg_read(n.UC_X86_REG_ESP)
   if address==self.find:cpu.reg_write(n.UC_X86_REG_EAX,1);return
   if address==self.move:
    actor,*delta=self.read(sp+4,'I3f');rotation=self.read(sp+20,'3i');hit,*flags=self.read(sp+32,'5I')
    if actor!=self.actor or any(flags):raise Exception('Unexpected MoveActor contract')
    response=self.responses[self.index];self.index+=1;self.events.append({'move':delta,'rotation':rotation})
    self.write(hit+4,'I',self.other);self.write(hit+20,'3f',*response['normal']);self.write(hit+36,'f',response['time']);cpu.reg_write(n.UC_X86_REG_EAX,int(response['result']));return
   if address==self.event:
    params=self.read(sp+8,'I')[0];self.events.append({'hitWall':self.read(params,'3f')})
    if self.rotate:self.write(self.actor+0x120,'3i',*self.rotate)
    return
  return super().on_instruction(cpu,address,size,data)
 def capture(self,c):
  self.events=[];self.responses=c['responses'];self.index=0;self.rotate=c.get('eventRotation');self.write(self.actor+0x120,'3i',*c.get('rotation',[0,0,0]));self.active=True
  result=self.call(0x103c9020,self.actor,struct.pack('<3f',*c['delta']));self.active=False;return {'result':bool(result),'events':self.events}
if __name__=='__main__':
 a=Native(Path(sys.argv[1]));print(json.dumps({'hashes':n.HASHES,'results':[a.capture(c)for c in json.loads(Path(sys.argv[2]).read_text())]}))
