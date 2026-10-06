"""Execute original ADecal construction, AttachDecal and DetachDecal.

Two modes, chosen by the stdin JSON:

* A JSON array (validate-decal-startup.mjs): the constructor, the AttachDecal
  gates and the empty DetachDecal. Argument evaluation and warning output are
  explicit host services. Positive attachment cases stop at 0x103e7357, after
  the MultiDecalLevel clamp; they are not successful AttachDecal runs.

* A JSON object {"mode": "attach", "modelPath": ..., "scenarios": [...]}: the
  unchanged original execAttachDecal (0x103e7250) and execDetachDecal
  (0x103e9a30) end to end on a real map's compiled UModel (exported by
  scripts/decal-model-export.mjs). Each scenario is a sequence of attach/
  detach operations on decal actors sharing one model, so surface Decals
  ordering (texture grouping) and removal are observable. After each operation
  the result word, SurfList, the exit gate, the footprint grid cells and every
  surface's FBspSurf.Decals (Vertices as f32 bits, Actor, Nodes,
  MoverRotation) are reported. Contract: docs/decals.md.

  Everything between the two entry points is original Engine/Core code:
  UModel::LineCheck, the FCoords/FVector helpers, appSqrt, appFrand, FArray
  growth/insert/remove, UModel::PostLoad (which builds FBspSurf.Nodes) and
  Core's FGlobalMath constructor (sine table). Host services, each recorded:
  msvcrt rand (the case's integers; appFrand's own fild/fmul runs), msvcrt
  memmove, GMalloc Malloc/Realloc/Free (a bump heap; contents copied, pointer
  values are not observable outputs), the Step evaluator for the two script
  arguments, FOutputDevice::Logf and AActor::SetBase (recorded, not run; only
  reachable when a hit surface's Actor IsA Mover, which no shipped level BSP
  surface is). appFailAssert traps. Fixture objects (model header, surfaces,
  actors, level, engine, client, textures) live in a region where every read
  of a byte the fixture did not supply, or the native code did not write,
  traps; reads near address zero trap. The FPU control word is per operation
  (default 0x037f, the value other game-thread oracles use; the live game
  thread value is an open question, so 0x027f/0x007f can be requested).
"""
import importlib.util
import json
from collections import deque
from pathlib import Path
import struct
import sys
from unicorn import UC_HOOK_BLOCK, UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE
from unicorn.x86_const import (UC_X86_REG_EAX, UC_X86_REG_EBP, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EIP,
                               UC_X86_REG_ESP, UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG)

spec = importlib.util.spec_from_file_location('native', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class Probe(native.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.actor = self.alloc(0x340)
        self.level = self.alloc(0x100)
        self.engine = self.alloc(0x100)
        self.client = self.alloc(0x100)
        self.frame = self.alloc(0x30)
        self.code = self.alloc(16)
        self.result = self.alloc(4)
        self.step = self.alloc(16)
        self.warning = self.alloc(16)
        self.cpu.mem_write(self.step, bytes.fromhex('c2 08 00'))
        self.cpu.mem_write(self.warning, b'\xc3')
        table = self.alloc(256 * 4)
        self.write(table + 0x10 * 4, 'I', self.step)
        self.write(0x10599a38, 'I', table)
        self.write(0x10599a68, 'I', self.warning)
        self.events = []
        self.boundary = None

    def on_instruction(self, cpu, address, size, data):
        sp = cpu.reg_read(UC_X86_REG_ESP)
        if address == self.step:
            frame, dst = self.read(sp + 4, '2I')
            index = self.read(frame + 12, 'I')[0] - self.code - 1
            value = self.arguments[index] if index < len(self.arguments) else None
            self.events.append({'op': 'Step', 'index': index, 'provided': value is not None})
            if value is not None:
                self.write(dst, 'f' if index == 0 else '3f', *([value] if index == 0 else value))
            return
        if address == self.warning:
            ptr = self.read(sp + 8, 'I')[0]
            words = []
            while self.read(ptr, 'H')[0]:
                words.append(chr(self.read(ptr, 'H')[0]))
                ptr += 2
            self.events.append({'op': 'Warning', 'format': ''.join(words)})
            return
        if address == 0x103e7357:
            # Clamp has been stored. Stop before any surface attachment work;
            # do not redirect to the native success/return path.
            bp = cpu.reg_read(UC_X86_REG_EBP)
            self.boundary = {'operation': 'AttachDecal.surfaces',
                             'distance': self.read(bp - 0x94, 'f')[0],
                             'direction': self.read(bp - 0x68, '3f')}
            cpu.emu_stop()
            return
        super().on_instruction(cpu, address, size, data)

    def constructor(self):
        before = b'\xa5' * 0x340
        self.cpu.mem_write(self.actor, before)
        self.call(0x10331090, self.actor, b'')
        after = bytes(self.cpu.mem_read(self.actor, 0x340))
        vtable = self.read(self.actor, 'I')[0]
        slots = [0x10, 0x24, 0x38, 0x74]
        return {'vtable': vtable, 'surfaces': self.read(self.actor + 0x320, '3I'),
                'changedOffsets': [i for i in range(len(before)) if before[i] != after[i]],
                'templateWords': self.read(self.actor + 0x318, '2I'),
                'startupSlots': [self.read(vtable + offset, 'I')[0] for offset in slots],
                'actorStartupSlots': [self.read(0x104268dc + offset, 'I')[0] for offset in slots]}

    def run(self, sample):
        self.events, self.boundary = [], None
        self.cpu.mem_write(self.actor, b'\0' * 0x340)
        self.write(self.actor + 0xac, 'I', self.level)
        self.write(self.level + 0x40, 'I', self.engine)
        self.write(self.engine + 0x44, 'I', 0 if sample.get('noClient') else self.client)
        self.write(self.client + 0x4c, 'I', sample.get('decals', 1))
        self.write(self.actor + 0x16c, 'I', 0 if sample.get('noTexture') else 0x1234)
        self.write(self.actor + 0x318, 'i', sample.get('depth', 4))
        self.write(self.result, 'I', 0xa5a5a5a5)
        detach = sample.get('detach', False)
        self.arguments = sample.get('args', [100])
        self.cpu.mem_write(self.code, b'\x16' if detach else b'\x10\x10\x16')
        self.write(self.frame + 8, '2I', self.actor, self.code)
        before = bytes(self.cpu.mem_read(self.actor, 0x340))
        self.write(0, 'I', 0)
        try:
            self.call(0x103e9a30 if detach else 0x103e7250, self.actor,
                      struct.pack('<2I', self.frame, self.result))
        except RuntimeError:
            if self.boundary is None or self.cpu.reg_read(native.UC_X86_REG_EIP) != 0x103e7357:
                raise
        after = bytes(self.cpu.mem_read(self.actor, 0x340))
        return {'name': sample['name'], 'result': self.read(self.result, 'I')[0],
                'depth': self.read(self.actor + 0x318, 'i')[0],
                'changedOffsets': [i for i in range(len(before)) if before[i] != after[i]],
                'codeAdvance': self.read(self.frame + 12, 'I')[0] - self.code,
                'events': self.events, 'boundary': self.boundary}


# --- Full AttachDecal / DetachDecal ---------------------------------------------

EXEC_ATTACH, EXEC_DETACH, ATTACH_RETURN = 0x103e7250, 0x103e9a30, 0x103e7328
UMODEL_VTABLE, UMODEL_POSTLOAD = 0x104265d8, 0x103ace90
GNATIVES_SLOT, LOGF_SLOT = 0x10599a38, 0x10599a68
SETBASE_THUNK = 0x10301285
CLIP_GUARD = 0x1058dae0  # 0x103e9340's function-static FVector[24] guard (bit 0)
MOVER_CLASS, BRUSH_CLASS, ACTOR_CLASS, OBJECT_CLASS = 0x1058bb58, 0x10582a28, 0x1057cdf0, 0x1029e0d0
GMATH, GMATH_CTOR = 0x101b3218, 0x10102978
CORE_GMALLOC, CORE_RAND_IAT, CORE_MEMMOVE_IAT, CORE_FAIL_ASSERT = 0x101a7c44, 0x102ab4fc, 0x102ab4bc, 0x10145b60
TRAP_BASE, TRAP_SIZE = 0x28000000, 0x02000000  # fixture objects, supplied-byte mask
HEAP_BASE, HEAP_SIZE = 0x30000000, 0x04000000  # GMalloc bump heap
SERVICE_BASE = 0x700f0000
SURF, DECAL = 0x40, 0x4c

# Last AttachDecal block before the shared return 0x103e7328 -> gate name.
EXITS = {0x103e72db: 'noClient', 0x103e72fb: 'decalsDisabled', 0x103e7325: 'noTexture',
         0x103e7635: 'traceMiss', 0x103e763d: 'noItem', 0x103e7752: 'noSurface',
         0x103e786b: 'rotationParallel', 0x103e7903: 'offPlane', 0x103e7905: 'offPlane',
         0x103e7916: 'polyFlags'}
# Footprint grid milestones (0x103e7f32..0x103e8902), in execution order.
GRID = {0x103e8130: 'trace', 0x103e8138: 'hit', 0x103e8147: 'item', 0x103e829f: 'surface',
        0x103e846a: 'newSurface', 0x103e8476: 'flagsOk', 0x103e851f: 'attached', 0x103e88aa: 'projected'}


def f32bits(value):
    return struct.unpack('<I', struct.pack('<f', value))[0]


def bitsf32(bits):
    return struct.unpack('<f', struct.pack('<I', bits & 0xffffffff))[0]


class Attach(native.NativeCollision):
    def __init__(self, root):
        super().__init__(Path(root))
        cpu = self.cpu
        cpu.hook_del(self.code_hook)  # narrow hooks only (the base traces every instruction)
        self.blocks = deque(maxlen=32)
        cpu.hook_add(UC_HOOK_BLOCK, lambda uc, a, s, d: self.blocks.append(a))
        cpu.hook_add(UC_HOOK_CODE, self.on_service, begin=0x70000000, end=0x700fffff)
        cpu.hook_add(UC_HOOK_CODE, self.on_attach_code, begin=EXEC_ATTACH, end=0x103e898e)
        cpu.hook_add(UC_HOOK_CODE, self.on_trap_code, begin=CORE_FAIL_ASSERT, end=CORE_FAIL_ASSERT)
        cpu.hook_add(UC_HOOK_CODE, self.on_trap_code, begin=SETBASE_THUNK, end=SETBASE_THUNK)
        cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_null, begin=0x10, end=0xffff)
        cpu.mem_map(TRAP_BASE, TRAP_SIZE)
        cpu.mem_map(HEAP_BASE, HEAP_SIZE)
        self.supplied = bytearray(TRAP_SIZE)
        self.trap_free = TRAP_BASE
        self.heap_free = HEAP_BASE
        self.blocks_size = {}
        cpu.hook_add(UC_HOOK_MEM_READ, self.on_trap_read, begin=TRAP_BASE, end=TRAP_BASE + TRAP_SIZE - 1)
        cpu.hook_add(UC_HOOK_MEM_WRITE, self.on_trap_write, begin=TRAP_BASE, end=TRAP_BASE + TRAP_SIZE - 1)
        self.services, self.next_service = {}, SERVICE_BASE
        step = self.service('Step', b'\xc2\x08\x00')
        table = self.alloc(256 * 4)
        self.write(table + 0x10 * 4, 'I', step)
        self.write(GNATIVES_SLOT, 'I', table)
        self.write(LOGF_SLOT, 'I', self.service('Logf', b'\xc3'))
        # Core's msvcrt imports used on these paths: rand (appFrand), memmove (appMemmove).
        self.services[self.read(CORE_RAND_IAT, 'I')[0]] = 'rand'
        self.services[self.read(CORE_MEMMOVE_IAT, 'I')[0]] = 'memmove'
        allocator, vtable = self.alloc(16), self.alloc(16)
        self.write(vtable, '3I', self.service('GMalloc.Malloc', b'\xc2\x08\x00'),
                   self.service('GMalloc.Realloc', b'\xc2\x0c\x00'), self.service('GMalloc.Free', b'\xc2\x04\x00'))
        self.write(allocator, 'I', vtable)
        self.write(CORE_GMALLOC, 'I', allocator)
        # The static-class SuperField chain the inline IsA(AMover) walks
        # (registration-time links; the DLL static constructors do not run here).
        self.write(MOVER_CLASS + 0x28, 'I', BRUSH_CLASS)
        self.write(BRUSH_CLASS + 0x28, 'I', ACTOR_CLASS)
        self.write(ACTOR_CLASS + 0x28, 'I', OBJECT_CLASS)
        self.write(OBJECT_CLASS + 0x28, 'I', 0)
        # 0x103e9340's static clip buffer: guard set as after its first
        # construction. FVector's default constructor (Core 0x10117670) stores
        # nothing; only the process-exit registration (msvcrt _onexit) is skipped.
        self.write(CLIP_GUARD, 'B', self.read(CLIP_GUARD, 'B')[0] | 1)
        self.call_native(GMATH_CTOR, GMATH, b'', 0x037f)
        self.events, self.rand_queue, self.trap_names = [], [], []
        self.read_log = None  # set() to record fixture reads (research aid)

    # -- plumbing ------------------------------------------------------------
    def service(self, name, body):
        address = self.next_service
        self.next_service += 0x10
        self.cpu.mem_write(address, body)
        self.services[address] = name
        return address

    def trap_alloc(self, size, name):
        address = (self.trap_free + 15) & ~15
        self.trap_free = address + size
        if self.trap_free > TRAP_BASE + TRAP_SIZE:
            raise MemoryError('decal oracle fixture region exhausted')
        self.trap_names.append((address, size, name))
        return address

    def supply(self, address, fmt, *values):
        self.write(address, fmt, *values)
        size = struct.calcsize('<' + fmt)
        if TRAP_BASE <= address < TRAP_BASE + TRAP_SIZE:
            self.supplied[address - TRAP_BASE:address - TRAP_BASE + size] = b'\1' * size

    def supply_bytes(self, address, data):
        self.cpu.mem_write(address, data)
        self.supplied[address - TRAP_BASE:address - TRAP_BASE + len(data)] = b'\1' * len(data)

    def describe(self, address):
        for start, size, name in self.trap_names:
            if start <= address < start + size:
                return f'{name}+{address - start:#x}'
        return hex(address)

    def on_trap_read(self, cpu, access, address, size, value, data):
        offset = address - TRAP_BASE
        if self.read_log is not None:
            self.read_log.add((address, size, cpu.reg_read(UC_X86_REG_EIP)))
        if not all(self.supplied[offset:offset + size]):
            raise RuntimeError(f'Unsupplied fixture read {self.describe(address)} ({size} bytes) from '
                               f'{cpu.reg_read(UC_X86_REG_EIP):#x}; blocks {[hex(b) for b in self.blocks][-8:]}')

    def on_trap_write(self, cpu, access, address, size, value, data):
        offset = address - TRAP_BASE
        self.supplied[offset:offset + size] = b'\1' * size

    def on_null(self, cpu, access, address, size, value, data):
        raise RuntimeError(f'Null-object access at {address:#x} from {cpu.reg_read(UC_X86_REG_EIP):#x}; '
                           f'blocks {[hex(b) for b in self.blocks][-8:]}')

    def on_trap_code(self, cpu, address, size, data):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        if address == SETBASE_THUNK:
            # AActor::SetBase(NewBase, bNotifyActor), thiscall: recorded host
            # boundary (actor graph), returns without running the body.
            base, notify = self.read(esp + 4, '2I')
            self.events.append({'op': 'SetBase', 'actor': self.actor_ids.get(cpu.reg_read(UC_X86_REG_ECX)),
                                'newBase': self.actor_ids.get(base, base), 'notify': notify})
            cpu.reg_write(UC_X86_REG_ESP, esp + 12)
            cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
            return
        expression, file, line = self.read(esp + 4, '3I')
        text = lambda p: bytes(self.cpu.mem_read(p, 128)).split(b'\0')[0].decode('latin1')
        raise RuntimeError(f'appFailAssert {text(expression)} {text(file)}:{line}')

    def on_service(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        name = self.services.get(address)
        if name is None:
            if address in self.thunks:
                raise RuntimeError(f'Unresolved import {self.thunks[address]}; blocks {[hex(b) for b in self.blocks][-8:]}')
            return
        esp = cpu.reg_read(UC_X86_REG_ESP)
        if name == 'Step':
            frame, dst = self.read(esp + 4, '2I')
            index = self.read(frame + 12, 'I')[0] - self.code - 1
            value = self.arguments[index] if index < len(self.arguments) else None
            self.events.append({'op': 'Step', 'index': index, 'provided': value is not None})
            if value is not None:
                if index == 0:
                    self.write(dst, 'I', value)
                else:
                    self.write(dst, '3I', *value)
        elif name == 'Logf':
            pointer = self.read(esp + 8, 'I')[0]
            words = []
            while self.read(pointer, 'H')[0]:
                words.append(chr(self.read(pointer, 'H')[0]))
                pointer += 2
            self.events.append({'op': 'Warning', 'format': ''.join(words)})
        elif name == 'rand':
            if not self.rand_queue:
                raise RuntimeError('msvcrt rand: the case supplied too few values')
            value = self.rand_queue.pop(0)
            self.rand_used.append(value)
            cpu.reg_write(UC_X86_REG_EAX, value)
            cpu.reg_write(UC_X86_REG_ESP, esp + 4)
            cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
        elif name == 'memmove':
            dst, src, count = self.read(esp + 4, '3I')
            if count:
                self.cpu.mem_write(dst, bytes(self.cpu.mem_read(src, count)))
            cpu.reg_write(UC_X86_REG_EAX, dst)
            cpu.reg_write(UC_X86_REG_ESP, esp + 4)
            cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
        elif name == 'GMalloc.Realloc':
            old, count, _tag = self.read(esp + 4, '3I')
            result = 0
            if count:
                result = (self.heap_free + 15) & ~15
                self.heap_free = result + count
                if self.heap_free > HEAP_BASE + HEAP_SIZE:
                    raise MemoryError('decal oracle GMalloc heap exhausted')
                if old:
                    keep = min(count, self.blocks_size[old])
                    self.cpu.mem_write(result, bytes(self.cpu.mem_read(old, keep)))
                self.blocks_size[result] = count
            self.realloc_count += 1
            cpu.reg_write(UC_X86_REG_EAX, result)
        elif name == 'GMalloc.Free':
            pass
        else:
            raise RuntimeError(f'Unexpected service {name}')

    def on_attach_code(self, cpu, address, size, data):
        if address == ATTACH_RETURN:
            # The block that branched (or fell through) to the shared return.
            previous = self.blocks[-2] if self.blocks[-1] == ATTACH_RETURN else self.blocks[-1]
            self.exit = EXITS.get(previous, hex(previous))
            return
        if address == 0x103e7f5e:
            bp = cpu.reg_read(UC_X86_REG_EBP)
            self.grid.append({'i': self.read(bp - 0x80, 'i')[0], 'j': self.read(bp - 0x38, 'i')[0], 'reached': []})
            return
        milestone = GRID.get(address)
        if milestone is None or not self.grid:
            return
        bp = cpu.reg_read(UC_X86_REG_EBP)
        cell = self.grid[-1]
        cell['reached'].append(milestone)
        if milestone == 'trace':
            cell['lineCheck'] = cpu.reg_read(UC_X86_REG_EAX)
        elif milestone == 'item':
            cell['item'] = self.read(bp - 0x198, 'i')[0]
        elif milestone == 'surface':
            cell['surface'] = cpu.reg_read(UC_X86_REG_EDX)
        elif milestone == 'attached':
            cell['cosBits'] = self.read(bp - 0x34, 'I')[0]

    def call_native(self, address, this, args, control_word, count=50_000_000):
        esp = self.stack - 0x100
        self.write(esp, 'I', self.done)
        self.cpu.mem_write(esp + 4, args)
        for reg, value in [(UC_X86_REG_ESP, esp), (UC_X86_REG_ECX, this), (UC_X86_REG_FPCW, control_word),
                           (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.cpu.emu_start(address, self.done + 1, count=count)
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise RuntimeError(f'Native call {address:#x} did not return')
        return self.cpu.reg_read(UC_X86_REG_EAX)

    # -- fixtures --------------------------------------------------------------
    def load_model(self, model, overrides, flag_overrides=None):
        nodes, surfs = model['nodes'], model['surfs']
        self.num_surfs = len(surfs)
        m = self.model = self.trap_alloc(0x100, 'UModel')
        self.supply(m, 'I', UMODEL_VTABLE)
        self.supply(m + 0x1c, 'I', 0)  # ObjectFlags (UObject::PostLoad ORs RF_DebugPostLoad)
        node_data = self.trap_alloc(64 * len(nodes), 'Nodes')
        raw = bytearray(64 * len(nodes))
        for i, node in enumerate(nodes):
            struct.pack_into('<4I2I7i4B2i', raw, 64 * i, *node['planeBits'], *node['zoneMask'], node['vertexPool'],
                             node['surface'], node['back'], node['front'], node['coplanar'], node['collisionBound'],
                             node['renderBound'], *node['zones'], node['vertexCount'], node['flags'], *node['leaves'])
        self.supply_bytes(node_data, bytes(raw))
        self.node_data = node_data

        def array(offset, name, stride, packed, count):
            data = self.trap_alloc(max(16, stride * count), name)
            if packed:
                self.supply_bytes(data, packed)
            self.supply(m + offset, '3I', data, count, count)
            return data
        self.supply(m + 0x58, '3I', node_data, len(nodes), len(nodes))
        array(0x68, 'Verts', 8, struct.pack(f'<{2 * len(model["verts"])}i', *[v for p in model['verts'] for v in p]), len(model['verts']))
        array(0x78, 'Vectors', 12, struct.pack(f'<{3 * len(model["vectorBits"])}I', *[v for p in model['vectorBits'] for v in p]), len(model['vectorBits']))
        array(0x88, 'Points', 12, struct.pack(f'<{3 * len(model["pointBits"])}I', *[v for p in model['pointBits'] for v in p]), len(model['pointBits']))
        array(0xcc, 'LeafHulls', 4, struct.pack(f'<{len(model["leafHulls"])}i', *model['leafHulls']), len(model['leafHulls']))
        self.supply(m + 0xf0, 'i', model['rootOutside'])
        surf_data = self.surf_data = self.trap_alloc(SURF * len(surfs), 'Surfs')
        self.supply(m + 0x98, '3I', surf_data, len(surfs), len(surfs))
        # Surface actors: shipped level BSP surfaces are all Brush actors. A
        # scenario may override a surface's actor (e.g. a Mover with a Rotation).
        brush = self.trap_alloc(0x200, 'Brush')
        self.supply(brush + 0x24, 'I', BRUSH_CLASS)
        movers = {}
        for key, spec in overrides.items():
            actor = self.trap_alloc(0x200, f'SurfActor{key}')
            self.supply(actor + 0x24, 'I', {'Mover': MOVER_CLASS, 'Brush': BRUSH_CLASS}[spec['class']])
            if 'rotation' in spec:
                self.supply(actor + 0x120, '3i', *spec['rotation'])
            movers[int(key)] = actor
        self.surface_actors = movers
        for i, surf in enumerate(surfs):
            p = surf_data + SURF * i
            actor = movers.get(i, brush if surf['brushActor'] else 0)
            flags = (flag_overrides or {}).get(str(i), surf['flags'])  # synthetic PolyFlags override
            self.supply(p + 4, 'IiI', flags, surf['base'], surf['normal'])
            self.supply(p + 0x24, 'I', actor)
            self.supply(p + 0x28, '6I', 0, 0, 0, 0, 0, 0)  # Decals and Nodes empty, as after load
        # FBspSurf.Nodes is not serialized; UModel::PostLoad (0x103ace90) adds
        # every node index to its surface's list. Run it unchanged.
        self.call_native(UMODEL_POSTLOAD, m, b'', 0x037f)
        # The level objects AttachDecal follows.
        self.level_info = self.trap_alloc(0x400, 'LevelInfo')
        self.xlevel = self.trap_alloc(0x100, 'XLevel')
        self.engine = self.trap_alloc(0x100, 'Engine')
        self.client = self.trap_alloc(0x100, 'Client')
        self.supply(self.level_info + 0xac, 'I', self.xlevel)
        self.supply(self.xlevel + 0x40, 'I', self.engine)
        self.supply(self.xlevel + 0x98, 'I', m)
        self.supply(self.engine + 0x44, 'I', self.client)
        self.supply(self.client + 0x4c, 'I', 1)
        self.frame = self.alloc(0x30)
        self.code = self.alloc(16)
        self.result_word = self.alloc(4)

    def texture(self, spec):
        key = spec['name']
        if key not in self.textures:
            t = self.trap_alloc(0x100, f'Texture:{key}')
            self.supply(t + 0x34, 'i', spec['USize'])
            self.textures[key] = t
        return self.textures[key]

    def make_actor(self, ident, spec):
        a = self.trap_alloc(0x340, f'Decal:{ident}')
        self.supply(a + 0xa8, 'I', self.level_info)
        self.supply(a + 0xac, 'I', self.xlevel)
        self.supply(a + 0x320, '3I', 0, 0, 0)
        if 'owner' in spec:
            # An actor id, or 'surface:N' for a scenario's surface actor override.
            owner = spec['owner']
            if isinstance(owner, str) and owner.startswith('surface:'):
                pointer = self.surface_actors[int(owner[8:])]
                self.actor_ids[pointer] = owner
            else:
                pointer = self.actor_ids_rev.get(owner, 0)
            self.supply(a + 0x3c, 'I', pointer)
        self.actors[ident] = a
        self.actor_ids[a] = ident
        self.actor_ids_rev[ident] = a
        return a

    def set_actor_fields(self, a, spec):
        loc = spec.get('locationBits') or [f32bits(v) for v in spec['location']]
        self.supply(a + 0x114, '3I', *loc)
        self.supply(a + 0x120, '3i', *spec['rotation'])
        self.supply(a + 0x16c, 'I', self.texture(spec['texture']) if spec.get('texture') else 0)
        self.supply(a + 0x17c, 'I', spec.get('drawScaleBits', f32bits(spec.get('drawScale', 1.0))))
        self.supply(a + 0x318, 'i', spec.get('multiDecalLevel', 4))

    def line_check(self, start, end, extra_node_flags=0):
        """UModel::LineCheck through the model's vtable (case generation aid):
        returns None for no hit, else the FCheckResult location, normal, time
        and node Item as f32 bits / ints."""
        hit = self.alloc(0x30)
        self.write(hit, '2I3f3fIfi', 0, 0, 0, 0, 0, 0, 0, 0, 0, 1.0, -1)
        clear = self.call_native(self.read(UMODEL_VTABLE + 0x58, 'I')[0], self.model,
                                 struct.pack('<II9II', hit, 0, *end, *start, 0, 0, 0, extra_node_flags), 0x037f)
        if clear:
            return None
        return {'locationBits': list(self.read(hit + 8, '3I')), 'normalBits': list(self.read(hit + 0x14, '3I')),
                'time': self.read(hit + 0x24, 'f')[0], 'item': self.read(hit + 0x28, 'i')[0]}

    # -- reading results ---------------------------------------------------------
    def decals_of(self, i_surf):
        data, num = self.read(self.surf_data + SURF * i_surf + 0x28, '2I')
        entries = []
        for k in range(num):
            e = data + DECAL * k
            verts = list(self.read(e, '12I'))
            actor, nodes_data, nodes_num = self.read(e + 0x30, '3I')[0], *self.read(e + 0x34, '2I')
            entries.append({'actor': self.actor_ids.get(actor, actor),
                            'verticesBits': [verts[3 * v:3 * v + 3] for v in range(4)],
                            'vertices': [[bitsf32(x) for x in verts[3 * v:3 * v + 3]] for v in range(4)],
                            'nodes': list(self.read(nodes_data, f'{nodes_num}i')) if nodes_num else [],
                            'moverRotation': list(self.read(e + 0x40, '3i'))})
        return entries

    def all_decals(self):
        raw = bytes(self.cpu.mem_read(self.surf_data, SURF * self.num_surfs))
        out = {}
        for i in range(self.num_surfs):
            if struct.unpack_from('<I', raw, SURF * i + 0x2c)[0]:
                out[i] = self.decals_of(i)
        return out

    def surf_list(self, a):
        data, num = self.read(a + 0x320, '2I')
        return list(self.read(data, f'{num}i')) if num else []

    def run_op(self, op):
        ident = op['actor']
        a = self.actors.get(ident) or self.make_actor(ident, op)
        self.events, self.grid, self.exit = [], [], None
        self.rand_queue, self.rand_used, self.realloc_count = list(op.get('rand', [])), [], 0
        detach = op['op'] == 'detach'
        if not detach:
            self.set_actor_fields(a, op)
            args = op.get('args', [100])
            self.arguments = [f32bits(args[0])] + ([[f32bits(v) for v in args[1]]] if len(args) > 1 else [])
            self.cpu.mem_write(self.code, b'\x10\x10\x16')
        else:
            self.arguments = []
            self.cpu.mem_write(self.code, b'\x16')
        self.write(self.frame + 8, '2I', a, self.code)
        self.write(self.result_word, 'I', 0xa5a5a5a5)
        before = self.surf_list(a)
        self.write(0, 'I', 0)
        self.call_native(EXEC_DETACH if detach else EXEC_ATTACH, a, struct.pack('<2I', self.frame, self.result_word),
                         op.get('controlWord', 0x037f))
        result = {'op': op['op'], 'actor': ident, 'controlWord': op.get('controlWord', 0x037f),
                  'surfListBefore': before, 'surfList': self.surf_list(a),
                  'multiDecalLevel': self.read(a + 0x318, 'i')[0],
                  'codeAdvance': self.read(self.frame + 12, 'I')[0] - self.code,
                  'events': self.events, 'reallocs': self.realloc_count}
        if not detach:
            result.update({'result': self.read(self.result_word, 'I')[0], 'exit': self.exit or 'attached',
                           'rand': self.rand_used, 'randLeft': len(self.rand_queue), 'grid': self.grid})
        result['decals'] = {str(k): v for k, v in self.all_decals().items()}
        return result

    def run_scenario(self, scenario, model):
        self.trap_free, self.heap_free, self.blocks_size = TRAP_BASE, HEAP_BASE, {}
        self.supplied[:] = bytes(TRAP_SIZE)
        self.cpu.mem_write(TRAP_BASE, bytes(TRAP_SIZE))
        self.trap_names, self.textures, self.actors = [], {}, {}
        self.actor_ids, self.actor_ids_rev = {}, {}
        self.realloc_count = 0
        self.load_model(model, scenario.get('surfaceActors', {}), scenario.get('surfaceFlags'))
        for ident, spec in scenario.get('actors', {}).items():
            self.make_actor(ident, spec)
        return {'name': scenario.get('name'), 'ops': [self.run_op(op) for op in scenario['ops']]}


def attach_main(request):
    model = json.loads(Path(request['modelPath']).read_text())['model']
    oracle = Attach(request['gameRoot'])
    out = []
    for scenario in request['scenarios']:
        try:
            out.append(oracle.run_scenario(scenario, model))
        except RuntimeError as error:
            out.append({'name': scenario.get('name'), 'error': str(error)})
    return {'hashes': native.HASHES, 'scenarios': out}


if __name__ == '__main__':
    request = json.load(sys.stdin)
    if isinstance(request, dict) and request.get('mode') == 'attach':
        request.setdefault('gameRoot', sys.argv[1] if len(sys.argv) > 1 else None)
        json.dump(attach_main(request), sys.stdout, separators=(',', ':'))
        print()
    else:
        probe = Probe(Path(sys.argv[1]))
        constructor = probe.constructor()
        print(json.dumps({'hashes': native.HASHES, 'constructor': constructor,
                          'cases': [probe.run(case) for case in request]}))
