"""Source-selected original walking input expression primitives, hash-gated Core."""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('camera',Path(__file__).with_name('native-camera-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Native(m.NativeCamera):
 def __init__(self,root):
  super().__init__(root);exports=m.b.collision.Image(root/'System'/'Core.dll').exports()
  for token,name in {35:'VectorConst',213:'Multiply_FloatVector',215:'Add_VectorVector',70:'FloatToInt',159:'MultiplyEqual_IntFloat',245:'FMax'}.items():
   address=exports[f'?exec{name}@UObject@@QAEXAAUFFrame@@QAX@Z'];self.addresses[token]=address;self.write(0x101f41b8+token*4,'I',address)
  self.intvalue=self.alloc(4);stub=self.alloc(16)
  self.cpu.mem_write(stub,b'\xc7\x05'+struct.pack('<II',0x101e32f8,self.intvalue)+b'\xc2\x08\x00');self.write(0x101f41b8+0x33*4,'I',stub)
 def run(self,code,fmt):
  self.cpu.mem_write(self.script,code[1:]);self.write(self.frame+8,'III',self.actor,self.script,0)
  self.call(self.addresses[code[0]],self.actor,struct.pack('<II',self.frame,self.output+36));return self.read(self.output+36,fmt)
 def capture(self,c):
  code=bytes([34])+struct.pack('<3i',*c['rotation'])+bytes([0x30,0x31,0x32,22]);self.cpu.mem_write(self.script,code);self.write(self.frame+8,'III',self.actor,self.script,0)
  self.call(0x10102d06,self.actor,struct.pack('<II',self.frame,self.output+36));axes=self.read(self.output,'9f')
  forward=self.evaluate([171,c['aForward'],.4]);strafe=self.evaluate([171,c['aStrafe'],.4])
  v=lambda a:bytes([35])+struct.pack('<3f',*a)
  mul=lambda value,a:bytes([213])+self.expression(value)+v(a)+bytes([22])
  accel=list(self.run(bytes([215])+mul(forward,axes[:3])+mul(strafe,axes[3:6])+bytes([22]),'3f'));accel[2]=0.
  speed=self.run(bytes([70])+self.expression(c['currentGroundSpeed']),'i')[0]
  if forward<0:
   self.write(self.intvalue,'i',speed);self.run(bytes([159,0x33])+self.expression(.65)+bytes([22]),'i');speed=self.read(self.intvalue,'i')[0]
  ground=self.evaluate([245,speed,100])
  return {'aForward':forward,'aStrafe':strafe,'newAccel':accel,'groundSpeed':ground}
if __name__=='__main__':
 n=Native(Path(sys.argv[1]));print(json.dumps({'hashes':m.b.collision.HASHES,'results':[n.capture(c) for c in json.loads(Path(sys.argv[2]).read_text())]}))
