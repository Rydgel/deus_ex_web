"""Original complete scroll movement chains; script and ConfigureChild are services."""
import importlib.util,json,struct,sys,copy
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP,UC_X86_REG_EAX
spec=importlib.util.spec_from_file_location('layout',Path(__file__).with_name('native-window-scroll-layout-oracle.py'))
l=importlib.util.module_from_spec(spec);spec.loader.exec_module(l)
EXT=l.EXT
EVENTS={0x9b378:('ScalePositionChanged','Iifi'),0x9b3b8:('ScaleRangeChanged','Iiiffi'),0x9b358:('ClipPositionChanged','Iii'),0x9b32c:('ButtonActivated','I'),0x9b340:('MouseButtonPressed','ffIi'),0x9b374:('unused','I')}
# Attribute event token is installed through its exported FName address below.
EVENTS[0x9b3e0]=('MouseMoved','ff')
EVENTS[0x9b394]=('MouseButtonReleased','ffIi')
EVENTS[0x9b36c]=('ScaleAttributesChanged','Iiii')
ENTRY={'move':(0x3e860,'i'),'tickPosition':(0x3dff0,'i'),'change':(0x3f5a0,'i'),'clipPosition':(0xb470,'ii'),'button':(0x42720,'I'),'wheel':(0x43d10,'ffii'),'range':(0x43a50,'Iiiffi'),'clipEvent':(0x43c40,'Iii'),'managerPosition':(0x42580,'Iifi')}
ENTRY.update({'press':(0x3fdc0,'ffii'),'drag':(0x40030,'ff'),'release':(0x40150,'ffii'),'repeat':(0x40250,'f'),'pixel':(0x3eb10,'f'),'show':(0xc360,'Iffff')})
class Probe(l.Probe):
 def __init__(self,root):
  super().__init__(root)
  for address,(_,symbol) in list(self.thunks.items()):
   if symbol=='ceil':
    bridge=self.alloc(64)
    self.cpu.mem_write(address,b'\xe9'+struct.pack('<i',bridge-address-5))
    self.cpu.mem_write(bridge,bytes.fromhex('dd44240483ec04d93c248b042425fff3ffff0d000800006689442402d96c2402d9fcd92c2483c404c3'))
    self.thunks.pop(address)
 def on_instruction(self,cpu,address,size,data):
  o=cpu.reg_read(UC_X86_REG_ECX);sp=cpu.reg_read(UC_X86_REG_ESP)
  if address==EXT+0x4ded0:
   event,params,third=self.read(sp+4,'3I');name,fmt=self.event_ids[event]
   args=list(self.read(params,fmt))
   if name in ['MouseButtonPressed','MouseButtonReleased']:args[2]&=255
   self.events.append({'op':name,'object':o,'args':args})
   node=self.objects[o]
   for off,val in node.get('mutate',{}).items():self.write(o+int(off),'I',self.addresses.get(val,val) if isinstance(val,str) else val)
   if name!='MouseMoved':self.write(params+struct.calcsize('<'+fmt),'I',int(node.get('handled',False)))
   self.ret(3);return
  if address==EXT+0x50050:
   self.events.append({'op':'sound','object':o,'args':list(self.read(sp+4,'I4f'))});self.ret(5);return
  if address==EXT+0x4fda0:
   self.events.append({'op':'tickOffset','object':o,'args':[]})
   bridge=self.alloc(16);self.cpu.mem_write(bridge,b'\x68'+struct.pack('<f',self.objects[o].get('tickOffset',0.125))+bytes.fromhex('d9042483c404c3'))
   from unicorn.x86_const import UC_X86_REG_EIP
   cpu.reg_write(UC_X86_REG_EIP,bridge);return
  if address==EXT+0x4cbf0 and not self.objects[o].get('nativeCursor'):
   self.events.append({'op':'cursor','object':o,'args':[]});x,y=self.read(sp+4,'2I');cursor=self.objects[o].get('cursor',[75,5])
   self.write(x,'f',cursor[0]);self.write(y,'f',cursor[1]);self.ret(2);return
  if address==EXT+0x4ec50:
   args=list(self.read(sp+4,'4f'));self.events.append({'op':'configure','object':o,'args':args,'context':self.read(EXT+0xaeafc,'I')[0]})
   self.write(o+0x78,'4f',*args);self.ret(4);return
  if address==EXT+0x4c890:
   self.events.append({'op':'sensitivity','object':o,'args':list(self.read(sp+4,'I'))});self.ret(1);return
  if address==EXT+0x3e460:
   self.events.append({'op':'valueString','object':o,'args':[]});cpu.reg_write(UC_X86_REG_EAX,0);self.ret(0);return
  super().on_instruction(cpu,address,size,data)
 def run(self,case):
  self.events=[];self.objects={};nodes=case['nodes'];self.addresses={key:self.alloc(0x600) for key in nodes};a=self.addresses
  for key,node in nodes.items():
   o=a[key];self.objects[o]=node;self.cpu.mem_write(o,bytes(0x600));self.write(o,'I',EXT+l.VT[node.get('kind','window')]);self.write(o+0x30,'I',1)
   for off,value in node.get('f',{}).items():self.write(o+off,'f',value)
   for off,value in node.get('i',{}).items():self.write(o+off,'I',value&0xffffffff)
   for off,key2 in node.get('p',{}).items():self.write(o+off,'I',a[key2])
  self.event_ids={}
  for token,(off,desc) in enumerate(EVENTS.items(),1):self.write(EXT+off,'I',token);self.event_ids[token]=desc
  self.write(EXT+0xaeafc,'I',0x13572468)
  images=[{'address':a[key],'node':node,'before':bytes(self.cpu.mem_read(a[key],0x600)).hex()} for key,node in nodes.items()]
  entry,fmt=ENTRY[case['mode']];args=[a.get(v,v) if isinstance(v,str) else v for v in case['args']]
  self.call(EXT+entry,a['root'],struct.pack('<'+fmt,*args));result=self.cpu.reg_read(UC_X86_REG_EAX)
  for image in images:image['after']=bytes(self.cpu.mem_read(image['address'],0x600)).hex()
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
input_cases=[]
def inputScale(vertical=0):
 node=scale();node['i'].update({0x14c:vertical});node['f'].update({0x210:30,0x214:2,0x218:20,0x21c:9,0x1e8:0.5,0x1ec:0.1});return node
for orientation in [0,1]:
 for x,y,key in [(35,5,1),(30,2,1),(50,5,1),(5,1,1),(90,12,1),(35,5,2),(35,5,257)]:
  input_cases.append({'name':f'press-{orientation}-{x}-{y}-{key}','mode':'press','args':[x,y,key,1],'nodes':{'root':inputScale(orientation)}})
 for dragging,rangeMode in [(0,16),(1,16),(1,0)]:
  node=inputScale(orientation);node['i'].update({0x258:dragging,0x164:rangeMode});node['f'][0x25c]=2.25
  input_cases.append({'name':f'drag-{orientation}-{dragging}-{rangeMode}','mode':'drag','args':[60.25,12.5],'nodes':{'root':node}})
for changed,key in [(False,1),(True,1),(True,2)]:
 node=inputScale();node['i'].update({0x258:0xabc1,0x260:2,0x1f0:10 if changed else 30})
 input_cases.append({'name':f'release-{changed}-{key}','mode':'release','args':[3,4,key,1],'nodes':{'root':node}})
for direction,delta,cursor in [(0,1,[75,5]),(1,0.1,[75,5]),(1,0.5,[75,5]),(1,0.5,[40,5]),(2,0.5,[10,5]),(1,0.5,[110,5]),(1,2,[75,5])]:
 node=inputScale();node['i'][0x260]=direction;node['f'][0x264]=0.1;node['cursor']=cursor
 input_cases.append({'name':f'repeat-{direction}-{delta}-{cursor}','mode':'repeat','args':[delta],'nodes':{'root':node}})
for mode in [0,16]:
 node=inputScale();node['i'][0x164]=mode
 input_cases.append({'name':'pixel-'+str(mode),'mode':'pixel','args':[52.5],'nodes':{'root':node}})
for cursor in [[75.5,5.25],[20.25,10.5]]:
 node=inputScale();node['i'][0x260]=1;node['f'].update({0x264:0.1,0xd4:3.25,0xd8:2.5});node['p']={0x138:'screen'};node['nativeCursor']=True
 input_cases.append({'name':'repeat-native-cursor-'+str(cursor),'mode':'repeat','args':[0.5],'nodes':{'root':node,'screen':{'i':{0x28:3},'f':{0x590:cursor[0],0x594:cursor[1]}}}})
for delay,interval in [(-1,0.1),(-1,0),(-1,-0.1)]:
 node=inputScale();node['f'].update({0x1e8:delay,0x1ec:interval})
 input_cases.append({'name':'repeat-delay-'+str(interval),'mode':'press','args':[80,5,1,1],'nodes':{'root':node}})
node=inputScale();node['i'][0x164]=0
input_cases.append({'name':'value-mode-press','mode':'press','args':[80,5,1,1],'nodes':{'root':node}})
cases+=input_cases
for x,y,w,h in [(0,0,10,10),(80,100,20,30),(-20,-15,10,10),(0,0,200,250),(-70,-90,200,250),(20,30,200,250),(20,30,0,0),(20.005,30.005,10.01,20.01)]:
 nodes={'root':{'kind':'clip','i':{0x184:4,0x174:5,0x178:7,0x188:20,0x18c:20},'f':{0x80:50,0x84:60},'p':{0x140:'content'}},'content':{'units':[2.5,3],'f':{0x80:250,0x84:300}}}
 cases.append({'name':'show-'+str((x,y,w,h)),'mode':'show','args':['content',x,y,w,h],'nodes':nodes})
if __name__=='__main__':
 probe=Probe(sys.argv[1]);print(json.dumps([probe.run(case) for case in cases]))
