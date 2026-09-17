"""Shared Unicorn probe for the Extension interactive-control natives.

Maps hash-checked Extension.dll (rebased to 0x12000000) plus Core.dll and
Engine.dll at their preferred bases (NativeCollision base).  Every native is
driven through its registered EXEC trampoline so the real parameter
marshalling runs: the fake FFrame keeps the object at +0x8 and a code pointer
at +0xc into a scratch byte buffer, and the Extension IAT slot 0x12059064
(Core!GNatives import) is overwritten with a fake table whose entries all
point at a stub this probe services.  Each param spec either writes a dword
through the eval result pointer (or, for {'out': label}, leaves the slot
address in the Core GPropAddr global reached through IAT 0x120590d0, or, for
{'skip': true}, writes nothing like an EX_Nothing argument) and returns
popping 8 like the real thiscall expression evaluators.

Window images get a fake vtable whose interactive slots are recording stubs:
  +0x7c  preferredSize(this, wFlag, &w, hFlag, &h)   -> event + queued w/h
  +0xe8  activate(this, source)                      -> event + queued result
  +0xec  activateKey2(this, source)                  -> event + queued result
  +0xf0  toggleChanged(this, source, toggle)         -> event + queued result
  +0x124 buttonPressed(this, key)                    -> event + queued result
AskParentForReconfigure (0x1204e060) is a no-arg leaf event.

Accesses are recorded for every tracked field of every built window, for the
labeled out/result slots, and for the image-global preferred-size recursion
counter 0x120aeb04.  Cases come from controlwindow-cases.json so the JS
validators replay the identical fixtures.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE, UC_MEM_READ
from unicorn.x86_const import (
    UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP,
)


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
IMAGES = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}
EXT = EXTENSION_BASE
IMAGE_BASE = 0x10000000

# Registered exec bodies (rebased) and the method bodies they tail-call.
NATIVES = {
    'activateButton':            {'exec': EXT + 0x85b0,  'execEnd': EXT + 0x85f9,
                                  'method': EXT + 0x77e0, 'methodEnd': EXT + 0x7881},
    'setActivateDelay':          {'exec': EXT + 0x8620,  'execEnd': EXT + 0x8665},
    'setButtonTextures':         {'exec': EXT + 0x8690,  'execEnd': EXT + 0x878f,
                                  'method': EXT + 0x7890, 'methodEnd': EXT + 0x7906},
    'setButtonColors':           {'exec': EXT + 0x87b0,  'execEnd': EXT + 0x8913,
                                  'method': EXT + 0x7940, 'methodEnd': EXT + 0x79b6},
    'setTextColors':             {'exec': EXT + 0x8940,  'execEnd': EXT + 0x8aa9,
                                  'method': EXT + 0x79f0, 'methodEnd': EXT + 0x7a66},
    'enableAutoRepeat':          {'exec': EXT + 0x8ad0,  'execEnd': EXT + 0x8b70,
                                  'method': EXT + 0x7aa0, 'methodEnd': EXT + 0x7ad2},
    'enableRightMouseClick':     {'exec': EXT + 0x8b90,  'execEnd': EXT + 0x8bd6,
                                  'method': EXT + 0x7ae0, 'methodEnd': EXT + 0x7afe},
    'setButtonSounds':           {'exec': EXT + 0x8c00,  'execEnd': EXT + 0x8c6f,
                                  'method': EXT + 0x7b00, 'methodEnd': EXT + 0x7b17},
    'pressButton':               {'exec': EXT + 0x8c90,  'execEnd': EXT + 0x8cdb},
    'setCheckboxTextures':       {'exec': EXT + 0xafb0,  'execEnd': EXT + 0xb075,
                                  'method': EXT + 0xa840, 'methodEnd': EXT + 0xa8db},
    'setCheckboxSpacing':        {'exec': EXT + 0xb0a0,  'execEnd': EXT + 0xb0e6,
                                  'method': EXT + 0xa910, 'methodEnd': EXT + 0xa969},
    'showCheckboxOnRightSide':   {'exec': EXT + 0xb110,  'execEnd': EXT + 0xb163},
    'setCheckboxStyle':          {'exec': EXT + 0xb190,  'execEnd': EXT + 0xb1d3,
                                  'method': EXT + 0xa9a0, 'methodEnd': EXT + 0xa9ad},
    'setCheckboxColor':          {'exec': EXT + 0xb200,  'execEnd': EXT + 0xb23c,
                                  'method': EXT + 0xa9b0, 'methodEnd': EXT + 0xa9bd},
    'setToggleSounds':           {'exec': EXT + 0x49dc0, 'execEnd': EXT + 0x49e2f,
                                  'method': EXT + 0x49a60, 'methodEnd': EXT + 0x49a77},
    'changeToggle':              {'exec': EXT + 0x49ce0, 'execEnd': EXT + 0x49cef,
                                  'method': EXT + 0x49910, 'methodEnd': EXT + 0x499a2},
    'getEnabledToggle':          {'exec': EXT + 0x38e00, 'execEnd': EXT + 0x38e1a},
    'queryPreferredSize':        {'exec': EXT + 0x53160, 'execEnd': EXT + 0x53200,
                                  'method': EXT + 0x4e710, 'methodEnd': EXT + 0x4e760,
                                  'helper': EXT + 0x4e790, 'helperEnd': EXT + 0x4e9bd},
    'isKeyDown':                 {'exec': EXT + 0x535f0, 'execEnd': EXT + 0x5363f,
                                  'method': EXT + 0x4c980, 'methodEnd': EXT + 0x4c9e2},
}

GNATIVES_IAT = EXT + 0x59064
GPROPADDR_IAT = EXT + 0x590d0
ASK_RECONFIGURE = EXT + 0x4e060
PREFSIZE_DEPTH = EXT + 0xaeb04

# Fake-vtable leaf slots -> recorded event op.
LEAF_SLOTS = {0x7c: 'PreferredSize', 0xe8: 'ActivateButton', 0xec: 'ActivateButton',
              0xf0: 'ToggleChanged', 0x124: 'ButtonPressed'}

# Field kinds by byte offset; everything else defaults to 'u32'.
U8_OFFSETS = {0x28, 0x30, 0x20c}
U8_RANGE = (0x630, 0x630 + 0x100)       # root-window key-state bytes
F32_OFFSETS = {0x9c, 0xa0, 0x80, 0x84, 0xbc, 0xc0, 0xc4, 0xc8,
               0x178, 0x17c, 0x180, 0x1fc, 0x200, 0x204}
PTR_OFFSETS = {0x00, 0x5c, 0xec, 0x138, 0x184, 0x190, 0x194, 0x1ec, 0x1f0,
               0x1f4, 0x1f8, 0x5c8,
               0x1a4, 0x1b0, 0x1bc, 0x1c8, 0x1d4, 0x1e0}  # style-table tex slots
PTR_RANGES = ()

WINDOW_SIZE = 0x800


def field_kind(offset):
    if offset in U8_OFFSETS or U8_RANGE[0] <= offset < U8_RANGE[1]:
        return 'u8'
    if offset in F32_OFFSETS:
        return 'f32'
    if offset in PTR_OFFSETS or any(a <= offset < b for a, b in PTR_RANGES):
        return 'ptr'
    return 'u32'


class ControlWindowProbe(_NATIVE.NativeCollision):
    """Run one interactive-control exec body against constructed windows."""

    def __init__(self, root):
        super().__init__(Path(root), IMAGES)
        self.events = []
        self.accesses = []
        self.exec_params = []
        self.virtual_results = {}      # (winLabel, slot) -> [returns]
        self.prefsize = None           # {'width': f32bits, 'height': f32bits}
        self.running = False
        self.windows = {}              # label -> base
        self.labels = {}               # label -> address (windows + resources)
        self.regions = {}              # label -> (base, size) for access tracing
        self.stub_map = {}             # stub addr -> (winLabel, slot)
        self.vtables = {}              # vtable addr -> window label
        self.seen_ids = {}

        # Fake GNatives table: every token dispatches to the eval stub.
        self.gnative_stub = self.alloc(16)
        self.cpu.mem_write(self.gnative_stub, b'\xc3')
        self.gnatives = self.alloc(0x400)
        for i in range(0x100):
            self.write(self.gnatives + 4 * i, 'I', self.gnative_stub)
        self.write(GNATIVES_IAT, 'I', self.gnatives)

        # Core GPropAddr global (the address the IAT slot was bound to); an
        # out-param eval sets it to the case out-slot.
        self.gprop_global = self.read(GPROPADDR_IAT, 'I')[0]

        self.cpu.hook_del(self.code_hook)
        self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction)
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_access)

    # ----- canonical labels ---------------------------------------------------
    def canon(self, ptr):
        if not ptr or not isinstance(ptr, int):
            return 0 if not ptr else ptr
        if ptr < 0x1000:
            return ptr
        for label, address in self.labels.items():
            if ptr == address:
                return label
        if ptr in self.vtables:
            return 'vtable:' + self.vtables[ptr]
        if ptr in self.seen_ids:
            return self.seen_ids[ptr]
        label = 'a%d' % len(self.seen_ids)
        self.seen_ids[ptr] = label
        return label

    # ----- leaf plumbing ------------------------------------------------------
    @staticmethod
    def _cdecl_return(cpu, stack, arg_bytes=0):
        ret = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + arg_bytes)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.thunks:
            raise RuntimeError(
                f'Unresolved import {self.thunks[address]}; trace {list(self.trace)}')
        self.trace.append(hex(address))
        if address == self.gnative_stub:
            self.on_gnative(cpu)
        elif address == ASK_RECONFIGURE:
            self.events.append({'op': 'AskParentForReconfigure',
                                'object': self.canon(cpu.reg_read(UC_X86_REG_ECX))})
            self._cdecl_return(cpu, cpu.reg_read(UC_X86_REG_ESP))
        elif address in self.stub_map:
            self.on_virtual(cpu, address)

    def on_gnative(self, cpu):
        """Model one param expression eval: (ecx=object, frame, resultPtr)."""
        stack = cpu.reg_read(UC_X86_REG_ESP)
        _frame, result_ptr = self.read(stack + 4, '2I')
        if not self.exec_params:
            raise RuntimeError('GNatives eval with no configured param')
        spec = self.exec_params.pop(0)
        if isinstance(spec, dict):
            if 'out' in spec:
                self.write(self.gprop_global, 'I', spec['out'])
            elif spec.get('skip'):
                pass
            else:
                self.write(result_ptr, 'I', spec['value'] & 0xffffffff)
        else:
            self.write(result_ptr, 'I', spec & 0xffffffff)
        self._cdecl_return(cpu, stack, 8)

    def on_virtual(self, cpu, stub):
        win_label, slot = self.stub_map[stub]
        stack = cpu.reg_read(UC_X86_REG_ESP)
        receiver = cpu.reg_read(UC_X86_REG_ECX)
        queue = self.virtual_results.setdefault((win_label, slot), [])
        result = queue.pop(0) if queue else 0
        if slot == 0x7c:
            flag_w, w_ptr, flag_h, h_ptr = self.read(stack + 4, '4I')
            width = self.prefsize.get('width', 0) if self.prefsize else 0
            height = self.prefsize.get('height', 0) if self.prefsize else 0
            self.write(w_ptr, 'I', width & 0xffffffff)
            self.write(h_ptr, 'I', height & 0xffffffff)
            self.events.append({'op': 'PreferredSize', 'object': self.canon(receiver),
                                'via': win_label, 'flagW': flag_w, 'flagH': flag_h,
                                'width': width, 'height': height,
                                'virtualSlot': slot, 'result': result})
        elif slot in (0xe8, 0xec):
            source = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'ActivateButton', 'object': self.canon(receiver),
                                'via': win_label, 'source': self.canon(source),
                                'virtualSlot': slot, 'result': result})
        elif slot == 0xf0:
            source, toggle = self.read(stack + 4, '2I')
            self.events.append({'op': 'ToggleChanged', 'object': self.canon(receiver),
                                'via': win_label, 'source': self.canon(source),
                                'toggle': toggle, 'virtualSlot': slot,
                                'result': result})
        elif slot == 0x124:
            key = self.read(stack + 4, 'I')[0]
            self.events.append({'op': 'ButtonPressed', 'object': self.canon(receiver),
                                'via': win_label, 'key': key, 'virtualSlot': slot,
                                'result': result})
        cpu.reg_write(UC_X86_REG_EAX, result & 0xffffffff)
        arg_bytes = {0x7c: 0x10, 0xe8: 4, 0xec: 4, 0xf0: 8, 0x124: 4}[slot]
        self._cdecl_return(cpu, stack, arg_bytes)

    # ----- access tracing -----------------------------------------------------
    def _region(self, address):
        for label, entry in self.regions.items():
            base, size = entry[0], entry[1]
            if base <= address < base + size:
                return label, address - base, entry[2] if len(entry) > 2 else None
        return None, None, None

    def on_access(self, cpu, access, address, size, value, data):
        if not self.running:
            return
        if address == PREFSIZE_DEPTH:
            label, offset, kind = 'prefSizeDepth', 0, 'u32'
        else:
            label, offset, override = self._region(address)
            if label is None:
                return
            kind = override or field_kind(offset)
            if (kind == 'u8' and size != 1) or (kind != 'u8' and size != 4):
                return
        captured = (int.from_bytes(cpu.mem_read(address, size), 'little')
                    if access == UC_MEM_READ
                    else value & ((1 << (size * 8)) - 1))
        self.accesses.append({
            'op': 'read' if access == UC_MEM_READ else 'write',
            'object': label, 'offset': offset, 'kind': kind, 'size': size,
            'bits': captured if kind != 'ptr' else None,
            'label': self.canon(captured) if kind == 'ptr' else None,
        })

    # ----- fixture construction -----------------------------------------------
    def _resolve(self, value):
        if isinstance(value, str):
            return self.labels[value]
        if isinstance(value, dict):
            if 'ptr' in value:
                return self.labels[value['ptr']]
            if 'f32' in value:
                return struct.unpack('<I', struct.pack('<f', value['f32']))[0]
            if 'i32' in value:
                return value['i32'] & 0xffffffff
            if 'u32' in value:
                return value['u32'] & 0xffffffff
            if 'u8' in value:
                return value['u8'] & 0xff
        return value & 0xffffffff if isinstance(value, int) else value

    def _window(self, label, fields=None):
        address = self.alloc(WINDOW_SIZE)
        vtable = self.alloc(0x200)
        self.cpu.mem_write(address, b'\xaa' * WINDOW_SIZE)
        self.cpu.mem_write(vtable, b'\x00' * 0x200)
        self.write(address, 'I', vtable)
        for slot in LEAF_SLOTS:
            stub = self.alloc(16)
            self.cpu.mem_write(stub, b'\xc3')
            self.write(vtable + slot, 'I', stub)
            self.stub_map[stub] = (label, slot)
        self.windows[label] = address
        self.labels[label] = address
        self.vtables[vtable] = label
        self.regions[label] = (address, WINDOW_SIZE, None)
        for off_text, value in (fields or {}).items():
            offset = int(off_text, 0)
            resolved = self._resolve(value)
            if offset in U8_OFFSETS or U8_RANGE[0] <= offset < U8_RANGE[1]:
                self.write(address + offset, 'B', resolved & 0xff)
            else:
                self.write(address + offset, 'I', resolved & 0xffffffff)
        return address

    def _resource(self, label, size=0x40, kind='u32', track=True):
        address = self.alloc(size)
        self.cpu.mem_write(address, b'\x00' * size)
        self.labels[label] = address
        if track:
            self.regions[label] = (address, size, kind)
        return address

    # ----- case driver --------------------------------------------------------
    def run_case(self, native, case):
        self.events = []
        self.accesses = []
        self.exec_params = []
        self.virtual_results = {}
        self.windows = {}
        self.labels = {}
        self.regions = {}
        self.stub_map = {}
        self.vtables = {}
        self.seen_ids = {}
        resources = case.get('resources', [])
        for name, fields in (resources.items() if isinstance(resources, dict)
                             else ((name, None) for name in resources)):
            self._resource(name)
            for off_text, value in (fields or {}).items():
                self.write(self.labels[name] + int(off_text, 0), 'I',
                           self._resolve(value))
        # nodes listed receiver-first; build outermost-first so links resolve
        for label, fields in reversed(case.get('nodes', [])):
            self._window(label, fields)
        receiver = self.windows[case.get('this', case['nodes'][0][0])]
        out_labels = {}
        args = []
        for arg in case.get('args', []):
            if isinstance(arg, dict) and 'out' in arg:
                name = arg['out']
                if name not in out_labels:
                    out_labels[name] = self._resource(name, 0x10)
                args.append({'out': out_labels[name]})
            elif isinstance(arg, dict) and 'skip' in arg:
                args.append(arg)
            else:
                args.append({'value': self._resolve(arg)})
        self.exec_params = args
        self.prefsize = {k: self._resolve(v)
                         for k, v in (case.get('prefsize') or {}).items()} or None
        for key, returns in case.get('vresults', {}).items():
            win, slot_text = key.split(':')
            self.virtual_results[(win, int(slot_text, 0))] = list(returns)
        result_slot = self.alloc(4)
        self.write(result_slot, 'I', 0xdeadbeef)
        frame = self.alloc(0x20)
        self.cpu.mem_write(frame, b'\0' * 0x20)
        code = self.alloc(0x40)
        self.cpu.mem_write(code, b'\x1c' * 0x40)
        self.write(frame + 8, 'I', receiver)
        self.write(frame + 0xc, 'I', code)
        self.running = True
        ret = self.call(NATIVES[native]['exec'], receiver,
                        struct.pack('<II', frame, result_slot))
        self.running = False
        result_raw = self.read(result_slot, 'I')[0]
        known = set(self.labels.values()) | set(self.vtables)
        result = self.canon(result_raw) if result_raw in known else result_raw
        state = {}
        dump_spec = case.get('dump', {})
        for label, base in self.windows.items():
            offsets = (dump_spec.get(label, []) if isinstance(dump_spec, dict)
                       else dump_spec)
            dump = {}
            for off_text in offsets:
                offset = int(off_text, 0)
                kind = field_kind(offset)
                if kind == 'u8':
                    value = self.read(base + offset, 'B')[0]
                    dump[off_text] = value
                else:
                    value = self.read(base + offset, 'I')[0]
                    dump[off_text] = self.canon(value) if kind == 'ptr' else value
            state[label] = dump
        return {'accesses': list(self.accesses), 'events': list(self.events),
                'state': state, 'result': result, 'ret': ret}


def oracle_main(native_name):
    probe = ControlWindowProbe(Path(sys.argv[1]))
    cases = json.loads(
        (Path(__file__).parent / 'controlwindow-cases.json').read_text())[native_name]
    entry = NATIVES[native_name]
    results = {}
    for name, case in cases.items():
        results[name] = probe.run_case(native_name, case)
    out = {
        'hashes': {'Extension.dll': EXTENSION_HASH,
                   'Core.dll': _NATIVE.HASHES['Core.dll'],
                   'Engine.dll': _NATIVE.HASHES['Engine.dll']},
        'extensionBase': EXTENSION_BASE,
        'execBody': (entry['exec'] - EXT) + IMAGE_BASE,
        'execEnd': (entry['execEnd'] - EXT) + IMAGE_BASE,
        'cases': results,
    }
    if entry.get('method'):
        out['methodBody'] = (entry['method'] - EXT) + IMAGE_BASE
        out['methodEnd'] = (entry['methodEnd'] - EXT) + IMAGE_BASE
    if entry.get('helper'):
        out['helperBody'] = (entry['helper'] - EXT) + IMAGE_BASE
        out['helperEnd'] = (entry['helperEnd'] - EXT) + IMAGE_BASE
    print(json.dumps(out))
