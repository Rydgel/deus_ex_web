"""Original complete scroll movement chains; script and ConfigureChild are services."""
import importlib.util,json,struct,sys,copy
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP,UC_X86_REG_EAX
spec=importlib.util.spec_from_file_location('layout',Path(__file__).with_name('native-window-scroll-layout-oracle.py'))
l=importlib.util.module_from_spec(spec);spec.loader.exec_module(l)
EXT=l.EXT
EVENTS={0x9b378:('ScalePositionChanged','Iifi'),0x9b3b8:('ScaleRangeChanged','Iiiffi'),0x9b358:('ClipPositionChanged','Iii'),0x9b32c:('ButtonActivated','I'),0x9b340:('MouseButtonPressed','ffIi'),0x9b374:('unused','I')}
# Attribute event token is installed through its exported FName address below.
EVENTS[0x9b36c]=('ScaleAttributesChanged','Iiii')
ENTRY={'move':(0x3e860,'i'),'tickPosition':(0x3dff0,'i'),'change':(0x3f5a0,'i'),'clipPosition':(0xb470,'ii'),'button':(0x42720,'I'),'wheel':(0x43d10,'ffii'),'range':(0x43a50,'Iiiffi'),'clipEvent':(0x43c40,'Iii'),'managerPosition':(0x42580,'Iifi')}
class Probe(l.Probe):
 def on_instruction(self,cpu,address,size,data):
  o=cpu.reg_read(UC_X86_REG_ECX);sp=cpu.reg_read(UC_X86_REG_ESP)
  if address==EXT+0x4ded0:
   event,params,third=self.read(sp+4,'3I');name,fmt=self.event_ids[event]
   args=list(self.read(params,fmt))
   if name=='MouseButtonPressed':args[2]&=255
   self.events.append({'op':name,'object':o,'args':args})
   node=self.objects[o]
   for off,val in node.get('mutate',{}).items():self.write(o+int(off),'I',self.addresses.get(val,val) if isinstance(val,str) else val)
   self.write(params+struct.calcsize('<'+fmt),'I',int(node.get('handled',False)))
   self.ret(3);return
  if address==EXT+0x4ec50:
   args=list(self.read(sp+4,'4f'));self.events.append({'op':'configure','object':o,'args':args,'context':self.read(EXT+0xaeafc,'I')[0]})
   self.write(o+0x78,'4f',*args);self.ret(4);return
  if address==EXT+0x4c890:
   self.events.append({'op':'sensitivity','object':o,'args':list(self.read(sp+4,'I'))});self.ret(1);return
  if address==EXT+0x3e460:
   self.events.append({'op':'valueString','object':o,'args':[]});cpu.reg_write(UC_X86_REG_EAX,0);self.ret(0);return
  super().on_instruction(cpu,address,size,data)
 def run(self,case):
  self.events=[];self.objects={};nodes=case['nodes'];self.addresses={key:self.alloc(0x300) for key in nodes};a=self.addresses
  for key,node in nodes.items():
   o=a[key];self.objects[o]=node;self.cpu.mem_write(o,bytes(0x300));self.write(o,'I',EXT+l.VT[node.get('kind','window')]);self.write(o+0x30,'I',1)
   for off,value in node.get('f',{}).items():self.write(o+off,'f',value)
   for off,value in node.get('i',{}).items():self.write(o+off,'I',value&0xffffffff)
   for off,key2 in node.get('p',{}).items():self.write(o+off,'I',a[key2])
  self.event_ids={}
  for token,(off,desc) in enumerate(EVENTS.items(),1):self.write(EXT+off,'I',token);self.event_ids[token]=desc
  self.write(EXT+0xaeafc,'I',0x13572468)
  images=[{'address':a[key],'node':node,'before':bytes(self.cpu.mem_read(a[key],0x300)).hex()} for key,node in nodes.items()]
  entry,fmt=ENTRY[case['mode']];args=[a.get(v,v) if isinstance(v,str) else v for v in case['args']]
  self.call(EXT+entry,a['root'],struct.pack('<'+fmt,*args));result=self.cpu.reg_read(UC_X86_REG_EAX)
  for image in images:image['after']=bytes(self.cpu.mem_read(image['address'],0x300)).hex()
  return {'name':case['name'],'mode':case['mode'],'args':args,'root':a['root'],'addresses':a,'images':images,'events':self.events,'result':result,'context':self.read(EXT+0xaeafc,'I')[0]}

def scale():return {'kind':'scale','i':{0x164:16,0x1c4:100,0x1cc:20,0x1c8:30,0x1d0:7},'f':{0x1d4:-2.5,0x1d8:8.25,0x250:2,0x254:102,0x194:7,0x198:3,0x80:110,0x84:15}}
cases=[]
for mode in range(9):cases.append({'name':'move-'+str(mode),'mode':'move','args':[mode],'nodes':{'root':scale()}})
for flags,count in [(0,1),(0,100),(16,0)]:
 node=scale();node['i'].update({0x164:flags,0x1c4:count});cases.append({'name':'broadcast-'+str((flags,count)),'mode':'change','args':[0],'nodes':{'root':node}})
for pos in [-20,0,200,30]:cases.append({'name':'position-'+str(pos),'mode':'tickPosition','args':[pos],'nodes':{'root':scale()}})
for flags in range(4):
 cases.append({'name':'clip-force-'+str(flags),'mode':'clipPosition','args':[12,9],'nodes':{
 'root':{'kind':'clip','i':{0x184:flags},'f':{0x80:80,0x84:60,0x198:3,0x19c:5},'p':{0x140:'content',0x138:'parent'}},
 'content':{'f':{0x80:100,0x84:120}},'parent':{'handled':True}}})
cases.append({'name':'clip-empty','mode':'clipPosition','args':[-3,7],'nodes':{'root':{'kind':'clip'}}})
cases.append({'name':'clip-unchanged','mode':'clipPosition','args':[0,0],'nodes':{'root':{'kind':'clip'}}})
# Real scroll -> scale -> range -> clip -> scroll -> scale feedback.
def chain():
 return {'root':{'kind':'scroll','p':{0x158:'scale',0x16c:'clip'}},
 'scale':dict(scale(),p={0x138:'manager'}),
 'manager':{'kind':'manager','p':{0x138:'root',0x158:'scale',0x14c:'up',0x150:'down'}},
 'up':{},'down':{},'clip':{'kind':'clip','f':{0x80:80,0x84:60,0x198:1,0x19c:3},'p':{0x140:'content',0x138:'root'}},
 'content':{'f':{0x80:80,0x84:300}}}
for key in [236,237,1,492]:cases.append({'name':'wheel-'+str(key),'mode':'wheel','args':[1.5,2.25,key,1],'nodes':chain()})
for state in ['hidden','missing','ancestor-hidden']:
 nodes=chain()
 if state=='hidden':nodes['scale']['i'][0x30]=0
 if state=='missing':del nodes['root']['p'][0x158]
 if state=='ancestor-hidden':nodes['manager']['i']={0x30:0}
 cases.append({'name':'wheel-'+state,'mode':'wheel','args':[0,0,237,0],'nodes':nodes})
for which in ['first','second','unrelated','alias','missing']:
 nodes={'root':{'kind':'manager','handled':True,'p':{0x158:'scale',0x14c:'first',0x150:'second'}},'scale':scale(),'first':{},'second':{},'other':{}}
 if which=='alias':nodes['root']['p'][0x150]='first'
 if which=='missing':del nodes['root']['p'][0x158]
 cases.append({'name':'button-'+which,'mode':'button','args':['first' if which in ['first','alias','missing'] else 'second' if which=='second' else 'other'],'nodes':nodes})
for source in ['scale','content']:
 cases.append({'name':'range-'+source,'mode':'range','args':[source,4,99,2.5,3.5,1],'nodes':chain()})
# Snapshot values are retained, but the parent is reread after the script callback.
nodes={'root':dict(scale(),p={0x138:'old'},mutate={0x138:'new',0x1c8:17}), 'old':{},'new':{'handled':True}}
cases.append({'name':'broadcast-live-parent','mode':'change','args':[1],'nodes':nodes})
for source in ['scale','other']:
 nodes={'root':{'kind':'manager','handled':True,'p':{0x158:'scale'}},'scale':scale(),'other':{}}
 cases.append({'name':'manager-position-'+source,'mode':'managerPosition','args':[source,3,1.25,0],'nodes':nodes})
for flags,position in [(0,30),(16,2147483647)]:
 node=scale();node['i'].update({0x164:flags,0x1c8:position})
 cases.append({'name':'move-extra-'+str(flags),'mode':'move','args':[7],'nodes':{'root':node}})
if __name__=='__main__':
 probe=Probe(sys.argv[1]);print(json.dumps([probe.run(case) for case in cases]))
