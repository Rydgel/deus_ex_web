"""Original SetActorZone with controlled PointRegion and script callbacks.
Also executes original PointRegion directly for supplied compiled model inputs.
"""
import importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('c',Path(__file__).with_name('native-collision-oracle.py'));c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
from unicorn.x86_const import UC_X86_REG_EBP,UC_X86_REG_EIP
class NativeZone(c.NativeCollision):
 def __init__(self,root):
  self.active=False;super().__init__(root)
  self.actor=self.alloc(0x800);self.level=self.alloc(0x200);self.zones={name:self.alloc(0x600)for name in ['world','a','b','c']};self.ids={v:k for k,v in self.zones.items()};self.ids[0]=None
  actors=self.alloc(4);self.write(actors,'I',self.zones['world']);self.write(self.level+0x2c,'II',actors,1);self.write(self.zones['world']+0x24,'I',0x1057bf00);self.write(self.actor+0x24,'I',0x1058c660)
  self.pri=self.alloc(0x400)
 def region(self,offset):
  zone,leaf,number=self.read(self.actor+offset,'IiI');return {'zone':self.ids[zone],'leaf':leaf,'zoneNumber':number&255}
 def state(self):return {'region':self.region(0xc8),'footRegion':self.region(0x330),'headRegion':self.region(0x33c)}
 def event(self,name):
  self.events.append({'event':name,**self.state()})
  for field,offset,fmt in [('position',0x114,'3f'),('height',0x1d8,'f'),('eyeHeight',0x3f8,'f')]:
   value=self.case.get('mutations',{}).get(name,{}).get(field)
   if value is not None:self.write(self.actor+offset,fmt,*(value if isinstance(value,list)else[value]))
 def on_instruction(self,cpu,address,size,data):
  if self.active:
   sp=cpu.reg_read(c.UC_X86_REG_ESP)
   if address==0x1030391d:
    out,world,*point=self.read(sp+4,'II3f');i=self.queryIndex;self.queryIndex+=1;r=self.case['regions'][i]
    self.events.append({'query':point});self.write(out,'IiI',self.zones[r['zone']],r.get('leaf',i+1),r.get('zoneNumber',i+1));cpu.reg_write(c.UC_X86_REG_EAX,out);cpu.reg_write(UC_X86_REG_EIP,self.read(sp,'I')[0]);cpu.reg_write(c.UC_X86_REG_ESP,sp+24);return
   hooks={0x1039bc1e:('leaving',0x1039bc45),0x1039bc45:('zoneChange',0x1039bc67),0x1039bc81:('entered',0x1039bcc2),0x1039bd94:('footChange',0x1039bdb1)}
   if address in hooks:
    name,nextaddress=hooks[address];self.event(name);cpu.reg_write(UC_X86_REG_EIP,nextaddress);return
   if address==0x103032e7:
    self.event('headChange');cpu.reg_write(UC_X86_REG_EIP,self.read(sp,'I')[0]);cpu.reg_write(c.UC_X86_REG_ESP,sp+8);return
  return super().on_instruction(cpu,address,size,data)
 def run(self,case):
  self.case=case
  if case.get('type')=='point':
   source=self.model(case['model']);model=self.alloc(0x800);self.cpu.mem_write(model,bytes(self.cpu.mem_read(source,0x100)));self.write(model+0x100,'I',case.get('numZones',4))
   for i,name in enumerate(case.get('zoneActors',['world','a','b','c'])):self.write(model+0x104+i*24,'I',self.zones.get(name,0))
   out=self.alloc(12);self.call(0x103f5db0,model,struct.pack('<II3f',out,self.zones['world'],*case['position']));z,l,n=self.read(out,'IiI');return {'zone':self.ids[z],'leaf':l,'zoneNumber':n&255}
  self.events=[];self.queryIndex=0
  self.write(self.actor+0x24,'I',0 if case.get('isPawn') is False else 0x1058c660)
  self.write(self.actor+0x28,'I',128 if case.get('deleted')else 0);self.write(self.actor+0x114,'3f',*case.get('position',[10,20,30]));self.write(self.actor+0x1d8,'f',case.get('height',43));self.write(self.actor+0x3f8,'f',case.get('eyeHeight',40))
  for field,offset in [('region',0xc8),('footRegion',0x330),('headRegion',0x33c)]:
   r=case.get(field,{'zone':'world','leaf':-1,'zoneNumber':0});self.write(self.actor+offset,'IiI',self.zones[r['zone']],r['leaf'],r['zoneNumber'])
  self.write(self.actor+0x558,'I',self.pri if case.get('pri')else 0);self.write(self.pri+0x368,'I',self.zones['world']);self.write(self.zones['world']+0x518,'B',case.get('netMode',0))
  self.active=True;self.call(0x1039b940,self.level,struct.pack('<III',self.actor,case.get('test',0),case.get('force',0)));self.active=False
  return {**self.state(),'events':self.events,'playerZone':self.ids[self.read(self.pri+0x368,'I')[0]]}
if __name__=='__main__':
 n=NativeZone(Path(sys.argv[1]));print(json.dumps({'hashes':c.HASHES,'results':[n.run(x)for x in json.loads(Path(sys.argv[2]).read_text())]}))
