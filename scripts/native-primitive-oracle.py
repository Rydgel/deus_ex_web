"""Hash-gated original UPrimitive and UMesh execution; no collision callbacks."""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('base',Path(__file__).with_name('native-collision-oracle.py'))
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
def main():
 n=b.NativeCollision(Path(sys.argv[1]),{'MSVCRT.dll':'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'})
 results=[]
 for c in json.loads(Path(sys.argv[2]).read_text()):
  actor=n.alloc(0x300);a=c['actor']
  n.write(actor+0x114,'3f',*a['location']);n.write(actor+0x1d4,'2f',a['radius'],a['height'])
  row={}
  for kind,addr in [('line',0x103d8af0),('mesh',0x103a6d10),('point',0x103d87e0)]:
   h=n.alloc(48);n.write(h+36,'f',1)
   vectors=(*c['end'],*c['start'],*c['extent']) if kind!='point' else (*c['start'],*c['extent'])
   args=struct.pack('<II'+'f'*len(vectors)+'I',h,actor,*vectors,c.get('flags',0))
   clear=n.call(addr,0,args);row[kind]=n.result(clear,h)
  results.append(row)
 print(json.dumps({'hashes':b.HASHES,'results':results}))
if __name__=='__main__':main()
