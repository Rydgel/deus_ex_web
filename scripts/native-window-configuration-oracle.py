"""Original SetConfiguration, with only AskParentForReconfigure intercepted."""
import importlib.util,json,struct,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('position',Path(__file__).with_name('native-window-position-oracle.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=m.WindowPositionProbe(Path(sys.argv[1]))
results=[]
for case in json.load(sys.stdin):
 p.cpu.mem_write(p.window,b'\0'*0x200)
 for off,val in case['initial']:
  p.cpu.mem_write(p.window+off,struct.pack('<B' if off in (0x88,0x89) else '<I',val))
 p.events=[]
 p.call(0x12003330,p.window,struct.pack('<4I',*case['args']))
 results.append({'storage':bytes(p.cpu.mem_read(p.window,0x200)).hex(),'events':p.events})
print(json.dumps(results))
