"""Execute original execMakeNoise (native 512, Engine.dll 0x103bcd20) through
the real AActor::MakeNoise (0x103bfad0 via thunk 0x103031a7) and the real
per-pawn hearing gate (0x103bf7b0 via thunk 0x1030286a). The Loudness
expression, appWarnf, the body-path IsChildOf (IAT 0x10599a74), IsProbing
(0x1059a02c), the FName lookup (0x10599a88), ProcessEvent (vtable +0x10) and
FastLineCheck (thunk 0x10301a37 repointed) are explicit controlled callbacks;
the noise-slot memory, pawn-list walk, class filters, distance/stimulus math,
team branch, NetMode gate and event arguments are original code.
"""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
F32=lambda v:struct.unpack('<f',struct.pack('<f',v))[0]
LEVELINFO,PLAYERPAWN,NAME=0x1057bf00,0x1058c160,0x156000
class NativeMakeNoise(m.NativeCollision):
 def __init__(self,root):
  super().__init__(root)
  self.emitter=self.alloc(0x400);self.xlevel=self.alloc(0x1200);self.actors=self.alloc(16)
  self.levelinfo=self.alloc(0x600);self.game=self.alloc(0x400)
  self.instigator=self.alloc(0x600);self.model=self.alloc(0x100)
  self.frame=self.alloc(0x40);self.code=self.alloc(16);self.result=self.alloc(4)
  self.argument=0x700fc000;self.warn=0x700fc010;self.childof=0x700fc020
  self.probing=0x700fc030;self.findname=0x700fc040;self.event=0x700fc050
  self.linecheck=0x700fc060
  # The warn stub is plain ret: every appWarnf call site cleans its own three
  # pushes with add esp,0xc, so a ret 0xc would drift esp +0xc per warning.
  for a,code in [(self.argument,'c2 08 00'),(self.warn,'c3'),(self.childof,'c2 04 00'),
                 (self.probing,'c2 04 00'),(self.findname,'c2 08 00'),(self.event,'c2 0c 00'),
                 (self.linecheck,'c2 18 00')]:
   self.cpu.mem_write(a,bytes.fromhex(code))
  natives=self.read(0x10599a38,'I')[0];self.write(natives+254*4,'I',self.argument)
  self.write(0x10599a1c,'I',self.warn);self.write(0x10599a74,'I',self.childof)
  self.write(0x1059a02c,'I',self.probing);self.write(0x10599a88,'I',self.findname)
  self.write(0x105836a4,'I',NAME);self.write(0x10599dac,'I',0)
  # Repoint the FastLineCheck thunk 0x10301a37 at the controlled stub.
  self.cpu.mem_write(0x10301a37,b'\xe9'+struct.pack('<I',(self.linecheck-0x10301a3c)&0xffffffff))
  self.vtable=self.alloc(0x40);self.write(self.vtable+0x10,'I',self.event)
  self.write(self.xlevel+0x2c,'III',self.actors,1,1)
  self.write(self.xlevel+0x98,'I',self.model)
  self.write(self.levelinfo+0x544,'I',self.game)
  self.write(self.emitter+0xac,'I',self.xlevel)
  self.write(self.frame+8,'2I',self.emitter,self.code)
 def name(self,p):
  if p==0:return None
  for key,ptr in self.objects.items():
   if p==ptr:return key
  return hex(p)
 def on_instruction(self,c,a,z,d):
  sp=c.reg_read(m.UC_X86_REG_ESP)
  if a==self.argument:
   self.write(self.read(sp+8,'I')[0],'f',self.loudness);return
  if a==self.warn:
   self.warns.append(self.read(sp+0xc,'I')[0]);return
  if a==self.childof:
   target,self_=self.read(sp+4,'I')[0],c.reg_read(m.UC_X86_REG_ECX)
   p=self.read(self_+0x24,'I')[0]
   while p:
    if p==target:c.reg_write(m.UC_X86_REG_EAX,1);return
    p=self.read(p+0x28,'I')[0]
   c.reg_write(m.UC_X86_REG_EAX,0);return
  if a==self.probing:
   self.probes.append(self.name(c.reg_read(m.UC_X86_REG_ECX)))
   c.reg_write(m.UC_X86_REG_EAX,1 if self.flags.get(self.name(c.reg_read(m.UC_X86_REG_ECX)),True) else 0);return
  if a==self.findname:
   c.reg_write(m.UC_X86_REG_EAX,self.read(sp+4,'I')[0]);return
  if a==self.event:
   fn,params,_=self.read(sp+4,'III')
   loud,src=self.read(params,'f I')
   self.events.append({'pawn':self.name(c.reg_read(m.UC_X86_REG_ECX)),'fn':'HearNoise' if fn==NAME else hex(fn),
    'loudness':loud,'source':self.name(src)});return
  if a==self.linecheck:
   start=self.read(sp+4,'3f');end=self.read(sp+16,'3f')
   self.lines.append({'start':list(start),'end':list(end)})
   c.reg_write(m.UC_X86_REG_EAX,self.line);return
  return super().on_instruction(c,a,z,d)
 def classchain(self,spec):
  # spec: list of symbolic class names, first = object's Class, each +0x28
  # links to the next; trailing names map to the real LevelInfo/PlayerPawn
  # objects while fabricated nodes share one emulated address per run.
  def node(name):
   if name=='LevelInfo':return LEVELINFO
   if name=='PlayerPawn':return PLAYERPAWN
   if name not in self.built:
    addr=self.alloc(0x40);self.built[name]=addr;self.objects[f'cls:{name}']=addr
   return self.built[name]
  head=None;prev=None
  for name in spec:
   addr=node(name)
   if head is None:head=addr
   else:self.write(prev+0x28,'I',addr)
   prev=addr
  return head or 0
 def pawn(self,key,cfg):
  p=self.alloc(0x600);self.objects[key]=p
  self.write(p,'I',self.vtable)
  self.write(p+0xac,'I',self.xlevel)
  self.write(p+0x24,'I',self.classchain(cfg.get('chain',['Pawn'])))
  self.write(p+0x114,'3f',*cfg.get('location',[0,0,0]))
  self.write(p+0x318,'B',2 if cfg.get('bIsPlayer') else 0)
  self.write(p+0x39c,'f',cfg.get('alertness',0))
  self.write(p+0x3a0,'f',cfg.get('stimulus',0))
  self.write(p+0x3ac,'f',cfg.get('threshold',0))
  if cfg.get('pri') is not None:
   pri=self.alloc(0x400);self.objects[f'{key}:pri']=pri
   self.write(pri+0x340,'B',cfg['pri'].get('team',0))
   self.write(p+0x558,'I',pri)
  return p
 def run(self,case):
  self.objects={'instigator':self.instigator,'emitter':self.emitter,
   'levelinfo':self.levelinfo,'game':self.game}
  self.built={}
  self.warns=[];self.probes=[];self.events=[];self.lines=[]
  self.flags=case.get('probing',{})
  self.line=case.get('linecheck',1)
  self.loudness=case['loudness']
  # LevelInfo class: real LevelInfo or a fabricated other class.
  self.write(self.levelinfo+0x24,'I',LEVELINFO if case.get('levelInfo','yes')=='yes' else self.classchain(['Other']))
  self.write(self.actors,'I',0 if case.get('actorsNull') else self.levelinfo)
  self.write(self.levelinfo+0x518,'B',case.get('netmode',0))
  self.write(self.levelinfo+0x54c,'I',0)  # PawnList head filled below
  self.write(self.xlevel+0xdc,'d',case.get('time',100.0))
  self.write(self.game+0x328,'I',case.get('gameFlags',0))
  self.write(self.emitter+0x24,'I',self.classchain(case.get('emitterChain',['Emitter'])))
  self.write(self.emitter+0x114,'3f',*case.get('location',[0,0,0]))
  ins=case.get('instigator')
  self.write(self.emitter+0xbc,'I',self.instigator if ins is not None else 0)
  if ins is not None:
   i=self.instigator
   self.write(i+0x498,'I',0)
   self.write(i+0x24,'I',self.classchain(ins.get('chain',['Pawn'])))
   self.write(i+0x318,'B',2 if ins.get('bIsPlayer') else 0)
   self.write(i+0x114,'3f',*ins.get('location',[0,0,0]))
   self.write(i+0x3cc,'I',0)
   if ins.get('enemy') is not None:
    e=self.pawn('enemy',ins['enemy']);self.write(i+0x3cc,'I',e)
   if ins.get('pri') is not None:
    pri=self.alloc(0x400);self.objects['instigator:pri']=pri
    self.write(pri+0x340,'B',ins['pri'].get('team',0));self.write(i+0x558,'I',pri)
   else:self.write(i+0x558,'I',0)
   for n,off in [(1,0x464),(2,0x47c)]:
    s=ins.get(f'slot{n}',{})
    spot=s.get('spot',[0,0,0]);self.write(i+off,'3f',*spot)
    self.write(i+off+0xc,'f',s.get('time',0));self.write(i+off+0x10,'I',s.get('other',0))
    self.write(i+off+0x14,'f',s.get('loud',0))
  head=None;prev=None
  for index,cfg in enumerate(case.get('pawns',[])):
   p=self.pawn(f'pawn{index}',cfg)
   if prev is not None:self.write(prev+0x498,'I',p)
   else:head=p
   prev=p
  if prev is not None:self.write(prev+0x498,'I',0)
  if case.get('instigatorInList') and ins is not None:
   if prev is not None:self.write(prev+0x498,'I',self.instigator)
   else:head=self.instigator
   self.write(self.instigator+0x498,'I',0)
  self.write(self.levelinfo+0x54c,'I',head or 0)
  self.cpu.mem_write(self.code,bytes([254,22]));self.write(self.frame+12,'I',self.code)
  fault=None
  try:self.call(0x103bcd20,self.emitter,struct.pack('<II',self.frame,self.result))
  except Exception as error:fault=str(error).split('\n')[0][:80]
  slots={}
  if ins is not None:
   i=self.instigator
   for n,off in [('slot1',0x464),('slot2',0x47c)]:
    spots=self.read(i+off,'3f');slots[n]={'spot':list(spots),'time':self.read(i+off+0xc,'f')[0],
     'other':self.read(i+off+0x10,'I')[0],'loud':self.read(i+off+0x14,'f')[0]}
  stimulus={}
  for key,p in self.objects.items():
   if key.startswith('pawn'):stimulus[key]=self.read(p+0x3a0,'f')[0]
  return {'warns':self.warns,'probes':self.probes,'events':self.events,'lines':self.lines,
   'slots':slots,'stimulus':stimulus,'fault':fault}
if __name__=='__main__':
 n=NativeMakeNoise(Path(sys.argv[1]));print(json.dumps({'hashes':m.HASHES,'results':[n.run(c)for c in json.loads(Path(sys.argv[2]).read_text())]}))
