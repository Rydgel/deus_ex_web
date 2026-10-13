"""Run the original UEventManager (Engine.dll 0x10382550..0x10384a90) over a synthetic level.

Optional research tool, never imported by the browser (docs/ai-event-manager.md). The manager's own instructions run unchanged:
AISetEventCallback / AIClearEventCallback / AISendEvent / AIStartEvent / AIEndEvent / AIClearEvent / DestroyActor / AIProcess /
CleanupEvents / Tick with their FindEvent, SafeDelete, CleanupSlot, ComputeSenseDetection (the real AICanHear and AICanSmell),
AIComputeScore and AIEvent. The boundaries around them are explicit leaves that log their arguments and return what the
scenario says:

* the three event classes' operator new (an allocator), their virtual deleting destructor (a log), UObject::FindFunction /
  FindFunctionChecked (a function id per name), AActor::ProcessEvent (the callbacks and the score callbacks);
* AActor::InStasis, APawn::AICanSee (the worker 0x103c6ab0, a float in ST0) and ULevel::SingleLineCheck;
* Core's appQsort (the comparator 0x10382420 is checked separately, `qsortCompare`), appStricmp, the FName table, GCRCTable
  (UE1's appInit values) and Logf.

AActor::bDeleteMe (vtable slot 11, 0x1030df80) is the original's. Input: JSON cases on stdin, each {actors, ops}; output: per op
the boundary log and a snapshot of the manager (types in bucket order, their senders and receivers in list order, the process ring).
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

MANAGER_VTABLE = 0x10429758
RECEIVER_VTABLE, SENDER_VTABLE, TYPE_VTABLE = 0x1042cfcc, 0x1042d030, 0x1042d0c4
CLASS_PAWN, CLASS_INVENTORY = 0x1058c660, 0x10576f70
FUNCTION_BASE = 0x30000000
F32 = struct.Struct('<f')


def f32(value):
    return F32.unpack(F32.pack(value))[0]


def bits(value):
    return struct.pack('<f', value).hex()


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.hooks = {}
        self.log = []
        self.names = ['None']
        self.name_entries = {}
        self.labels = {}
        self.stub_next = 0x700e0000
        self.scratch = self.alloc(64)
        self.policy = {}
        self.actors = {}
        self.ids = {}
        self.stasis = {}
        self.functions = {}
        # --- Core boundary: the FName table, UE1's CRC table, the timing globals ---
        names_array = self.read(0x10599a70, 'I')[0]
        self.names_data = self.alloc(4 * 4096)
        self.write(names_array, '3I', self.names_data, 4096, 4096)
        self.intern('None')
        crc = self.read(0x10599ba0, 'I')[0]
        table = []
        for index in range(256):
            c = index << 24
            for _ in range(8):
                c = ((c << 1) ^ 0x04c11db7) & 0xffffffff if c & 0x80000000 else (c << 1) & 0xffffffff
            table.append(c)
        self.cpu.mem_write(crc, struct.pack('<256I', *table))
        self.write(self.read(0x10599dac, 'I')[0], 'I', 0)       # GTimestamp: no profiling clock
        self.write(self.read(0x10599da8, 'I')[0], 'd', 0.000000001)
        # --- the level and the manager ---
        self.level = self.alloc(0x400)
        self.level_vtable = self.alloc(0x200)
        self.write(self.level, 'I', self.level_vtable)
        self.write(self.level + 0xdc, 'd', 0.0)
        self.manager = self.alloc(0x43c)
        self.write(self.manager, 'I', MANAGER_VTABLE)
        self.write(self.manager + 0x28, 'I', self.level)
        # --- patched boundaries ---
        self.patch_new(0x10384b20, 0x3c, 'type')
        self.patch_new(0x10384df0, 0x14c, 'sender')
        self.patch_new(0x103850c0, 0x84, 'receiver')
        for vtable, label in [(RECEIVER_VTABLE, 'receiver'), (SENDER_VTABLE, 'sender'), (TYPE_VTABLE, 'type')]:
            stub = self.stub(lambda cpu, stack, label=label: self.on_delete(label, cpu.reg_read(UC_X86_REG_ECX)), pop=4)
            self.write(vtable + 0xc, 'I', stub)
        self.write(0x10599ed4, 'I', self.stub(self.on_find_function, pop=8))        # UObject::FindFunction
        self.write(0x10599a88, 'I', self.stub(self.on_find_function, pop=8))        # FindFunctionChecked
        self.write(0x10599bac, 'I', self.stub(self.on_name_ctor, pop=8))            # FName::FName(const TCHAR*, EFindName)
        self.write(0x10599bb0, 'I', self.stub(self.on_stricmp))                     # appStricmp (cdecl)
        self.write(0x10599ed0, 'I', self.stub(self.on_qsort))                       # appQsort (cdecl)
        self.write(0x10599a68, 'I', self.stub(self.on_logf))                        # FOutputDevice::Logf (cdecl, varargs)
        self.write(0x10599a1c, 'I', self.stub(self.on_assert))                      # appFailAssert
        self.actor_vtable = self.alloc(0x200)
        self.write(self.actor_vtable + 0x2c, 'I', 0x10302167)                       # the original bDeleteMe getter
        self.write(self.actor_vtable + 0x10, 'I', self.stub(self.on_process_event, pop=12))
        self.write(self.level_vtable + 0xc0, 'I', self.stub(self.on_line_check, pop=0x24))
        # InStasis (AActor, no arguments) and AICanSee's worker (a float in ST0, six arguments)
        self.patch(0x1036bfe0, b'\xc3', self.on_in_stasis)
        self.patch(0x103c6ab0, b'\xd9\x05' + struct.pack('<I', self.scratch) + b'\xc2\x18\x00', self.on_can_see)
        self.class_pawn, self.class_inventory, self.class_plain = self.alloc(0x40), self.alloc(0x40), self.alloc(0x40)
        self.write(self.class_pawn + 0x28, 'I', CLASS_PAWN)
        self.write(self.class_inventory + 0x28, 'I', CLASS_INVENTORY)

    # ---- plumbing ----------------------------------------------------------
    def patch(self, address, code, handler):
        self.cpu.mem_write(address, code)
        self.hooks[address] = handler

    def stub(self, handler, pop=0):
        address = self.stub_next
        self.stub_next += 16
        self.cpu.mem_write(address, b'\xc2' + struct.pack('<H', pop) if pop else b'\xc3')
        self.hooks[address] = handler
        return address

    def patch_new(self, address, size, label):
        def handler(cpu, stack):
            block = self.alloc(size)
            cpu.mem_write(block, bytes(size))
            cpu.reg_write(UC_X86_REG_EAX, block)
            self.labels[block] = label
        self.patch(address, b'\xc3', handler)

    def on_instruction(self, cpu, address, size, data):
        handler = self.hooks.get(address)
        if handler:
            handler(cpu, cpu.reg_read(UC_X86_REG_ESP))
        super().on_instruction(cpu, address, size, data)

    def wide(self, pointer):
        text = ''
        while True:
            unit = self.read(pointer, 'H')[0]
            if not unit:
                return text
            text += chr(unit)
            pointer += 2

    def intern(self, text):
        if text in self.names:
            return self.names.index(text)
        index = len(self.names)
        self.names.append(text)
        entry = self.alloc(0xc + 2 * (len(text) + 1))
        self.cpu.mem_write(entry + 0xc, (text + '\0').encode('utf-16le'))
        self.write(entry, 'I', index)
        self.write(self.names_data + 4 * index, 'I', entry)
        return index

    # ---- leaves -------------------------------------------------------------
    def on_delete(self, label, this):
        self.log.append({'kind': 'delete', 'class': label, **self.describe(this, label)})

    def describe(self, this, label):
        if label == 'sender' or label == 'receiver':
            return {'actor': self.ids.get(self.read(this + 0x2c, 'I')[0]), 'event': self.event_name(this)}
        return {'event': self.names[self.read(this + 0x28, 'I')[0]]}

    def event_name(self, event):
        kind = self.read(event + 0x28, 'I')[0]
        return self.names[self.read(kind + 0x28, 'I')[0]]

    def on_find_function(self, cpu, stack):
        name = self.read(stack + 4, 'I')[0]
        actor = cpu.reg_read(UC_X86_REG_ECX)
        allowed = self.functions.get(actor)
        found = allowed is None or self.names[name] in allowed
        cpu.reg_write(UC_X86_REG_EAX, FUNCTION_BASE + name if found else 0)

    def on_name_ctor(self, cpu, stack):
        pointer = self.read(stack + 4, 'I')[0]
        index = self.intern(self.wide(pointer))
        this = cpu.reg_read(UC_X86_REG_ECX)
        self.write(this, 'I', index)
        cpu.reg_write(UC_X86_REG_EAX, this)

    def on_stricmp(self, cpu, stack):
        a, b = (self.wide(p).lower() for p in self.read(stack + 4, '2I'))
        cpu.reg_write(UC_X86_REG_EAX, ((a > b) - (a < b)) & 0xffffffff)

    def on_qsort(self, cpu, stack):
        base, count, width, compare = self.read(stack + 4, '4I')
        assert width == 4 and compare == 0x10302ecd
        entries = list(self.read(base, f'{count}I'))
        scores = [self.read(entry + 0x38, 'f')[0] for entry in entries]
        order = sorted(range(count), key=lambda i: (scores[i], i))
        self.cpu.mem_write(base, struct.pack(f'<{count}I', *[entries[i] for i in order]))
        self.log.append({'kind': 'qsort', 'count': count})

    def on_logf(self, cpu, stack):
        self.log.append({'kind': 'warning', 'format': self.wide(self.read(stack + 8, 'I')[0])[:40]})

    def on_assert(self, cpu, stack):
        raise RuntimeError('appFailAssert in the event manager')

    def on_in_stasis(self, cpu, stack):
        actor = cpu.reg_read(UC_X86_REG_ECX)
        cpu.reg_write(UC_X86_REG_EAX, 1 if self.stasis.get(actor) else 0)

    def on_can_see(self, cpu, stack):
        pawn = cpu.reg_read(UC_X86_REG_ECX)
        other, visibility, *flags = self.read(stack + 4, 'IfIIII')
        result = f32(self.policy.get('canSeeScale', 0.75) * visibility)
        for rule in self.policy.get('canSee', []):
            if self.ids.get(pawn) == rule[0] and self.ids.get(other) == rule[1]:
                result = f32(rule[2])
        self.write(self.scratch, 'f', result)
        self.log.append({'kind': 'canSee', 'pawn': self.ids.get(pawn), 'other': self.ids.get(other), 'visibility': bits(visibility), 'flags': flags, 'result': bits(result)})

    def on_line_check(self, cpu, stack):
        hit, source, end, start, flags = self.read(stack + 4, '5I')
        blocked = any(self.ids.get(source) == rule[0] and rule[1] == self.ids.get(self.actor_at(end)) for rule in self.policy.get('blocked', []))
        self.write(hit + 0x24, 'f', 0.5 if blocked else 1.0)
        self.log.append({'kind': 'lineCheck', 'source': self.ids.get(source), 'end': [bits(v) for v in self.read(end, '3f')],
                         'start': [bits(v) for v in self.read(start, '3f')], 'flags': flags, 'blocked': blocked})

    def actor_at(self, location_pointer):
        return location_pointer - 0x114

    def on_process_event(self, cpu, stack):
        actor = cpu.reg_read(UC_X86_REG_ECX)
        function, parms, result = self.read(stack + 4, '3I')
        name = self.names[function - FUNCTION_BASE]
        if name in self.policy.get('scoreFunctions', []) or name.endswith('Score'):
            receiver, sender = self.read(parms, '2I')
            score = self.read(parms + 8, 'f')[0]
            value = f32(score * self.policy.get('scoreScale', 0.5))
            if [self.ids.get(receiver), self.ids.get(sender)] in self.policy.get('cull', []):
                value = 0.0
            self.write(parms + 0xc, 'f', value)
            self.log.append({'kind': 'score', 'actor': self.ids.get(actor), 'function': name, 'receiver': self.ids.get(receiver),
                             'sender': self.ids.get(sender), 'score': bits(score), 'result': bits(value)})
        else:
            event, state = self.read(parms, 'IB')
            best, score, visibility, volume, smell = self.read(parms + 8, 'Iffff')
            self.log.append({'kind': 'callback', 'actor': self.ids.get(actor), 'function': name, 'event': self.names[event], 'state': state,
                             'params': {'bestActor': self.ids.get(best), 'score': bits(score), 'visibility': bits(visibility),
                                        'volume': bits(volume), 'smell': bits(smell)}})

    # ---- the scenario world -------------------------------------------------
    def make_actor(self, name):
        address = self.alloc(0x800)
        self.actors[name] = address
        self.ids[address] = name
        self.write(address, 'I', self.actor_vtable)
        self.write(address + 0xac, 'I', self.level)

    DEFAULTS = {'kind': 'plain', 'location': [0, 0, 0], 'radius': 17, 'height': 39, 'detectable': True, 'deleted': False,
                'lastRender': 0, 'distance': 100000, 'hearing': 0, 'stasis': False, 'owner': None}

    def set_actor(self, name, spec):
        address = self.actors[name]
        if 'kind' in spec:
            self.write(address + 0x24, 'I', {'pawn': self.class_pawn, 'inventory': self.class_inventory, 'plain': self.class_plain}[spec['kind']])
        if 'location' in spec:
            self.write(address + 0x114, '3f', *spec['location'])
        if 'radius' in spec:
            self.write(address + 0x1d4, 'f', spec['radius'])
        if 'height' in spec:
            self.write(address + 0x1d8, 'f', spec['height'])
        if 'detectable' in spec:
            flags = self.read(address + 0x2c, 'I')[0]
            self.write(address + 0x2c, 'I', (flags & ~1) | (1 if spec['detectable'] else 0))
        if 'deleted' in spec:
            flags = self.read(address + 0x28, 'I')[0]
            self.write(address + 0x28, 'I', (flags & ~0x80) | (0x80 if spec['deleted'] else 0))
        if 'owner' in spec:
            self.write(address + 0x3c, 'I', self.actors[spec['owner']] if spec['owner'] else 0)
        if 'lastRender' in spec:
            self.write(address + 0x34, 'f', spec['lastRender'])
        if 'distance' in spec:
            self.write(address + 0x38, 'f', spec['distance'])
        if 'hearing' in spec:
            self.write(address + 0x3ac, 'f', spec['hearing'])
        if 'stasis' in spec:
            self.stasis[address] = spec['stasis']
        if 'functions' in spec:
            self.functions[address] = spec['functions']

    def actor_id(self, pointer):
        return self.ids.get(pointer) if pointer else None

    # ---- the manager's state --------------------------------------------------
    def snapshot(self):
        mgr = self.manager
        first = self.read(mgr + 0x38, 'I')[0]
        out = {'currentSlot': self.read(mgr + 0x34, 'I')[0], 'refProcessing': self.read(mgr + 0x2c, 'i')[0], 'deleteCount': self.read(mgr + 0x30, 'i')[0],
               'firstProcess': self.receiver_key(first) if first else None, 'types': [], 'ring': []}
        for bucket in range(256):
            kind = self.read(mgr + 0x3c + 4 * bucket, 'I')[0]
            while kind:
                entry = {'bucket': bucket, 'name': self.names[self.read(kind + 0x28, 'I')[0]], 'hash': self.read(kind + 0x2c, 'I')[0], 'senders': [], 'receivers': []}
                sender = self.read(kind + 0x30, 'I')[0]
                while sender:
                    slots = [[bits(v) for v in self.read(sender + 0x3c + 16 * i, '4f')] for i in range(16)]
                    entry['senders'].append({'actor': self.actor_id(self.read(sender + 0x2c, 'I')[0]), 'destroyed': self.read(sender + 0x30, 'I')[0],
                                             'holdScore': bits(self.read(sender + 0x38, 'f')[0]), 'slots': slots,
                                             'current': [bits(v) for v in self.read(sender + 0x13c, '4f')]})
                    sender = self.read(sender + 0x34, 'I')[0]
                receiver = self.read(kind + 0x34, 'I')[0]
                while receiver:
                    r = self.read(receiver + 0x28, '13I')
                    entry['receivers'].append({
                        'actor': self.actor_id(r[1]), 'destroyed': r[2], 'callback': self.names[self.read(receiver + 0x38, 'I')[0]],
                        'scoreCallback': self.names[self.read(receiver + 0x3c, 'I')[0]], 'invoke': self.read(receiver + 0x40, 'I')[0],
                        'state': self.read(receiver + 0x44, 'B')[0], 'checks': list(self.read(receiver + 0x48, '4I')),
                        'on': self.read(receiver + 0x58, 'I')[0], 'bestScore': bits(self.read(receiver + 0x5c, 'f')[0]),
                        'bestSender': self.actor_id(self.read(receiver + 0x60, 'I')[0]), 'nextSlot': self.read(receiver + 0x64, 'i')[0],
                        'params': {'bestActor': self.actor_id(self.read(receiver + 0x68, 'I')[0]), 'score': bits(self.read(receiver + 0x6c, 'f')[0]),
                                   'visibility': bits(self.read(receiver + 0x70, 'f')[0]), 'volume': bits(self.read(receiver + 0x74, 'f')[0]),
                                   'smell': bits(self.read(receiver + 0x78, 'f')[0])}})
                    receiver = self.read(receiver + 0x34, 'I')[0]
                out['types'].append(entry)
                kind = self.read(kind + 0x38, 'I')[0]
        node, guard = first, 0
        while node and guard < 4096:
            out['ring'].append({**self.receiver_key(node), 'destroyed': self.read(node + 0x30, 'I')[0]})
            node = self.read(node + 0x7c, 'I')[0]
            guard += 1
            if node == first:
                break
        return out

    def receiver_key(self, receiver):
        return {'actor': self.actor_id(self.read(receiver + 0x2c, 'I')[0]), 'event': self.event_name(receiver)}

    # ---- operations -----------------------------------------------------------
    def op(self, op):
        kind = op['op']
        a = self.actors
        manager = self.manager
        n = self.intern
        if kind == 'set':
            self.set_actor(op['actor'], op['fields'])
        elif kind == 'policy':
            self.policy.update(op['policy'])
        elif kind == 'time':
            self.write(self.level + 0xdc, 'd', op['seconds'])
        elif kind == 'setCallback':
            flags = op.get('flags', [1, 1, 0, 1])
            args = struct.pack('<8I', a[op['receiver']], n(op['event']), n(op['callback']), n(op['score']) if op.get('score') else 0, *flags)
            self.call(0x10382990, manager, args)
        elif kind == 'clearCallback':
            self.call(0x10382b90, manager, struct.pack('<2I', a[op['receiver']], n(op['event'])))
        elif kind in ('send', 'start'):
            args = struct.pack('<3Iff', a[op['sender']], n(op['event']), op['type'], op.get('value', 1.0), op.get('radius', 800.0))
            self.call(0x10382c60 if kind == 'send' else 0x10382fe0, manager, args)
        elif kind == 'end':
            self.call(0x103831e0, manager, struct.pack('<3I', a[op['sender']], n(op['event']), op['type']))
        elif kind == 'clear':
            self.call(0x103832c0, manager, struct.pack('<2I', a[op['sender']], n(op['event'])))
        elif kind == 'destroyActor':
            self.call(0x10382760, manager, struct.pack('<I', a[op['actor']]))
        elif kind == 'process':
            self.call(0x10384080, manager, b'')
        elif kind == 'cleanup':
            self.call(0x10383d80, manager, b'')
        elif kind == 'tick':
            self.call(0x103828f0, manager, struct.pack('<f', op.get('delta', 0.0166667)))
        elif kind == 'canHear':
            result = self.call_float(0x103c7680, a[op['pawn']], struct.pack('<Iff', a[op['other']], op['volume'], op['radius']))
            self.log.append({'kind': 'canHearResult', 'result': bits(result)})
        elif kind == 'qsortCompare':
            # the comparator against a Python ordering: slots hold pointers to events with holdScores
            events = [self.alloc(0x100) for _ in op['scores']]
            for event, score in zip(events, op['scores']):
                self.write(event + 0x38, 'f', score)
            table = self.alloc(4 * len(events))
            self.cpu.mem_write(table, struct.pack(f'<{len(events)}I', *events))
            out = []
            for i in range(len(events)):
                for j in range(len(events)):
                    value = self.call(0x10382420, 0, struct.pack('<2I', table + 4 * i, table + 4 * j))
                    out.append((value if value < 0x80000000 else value - (1 << 32)))
            self.log.append({'kind': 'compare', 'matrix': out})
        else:
            raise ValueError(kind)

    def call_float(self, address, this, args):
        """Call and read the float32 the function leaves in ST0 (the oracle's `fst` bridge)."""
        bridge = self.alloc(64)
        code = b''.join(b'\x68' + args[i:i + 4] for i in range(len(args) - 4, -1, -4))
        code += b'\xb8' + struct.pack('<I', address) + b'\xff\xd0' + b'\xd9\x1d' + struct.pack('<I', self.scratch) + b'\xc3'
        self.cpu.mem_write(bridge, code)
        self.cpu.ctl_remove_cache(bridge, bridge + 64)
        self.call(bridge, this, b'')
        return self.read(self.scratch, 'f')[0]

    def run(self, case):
        for name in case['actors']:
            self.make_actor(name)
        for name, spec in case['actors'].items():
            self.set_actor(name, {**self.DEFAULTS, **spec})
        self.log = []
        out = []
        for op in case['ops']:
            self.log = []
            self.op(op)
            row = {'op': op, 'log': self.log}
            if op['op'] not in ('canHear', 'qsortCompare', 'set', 'policy', 'time') or op.get('snapshot'):
                row['snapshot'] = self.snapshot()
            out.append(row)
        return {'name': case['name'], 'ops': out}


if __name__ == '__main__':
    results = []
    for case in json.load(sys.stdin):
        results.append(Probe(Path(sys.argv[1])).run(case))
    print(json.dumps({'cases': results, 'names': None}))
