"""Original TileWindow.ComputeChildSizes, selected ORDER_Down branch.
Child QueryPreferredHeight and FArray allocation are supplied ABI services;
all layout/row/truncation instructions execute from hash-verified Extension.
"""
import importlib.util,json,struct,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP,UC_X86_REG_EAX
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'))
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
class Probe(native.NativeCollision):
 def __init__(self,root):
  super().__init__(root,{'Extension.dll':'93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'})
  self.result=self.alloc(4);self.children={};self.calls=[]
  self.cpu.mem_write(0x1004e680,b'\xd9\x05'+struct.pack('<I',self.result)+b'\xc2\x04\x00')
  self.realloc=self.alloc(16);self.add=self.alloc(16)
  self.cpu.mem_write(self.realloc,b'\xc2\x04\x00');self.cpu.mem_write(self.add,b'\xc2\x08\x00')
  self.write(0x1005909c,'I',self.realloc);self.write(0x100590a4,'I',self.add)
 def on_instruction(self,cpu,address,size,data):
  sp=cpu.reg_read(UC_X86_REG_ESP);obj=cpu.reg_read(UC_X86_REG_ECX)
  if address==0x1004e680:
   width=self.read(sp+4,'f')[0];self.calls.append(width)
   self.write(self.result,'f',self.children[obj]);return
  if address==self.realloc:
   self.write(obj,'I',self.alloc(1024));return
  if address==self.add:
   old=self.read(obj+4,'I')[0];self.write(obj+4,'I',old+self.read(sp+4,'I')[0]);cpu.reg_write(UC_X86_REG_EAX,old);return
  super().on_instruction(cpu,address,size,data)
 def run(self,s):
  tile=self.alloc(0x180);children=[];self.calls=[]
  self.write(tile+0x14c,'3B',1,0,0)
  self.write(tile+0x150,'4f',*s.get('margins',[20,10]),s.get('spacing',1),1)
  self.write(tile+0x160,'2B',3,0);self.write(tile+0x164,'I',2)
  for height in s['heights']:
   c=self.alloc(0x180);children.append(c);self.children[c]=height;self.write(c+0x30,'I',1)
  self.write(tile+0x13c,'2I',children[0] if children else 0,children[-1] if children else 0)
  for a,b in zip(children,children[1:]):self.write(a+0x148,'I',b);self.write(b+0x144,'I',a)
  w=self.alloc(4);h=self.alloc(4);self.write(w,'f',s['width']);self.write(h,'f',0)
  self.call(0x10048a90,tile,struct.pack('<4I',1,w,0,h))
  height=self.read(h,'f')[0]
  self.call(0x10048a90,tile,struct.pack('<4I',1,w,1,h))
  return {'height':height,'rects':[self.read(c+0xa4,'4f') for c in children],'queryWidths':self.calls}
if __name__=='__main__':
 req=json.load(sys.stdin);p=Probe(Path(req['gameRoot']));print(json.dumps([p.run(s) for s in req['samples']]))
