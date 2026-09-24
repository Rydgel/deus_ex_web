"""Original XCheckboxWindow bodies and XTextWindow granularity under Unicorn.

Runs these bodies unchanged from the hash-checked Extension.dll:

  0x1000acb0  XCheckboxWindow::ParentRequestedPreferredSize. It calls the
              checkbox extent 0x1000a9c0 and, for empty text without a
              background, XTextWindow's 0x100465a0; both run natively.
  0x10046880  XTextWindow::ParentRequestedGranularity
  0x1000a710  XCheckboxWindow::Init
  0x1000aad0  XCheckboxWindow::Draw

The leaves are recorded services. Each records its arguments (floats as
bits) and returns the case's controlled response:

  - GetGC 0x1004ddc0 and ReleaseGC 0x1004de50;
  - the string compare import at [0x100590c8];
  - the GC's GetTextExtent 0x10027bb0 and GetFontHeight 0x10027d60;
  - the XWindow script bridges 0x10050390 (preferred size), 0x10050450
    (granularity) and 0x10003bf0 (Draw);
  - XToggleWindow::Init 0x10049820;
  - the GC calls of Draw: SetAlignments 0x100276d0, EnableWordWrap
    0x10027720, SetTextColor 0x10027580, DrawText 0x10028180, SetStyle
    0x10027170, SetTileColor 0x100274f0 and the tile gate 0x10028770.

This checks each body's control flow, x87 arithmetic, store order and
call ABI, not font measurement or rasterization. It reads JSON {"cases": [...]}
on stdin and prints one JSON array. Research tool; the browser never imports
it. See docs/script-window-checkbox.md.
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path

from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

EXTENSION = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
ENTRY = {'preferred': 0x1000acb0, 'granularity': 0x10046880, 'init': 0x1000a710, 'draw': 0x1000aad0}
FONT_HEIGHT = 0x10027d60
bits = lambda value: struct.unpack('<I', struct.pack('<f', value))[0]


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root), {'Extension.dll': EXTENSION})
        self.result = self.alloc(4)
        self.compare = self.alloc(16)
        self.write(0x100590c8, 'I', self.compare)
        # GetFontHeight returns in st0: `fld dword [result]; ret 4`.
        self.cpu.mem_write(FONT_HEIGHT, b'\xd9\x05' + struct.pack('<I', self.result) + b'\xc2\x04\x00')
        self.leaves = {
            0x1004ddc0: ('getGC', '', 0), 0x1004de50: ('releaseGC', 'I', 4), 0x10027bb0: ('extent', 'IIII', 16),
            0x10050390: ('script', 'IIII', 16), 0x10050450: ('baseGranularity', 'II', 8), 0x10049820: ('toggleInit', 'I', 4),
            0x10003bf0: ('drawWindow', 'I', 4), 0x100276d0: ('setAlignments', 'II', 8), 0x10027720: ('enableWordWrap', 'I', 4),
            0x10027580: ('setTextColor', 'I', 4), 0x10028180: ('drawText', 'IIIII', 20), 0x10027170: ('setStyle', 'I', 4),
            0x100274f0: ('setTileColor', 'I', 4), 0x10028770: ('tile', '9I', 36),
        }

    def ret(self, cpu, sp, count):
        cpu.reg_write(UC_X86_REG_EIP, self.read(sp, 'I')[0])
        cpu.reg_write(UC_X86_REG_ESP, sp + 4 + count)

    def string(self, address):
        out = []
        while address:
            unit = self.read(address, 'H')[0]
            if not unit:
                break
            out.append(chr(unit))
            address += 2
        return ''.join(out)

    def on_instruction(self, cpu, address, size, data):
        sp = cpu.reg_read(UC_X86_REG_ESP)
        case = self.case
        if address == FONT_HEIGHT:
            self.calls.append(['fontHeight', self.read(sp + 4, 'I')[0]])
            self.write(self.result, 'f', case.get('fontHeight', 11.25))
            return
        if address == self.compare:
            cpu.reg_write(UC_X86_REG_EAX, int(bool(case.get('text', ''))))
            self.ret(cpu, sp, 0)
            return
        leaf = self.leaves.get(address)
        if not leaf:
            super().on_instruction(cpu, address, size, data)
            return
        name, fmt, count = leaf
        args = list(self.read(sp + 4, fmt)) if fmt else []
        if name == 'getGC':
            self.calls.append(['getGC'])
            cpu.reg_write(UC_X86_REG_EAX, 0 if case.get('noGC') else self.gc)
        elif name == 'releaseGC':
            self.calls.append(['releaseGC'])
        elif name == 'extent':
            clip, width, height, _text = args
            self.calls.append(['extent', clip])
            extent = case.get('extent', [30.25, 10.5])
            self.write(width, 'f', extent[0])
            self.write(height, 'f', extent[1])
        elif name == 'script':
            bw, width, bh, height = args
            self.calls.append(['script', bw, bits(self.read(width, 'f')[0]), bh, bits(self.read(height, 'f')[0])])
            self.write(width, 'f', 42.5)
            self.write(height, 'f', 23.25)
        elif name == 'baseGranularity':
            self.calls.append(['baseGranularity', self.read(args[0], 'I')[0], self.read(args[1], 'I')[0]])
        elif name == 'drawText':
            self.calls.append(['drawText', *args[:4], self.string(args[4])])
        elif name == 'tile':
            self.calls.append(['tile', *args[:8], self.labels.get(args[8], args[8])])
        elif name == 'drawWindow':
            self.calls.append(['drawWindow'])
        else:
            self.calls.append([name, *args])
        self.ret(cpu, sp, count)

    def texture(self, sizes, label):
        address = self.alloc(0x100)
        self.cpu.mem_write(address, bytes(0x100))
        self.write(address + 0x34, '2i', *sizes)
        self.labels[address] = label
        return address

    def run(self, case):
        self.case, self.calls, self.labels = case, [], {}
        self.gc = self.alloc(0x100)
        win = self.alloc(0x300)
        self.cpu.mem_write(win, bytes.fromhex(case['image']) if case.get('image') else bytes(0x300))
        for offset, value in case.get('u8', {}).items():
            self.write(win + int(offset), 'B', value)
        for offset, value in case.get('u32', {}).items():
            self.write(win + int(offset), 'I', value & 0xffffffff)
        for offset, value in case.get('f32', {}).items():
            self.write(win + int(offset), 'f', value)
        for offset, value in case.get('i32', {}).items():
            self.write(win + int(offset), 'i', value)
        for offset, (sizes, label) in case.get('textures', {}).items():
            self.write(win + int(offset), 'I', self.texture(sizes, label))
        text = case.get('text', '')
        if text:
            data = self.alloc(2 * len(text) + 2)
            self.cpu.mem_write(data, text.encode('utf-16-le') + b'\0\0')
            self.write(win + 0x168, '3I', data, len(text) + 1, len(text) + 1)
        body = case['body']
        out = {'id': case['id']}
        if body == 'preferred':
            w, h = self.alloc(4), self.alloc(4)
            self.write(w, 'f', case.get('width', 100))
            self.write(h, 'f', case.get('height', 80))
            self.call(ENTRY[body], win, struct.pack('<4I', case.get('bW', 0), w, case.get('bH', 0), h))
            out.update(width=self.read(w, 'I')[0], height=self.read(h, 'I')[0])
        elif body == 'granularity':
            hg, vg = self.alloc(4), self.alloc(4)
            self.write(hg, 'f', case.get('h', 2.5))
            self.write(vg, 'f', case.get('v', 3.5))
            self.call(ENTRY[body], win, struct.pack('<2I', hg, vg))
        elif body == 'init':
            self.call(ENTRY[body], win, struct.pack('<I', case['parent']))
        elif body == 'draw':
            self.call(ENTRY[body], win, struct.pack('<I', self.gc))
        out['calls'] = self.calls
        out['image'] = bytes(self.cpu.mem_read(win, 0x300)).hex()
        return out


if __name__ == '__main__':
    request = json.load(sys.stdin)
    probe = Probe(request['gameRoot'])
    print(json.dumps([probe.run(case) for case in request['cases']]))
