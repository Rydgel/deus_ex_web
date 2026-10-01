"""Original AActor::physPathing (Engine 0x103dd8a0, PHYS_Interpolating) over
controlled InterpolationPoint paths (docs/pathing.md).

Each case builds the moving actor (class PlayerPawn, Pawn or a plain Actor
class), its LevelInfo and XLevel, and up to eight InterpolationPoints at the
SDK offsets: Location +0x114, Rotation +0x120, RateModifier +0x31c,
GameSpeedModifier +0x320, FovModifier +0x324, bEndOfPath/bSkipNextPath +0x328
bits 0/1, ScreenFlashScale +0x32c, ScreenFlashFog +0x330, Prev +0x33c and
Next +0x340, with their class pointer the static AInterpolationPoint class so
UObject::IsA executes from Core. PlayerPawn's class chain reaches APawn and
its default object holds the case's FovAngle. Leaves: ULevel::MoveActor
(level vtable +0x88: records delta, NewRotation and flags; applies them
unless the case blocks that move), FindFunctionChecked (a fixed function
pointer) and UObject::ProcessEvent (object vtable +0x10: records receiver
and InterpolateEnd's Other; a case may clear bInterpolating or rewrite
PhysRate at a given event). Floats are reported as float32 bit patterns.
"""
import importlib.util,json,struct,sys
from unicorn import UC_HOOK_MEM_READ,UC_HOOK_MEM_WRITE
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
INTERPOLATION_POINT,PLAYER_PAWN,PAWN=0x10579738,0x1058c160,0x1058c660
MOVE,PROCESS,FIND=0x700fe000,0x700fe100,0x700fe200
DEFAULT_SIZE=0x800
class NativePathing(m.NativeCollision):
 def __init__(self,root):
  super().__init__(root)
  self.cpu.mem_write(MOVE,bytes.fromhex('c2 30 00'));self.cpu.mem_write(PROCESS,bytes.fromhex('c2 0c 00'))
  self.cpu.mem_write(FIND,bytes.fromhex('b8 77 77 00 00 c2 08 00'))
  self.write(0x10599a88,'I',FIND)
  self.vtable=self.alloc(0x100);self.write(self.vtable+0x10,'I',PROCESS)
  self.levelVtable=self.alloc(0x100);self.write(self.levelVtable+0x88,'I',MOVE)
  # PlayerPawn's static class: SuperField -> APawn, a GetPropertiesSize stub
  # matching Defaults.Num, and the default object for FovAngle.
  self.classVtable=self.alloc(0x100);stub=self.alloc(16)
  self.cpu.mem_write(stub,b'\xb8'+struct.pack('<I',DEFAULT_SIZE)+b'\xc3');self.write(self.classVtable+0x64,'I',stub)
  self.defaults=self.alloc(DEFAULT_SIZE)
  self.write(PLAYER_PAWN,'I',self.classVtable);self.write(PLAYER_PAWN+0x28,'I',PAWN)
  self.write(PLAYER_PAWN+0x4d4,'I',self.defaults);self.write(PLAYER_PAWN+0x4d8,'I',DEFAULT_SIZE)
  self.plainClass=self.alloc(0x500)
  self.actor=self.alloc(0x800);self.levelInfo=self.alloc(0x600);self.level=self.alloc(0x100)
  self.points=[self.alloc(0x400) for _ in range(8)]
  # The harness maps page 0 for the FS exception chain; Windows reserves the
  # null page no-access, so a read or write past fs:[0] there is the original
  # access violation (a pointer the body dereferences without a test).
  def null(c,access,address,size,value,data):raise RuntimeError(f'null dereference at {address:#x}')
  self.cpu.hook_add(UC_HOOK_MEM_READ|UC_HOOK_MEM_WRITE,null,begin=0x10,end=0xffff)
 def index(self,address):
  if address==0:return None
  if address==self.actor:return 'self'
  return self.points.index(address) if address in self.points else hex(address)
 def on_instruction(self,c,a,z,d):
  if a==MOVE:
   sp=c.reg_read(m.UC_X86_REG_ESP);actor,*delta=self.read(sp+4,'I3f');rotation=list(self.read(sp+20,'3i'));flags=self.read(sp+36,'4I')
   if actor!=self.actor or any(flags):raise RuntimeError('Unexpected MoveActor contract')
   if len(self.events)>=300:raise RuntimeError('Unexpected move count')
   blocked=self.moves in self.blocked;self.moves+=1
   self.events.append({'move':list(self.read(sp+8,'3I')),'rotation':rotation,'applied':not blocked})
   if not blocked:
    self.write(actor+0x114,'3f',*[x+y for x,y in zip(self.read(actor+0x114,'3f'),delta)])
    self.write(actor+0x120,'3i',*rotation)
   c.reg_write(m.UC_X86_REG_EAX,0 if blocked else 1);return
  if a==PROCESS:
   sp=c.reg_read(m.UC_X86_REG_ESP);function,parms=self.read(sp+4,'2I')
   if function!=0x7777:raise RuntimeError('Unexpected ProcessEvent function')
   other=self.read(parms,'I')[0]
   self.events.append({'interpolateEnd':self.index(c.reg_read(m.UC_X86_REG_ECX)),'other':self.index(other)})
   effect=self.effects.get(str(self.calls));self.calls+=1
   if effect:
    if 'interpolating' in effect:self.write(self.actor+0x1ec,'I',128 if effect['interpolating'] else 0)
    if 'rate' in effect:self.write(self.actor+0x218,'f',effect['rate'])
   return
  return super().on_instruction(c,a,z,d)
 def run(self,case):
  a=self.actor;self.events=[];self.moves=0;self.calls=0;self.blocked=set(case.get('blocked',[]));self.effects=case.get('effects',{})
  for address,size in [(a,0x800),(self.levelInfo,0x600),(self.level,0x100)]+[(p,0x400) for p in self.points]:self.cpu.mem_write(address,bytes(size))
  cls={'playerpawn':PLAYER_PAWN,'pawn':PAWN,'actor':self.plainClass}[case.get('actorClass','actor')]
  self.write(a,'I',self.vtable);self.write(a+0x24,'I',cls);self.write(a+0xa8,'I',self.levelInfo);self.write(a+0xac,'I',self.level);self.write(self.level,'I',self.levelVtable)
  self.write(self.defaults+0x410,'f',case.get('defaultFov',90))
  self.write(a+0x214,'f',case['alpha']);self.write(a+0x218,'f',case['rate']);self.write(a+0x1ec,'I',128 if case.get('interpolating',True) else 0)
  self.write(a+0x114,'3f',*case['location']);self.write(a+0x120,'3i',*case.get('rotation',[0,0,0]))
  self.write(a+0x410,'f',case.get('fov',90))
  pointer=lambda i:0 if i is None else self.points[i]
  for i,p in enumerate(case['points']):
   q=self.points[i];self.write(q,'I',self.vtable);self.write(q+0x24,'I',INTERPOLATION_POINT if p.get('ip',True) else self.plainClass)
   self.write(q+0x114,'3f',*p['location']);self.write(q+0x120,'3i',*p.get('rotation',[0,0,0]))
   self.write(q+0x31c,'3f',p.get('rateModifier',1),p.get('gameSpeed',1),p.get('fov',1))
   self.write(q+0x328,'I',(1 if p.get('endOfPath') else 0)|(2 if p.get('skip') else 0))
   self.write(q+0x32c,'f',p.get('flashScale',1));self.write(q+0x330,'3f',*p.get('flashFog',[0,0,0]))
   self.write(q+0x33c,'2I',pointer(p.get('prev')),pointer(p.get('next')))
  self.write(a+0xb8,'I',pointer(case.get('target')))
  self.call(0x103dd8a0,a,struct.pack('<f',case['dt']))
  return {'events':self.events,'location':list(self.read(a+0x114,'3I')),'rotation':list(self.read(a+0x120,'3i')),
   'alpha':self.read(a+0x214,'I')[0],'rate':self.read(a+0x218,'I')[0],'interpolating':bool(self.read(a+0x1ec,'I')[0]&128),
   'target':self.index(self.read(a+0xb8,'I')[0]),'timeDilation':self.read(self.levelInfo+0x474,'I')[0],
   'fov':self.read(a+0x410,'I')[0],'viewRotation':list(self.read(a+0x3dc,'3i')),
   'flashScale':list(self.read(a+0x610,'3I')),'flashFog':list(self.read(a+0x61c,'3I')),
   'desiredFlashScale':self.read(a+0x638,'I')[0],'desiredFlashFog':list(self.read(a+0x644,'3I'))}
if __name__=='__main__':
 n=NativePathing(Path(sys.argv[1]));out=[]
 for c in json.loads(Path(sys.argv[2]).read_text()):
  try:out.append(n.run(c))
  except Exception as e:out.append({'fault':str(e).split(';')[0]})
 print(json.dumps({'hashes':m.HASHES,'results':out}))
