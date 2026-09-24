"""Original preferred-size chain; only script sizing/granularity and TabGroup are services."""
import importlib.util,json,struct,sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX,UC_X86_REG_ESP,UC_X86_REG_EIP
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'))
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
EXT=0x12000000
HASH='93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
VT={'window':0x59930,'scale':0x5bab4,'manager':0x5bbd0,'clip':0x5aff0,'scroll':0x5bcec}
ENTRY={'scale':0x3f780,'manager':0x420e0,'clip':0xc660,'queryClip':0xbbd0,'scroll':0x438f0,'tileGran':0x48860}
class Probe(n.NativeCollision):
 def __init__(self,root):
  super().__init__(Path(root),{'Extension.dll':{'hash':HASH,'base':EXT}});self.events=[];self.objects={}
 def ret(self,count):
  sp=self.cpu.reg_read(UC_X86_REG_ESP);self.cpu.reg_write(UC_X86_REG_ESP,sp+4+count*4);self.cpu.reg_write(UC_X86_REG_EIP,self.read(sp,'I')[0])
 def on_instruction(self,cpu,address,size,data):
  if address in [EXT+0x50390,EXT+0x45700,EXT+0x4e9e0,EXT+0x50450]:
   o=cpu.reg_read(UC_X86_REG_ECX);sp=cpu.reg_read(UC_X86_REG_ESP);obj=self.objects[o]
   if address in [EXT+0x4e9e0,EXT+0x50450]:
    pw,ph=self.read(sp+4,'2I');result=obj.get('units',[2,3]);op='granularity' if address==EXT+0x4e9e0 else 'baseGranularity';args=[] if op=='granularity' else [self.read(pw,'f')[0],self.read(ph,'f')[0]];count=2
   else:
    bw,pw,bh,ph=self.read(sp+4,'4I');args=[bw,self.read(pw,'f')[0],bh,self.read(ph,'f')[0]]
    op='tabGroup' if address==EXT+0x45700 else 'preferred';count=4
    result=obj.get('preferred',[23,29])
    if obj.get('wrap') and bw:result=[args[1],100 if args[1]<90 else 40]
    if obj.get('oscillate') and bw:result=[args[1],40 if args[1]<90 else 120]
   self.events.append({'op':op,'object':o,'args':args})
   self.write(pw,'f',result[0]);self.write(ph,'f',result[1]);self.ret(count);return
  super().on_instruction(cpu,address,size,data)
 def run(self,case):
  self.events=[];self.objects={};nodes=case['nodes'];addresses={key:self.alloc(0x300) for key in nodes}
  for key,node in nodes.items():
   o=addresses[key];self.objects[o]=node;self.cpu.mem_write(o,bytes(0x300))
   self.write(o,'I',EXT+VT[node.get('kind','window')]);self.write(o+0x30,'I',1)
   self.write(o+0x9c,'2f',-1,-1);self.write(o+0xb8,'I',2)
   if node.get('kind')=='clip':self.write(o+0x17c,'2i',-1,-1)
   for off,value in node.get('f',{}).items():self.write(o+off,'f',value)
   for off,value in node.get('i',{}).items():self.write(o+off,'I',value&0xffffffff)
   for off,key2 in node.get('p',{}).items():self.write(o+off,'I',addresses[key2])
  images=[{'address':o,'node':nodes[key],'before':bytes(self.cpu.mem_read(o,0x300)).hex()} for key,o in addresses.items()]
  out=self.alloc(16);self.cpu.mem_write(out,bytes(16));bw,w,bh,h=case.get('args',[0,0,0,0])
  self.write(out,'f',w);self.write(out+4,'f',h)
  args=struct.pack('<IfIIIfII',bw,w,out,out+8,bh,h,out+4,out+12) if case['mode']=='queryClip' else struct.pack('<4I',bw,out,bh,out+4)
  if case['mode']=='tileGran':args=struct.pack('<2I',out,out+4)
  if case['mode'].endswith('Config'):args=b''
  self.call(EXT+ENTRY[case['mode']],addresses['root'],args)
  for image in images:image['after']=bytes(self.cpu.mem_read(image['address'],0x300)).hex()
  return {'name':case['name'],'mode':case['mode'],'args':[bw,w,bh,h],'root':addresses['root'],'images':images,'events':self.events,'out':bytes(self.cpu.mem_read(out,16)).hex()}

def scale(name,fields,texture=False):
 nodes={'root':{'kind':'scale','f':fields}}
 if texture:
  nodes['texture']={'i':{0x34:17,0x38:31}};nodes['root']['p']={0x150:'texture'}
 return {'name':name,'mode':'scale','nodes':nodes}
cases=[scale('empty-scale',{}),scale('scale-borders-margins',{0x18c:11,0x190:2,0x194:7,0x198:4,0x16c:0.25,0x170:2.5,0x19c:13,0x1a0:3,0x1bc:1.25,0x1c0:2.75}),scale('scale-texture-fallback',{0x18c:-1,0x190:0,0x1a4:99,0x1a8:99},True)]
for orient in [0,1]:
 cases.append({'name':'manager-'+str(orient),'mode':'manager','nodes':{
  'root':{'kind':'manager','i':{0x15c:orient},'f':{0x164:2.25,0x168:3.5,0x16c:1.75},'p':{0x13c:'a'}},
  'a':{'preferred':[13,17],'p':{0x148:'hidden'}},'hidden':{'i':{0x30:0},'p':{0x148:'b'}},'b':{'preferred':[23,11]}}})
cases.append({'name':'manager-empty','mode':'manager','nodes':{'root':{'kind':'manager','f':{0x164:2,0x168:3}}}})
for force in range(4):
 cases.append({'name':'clip-force-'+str(force),'mode':'queryClip','args':[1,80,1,70],'nodes':{
  'root':{'kind':'clip','i':{0x184:force|4,0x174:-7,0x178:11},'p':{0x140:'child'}},'child':{'preferred':[100,120]}}})
cases += [
 {'name':'clip-units','mode':'clip','args':[0,5,0,7],'nodes':{'root':{'kind':'clip','i':{0x184:7,0x17c:4,0x180:5},'p':{0x140:'child'}},'child':{'units':[2.5,3.25]}}},
 {'name':'clip-hard','mode':'queryClip','nodes':{'root':{'kind':'clip','f':{0x9c:30,0xa0:40},'p':{0x140:'child'}},'child':{'preferred':[90,100]}}},
 {'name':'clip-empty','mode':'queryClip','nodes':{'root':{'kind':'clip'}}},
 {'name':'clip-hidden-top','mode':'clip','nodes':{'root':{'kind':'clip','p':{0x140:'hidden',0x144:'sibling'}},'hidden':{'i':{0x30:0}},'sibling':{'preferred':[31,37]}}}]
for name,auto,flags,args,pref,force in [
 ('unconstrained',1,0,[0,0,0,0],[150,180],0),('fits',1,0,[1,100,1,100],[50,60],0),
 ('both-overflow',1,0,[1,100,1,100],[150,160],0),('cross-overflow',1,0,[1,100,1,100],[89,120],0),
 ('hide-old-bars',1,6,[1,100,1,100],[10,20],0),('no-autohide',0,0,[1,100,1,100],[10,20],0),
 ('forced-both',1,0,[1,100,1,100],[150,160],3),('rounding',0,0,[0,0,0,0],[16777216,3.25],0)]:
 cases.append({'name':'scroll-'+name,'mode':'scroll','args':args,'nodes':{
  'root':{'kind':'scroll','i':{0x17c:0xa0|auto|flags},'f':{0x170:2.25,0x174:4.5,0x178:1.25},'p':{0x14c:'horizontal',0x150:'vertical',0x16c:'clip'}},
  'horizontal':{'preferred':[19,7.5]},'vertical':{'preferred':[11.25,21]},
  'clip':{'kind':'clip','i':{0x184:force},'p':{0x140:'child'}},'child':{'preferred':pref}}})
# The empty/invisible clip branch preserves last-show flags and touches only visible managers.
cases.append({'name':'scroll-hidden-clip','mode':'scroll','nodes':{'root':{'kind':'scroll','i':{0x17c:7},'p':{0x14c:'manager',0x16c:'clip'}},'manager':{'f':{0xac:42}},'clip':{'kind':'clip','i':{0x30:0}}}})
cases.append({'name':'scroll-autohide-trial-limit','mode':'scroll','args':[1,100,1,100],'nodes':{
 'root':{'kind':'scroll','i':{0x17c:1},'f':{0x170:2.25,0x174:4.5,0x178:1.25},'p':{0x150:'vertical',0x16c:'clip'}},
 'vertical':{'preferred':[11.25,21]},'clip':{'kind':'clip','i':{0x184:1},'p':{0x140:'child'}},'child':{'oscillate':True}}})
# Full real manager -> scale and clip query chain. No manager/scale sizing service.
nodes={'root':{'kind':'scroll','i':{0x17c:1},'p':{0x14c:'hm',0x150:'vm',0x16c:'clip'}},
 'clip':{'kind':'clip','i':{0x184:5},'p':{0x140:'content'}},'content':{'preferred':[230,400]}}
for name,orientation in [('hm',0),('vm',1)]:
 nodes[name]={'kind':'manager','i':{0x15c:orientation},'p':{0x13c:name+'a'}}
 nodes[name+'a']={'f':{0x9c:11,0xa0:12},'p':{0x148:name+'scale'}}
 nodes[name+'scale']={'kind':'scale','f':{0x18c:11,0x190:2,0x194:7,0x198:2},'p':{0x148:name+'b'}}
 nodes[name+'b']={'f':{0x9c:11,0xa0:12}}
cases.append({'name':'scroll-full-family-chain','mode':'scroll','args':[1,200,1,250],'nodes':nodes})
for orient,flags,child in [(0,12,True),(1,12,True),(0,4,True),(1,12,False)]:
 nodes={'root':{'i':{0x14c:orient,0x164:flags},'f':{0x158:2.25,0x15c:3.5}}}
 if child:
  nodes['root']['p']={0x140:'hidden'};nodes['hidden']={'i':{0x30:0},'p':{0x144:'visible'}};nodes['visible']={'f':{0x80:17.75,0x84:21.25}}
 cases.append({'name':'tile-granularity-'+str((orient,flags,child)),'mode':'tileGran','args':[0,1,0,1],'nodes':nodes})
if __name__=='__main__':
 probe=Probe(sys.argv[1]);print(json.dumps([probe.run(case) for case in cases]))
