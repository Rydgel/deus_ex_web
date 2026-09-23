"""Unchanged original Window/PlayerPawnExt actor-reference tracking bodies."""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('native',Path(__file__).with_name('native-collision-oracle.py'))
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
HASH='93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'

class Probe(native.NativeCollision):
 def __init__(self,root):super().__init__(Path(root),{'Extension.dll':HASH})
 def run(self,s):
  pawn=self.alloc(0xa00);root=self.alloc(0x800);window=self.alloc(0x200);second=self.alloc(0x200)
  self.write(root+0x28,'B',3);self.write(root+0x588,'I',0 if s.get('noPawn') else pawn)
  self.write(window+0x138,'I',0 if s.get('noRoot') else root)
  self.write(second+0x138,'I',window)
  names={name for name,refs in s.get('initial',[]) if name is not None}
  names.update(name for op,name in s['ops'] if name is not None)
  names.update(s.get('deleted',[]));actors={name:self.alloc(0x40) for name in sorted(names)}
  reverse={ptr:name for name,ptr in actors.items()}
  for name in s.get('deleted',[]):self.write(actors[name]+0x28,'I',0x80)
  for i,(name,refs) in enumerate(s.get('initial',[])):
   self.write(pawn+0x898+i*8,'Ii',actors.get(name,0),refs)
  self.write(pawn+0x998,'i',len(s.get('initial',[])))
  results=[]
  for step,(op,name) in enumerate(s['ops']):
   actor=actors.get(name,0);value=None
   if op=='kill':self.write(actor+0x28,'I',0x80)
   else:
    target=second if s.get('secondWindow') and step%2 else window
    result=self.call({'add':0x1004fe20,'remove':0x1004fea0,'valid':0x1004ff20}[op],target,struct.pack('<I',actor))
    if op=='valid':value=bool(result)
   results.append({'value':value,'count':self.read(pawn+0x998,'i')[0],
    'slots':[[reverse.get(self.read(pawn+0x898+i*8,'I')[0]),self.read(pawn+0x89c+i*8,'i')[0]] for i in range(32)]})
  return results
if __name__=='__main__':
 req=json.load(sys.stdin);p=Probe(req['gameRoot']);print(json.dumps({'hash':HASH,'cases':[p.run(s) for s in req['samples']]}))
