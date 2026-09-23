"""Original Engine FSceneNode coordinate/size producers for HUD projection.
Core appTan is supplied only from a real-x87 captured qword result: Unicorn's
FPTAN is not authoritative. Other transforms/size operations execute unchanged.
Render-device vtable +0xac is the sole other intercepted runtime leaf.
Inputs and capture results remain outside Git.
"""
import importlib.util,json,struct,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'))
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)

class Probe(native.NativeCollision):
 def __init__(self,root,tangents):
  super().__init__(Path(root));self.tangents=tangents;self.tangent_calls=[];self.callbacks=[];self.device_callback=0
  self.call(0x10102978,0x101b3218,b'')
  self.view_coords=list(self.read(0x101b3218+0x5c,'12f'))
  self.tan_result=self.alloc(8)
  self.cpu.mem_write(0x10123260,b'\xdd\x05'+struct.pack('<I',self.tan_result)+b'\xc3')
  self.device_callback=self.alloc(16);self.cpu.mem_write(self.device_callback,b'\xc2\x04\x00')
 def on_instruction(self,cpu,address,size,data):
  sp=cpu.reg_read(UC_X86_REG_ESP)
  if address==0x10123260:
   key=f'{self.read(sp+4,"Q")[0]:016x}'
   if key not in self.tangents:raise RuntimeError(f'No hardware appTan sample for double input {key}')
   self.write(self.tan_result,'Q',int(self.tangents[key],16));self.tangent_calls.append(key)
  if address==self.device_callback:self.callbacks.append(self.read(sp+4,'I')[0])
  super().on_instruction(cpu,address,size,data)
 def run(self,s):
  self.tangent_calls=[];self.callbacks=[]
  frame=self.alloc(0x300);viewport=self.alloc(0x100);actor=self.alloc(0x800);dev=self.alloc(0x100);vt=self.alloc(0x100)
  self.write(frame,'I',viewport);self.write(viewport+0x30,'I',actor);self.write(viewport+0x64,'I',dev);self.write(dev,'I',vt);self.write(vt+0xac,'I',self.device_callback)
  self.write(actor+0x600,'I',s.get('renderMode',5));self.write(actor+0x410,'f',s['fov']);self.write(actor+0x40c,'f',10000)
  self.write(frame+0xa8,'2i',s['width'],s['height'])
  location=self.alloc(12);rotation=self.alloc(12);self.write(location,'3f',*s['location']);self.write(rotation,'3i',*s['rotation'])
  self.call(0x103019d3,frame,struct.pack('<2I',location,rotation))
  if self.callbacks!=[frame]:raise RuntimeError('Unexpected ComputeRenderSize renderer callback')
  return {'coordsBits':list(self.read(frame+0x34,'12I')),'sizeBits':[self.read(frame+at,'I')[0] for at in [0xb8,0xbc,0xc8,0xcc,0xdc]],'tangentCalls':self.tangent_calls,'rendererCallbacks':len(self.callbacks)}
if __name__=='__main__':
 req=json.load(sys.stdin);p=Probe(req['gameRoot'],req['tangents']);print(json.dumps({'hashes':native.HASHES,'viewCoords':p.view_coords,'results':[p.run(s) for s in req['samples']]}))
