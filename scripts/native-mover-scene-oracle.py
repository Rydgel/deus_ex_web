"""Original mover scene with an explicitly controlled PlayerPawn fixture."""
import hashlib,importlib.util,json,struct,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('mover',Path(__file__).with_name('native-mover-move-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class NativePlayerScene(m.Native):
 def alloc(self,size):return super().alloc(max(size,0x800) if size==0x400 else size)
 def __init__(self,root,scene):
  super().__init__(root,scene)
  self.write(0x1058c160+0x28,'I',0x1058c660)
  pawn=self.actor_ptrs['$pawn'];self.write(pawn+0x24,'I',0x1058c160);self.write(pawn+0x5d4,'I',pawn);self.write(pawn+0x318,'I',2)
if __name__=='__main__':
 raw=Path(sys.argv[2]).read_bytes();case_raw=Path(sys.argv[3]).read_bytes();scene=json.loads(raw);results=[]
 for c in json.loads(case_raw):
  n=NativePlayerScene(Path(sys.argv[1]),scene)
  if 'pawnPosition'in c:
   p=n.actor_ptrs['$pawn'];n.call(0x103583a0,n.hash,struct.pack('<I',p));n.write(p+0x114,'3f',*c['pawnPosition']);n.call(0x103580b0,n.hash,struct.pack('<I',p))
  results.append(n.capture(c))
 print(json.dumps({'hashes':m.m.base.HASHES|{'MSVCRT.dll':m.m.hash_module.CRT_HASH},'sceneSha256':hashlib.sha256(raw).hexdigest(),'casesSha256':hashlib.sha256(case_raw).hexdigest(),'results':results}))
