"""Run the original FPropertyTag bool writer, including bit 31, without stubs."""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
probe = native.NativeCollision(Path(sys.argv[1]))
tag, archive, prop, data = [probe.alloc(0x80) for _ in range(4)]
probe.write(archive + 0x0c, 'I', 1)
probe.write(prop + 0x24, 'I', 0x102a6bf0)
cases = []
for mask, before, value in [(0x80000000, 0x12345678, True),
                            (0x80000000, 0xffffffff, False),
                            (1, 0x80000000, True), (1, 0x80000001, False)]:
    probe.write(tag + 1, 'B', 0x83 if value else 3)
    probe.write(prop + 0x5c, 'I', mask)
    probe.write(data, 'I', before)
    probe.call(0x1012aca0, tag, struct.pack('<3I', archive, prop, data))
    cases.append({'mask': mask, 'before': before, 'value': value, 'after': probe.read(data, 'I')[0]})
print(json.dumps(cases))
