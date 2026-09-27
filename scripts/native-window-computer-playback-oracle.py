"""Run original ComputerWindow playback over an exported same-heap fixture.
Only VM script dispatch, existing GC calls, and bounded FArray leaves are
intercepted. No ComputerWindow calculation is replaced."""
import importlib.util, json, struct, sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP, UC_X86_REG_EIP, UC_X86_REG_EAX
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'))
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
EXT=0x12000000
HASH='93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'

class Probe(n.NativeCollision):
 def __init__(self,root):
  super().__init__(Path(root),{'Extension.dll':{'hash':HASH,'base':EXT}})
  self.imports={key:self.read(EXT+off,'I')[0] for key,off in {'add':0x590a4,'remove':0x59094,'realloc':0x5909c,'stricmp':0x590c8,'name':0x590dc,'find':0x590e0}.items()}
  self.script=self.alloc(16)
 def ret(self,count=0,value=None):
  sp=self.cpu.reg_read(UC_X86_REG_ESP);ip=self.read(sp,'I')[0]
  if value is not None:self.cpu.reg_write(UC_X86_REG_EAX,value)
  self.cpu.reg_write(UC_X86_REG_ESP,sp+4+count*4);self.cpu.reg_write(UC_X86_REG_EIP,ip)
 def on_instruction(self,cpu,address,size,data):
  sp=cpu.reg_read(UC_X86_REG_ESP);o=cpu.reg_read(UC_X86_REG_ECX)
  if address==self.imports['add']:
   count,element=self.read(sp+4,'II');num,cap=self.read(o+4,'II')
   if num+count>cap:
    if num+count>128:raise RuntimeError('Oracle capacity exceeded')
    self.write(o,'I',self.win+0x2400);self.write(o+8,'I',num+count+(3*(num+count))//8+32)
   self.write(o+4,'I',num+count);self.ret(2,num);return
  if address==self.imports['remove']:
   index,count,element=self.read(sp+4,'III');ptr,num=self.read(o,'II')
   self.cpu.mem_write(ptr+index*element,bytes(self.cpu.mem_read(ptr+(index+count)*element,(num-index-count)*element)))
   self.write(o+4,'I',num-count);self.ret(3);return
  if address==self.imports['realloc']:
   if self.read(o+8,'I')[0]!=0:raise RuntimeError('Unreached oracle reallocation')
   self.write(o,'I',0);self.ret(1);return
  if address==self.imports['stricmp']:self.ret(0,int(self.paused));return
  if address==self.imports['name']:
   ptr=self.read(sp+4,'I')[0];self.event='ComputerStart' if ptr==EXT+0x97b88 else 'ComputerFadeOutCompleted'
   self.write(o,'I',77);self.ret(2,o);return
  if address==self.imports['find']:self.ret(2,1);return
  if address==self.script:
   _,params,_=self.read(sp+4,'III');self.events.append({'op':self.event,'object':o,'args':[]})
   if self.event=='ComputerStart':self.write(params,'I',int(o==self.parent))
   self.ret(3);return
  if address==EXT+0x4ded0:
   _,params,_=self.read(sp+4,'III');visible=self.read(params,'I')[0]
   self.events.append({'op':'VisibilityChanged','object':o,'args':[bool(visible)]});self.ret(3);return
  if address==EXT+0x03bf0:
   self.events.append({'op':'DrawWindow','object':o,'args':[self.read(sp+4,'I')[0]]});self.ret(1);return
  leaves={0x27640:('setFonts',2),0x27170:('setStyle',1),0x274f0:('setTileColor',1),0x27580:('setTextColor',1),0x289c0:('drawIcon',3),0x28a60:('drawPattern',7)}
  if address-EXT in leaves:
   name,count=leaves[address-EXT];self.events.append({'op':name,'object':o,'args':list(self.read(sp+4,str(count)+'I'))});self.ret(count);return
  if address==EXT+0x28180:
   args=list(self.read(sp+4,'5I'));ptr=args.pop();text=''
   while self.read(ptr,'H')[0]:text+=chr(self.read(ptr,'H')[0]);ptr+=2
   self.events.append({'op':'drawText','object':o,'args':args+[text]});self.ret(5);return
  if address==EXT+0x4bec0:self.ret();return
  super().on_instruction(cpu,address,size,data)
 def run(self,c):
  base=self.alloc(0x4000);self.cpu.mem_write(base,bytes(0x4000))
  self.win=base;self.parent=base+0x300;self.input=base+0x600;player=base+0xa00;level=base+0xb00
  queue=base+0x1200;display=base+0x2400;gc=base+0x3800;vt=base+0x3900
  self.write(vt+16,'I',self.script)
  for o in [self.win,self.parent]:self.write(o,'I',vt)
  self.write(self.win+0x138,'I',self.parent);self.write(self.win+0x1d0,'I',player)
  self.write(player+0xa8,'I',level);self.write(self.input+0x138,'I',self.win)
  self.write(self.win+0x1e0,'III',queue,0,128);self.write(self.win+0x1d4,'III',display,0,128)
  self.write(self.win+0x1cc,'I',self.input);self.write(self.win+0x210,'I',self.input)
  self.write(self.win+0x16c,'ii',10,3);self.write(self.win+0x178,'ii',7,9)
  self.write(self.win+0x174,'I',0x22222220);self.write(self.win+0x180,'I',0x802468ce)
  self.write(self.win+0x14c,'f',0.03);self.write(self.win+0x15c,'f',0.75);self.write(self.win+0x160,'f',1)
  self.write(self.win+0x190,'I',1);self.write(self.win+0x1bc,'f',0.25);self.write(self.win+0x1c0,'I',3)
  for off,value in c.get('i',{}).items():self.write(base+off,'I',value&0xffffffff)
  for off,value in c.get('f',{}).items():self.write(base+off,'f',value)
  for idx,event in enumerate(c.get('queue',[])):
   p=queue+idx*32;kind=event.get('type',0);self.write(p,'If',kind,event.get('time',0))
   if kind==0:self.write(p+8,'H',ord(event.get('char','A')));self.write(p+16,'ii',event.get('x',-1),event.get('y',-1))
   else:self.write(p+8,'II',event.get('arg',0),event.get('arg1',0))
  self.write(base+0x1e4,'I',len(c.get('queue',[])))
  for idx,event in enumerate(c.get('display',[])):
   p=display+idx*32;self.write(p,'If',event.get('type',0),event.get('fade',0));self.write(p+8,'H',ord(event.get('char','A')))
   self.write(p+10,'I',event.get('color',0x802468ce));self.write(p+16,'ii',event.get('x',0),event.get('y',0))
  self.write(base+0x1d8,'I',len(c.get('display',[])))
  self.events=[];self.paused=c.get('paused',False)
  before=bytes(self.cpu.mem_read(base,0x4000)).hex();args=c.get('args',[])
  entry={'tick':0xf7b0,'draw':0xed60,'visibility':0xee70,'queue':0xfe20,'scroll':0xeaf0,'cleanup':0xd6d0}[c['mode']]
  packed=struct.pack('<f',args[0]) if c['mode']=='tick' else struct.pack('<I',gc) if c['mode']=='draw' else struct.pack('<I',args[0]) if c['mode']=='visibility' else b''
  self.call(EXT+entry,base,packed)
  return {'name':c['name'],'mode':c['mode'],'args':args,'paused':self.paused,'base':base,'gc':gc,'parent':self.parent,'before':before,'after':bytes(self.cpu.mem_read(base,0x4000)).hex(),'events':self.events}

def main():
 cases=[]
 for flag in [0,8,16]:cases.append({'name':'visibility-'+str(flag),'mode':'visibility','args':[1],'i':{0x190:flag}})
 cases.append({'name':'visibility-hide','mode':'visibility','args':[0]})
 for name,i,f,paused in [('first',{0x190:17},{},False),('ignore',{0x214:8},{},False),('pause-enter',{}, {},True),('paused',{0x214:20},{},True),('pause-exit',{0x214:20},{},False),('ignore-pause',{0x214:32},{},True),('start',{0x190:5},{},False),('processing-pause',{0x214:4},{},False),('fade-complete',{}, {0x164:.0625,0x168:.5},False),('extended-clock',{}, {0x158:16777216.,0x154:16777216.,0x14c:.0625},False)]:
  cases.append({'name':'tick-'+name,'mode':'tick','args':[.125],'i':i,'f':f,'paused':paused,'display':[{'fade':.3},{'fade':.06}]})
 for text in [' A BC DEFG HI JK LMNO PQR','abcdefghijk','Hi^There','one two three four five six seven']:
  queue=[{'type':1,'arg':0xf04080c0}]+[{'type':4} if ch=='^' else {'char':ch} for ch in text]
  cases.append({'name':'queue-'+text,'mode':'tick','args':[1.125],'queue':queue})
 cases.append({'name':'queue-strict-time','mode':'queue','f':{0x158:.5},'queue':[{'char':'A','time':.25},{'char':'B','time':.5}]})
 cases.append({'name':'queue-explicit-position','mode':'queue','f':{0x158:1},'queue':[{'char':'Z','x':5,'y':2}]})
 cases.append({'name':'queue-other-events','mode':'queue','f':{0x158:1},'queue':[{'type':3,'arg':3,'arg1':1},{'char':'A'},{'type':6},{'char':'B'},{'type':11,'arg':0x3f000000}]})
 display=[{'char':'A','x':0,'y':0,'fade':.375},{'char':'B','x':1,'y':0,'fade':.03},{'char':'C','x':2,'y':1,'fade':0}]
 for name,i,f in [('fade-in',{},{}),('fade-out',{}, {0x164:.1234567,0x168:.9}),('no-fade',{}, {0x15c:0}),('cursor',{0x1ac:0x12345678,0x1b0:0xff804020,0x1b4:7,0x1b8:2},{}),('background',{0x194:123,0x198:124,0x19c:125,0x1a0:126,0x1a4:127,0x1a8:128},{})]:
  cases.append({'name':'draw-'+name,'mode':'draw','i':i,'f':f,'display':display})
 cases.append({'name':'scroll','mode':'scroll','display':display})
 cases.append({'name':'cleanup','mode':'cleanup','queue':[{'char':'A'}],'display':display})
 probe=Probe(sys.argv[1]);print(json.dumps({'hash':HASH,'cases':[probe.run(c) for c in cases]}))
if __name__=='__main__':main()
