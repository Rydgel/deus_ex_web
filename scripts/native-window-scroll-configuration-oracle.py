"""Original configuration bodies. ConfigureChild and script events are explicit services."""
import importlib.util,json,sys,struct
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP,UC_X86_REG_EAX
spec=importlib.util.spec_from_file_location('layout',Path(__file__).with_name('native-window-scroll-layout-oracle.py'))
l=importlib.util.module_from_spec(spec);spec.loader.exec_module(l)
l.ENTRY.update({'scrollConfig':0x437c0,'managerConfig':0x42260,'scaleConfig':0x3f8f0,'clipConfig':0xc560})
class Probe(l.Probe):
 def __init__(self,root):
  super().__init__(root)
  # MSVCRT ceil service: load double, round toward +infinity, restore caller CW.
  # Original Core.appCeil and its _ftol conversion still execute.
  for address,(_,symbol) in list(self.thunks.items()):
   if symbol=='ceil':
    bridge=self.alloc(64)
    self.cpu.mem_write(address,b'\xe9'+struct.pack('<i',bridge-address-5))
    self.cpu.mem_write(bridge,bytes.fromhex('dd44240483ec04d93c248b042425fff3ffff0d000800006689442402d96c2402d9fcd92c2483c404c3'))
    self.thunks.pop(address)
 def on_instruction(self,cpu,address,size,data):
  if address==l.EXT+0x4ec50:
   o=cpu.reg_read(UC_X86_REG_ECX);sp=cpu.reg_read(UC_X86_REG_ESP)
   args=list(self.read(sp+4,'4f'));self.events.append({'op':'configure','object':o,'args':args})
   node=self.objects[o]
   if node.get('hideOnConfigure'):
    target=self.read(o+0x114,'I')[0];self.write(target+0x30,'I',0)
   self.ret(4);return
  if address==l.EXT+0x3f00:
   o=cpu.reg_read(UC_X86_REG_ECX);sp=cpu.reg_read(UC_X86_REG_ESP)
   args=list(self.read(sp+4,'I4i'));self.events.append({'op':'clipAttributes','object':o,'args':args})
   cpu.reg_write(UC_X86_REG_EAX,1 if self.objects[o].get('consume') else 0);self.ret(5);return
  if address==l.EXT+0x4c890:
   o=cpu.reg_read(UC_X86_REG_ECX);sp=cpu.reg_read(UC_X86_REG_ESP)
   self.events.append({'op':'sensitivity','object':o,'args':list(self.read(sp+4,'I'))});self.ret(1);return
  if address==l.EXT+0x4ded0:
   o=cpu.reg_read(UC_X86_REG_ECX);sp=cpu.reg_read(UC_X86_REG_ESP);params=self.read(sp+8,'I')[0]
   scale=self.read(sp,'I')[0] in [l.EXT+0x3eee,l.EXT+0x42696];count=4 if scale else 5
   args=list(self.read(params,'I'+str(count-1)+'i'));self.events.append({'op':'scaleScript' if scale else 'clipScript','object':o,'args':args})
   self.write(params+count*4,'I',1 if self.objects[o].get('scriptHandled') else 0);self.ret(3);return
  super().on_instruction(cpu,address,size,data)

cases=[]
for orientation in [0,1]:
 for alignment in [0,1,2,3]:
  cases.append({'name':f'manager-{orientation}-{alignment}','mode':'managerConfig','nodes':{
   'root':{'kind':'manager','i':{0x15c:orientation,0x170:alignment|(alignment<<8)},'f':{0x80:101.25,0x84:90.75,0x164:2.25,0x168:3.5,0x16c:1.5},'p':{0x13c:'a'}},
   'a':{'preferred':[13.25,17.5],'p':{0x148:'b'}},'b':{'preferred':[23.75,11.25]}}})
for flags,extent in [(1,100),(2,100),(3,100),(3,20),(0,100)]:
 cases.append({'name':f'manager-stretch-{flags}-{extent}','mode':'managerConfig','nodes':{
  'root':{'kind':'manager','i':{0x160:flags},'f':{0x80:extent,0x84:40,0x164:2.25,0x16c:1.5},'p':{0x13c:'a',0x158:'scale',0x154:'value'}},
  'a':{'preferred':[13.25,17.5],'p':{0x148:'scale'}},'scale':{'preferred':[23.75,11.25],'p':{0x138:'root',0x148:'value'}},'value':{'preferred':[17.25,7],'p':{0x138:'root'}}}})
for orientation,stretch,extent in [(0,0,100),(1,0,100),(0,1,100),(1,1,100),(0,1,3),(1,1,3)]:
 cases.append({'name':f'scale-{orientation}-{stretch}-{extent}','mode':'scaleConfig','nodes':{
  'root':{'kind':'scale','i':{0x14c:orientation,0x164:16|(8 if stretch else 0),0x1c4:20,0x1cc:7,0x1c8:3},
    'f':{0x80:extent,0x84:extent+3.5,0x18c:11,0x190:2,0x16c:1.25,0x194:7,0x198:2,0x170:0.75,0x19c:3,0x1a0:4,0x1bc:1.5,0x1c0:2.25,0x1b4:2.5,0x1b8:3.5,0x1a4:7,0x1a8:4,0x1ac:7,0x1b0:4}}}})
for flags,pos,size in [(4,0,120),(12,3,20),(4,100,120),(7,-4,120)]:
 cases.append({'name':f'clip-{flags}-{pos}-{size}','mode':'clipConfig','nodes':{
  'root':{'kind':'clip','i':{0x184:flags,0x174:pos,0x178:pos},'f':{0x80:80,0x84:70},'p':{0x140:'content',0x138:'parent'}},
  'content':{'preferred':[size,size+9.5],'units':[2.5,3.25],'p':{0x144:'other'}},'other':{},'parent':{'consume':True}}})
# Exercise the existing real preferred-size chain then configuration service order.
for hidden in [False,True]:
 nodes={'root':{'kind':'scroll','i':{0x17c:0},'f':{0x80:100,0x84:120,0x170:2,0x174:3,0x178:1},'p':{0x14c:'horizontal',0x150:'vertical',0x16c:'clip'}},
  'horizontal':{'preferred':[20,7],'hideOnConfigure':hidden,'p':{0x114:'vertical'}},'vertical':{'preferred':[11,20]},
  'clip':{'kind':'clip','p':{0x140:'content'}},'content':{'preferred':[90,150]}}
 cases.append({'name':'scroll-config-mutation-'+str(hidden),'mode':'scrollConfig','nodes':nodes})
import copy
unchanged=copy.deepcopy(next(case for case in cases if case['name']=='clip-4-0-120'))
unchanged['name']='clip-unchanged-counts'
unchanged['nodes']['root']['i'].update({0x190:48,0x194:40,0x188:32,0x18c:21})
cases.append(unchanged)
for matches in [True,False]:
 callback=copy.deepcopy(next(case for case in cases if case['name']=='clip-4-0-120'))
 callback['name']='clip-scroll-range-callback-'+str(matches)
 nodes=callback['nodes'];nodes['parent']={'kind':'scroll','scriptHandled':True,'i':{0x30:0},'p':{0x16c:'root' if matches else 'other',0x154:'hScale',0x158:'vScale'}}
 for name in ['hScale','vScale']:
  nodes[name]={'kind':'scale','i':{0x164:16,0x1c4:1,0x1cc:1},'p':{0x138:'parent'}}
 cases.append(callback)
visible=copy.deepcopy(next(case for case in cases if case['name']=='clip-scroll-range-callback-True'))
visible['name']='clip-visible-scale-attributes';nodes=visible['nodes'];nodes['parent']['i'][0x30]=1;nodes['parent']['scriptHandled']=False
for name in ['hScale','vScale']:
 nodes[name]['p'][0x138]=name+'Mgr'
 nodes[name+'Mgr']={'kind':'manager','p':{0x138:'parent',0x158:name,0x14c:name+'First',0x150:name+'Last'}}
 nodes[name+'First']={};nodes[name+'Last']={}
cases.append(visible)
probe=Probe(sys.argv[1]);print(json.dumps([probe.run(case) for case in cases]))
