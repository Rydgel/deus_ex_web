"""Direct original IsBlockedBy, Brush source and controlled class/flag fixtures."""
import importlib.util,json,sys,struct,hashlib
from pathlib import Path
s=importlib.util.spec_from_file_location('check',Path(__file__).with_name('native-check-encroachment-oracle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class NativeBlocking(m.NativeCheck):
 def blocked(self,c):
  self.capture({'op':'overlap','source':'s','other':'a','actors':[{'id':'s','kind':'Brush','flags':c['sourceFlags']},{'id':'a','kind':'Player' if c['kind']=='UncontrolledPlayer' else c['kind'],'flags':c['otherFlags']}]})
  if c['kind']=='UncontrolledPlayer':self.write(self.ptrs['a']+0x5d4,'I',0)
  return bool(self.call(0x1034c5e0,self.ptrs['s'],struct.pack('<I',self.info if c['kind']=='World' else self.ptrs['a'])))
if __name__=='__main__':
 raw=Path(sys.argv[2]).read_bytes();n=NativeBlocking(Path(sys.argv[1]));print(json.dumps({'hashes':m.m.HASHES,'casesSha256':hashlib.sha256(raw).hexdigest(),'results':[n.blocked(c) for c in json.loads(raw)]}))
