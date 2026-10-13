"""Execute recovered APawn latent-locomotion natives in an isolated x86 emulator.

The five setup bodies (MoveTo 500, MoveToward 502, TurnTo 508, TurnToward 510,
WaitForLanding 527) install a StateFrame latent code and seed the pawn movement
fields; the paired polls (501, 503, 509, 511, 528) run each tick and clear the
latent code when the recovered completion predicate holds.  Three shared helpers
sit behind Engine thunks: turn setup 0x103be980 (0x10303aa3), move/arrive setup
0x103be200 (0x103024fa), and the move timer 0x103be160 (0x10301226).

FVector::Rotation (Core 0x10144390) is the single fpatan path in these bodies.
Unicorn's softfloat computes fpatan in host double precision and is not
authoritative for it, so the probe intercepts the body and substitutes values
measured on real x87 silicon (tools/pawn-rotation-probe.c under CrossOver).  A
vector with no probed row raises RotationOracleMiss instead of falling back to
the emulator.  Every other instruction — FADD/FMUL/FCOMPP vector math, the GMath
sine-table FCoords constructor, SafeNormal, appSqrt — executes the real DLL
bytes under Unicorn.

Input: a JSON scene on argv[1].  Output: JSON field/event capture on stdout.
Optional research tool; inputs and results stay local.
"""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

try:
    from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE, UC_HOOK_MEM_INVALID
    from unicorn.x86_const import (
        UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EIP, UC_X86_REG_ESP,
        UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG,
    )
except ImportError:
    sys.exit('Install unicorn==2.1.4 in a virtualenv and set NATIVE_PROBE_PYTHON to its Python executable.')

HASHES = {
    'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
    'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
    'MSVCRT.dll': 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
}

# Recovered entry points (Engine.dll image base 0x10300000).
BODIES = {
    'WaitForLanding': 0x103bb6f0, 'pollWaitForLanding': 0x103bb730,
    'MoveTo': 0x103bceb0,         'pollMoveTo': 0x103bd060,
    'MoveToward': 0x103bd150,     'pollMoveToward': 0x103bd370,
    'TurnToward': 0x103bdbf0,     'pollTurnToward': 0x103bdd60,
    'TurnTo': 0x103bdec0,         'pollTurnTo': 0x103be020,
    'StrafeTo': 0x103bd5f0,       'pollStrafeTo': 0x103bd7d0,
    'StrafeFacing': 0x103bd8c0,   'pollStrafeFacing': 0x103bdad0,
}

# Fixed original globals.
ROTATION_BODY = 0x10144390       # Core FVector::Rotation — intercepted (fpatan).
FIND_FUNCTION = 0x1010263f       # Core FindFunctionChecked thunk — patched stub.
FAIL_ASSERT = 0x10102c70         # appFailAssert IAT target — intercepted, must not fire.
GNATIVES = 0x101f41b8            # Core GNatives array base (.bss, fabricated).
SINE_TABLE = 0x101b32a4          # Core GMath sine table (.bss, populated here).
PAWN_CLASS = 0x1058c660          # Engine APawn PrivateStaticClass object.
INVENTORY_CLASS = 0x10576f70     # Engine AInventory PrivateStaticClass object.
NAME_LONG_FALL = 0x10583664      # .bss FName caches read by the bodies.
NAME_TOUCH = 0x10583704
NAME_ALTER_DESTINATION = 0x105835c8   # built from the string "AlterDestination" (0x1047d00c) at 0x103806d2..0x103806e0

# Harness mailbox (dedicated page below the 0x20000000 arena).
MAIL_FFC_COUNT = 0x1ff00000
MAIL_FFC_NAMES = 0x1ff00010
MAIL_EVT_COUNT = 0x1ff00800
MAIL_EVT_LIST = 0x1ff00810

# Expression tokens consumed by the setup bodies through GNatives[token].
TOK_NOTHING = 0x0b # EX_Nothing — a skipped optional argument; consumes itself
TOK_FLOAT = 0x1e   # EX_FloatConst — operand: 4-byte float32
TOK_OBJECT = 0x20  # EX_ObjectConst — operand: harness 4-byte object address
TOK_VECTOR = 0x23  # EX_VectorConst — operand: three float32
TOK_END = 0x16     # EX_EndFunctionParms — consumed by the body's own Code++


def u32(v):
    return v & 0xffffffff


def f32bits(v):
    return struct.unpack('<I', struct.pack('<f', v))[0]


def dword_stub(loads):
    """GNatives evaluator stub: [esp+4]=frame, [esp+8]=out; copies `loads`
    dwords from *frame.Code to out and advances Code past the operand.
    Only caller-saved eax/ecx/edx are free; esi is preserved explicitly."""
    parts = ['56',                    # push esi
             '8b442408',              # mov eax,[esp+8]   = frame
             '8b500c',                # mov edx,[eax+0xc] = Code
             '8b4c240c']              # mov ecx,[esp+0xc] = out
    for i in range(loads):
        parts.append('8b32' if i == 0 else f'8b72{i * 4:02x}')   # mov esi,[edx+i*4]
        parts.append('8931' if i == 0 else f'8971{i * 4:02x}')   # mov [ecx+i*4],esi
    parts.append('83400c' + f'{loads * 4:02x}')                  # add [eax+0xc],N*4
    parts.append('5e')                    # pop esi
    parts.append('c20800')                # ret 8
    return bytes.fromhex(''.join(parts))


def hx(*parts):
    return bytes.fromhex(''.join(parts))


# UObject::ProcessEvent record stub: ecx=this, [esp+4]=fn, [esp+8]=parms,
# [esp+0xc]=extra; appends {this,fn,parms,extra} to the mailbox; ret 0xc.
# Record layout is five dwords: this, fn, parms, extra, *parms (0 when the
# parms pointer is null — the bodies only ever pass null or a valid stack
# slot, so the dereference is safe).
PROCESS_EVENT_STUB = hx(
    '50', '53', '51',
    '8b1d', struct.pack('<I', MAIL_EVT_COUNT).hex(),          # mov ebx,[count]
    '6bdb14',                                                 # imul ebx,ebx,20
    '81c3', struct.pack('<I', MAIL_EVT_LIST).hex(),           # add ebx,list
    '890b',                                                   # mov [ebx],ecx
    '8b442410', '894304',                                     # fn
    '8b442414', '894308',                                     # parms
    '8b442418', '89430c',                                     # extra
    '8b442414',                                               # mov eax,[esp+0x14] = parms
    '85c0',                                                   # test eax,eax
    '7402',                                                   # je +2
    '8b00',                                                   # mov eax,[eax]
    '894310',                                                 # mov [ebx+0x10],eax
    'ff05', struct.pack('<I', MAIL_EVT_COUNT).hex(),          # inc [count]
    '59', '5b', '58',
    '33c0',
    'c20c00')

# FindFunctionChecked patch at the real thunk VA: ecx=this, [esp+4]=FName,
# [esp+8]=unused.  Records the name dword and returns name|0x60000000 as a
# recognizable fake UFunction pointer; ret 8 like the real body.
FIND_FUNCTION_STUB = hx(
    '53',                                                     # push ebx (callee-saved)
    '8b442408',                                               # mov eax,[esp+8]  = name
    '8b1d', struct.pack('<I', MAIL_FFC_COUNT).hex(),          # mov ebx,[count]
    '89049d', struct.pack('<I', MAIL_FFC_NAMES).hex(),        # mov [ebx*4+names],eax
    'ff05', struct.pack('<I', MAIL_FFC_COUNT).hex(),          # inc [count]
    '0d00000060',                                             # or eax,0x60000000
    '5b',                                                     # pop ebx
    'c20800')

# UClass::GetPropertiesSize stand-in on fabricated class vtables (slot 0x64):
# returns the object's +0x4d8 field so the 0x103be2a4 assert compares equal.
PROPSIZE_STUB = hx('8b81d8040000', 'c3')                      # mov eax,[ecx+0x4d8]; ret


class ProbeError(RuntimeError):
    pass


class RotationOracleMiss(ProbeError):
    pass


class Image:
    def __init__(self, path, expected_hash=None):
        self.data = path.read_bytes()
        if hashlib.sha256(self.data).hexdigest() != (expected_hash or HASHES[path.name]):
            raise ValueError(f'Unsupported original binary hash: {path.name}')
        pe = struct.unpack_from('<I', self.data, 60)[0]
        opt = pe + 24
        self.base = struct.unpack_from('<I', self.data, opt + 28)[0]
        self.size = struct.unpack_from('<I', self.data, opt + 56)[0]
        self.directories = [struct.unpack_from('<II', self.data, opt + 96 + i * 8) for i in range(16)]
        section = opt + struct.unpack_from('<H', self.data, pe + 20)[0]
        count = struct.unpack_from('<H', self.data, pe + 6)[0]
        self.sections = [struct.unpack_from('<8sIIII', self.data, section + i * 40) for i in range(count)]

    def offset(self, rva):
        for _, virtual_size, virtual, raw_size, raw in self.sections:
            if virtual <= rva < virtual + max(virtual_size, raw_size):
                return raw + rva - virtual
        return rva

    def read(self, rva, fmt):
        return struct.unpack_from('<' + fmt, self.data, self.offset(rva))

    def string(self, rva):
        offset = self.offset(rva)
        return self.data[offset:self.data.index(0, offset)].decode('ascii')

    def export_map(self):
        table = self.directories[0][0]
        count, functions, names, ordinals = self.read(table + 24, 'IIII')
        return {
            self.string(self.read(names + i * 4, 'I')[0]):
            self.base + self.read(functions + self.read(ordinals + i * 2, 'H')[0] * 4, 'I')[0]
            for i in range(count)
        }

    def imports(self):
        descriptor = self.directories[1][0]
        while True:
            original, _, _, name, iat = self.read(descriptor, 'IIIII')
            if not name:
                return
            index = 0
            while True:
                entry = self.read((original or iat) + index * 4, 'I')[0]
                if not entry:
                    break
                symbol = entry & 0xffff if entry & 0x80000000 else self.string(entry + 2)
                yield self.string(name).lower(), symbol, self.base + iat + index * 4
                index += 1
            descriptor += 20


class PawnLatentProbe:
    """Fabricates the pawn/target/zone/class memory image and runs the real
    native bytes.  Scene keys mirror the recovered field offsets; every
    observable write is captured back into the result."""

    def __init__(self, game_root):
        self.cpu = cpu = Uc(UC_ARCH_X86, UC_MODE_32)
        self.thunks = {}
        self.trace = []
        self.images = {name: Image(game_root / 'System' / name) for name in HASHES}
        for image in self.images.values():
            cpu.mem_map(image.base, (image.size + 4095) & ~4095)
            cpu.mem_write(image.base, image.data[:1024])
            for _, _, virtual, size, raw in image.sections:
                if size:
                    cpu.mem_write(image.base + virtual, image.data[raw:raw + size])
        cpu.mem_map(0, 0x10000)               # fs:[0] exception-chain slots
        cpu.mem_map(0x1ff00000, 0x2000)
        cpu.mem_map(0x20000000, 0x4000000)
        self.free = 0x20000000
        self.stack = 0x23ff0000
        self.done = 0x20010000
        exports = {name.lower(): image.export_map() for name, image in self.images.items()}
        thunk = 0x20020000
        for image in self.images.values():
            for dll, symbol, iat in image.imports():
                address = exports.get(dll, {}).get(symbol)
                if address is None:
                    address = thunk
                    thunk += 16
                    self.thunks[address] = (dll, symbol)
                self.write(iat, 'I', address)
                if dll == 'msvcrt.dll' and symbol == '_ftol' and address in self.thunks:
                    # Real MSVCRT _ftol: FISTTP m64 (truncate); keep only the low dword.
                    cpu.mem_write(address, bytes.fromhex('83ec08dd0c24585ac3'))
                    self.thunks.pop(address)
        # Runtime-initialized globals the bodies read.
        gmath = exports['core.dll']['?GMath@@3VFGlobalMath@@A']
        self.write(gmath + 0x18, '12f', 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)
        table = bytes().join(struct.pack('<f', __import__('math').sin(i * 6.283185307179586 / 16384))
                             for i in range(16384))
        cpu.mem_write(SINE_TABLE, table)
        # Expression evaluator stubs behind GNatives.
        self.write(GNATIVES + TOK_VECTOR * 4, 'I', self.deploy(dword_stub(3)))
        self.write(GNATIVES + TOK_FLOAT * 4, 'I', self.deploy(dword_stub(1)))
        self.write(GNATIVES + TOK_OBJECT * 4, 'I', self.deploy(dword_stub(1)))
        # EX_Nothing writes nothing and consumes no operand — the pre-seeded
        # optional-argument slot keeps its 1.0f default.
        self.write(GNATIVES + TOK_NOTHING * 4, 'I', self.deploy(dword_stub(0)))
        # Fake-name sentinels the event path reports through the mailbox.
        self.write(NAME_LONG_FALL, 'I', 0x1f000001)
        self.write(NAME_TOUCH, 'I', 0x1f000002)
        self.write(NAME_ALTER_DESTINATION, 'I', 0x1f000003)
        self.process_event = self.deploy(PROCESS_EVENT_STUB)
        self.prop_size = self.deploy(PROPSIZE_STUB)
        # Patch the FindFunctionChecked thunk in-place so calls through the
        # engine IAT land on the recording stub instead of the real lookup.
        cpu.mem_write(FIND_FUNCTION, FIND_FUNCTION_STUB)
        self.rotation_table = {}
        self.events = []
        self.alter = None
        self.alter_pawn = 0
        cpu.hook_add(UC_HOOK_CODE, self.on_instruction)
        cpu.hook_add(UC_HOOK_MEM_INVALID, self.on_bad_memory)

    def deploy(self, code):
        address = self.alloc(len(code))
        self.cpu.mem_write(address, code)
        return address

    def alloc(self, size):
        address = self.free
        self.free += (size + 15) & ~15
        if self.free >= 0x23000000:
            raise MemoryError('Probe allocation limit exceeded')
        return address

    def write(self, address, fmt, *values):
        self.cpu.mem_write(address, struct.pack('<' + fmt, *values))

    def read(self, address, fmt):
        return struct.unpack('<' + fmt, self.cpu.mem_read(address, struct.calcsize('<' + fmt)))

    def f32(self, address):
        return self.read(address, 'f')[0]

    def on_bad_memory(self, cpu, access, address, size, value, data):
        raise ProbeError(f'Invalid memory {address:x}; trace {self.trace[-12:]}')

    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if address in self.thunks:
            dll, symbol = self.thunks[address]
            raise ProbeError(f'Unresolved import {dll}!{symbol}; trace {self.trace[-12:]}')
        if address == ROTATION_BODY:
            self.intercept_rotation(cpu)
            return
        if address == FAIL_ASSERT:
            raise ProbeError(f'appFailAssert fired; trace {self.trace[-12:]}')
        if address == self.process_event and self.alter is not None:
            # The script event rewrites Destination (ScriptedPawn.AlterDestination does): the caller's helpers read it after.
            fn = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, 'I')[0]
            if (fn & 0x1fffffff) == 0x1f000003:
                for i, v in enumerate(self.alter):
                    self.write(self.alter_pawn + 0x354 + 4 * i, 'f', v)
        self.trace.append(hex(address))
        if len(self.trace) > 24:
            self.trace.pop(0)

    def intercept_rotation(self, cpu):
        vec = cpu.reg_read(UC_X86_REG_ECX)
        out = self.read(cpu.reg_read(UC_X86_REG_ESP) + 4, 'I')[0]
        key = self.cpu.mem_read(vec, 12).hex()
        row = self.rotation_table.get(key)
        if row is None:
            raise RotationOracleMiss(
                f'No hardware-probed FVector::Rotation for {key}; extend the CrossOver table')
        self.write(out, '3i', *row)
        cpu.reg_write(UC_X86_REG_EAX, out)
        esp = cpu.reg_read(UC_X86_REG_ESP)
        cpu.reg_write(UC_X86_REG_EIP, self.read(esp, 'I')[0])
        cpu.reg_write(UC_X86_REG_ESP, esp + 8)

    def vtable(self, extra_slots=()):
        table = self.alloc(0x120)
        self.write(table + 0x10, 'I', self.process_event)
        for slot, target in extra_slots:
            self.write(table + slot, 'I', target)
        return table

    def class_object(self, super_class=0):
        cls = self.alloc(0x600)
        self.write(cls + 0x28, 'I', super_class)
        return cls

    def actor(self, spec, vtable):
        obj = self.alloc(0x800)
        self.write(obj, 'I', vtable)
        self.write(obj + 0x0c, 'I', spec.get('stateFrame', 0))
        spec_cls = spec.get('cls')
        cls = {'pawn': PAWN_CLASS, 'inventory': INVENTORY_CLASS,
               'pawn*': PAWN_CLASS, 'inventory*': INVENTORY_CLASS,
               'actor': 0}.get(spec_cls)
        # A '*' suffix installs a fabricated subclass whose SuperField is the
        # real class object — the body's IsA chain-walk has to traverse it.
        self.write(obj + 0x24, 'I', self.class_object(cls if cls else 0))
        if cls and not str(spec_cls).endswith('*'):
            self.write(obj + 0x24, 'I', cls)
        for key, off in [('physics', 0x30)]:
            if key in spec:
                self.write(obj + off, 'B', spec[key])
        for key, off in [('location', 0x114), ('velocity', 0x144), ('acceleration', 0x150),
                         ('floor', 0x3fc), ('destination', 0x354), ('focus', 0x360)]:
            if key in spec:
                self.write(obj + off, '3f', *spec[key])
        for key, off in [('rotation', 0x120), ('desiredRotation', 0x208)]:
            if key in spec:
                self.write(obj + off, '3i', *spec[key])
        for key, off in [('latentFloat', 0xe0), ('collisionRadius', 0x1d4), ('collisionHeight', 0x1d8),
                         ('rotationRateYaw', None), ('avgPhysicsTime', 0x32c), ('moveTimer', 0x348),
                         ('desiredSpeed', 0x36c), ('maxDesiredSpeed', 0x370), ('meleeRange', 0x374),
                         ('groundSpeed', 0x378), ('waterSpeed', 0x37c), ('airSpeed', 0x380),
                         ('accelRate', 0x384)]:
            if off is not None and key in spec:
                self.write(obj + off, 'f', spec[key])
        if 'rotationRate' in spec:  # rotator at +0x1fc
            self.write(obj + 0x1fc, '3i', *spec['rotationRate'])
        for key, off in [('flags318', 0x318), ('flags31c', 0x31c)]:
            if key in spec:
                self.write(obj + off, 'I', spec[key])
        return obj

    def zone(self, spec):
        """ZoneInfo image: +0x24 class, +0x324 ZoneGravity.z, +0x388 flags."""
        zone = self.alloc(0x400)
        cls = self.alloc(0x600)
        defaults = self.alloc(0x400)
        vt = self.vtable(extra_slots=[(0x64, self.prop_size)])
        self.write(cls, 'I', vt)
        self.write(cls + 0x4d4, 'I', defaults)
        self.write(cls + 0x4d8, 'I', spec.get('propertiesSize', 0x100))
        self.write(defaults + 0x324, 'f', spec.get('defaultGravityZ', -950.0))
        self.write(zone + 0x24, 'I', cls)
        self.write(zone + 0x324, 'f', spec.get('gravityZ', -950.0))
        self.write(zone + 0x388, 'B', spec.get('flags', 0))
        return zone

    def run(self, scene):
        self.rotation_table = scene.get('rotationTable', {})
        # Distinct objects, as in the real process: the FFrame argument carries
        # Code at +0x0c; the pawn's +0x0c StateFrame carries latent at +0x24.
        self.write(MAIL_EVT_COUNT, 'I', 0)
        self.write(MAIL_FFC_COUNT, 'I', 0)
        pawn = self.actor(scene['pawn'], self.vtable())
        self.alter = scene.get('alterDestination')
        self.alter_pawn = pawn
        target = self.actor(scene['target'], self.vtable()) if scene.get('target') else 0
        if 'zone' in scene or 'pawnZone' in scene:
            zone = self.zone(scene.get('pawnZone', scene.get('zone', {})))
            self.write(pawn + 0xc8, 'I', zone)
        if 'zone' in scene and target:
            self.write(target + 0xc8, 'I', self.zone(scene['zone']))
        if 'targetZone' in scene and target:
            self.write(target + 0xc8, 'I', self.zone(scene['targetZone']))
        objects = {'target': target, 'pawn': pawn, 'none': 0}
        stream = []
        for arg in scene.get('args', []):
            if arg['kind'] == 'vector':
                stream.append(TOK_VECTOR)
                stream += struct.pack('<3f', *arg['value'])
            elif arg['kind'] == 'float':
                stream.append(TOK_FLOAT)
                stream += struct.pack('<f', arg['value'])
            elif arg['kind'] == 'object':
                stream.append(TOK_OBJECT)
                stream += struct.pack('<I', objects[arg['value']])
            elif arg['kind'] == 'nothing':
                stream.append(TOK_NOTHING)
            else:
                raise ValueError(f"Unknown arg kind {arg['kind']}")
        code = self.alloc(len(stream) + 16)
        self.cpu.mem_write(code, bytes(stream + [TOK_END, 0, 0, 0]))
        frame = self.alloc(0x40)           # FFrame argument
        state = self.alloc(0x40)           # pawn+0x0c StateFrame
        self.write(frame + 0xc, 'I', code)
        self.write(state + 0x24, 'I', scene.get('latent', 0))
        self.write(pawn + 0x0c, 'I', state)
        pawn_spec = scene.get('pawn', {})
        for key, off in [('moveTarget', 0x34c), ('faceTarget', 0x350)]:
            ref = pawn_spec.get(key, scene.get(key))
            if ref in objects:
                self.write(pawn + off, 'I', objects[ref])
            elif isinstance(ref, int):
                self.write(pawn + off, 'I', ref)
        dt = self.alloc(16)
        self.write(dt, 'f', scene.get('dt', 0.05))
        body = BODIES[scene['body']]
        is_poll = scene['body'].startswith('poll')
        args = [state, dt] if is_poll else [frame, self.alloc(16)]
        for reg, value in [(UC_X86_REG_ESP, self.stack),
                           (UC_X86_REG_FPCW, 0x037f), (UC_X86_REG_FPSW, 0), (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.cpu.reg_write(UC_X86_REG_ECX, pawn)
        self.write(self.stack, 'I', self.done)
        for i, arg in enumerate(args):
            self.write(self.stack + 4 + i * 4, 'I', arg)
        self.cpu.emu_start(body, self.done + 1, count=4000000)
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise ProbeError('Native instruction budget exceeded')
        names = {0x1f000001: 'LongFall', 0x1f000002: 'Touch', 0x1f000003: 'AlterDestination'}
        ffc = [self.read(MAIL_FFC_NAMES + i * 4, 'I')[0]
               for i in range(self.read(MAIL_FFC_COUNT, 'I')[0])]
        events = []
        for i in range(self.read(MAIL_EVT_COUNT, 'I')[0]):
            this, fn, parms, extra, arg0 = self.read(MAIL_EVT_LIST + i * 20, '5I')
            events.append({'this': this, 'name': names.get(fn & 0x1fffffff, hex(fn)),
                           'parms': parms, 'extra': extra, 'arg0': arg0})
        def vec(obj, off):
            raw = self.read(obj + off, '3I')
            return [struct.unpack('<f', struct.pack('<I', w))[0] for w in raw]
        def vecbits(obj, off):
            return ['%08x' % w for w in self.read(obj + off, '3I')]
        def rot(obj, off):
            return list(self.read(obj + off, '3i'))
        def fbits(addr):
            return '%08x' % self.read(addr, 'I')[0]
        result = {
            'returned': self.cpu.reg_read(UC_X86_REG_EAX),
            'latent': self.read(state + 0x24, 'I')[0],
            'code': self.read(frame + 0xc, 'I')[0] - code,
            'events': events,
            'findFunction': [names.get(n, hex(n)) for n in ffc],
            'pawn': {
                'location': vec(pawn, 0x114), 'velocity': vec(pawn, 0x144),
                'acceleration': vec(pawn, 0x150), 'rotation': rot(pawn, 0x120),
                'desiredRotation': rot(pawn, 0x208), 'floor': vec(pawn, 0x3fc),
                'destination': vec(pawn, 0x354), 'focus': vec(pawn, 0x360),
                'latentFloat': self.f32(pawn + 0xe0),
                'moveTimer': self.f32(pawn + 0x348),
                'moveTarget': self.read(pawn + 0x34c, 'I')[0],
                'faceTarget': self.read(pawn + 0x350, 'I')[0],
                'desiredSpeed': self.f32(pawn + 0x36c),
                'flags318': self.read(pawn + 0x318, 'I')[0],
                'flags31c': self.read(pawn + 0x31c, 'I')[0],
                'physics': self.read(pawn + 0x30, 'B')[0],
            },
            'pawnBits': {
                'location': vecbits(pawn, 0x114), 'velocity': vecbits(pawn, 0x144),
                'acceleration': vecbits(pawn, 0x150), 'floor': vecbits(pawn, 0x3fc),
                'destination': vecbits(pawn, 0x354), 'focus': vecbits(pawn, 0x360),
                'latentFloat': fbits(pawn + 0xe0), 'moveTimer': fbits(pawn + 0x348),
                'desiredSpeed': fbits(pawn + 0x36c), 'maxDesiredSpeed': fbits(pawn + 0x370),
                'meleeRange': fbits(pawn + 0x374), 'groundSpeed': fbits(pawn + 0x378),
                'waterSpeed': fbits(pawn + 0x37c), 'airSpeed': fbits(pawn + 0x380),
                'accelRate': fbits(pawn + 0x384), 'avgPhysicsTime': fbits(pawn + 0x32c),
                'collisionRadius': fbits(pawn + 0x1d4), 'collisionHeight': fbits(pawn + 0x1d8),
            },
            'pawnAddress': pawn, 'targetAddress': target, 'frameAddress': frame,
        }
        if target:
            result['target'] = {
                'location': vec(target, 0x114),
                'class': self.read(target + 0x24, 'I')[0],
            }
        return result


def sanitize(value):
    if isinstance(value, float) and not math.isfinite(value):
        return 'f32:0x%08x' % f32bits(value)
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value


def main():
    root = Path(__file__).resolve().parent.parent
    payload = json.loads(Path(sys.argv[1]).read_text() if len(sys.argv) > 1 else sys.stdin.read())
    probe = PawnLatentProbe(root / 'Deus Ex GOTY Edition')
    if isinstance(payload, list):
        out = []
        for scene in payload:
            try:
                out.append({'ok': True, 'result': probe.run(scene)})
            except (ProbeError, RotationOracleMiss) as e:
                out.append({'ok': False, 'error': str(e), 'type': type(e).__name__})
        print(json.dumps(sanitize(out)))
    else:
        print(json.dumps(sanitize(probe.run(payload)), indent=1))


if __name__ == '__main__':
    main()
