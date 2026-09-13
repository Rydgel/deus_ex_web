"""Execute the original Core/Engine DLL static class registration and package
load in an isolated x86 emulator to recover the GObjObjects index assignment.

Optional research tool, never imported by the browser. Inputs, DLLs and results
stay local. This is the boot-replay experiment described in
docs/boot-replay.md: the global UObject index of a loaded object is assigned by
Core AddObject (0x10157830) in the original DLL-init and package-load order.
Only the two hash-verified GOTY DLLs below are supported by the base harness.

Recovered bootstrap (Core.dll):
  _DllMainCRTStartup 0x1016f14f -> _CRT_INIT 0x1016f0a4 -> _initterm(0x101a7000, 0x101a78a4)
  appInit 0x10152790: zeroes 4096 buckets at 0x1029e644, sets gate 0x102a2644=1,
  calls ProcessRegistrants 0x10152a40.
  AddObject 0x10157830 appends at GObjObjects (data 0x1029e628, count 0x1029e62c,
  capacity 0x1029e630) from the free-index array (data 0x1029e618, count 0x1029e61c).
  FName table: GNames data 0x102961f0, count 0x102961f4, capacity 0x102961f8.
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_native = _load('native_collision_oracle', REPO / 'scripts' / 'native-collision-oracle.py')
NativeCollision = _native.NativeCollision
from unicorn import UC_HOOK_MEM_INVALID, UC_HOOK_MEM_WRITE, UC_HOOK_CODE  # noqa: E402
from unicorn.x86_const import (  # noqa: E402
    UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EIP, UC_X86_REG_ESP,
    UC_X86_REG_EDI, UC_X86_REG_ESI, UC_X86_REG_EBX, UC_X86_REG_EBP,
    UC_X86_REG_FPCW, UC_X86_REG_FPSW, UC_X86_REG_FPTAG,
)

CORE_BASE = 0x10100000
GOG = 0x1029e628            # GObjObjects FArray data
GOG_COUNT = 0x1029e62c
GOG_CAP = 0x1029e630
GOG_FREE = 0x1029e618       # free-index FArray data
GOG_FREE_COUNT = 0x1029e61c
GOG_FREE_CAP = 0x1029e620
G_HASH = 0x1029e644         # 4096 GObjHashBuckets
REG_GATE = 0x102a2644
OBJ_GATE = 0x102a2648
GMALLOC_PTR = 0x101a7c44
GNAMES = 0x102961f0
GNAME_AVAIL = 0x102961e0

APP_FAIL_ASSERT = 0x10102c70
PROCESS_REGISTRANTS = 0x10152a40
ADD_OBJECT = 0x10157830

CORE_INIT_A = 0x101a7000
CORE_INIT_Z = 0x101a78a4
ENGINE_INIT_A = 0x10479000
ENGINE_INIT_Z = 0x10479b28
FIRE_INIT_A = 0x10515000
FIRE_INIT_Z = 0x10515034
IPDRV_INIT_A = 0x10723000
IPDRV_INIT_Z = 0x107232e8
EXTENSION_INIT_A = 0x10097000
EXTENSION_INIT_Z = 0x10097914
CONSYS_INIT_A = 0x1001d000
CONSYS_INIT_Z = 0x1001d13c

# Hash-verified native DLLs loaded after Core/Engine. Every extra DLL overlaps
# Engine's mapped image (or another DLL's preferred base), so each is rebased to
# a free region and its init-array virtual addresses shift by the same delta.
# DeusEx.dll statically links its CRT, so its arrays are driven by the internal
# _initterm at 0x1001bf67: (0x10034178, 0x1003418c) then (0x10034000, 0x10034174).
# Fields: display name, file, preferred base, rebased base, [(init A, init Z)].
NATIVE_DLLS = [
    ('Core', 'Core.dll', 0x10100000, 0x10100000, [(CORE_INIT_A, CORE_INIT_Z)]),
    ('Engine', 'Engine.dll', 0x10300000, 0x10300000, [(ENGINE_INIT_A, ENGINE_INIT_Z)]),
    ('Window', 'Window.dll', 0x11000000, 0x11000000, [(0x1104f000, 0x1104f21c)]),
    ('Fire', 'Fire.dll', 0x10500000, 0x12200000, [(FIRE_INIT_A, FIRE_INIT_Z)]),
    ('IpDrv', 'IpDrv.dll', 0x10700000, 0x12300000, [(IPDRV_INIT_A, IPDRV_INIT_Z)]),
    ('Extension', 'Extension.dll', 0x10000000, 0x12000000, [(EXTENSION_INIT_A, EXTENSION_INIT_Z)]),
    ('ConSys', 'ConSys.dll', 0x10000000, 0x12100000, [(CONSYS_INIT_A, CONSYS_INIT_Z)]),
    ('DeusEx', 'DeusEx.dll', 0x10000000, 0x13000000, [(0x10034178, 0x1003418c), (0x10034000, 0x10034174)]),
    ('DeusExText', 'DeusExText.dll', 0x10000000, 0x12800000, [(0x1000a000, 0x1000a044)]),
]

EXTRA_DLL_HASHES = {
    'Window.dll': {'hash': '3d40db1dd7467d94c17bf4ef0fa4cafd1a9d699ac7df7a5526b3961b4642e59d',
                   'base': 0x11000000},
    'Fire.dll': {'hash': '64bdcd86329f205fbae1a1bbc55dfcc8d14de23be9b9c35331ff06ff03644d28',
                 'base': 0x12200000},
    'IpDrv.dll': {'hash': '865a64086378a2d018359ae578ae7489be4632abc0d0036ceee638cea8b98ed5',
                  'base': 0x12300000},
    'Extension.dll': {'hash': '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
                      'base': 0x12000000},
    'ConSys.dll': {'hash': 'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
                   'base': 0x12100000},
    'DeusEx.dll': {'hash': 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04',
                   'base': 0x13000000},
    'DeusExText.dll': {'hash': '5f64ff6be5e44a276906e72325a25e1a27406314267076c2b5ad061b4a339aa1',
                       'base': 0x12800000},
}

# Known Core native class registration bodies for reporting.
KNOWN_REGISTRATIONS = {
    0x10128750: 'Core.Class', 0x10150cc0: 'Core.Object', 0x10125e50: 'Core.Field',
    0x101273d0: 'Core.Struct', 0x10127760: 'Core.State', 0x1015a710: 'Core.Package',
    0x10165650: 'Core.Property', 0x10166fc0: 'Core.ObjectProperty',
    0x101671c0: 'Core.ClassProperty',
}

# The exe statically imports Window/Core/Engine; the base oracle loads only
# those. Every other native DLL is loaded on demand from appGetDllHandle at its
# package bind point, exactly as UObject::BindPackage does.
STATIC_DLL_HASHES = {'Window.dll': EXTRA_DLL_HASHES['Window.dll']}
DLL_INFO = {
    'core.dll': ('Core.dll', 0x10100000, 0x10100000, [(CORE_INIT_A, CORE_INIT_Z)]),
    'engine.dll': ('Engine.dll', 0x10300000, 0x10300000, [(ENGINE_INIT_A, ENGINE_INIT_Z)]),
    'window.dll': ('Window.dll', 0x11000000, 0x11000000, [(0x1104f000, 0x1104f21c)]),
    'fire.dll': ('Fire.dll', 0x10500000, 0x12200000, [(FIRE_INIT_A, FIRE_INIT_Z)]),
    'ipdrv.dll': ('IpDrv.dll', 0x10700000, 0x12300000, [(IPDRV_INIT_A, IPDRV_INIT_Z)]),
    'extension.dll': ('Extension.dll', 0x10000000, 0x12000000, [(EXTENSION_INIT_A, EXTENSION_INIT_Z)]),
    'consys.dll': ('ConSys.dll', 0x10000000, 0x12100000, [(CONSYS_INIT_A, CONSYS_INIT_Z)]),
    'deusex.dll': ('DeusEx.dll', 0x10000000, 0x13000000,
                   [(0x10034178, 0x1003418c), (0x10034000, 0x10034174)]),
    'deusextext.dll': ('DeusExText.dll', 0x10000000, 0x12800000, [(0x1000a000, 0x1000a044)]),
}
GAME_DLLS = ('fire.dll', 'ipdrv.dll', 'extension.dll', 'consys.dll', 'deusex.dll', 'deusextext.dll')


def dll_hash(file):
    if file in EXTRA_DLL_HASHES:
        return EXTRA_DLL_HASHES[file]['hash']
    return _native.HASHES[file]


# appGetDllHandle / appFindPackageFile / UObject::BindPackage thunks.
APP_GET_DLL_HANDLE = 0x1010181b
APP_FIND_PACKAGE_FILE = 0x10102e87
BIND_PACKAGE = 0x101017e9

# Fake allocator / vtable / handler locations.
FAKE = 0x71000000
GMALLOC = FAKE + 0x00000
GMALLOC_VT = FAKE + 0x01000
HANDLERS = FAKE + 0x02000

# Fake FFileManager / FArchive region (outside the mapped images/allocator).
FILE_MANAGER = FAKE + 0x10000
FILE_MANAGER_VT = FAKE + 0x11000
ARCHIVE_BASE = FAKE + 0x12000
ARCHIVE_VT = FAKE + 0x13000
FILE_HANDLERS = FAKE + 0x14000

DUMMY_OBJECT = FAKE + 0x20000
DUMMY_VT = FAKE + 0x21000
DUMMY_STUB = FAKE + 0x22000


class Allocator:
    """GMalloc replacement backed by the emulator's bump allocator.

    The emulated code writes directly to guest memory, so a reallocation must
    copy the old block from guest memory rather than a stale Python mirror.
    """

    def __init__(self, emu):
        self.emu = emu
        self.sizes = {}           # ptr -> allocated size, 0 while free

    def malloc(self, size, tag=0):
        size = max(int(size), 1)
        ptr = self.emu.alloc(size)
        self.emu.cpu.mem_write(ptr, b'\x00' * size)
        self.sizes[ptr] = size
        return ptr

    def realloc(self, ptr, size, tag=0):
        size = max(int(size), 1)
        if ptr == 0:
            return self.malloc(size, tag)
        old_size = self.sizes.get(ptr, 0)
        old = bytes(self.emu.cpu.mem_read(ptr, old_size)) if old_size else b''
        newptr = self.emu.alloc(size)
        buf = bytearray(size)
        buf[:min(len(old), size)] = old[:size]
        self.emu.cpu.mem_write(newptr, bytes(buf))
        self.sizes[newptr] = size
        return newptr

    def free(self, ptr):
        if ptr:
            self.sizes.pop(ptr, None)

    def size(self, ptr):
        return self.sizes.get(ptr, 0)


class BootReplay(NativeCollision):
    def __init__(self, game_root, static_only=False, ranged=True):
        super().__init__(game_root, additional_hashes=STATIC_DLL_HASHES)
        self.game_root = Path(game_root)
        self.cpu.mem_map(0x71000000, 0x1000000)
        self.cpu.mem_map(0x70100000, 0x100000)  # dynamic import thunks
        # Package loading creates far more objects than the collision oracle's
        # 48 MB arena; extend the bump allocator region for the boot replay.
        self.cpu.mem_map(0x24000000, 0x10000000)
        self.free = 0x24000000
        self.alloc_limit = 0x34000000
        # Replace the shared oracle's global per-instruction hook with ranged
        # hooks covering only the thunk/fake-handler regions. Core/Engine code
        # then executes without a Python callback per instruction. `--debug`
        # keeps the global hook so Core-address debug prints still fire.
        self.use_ranged_hooks = ranged
        if ranged:
            self.cpu.hook_del(self.code_hook)
            # NB: hook_add(htype, callback, user_data, begin, end); pass None so
            # the range lands in begin/end rather than user_data.
            self.code_hooks = [
                self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, None, 0x70000000, 0x70200000),
                self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, None, 0x71000000, 0x71200000),
                self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, None, APP_GET_DLL_HANDLE, APP_GET_DLL_HANDLE + 1),
                self.cpu.hook_add(UC_HOOK_CODE, self.on_instruction, None, APP_FIND_PACKAGE_FILE, APP_FIND_PACKAGE_FILE + 1),
            ]
        self.trace = __import__('collections').deque(maxlen=200)
        self.allocator = Allocator(self)
        self.registrations = []       # (index, object_ptr, name_ptr/text)
        self.failures = []
        self.loaded = {}              # lower dll name -> handle (rebased base)
        self.image_exports = {}       # lower dll name -> {export: rva}
        self.dyn_thunk = 0x70100000
        self.static_only = static_only
        self.instruction_budget = 100_000_000
        self.debug_mode = False
        self.log = print
        self.init_gmalloc()
        self.init_gates()
        # Record the statically loaded images (Core/Engine/Window) for dynamic
        # import resolution and mark them loaded.
        for name in ('core.dll', 'engine.dll', 'window.dll'):
            file, pref, reb, ranges = DLL_INFO[name]
            img = _native.Image(self.game_root / 'System' / file, dll_hash(file), rebase=reb)
            self.image_exports[name] = img.exports()
            self.loaded[name] = reb
        self.setup_file_manager()
        self.setup_devices()
        # Make appFailAssert a no-op so assert-and-continue matches the release
        # build without pulling in the log/config device graph.
        self.cpu.mem_write(APP_FAIL_ASSERT, b'\xc3')
        # Index-recovery boundary: UObject::LoadConfig and UObject::LoadLocalized
        # need the Engine config/localization device graph (already recovered as
        # a separate subsystem) and do not create registry objects. A bare
        # thiscall return keeps the drain moving without a guessed config device.
        self.cpu.mem_write(0x101023dd, b'\xc2\x0c\x00')  # LoadConfig(this, int, UClass*, TCHAR*) ret 0xc
        self.cpu.mem_write(0x1010306c, b'\xc2\x08\x00')  # LoadLocalized(this, int, UClass*) ret 0x8

    def alloc(self, size):
        address = self.free
        self.free += (size + 15) & ~15
        if self.free >= self.alloc_limit:
            raise MemoryError('Boot replay allocation limit exceeded')
        return address

    def resolve_imports(self, img):
        """Wire `img`'s IAT entries against loaded exports or CRT/kernel thunks."""
        for dll, symbol, iat in img.imports():
            address = self.image_exports.get(dll, {}).get(symbol)
            if address is None:
                address = self.dyn_thunk
                self.dyn_thunk += 16
                self.thunks[address] = (dll, symbol)
            self.write(iat, 'I', address)
            if dll == 'msvcrt.dll' and symbol == '_ftol' and address in self.thunks:
                self.cpu.mem_write(address, bytes.fromhex('83 ec 08 dd 0c 24 58 5a c3'))
                self.thunks.pop(address)

    def load_dll(self, name):
        """Load, rebase, wire and initialize a native DLL on demand.

        Mirrors the Windows loader: imported native DLLs are loaded first.
        Returns a nonzero pseudo-handle (the rebased image base), or 0 when the
        name is not a known native DLL.
        """
        key = name.lower()
        if key in self.loaded:
            return self.loaded[key]
        info = DLL_INFO.get(key)
        if info is None:
            return 0
        file, preferred, rebased, ranges = info
        img = _native.Image(self.game_root / 'System' / file, dll_hash(file), rebase=rebased)
        # Dependencies first (the real loader runs their DllMain before this one).
        for dll, _symbol, _iat in img.imports():
            if dll in DLL_INFO and dll != key:
                self.load_dll(dll)
        self.cpu.mem_map(img.base, (img.size + 4095) & ~4095)
        self.cpu.mem_write(img.base, img.data[:1024])
        for _, _, virtual, size, raw in img.sections:
            if size:
                self.cpu.mem_write(img.base + virtual, img.data[raw:raw + size])
        self.resolve_imports(img)
        self.image_exports[key] = img.exports()
        self.loaded[key] = img.base
        delta = rebased - preferred
        for start, end in ranges:
            self.run_initializers(self.read_init_array(start + delta, end + delta), stop_on_failure=False)
        return img.base

    def setup_file_manager(self):
        """Fake FFileManager whose vtable +0x04 CreateFileReader serves package bytes."""
        self.cpu.mem_write(FILE_MANAGER, b'\x00' * 0x40)
        for slot in range(8):
            self.write(FILE_MANAGER_VT + slot * 4, 'I', FILE_HANDLERS + slot * 16)
            self.cpu.mem_write(FILE_HANDLERS + slot * 16, bytes([0xb8, slot, 0, 0, 0, 0xc3]))
        self.write(FILE_MANAGER, 'I', FILE_MANAGER_VT)
        self.write(0x101a7c48, 'I', FILE_MANAGER)
        # Archive vtable: slots are intercepted by handle_file (see on_instruction).
        for slot in range(20):
            self.write(ARCHIVE_VT + slot * 4, 'I', FILE_HANDLERS + 0x200 + slot * 16)
            self.cpu.mem_write(FILE_HANDLERS + 0x200 + slot * 16, bytes([0xb8, slot, 0, 0, 0, 0xc3]))
        self.archives = {}

    def setup_devices(self):
        """Non-null GLog/GError/GWarn/GConfig dummies.

        appInit receives these from the exe and stores them at Core globals.
        StaticConstructObject requires a non-null error device and returns null
        otherwise, so the linker allocation needs one.
        """
        self.cpu.mem_write(DUMMY_OBJECT, b'\x00' * 0x40)
        for slot in range(16):
            self.write(DUMMY_VT + slot * 4, 'I', DUMMY_STUB)
        self.write(DUMMY_OBJECT, 'I', DUMMY_VT)
        self.cpu.mem_write(DUMMY_STUB, bytes.fromhex('c20800'))  # thiscall FOutputDevice::Serialize(const TCHAR*, EName)
        for global_ptr in (0x101a7c34, 0x101a7c38, 0x101e3310, 0x101e3314):
            self.write(global_ptr, 'I', DUMMY_OBJECT)
        # Single-player is both client and server; the linker builds its
        # CreateExport flag mask (+0xa0) from these three globals.
        self.write(0x101e5544, 'I', 0)  # GIsEditor
        self.write(0x101e5548, 'I', 1)  # GIsClient
        self.write(0x101e554c, 'I', 1)  # GIsServer

    def package_bytes(self, name):
        """Resolve a package/filename to its bytes from the local install.

        Package files win over same-stem .ini/.int/.dll, in the UE1 extension
        preference order.
        """
        stem = name.lower().rsplit('\\', 1)[-1].rsplit('/', 1)[-1]
        stem = stem.rsplit('.', 1)[0]
        priority = {'.u': 0, '.dx': 1, '.uax': 2, '.utx': 3, '.umx': 4}
        best = None
        best_rank = 99
        for directory in ('Maps', 'System', 'Sounds', 'Textures', 'Music'):
            folder = self.game_root / directory
            if not folder.is_dir():
                continue
            for candidate in folder.iterdir():
                if candidate.stem.lower() != stem:
                    continue
                rank = priority.get(candidate.suffix.lower(), 50)
                if rank < best_rank:
                    best, best_rank = candidate, rank
        return best.read_bytes() if best is not None and best_rank < 50 else None

    # -- original Core entry points intercepted by address ---------------------
    def handle_app_get_dll_handle(self, cpu):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        name = self._read_wstr(struct.unpack('<I', cpu.mem_read(esp + 4, 4))[0])
        handle = self.load_dll(name)
        if getattr(self, 'log_archive', False):
            print(f'  appGetDllHandle({name!r}) -> {handle:#x} caller={ret:#x}')
        cpu.reg_write(UC_X86_REG_EAX, handle)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, esp + 4)

    def handle_app_find_package_file(self, cpu):
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        in_name = struct.unpack('<I', cpu.mem_read(esp + 4, 4))[0]
        out_name = struct.unpack('<I', cpu.mem_read(esp + 12, 4))[0]
        name = self._read_wstr(in_name)
        found = self.package_bytes(name) is not None or not name
        if getattr(self, 'log_archive', False):
            print(f'  appFindPackageFile({name!r}) found={found}')
        if found and out_name:
            self._write_wstr(out_name, name)
        cpu.reg_write(UC_X86_REG_EAX, 1 if found else 0)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, esp + 4)

    def handle_file_manager(self, cpu, address):
        slot = (address - FILE_HANDLERS) // 16
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        args = struct.unpack('<4I', cpu.mem_read(esp + 4, 16))
        if getattr(self, 'log_archive', False) and slot != 1:
            print(f'  fileManager slot {slot} args={[hex(a) for a in args]}')
        if slot == 0:  # CreateFileReader(Filename, Flags, Error) per linker ctor 0x101601cb
            filename = self._read_wstr(args[0])
            data = self.package_bytes(filename)
            if getattr(self, 'log_archive', False):
                print(f'  CreateFileReader({filename!r}) bytes={None if data is None else len(data)}')
            if data is None:
                cpu.reg_write(UC_X86_REG_EAX, 0)
            else:
                archive = ARCHIVE_BASE + len(self.archives) * 0x80
                self.archives[archive] = {'data': data, 'pos': 0, 'name': filename}
                self.cpu.mem_write(archive, b'\x00' * 0x80)
                self.write(archive, 'I', ARCHIVE_VT)
                self.write(archive + 0x10, 'I', len(data))
                cpu.reg_write(UC_X86_REG_EAX, archive)
            cpu.reg_write(UC_X86_REG_EIP, ret)
            cpu.reg_write(UC_X86_REG_ESP, esp + 4 + 12)
            return
        cpu.reg_write(UC_X86_REG_EAX, 0)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, esp + 4)

    def _archive_compact(self, archive):
        data = archive['data']
        pos = archive['pos']
        value = 0
        shift = 0
        while True:
            byte = data[pos]
            pos += 1
            value |= (byte & 0x7f) << shift
            shift += 7
            if not (byte & 0x80) or shift > 35:
                break
        archive['pos'] = pos
        return value & 0xffffffff

    def handle_archive(self, cpu, address):
        slot = (address - (FILE_HANDLERS + 0x200)) // 16
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        ecx = cpu.reg_read(UC_X86_REG_ECX)
        archive = self.archives.get(ecx)
        args = struct.unpack('<4I', cpu.mem_read(esp + 4, 16))
        if archive is None:
            cpu.reg_write(UC_X86_REG_EAX, 0)
            cpu.reg_write(UC_X86_REG_EIP, ret)
            cpu.reg_write(UC_X86_REG_ESP, esp + 4)
            return
        result = 0
        argbytes = 0
        if slot == 1:      # Serialize(void* data, int count)
            count = args[1]
            chunk = archive['data'][archive['pos']:archive['pos'] + count]
            if len(chunk) < count:
                chunk = chunk + b'\x00' * (count - len(chunk))
            if args[0] and count:
                self.cpu.mem_write(args[0], bytes(chunk))
            archive['pos'] += count
            argbytes = 8
        elif slot in (6, 7):  # operator<<(FName&/UObject*&): compact index
            self.cpu.mem_write(args[0], struct.pack('<I', self._archive_compact(archive)))
            result = ecx
            argbytes = 4
        elif slot == 10:   # Tell()
            result = archive['pos']
            argbytes = 0
        elif slot == 13:   # Seek(int pos)
            archive['pos'] = args[0]
            argbytes = 4
        elif slot == 14:   # AttachLazyLoader(FLazyLoader*)
            argbytes = 4
        else:
            if getattr(self, 'log_archive', False):
                print(f'  unhandled archive slot {slot} this={ecx:#x} args={[hex(a) for a in args[:3]]}')
            argbytes = 4
        cpu.reg_write(UC_X86_REG_EAX, result)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cpu.reg_write(UC_X86_REG_ESP, esp + 4 + argbytes)



    def drive_package_load(self, names, budget=None):
        """Call original UObject::LoadPackage (0x10102e50) for each package name.

        Each call is instruction-bounded so a slow/pathological load reports
        rather than hanging.
        """
        results = []
        for name in names:
            ptr = self.alloc(0x40)
            self._write_wstr(ptr, name)
            count = struct.unpack('<I', self.cpu.mem_read(GOG_COUNT, 4))[0]
            self.log(f'Loading {name} (objects before={count})...')
            try:
                result = self.call(0x10102e50, 0, struct.pack('<IIi', 0, ptr, 0), budget=budget)
            except Exception as error:
                self.log(f'LoadPackage({name}) failed: {type(error).__name__}: {error}')
                break
            after = struct.unpack('<I', self.cpu.mem_read(GOG_COUNT, 4))[0]
            self.log(f'LoadPackage({name}) -> {result:#x} (objects after={after}, '
                     f'arena used={self.free - 0x24000000:#x})')
            results.append((name, result))
        return results

    def init_gmalloc(self):
        cpu = self.cpu
        cpu.mem_write(GMALLOC, b'\x00' * 0x40)
        for slot in range(4):
            self.write(GMALLOC_VT + slot * 4, 'I', HANDLERS + slot * 16)
        self.write(GMALLOC, 'I', GMALLOC_VT)
        self.write(GMALLOC_PTR, 'I', GMALLOC)
        # Handlers: mov eax, slot ; ret (intercepted before execution)
        for slot in range(4):
            cpu.mem_write(HANDLERS + slot * 16, bytes([0xb8, slot, 0, 0, 0, 0xc3]))

    def init_gates(self):
        self.write(REG_GATE, 'I', 0)
        self.write(OBJ_GATE, 'I', 0)
        self.write(GOG, 'I', 0)
        self.write(GOG_COUNT, 'I', 0)
        self.write(GOG_CAP, 'I', 0)
        self.write(GOG_FREE, 'I', 0)
        self.write(GOG_FREE_COUNT, 'I', 0)
        self.write(GOG_FREE_CAP, 'I', 0)
        self.cpu.mem_write(G_HASH, b'\x00' * (4096 * 4))
        self.cpu.mem_write(GNAMES, b'\x00' * 0x20)
        self.cpu.mem_write(GNAME_AVAIL, b'\x00' * 0x20)

    def on_bad_memory(self, cpu, access, address, size, value, data):
        self.bad = (address, cpu.reg_read(UC_X86_REG_EIP))
        self.bad_regs = {name: cpu.reg_read(reg) for name, reg in
                         [('eax', UC_X86_REG_EAX), ('ecx', UC_X86_REG_ECX),
                          ('edx', UC_X86_REG_EDX), ('esi', UC_X86_REG_ESI), ('edi', UC_X86_REG_EDI)]}
        cpu.emu_stop()

    # The full multi-DLL drain is legitimately long; the shared oracle's 4M
    # budget is too small once Fire/IpDrv/Extension/ConSys classes are queued.
    # A call is bounded so a pathological path fails fast instead of hanging.
    def call(self, address, this, args, budget=None):
        for reg, value in [(UC_X86_REG_ESP, self.stack), (UC_X86_REG_ECX, this),
                           (UC_X86_REG_FPCW, 0x037f), (UC_X86_REG_FPSW, 0),
                           (UC_X86_REG_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.write(self.stack, 'I', self.done)
        self.cpu.mem_write(self.stack + 4, args)
        limit = self.instruction_budget if budget is None else budget
        self.cpu.emu_start(address, self.done + 1, count=limit)
        if self.cpu.reg_read(UC_X86_REG_EIP) != self.done:
            raise RuntimeError(f'Native instruction budget exceeded ({limit})')
        return self.cpu.reg_read(UC_X86_REG_EAX)
    def on_instruction(self, cpu, address, size, data):
        if address == self.done:
            cpu.emu_stop()
            return
        if HANDLERS <= address < HANDLERS + 0x100:
            self.handle_gmalloc(cpu, address, size)
            return
        if address == APP_GET_DLL_HANDLE:
            self.handle_app_get_dll_handle(cpu)
            return
        if address == APP_FIND_PACKAGE_FILE:
            self.handle_app_find_package_file(cpu)
            return
        if FILE_HANDLERS <= address < FILE_HANDLERS + 0x100:
            self.handle_file_manager(cpu, address)
            return
        if FILE_HANDLERS + 0x200 <= address < FILE_HANDLERS + 0x400:
            self.handle_archive(cpu, address)
            return
        if self.debug_mode:
            self.trace.append(hex(address))
            self.debug_step(cpu, address)
        if address in self.thunks:
            if self.handle_import(cpu, address):
                return
            raise RuntimeError(f'Unresolved import {self.thunks[address]}; trace {list(self.trace)}')

    def debug_step(self, cpu, address):
        if getattr(self, 'log_archive', False) and address in (0x1015486d, 0x101548b2, 0x1015494d, 0x101548a1):
            print(f'  GetPackageLinker @{address:#x} ebx(Outer)={cpu.reg_read(UC_X86_REG_EBX):#x} '
                  f'edx(Flags)={cpu.reg_read(UC_X86_REG_EDX):#x}')
        if getattr(self, 'log_archive', False) and address == 0x10161bf0:
            linker = cpu.reg_read(UC_X86_REG_ECX)
            u32 = lambda a: struct.unpack('<I', cpu.mem_read(a, 4))[0]
            print(f'  LoadAllObjects linker={linker:#x} exports={u32(linker + 0x40)} '
                  f'expData={u32(linker + 0x84):#x} '
                  f'gateFlags={u32(linker + 0xa0):#x} linkFlags={u32(linker + 0x3c):#x}')
        if getattr(self, 'log_archive', False) and address == 0x10160000:
            print(f'  ULinkerLoad ctor this={cpu.reg_read(UC_X86_REG_ECX):#x} '
                  f'file={self._read_wstr(struct.unpack("<I", cpu.mem_read(cpu.reg_read(UC_X86_REG_ESP) + 4, 4))[0])!r}')
        if getattr(self, 'log_archive', False) and address == 0x101601cb:
            print(f'  linker CreateFileReader file={self._read_wstr(cpu.reg_read(UC_X86_REG_EBX))!r}')
        if getattr(self, 'debug_makeunique', False) and address == 0x101575b0:
            esp = cpu.reg_read(UC_X86_REG_ESP)
            outer = struct.unpack('<I', cpu.mem_read(esp + 8, 4))[0]
            cls = struct.unpack('<I', cpu.mem_read(esp + 12, 4))[0]
            ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
            print(f'MakeUniqueObjectName outer={outer:#x} class={cls:#x} caller={ret:#x}')
        if getattr(self, 'debug_add', False) and address == ADD_OBJECT:
            obj = cpu.reg_read(UC_X86_REG_ECX)
            name_idx = struct.unpack('<I', cpu.mem_read(obj + 0x20, 4))[0]
            count = struct.unpack('<I', cpu.mem_read(GOG_COUNT, 4))[0]
            print(f'  AddObject obj={obj:#010x} nameIdx={name_idx} count={count}')
        if getattr(self, 'debug_add', False) and address == PROCESS_REGISTRANTS:
            print('  ProcessRegistrants enter queue=', hex(struct.unpack('<I', cpu.mem_read(0x102a265c, 4))[0]))
        if getattr(self, 'trace_fname', False) and address == 0x1014b976:
            ebx = cpu.reg_read(UC_X86_REG_EBX)
            text = self._read_wstr(ebx, 40) if ebx else '<null>'
            print(f'FName ctor text={text!r} ptr={ebx:#x}')
        if getattr(self, 'trace_low', False) and address < 0x10000 and self.trace:
            prev = int(self.trace[-1], 16) if self.trace[-1] else 0
            if prev >= 0x10000000:
                print(f'JUMP to low {address:#x} from {prev:#x}')

    # -- CRT import emulation (cdecl: emulate `ret`, leave args for the caller) --
    def _read_wstr(self, ptr, limit=4096):
        if not ptr:
            return ''
        out = bytearray()
        for base in range(0, limit * 2, 256):
            try:
                out += self.cpu.mem_read(ptr + base, 256)
            except Exception:
                break
            end = -1
            for i in range(0, len(out) - 1, 2):
                if out[i] == 0 and out[i + 1] == 0:
                    end = i
                    break
            if end >= 0:
                out = out[:end]
                break
        return bytes(out).decode('utf-16le', 'replace')

    def _write_wstr(self, ptr, text, maxchars=None):
        data = text.encode('utf-16le') + b'\x00\x00'
        if maxchars is not None:
            data = data[:maxchars * 2]
            if len(data) < maxchars * 2:
                data += b'\x00\x00' * (maxchars - len(data) // 2)
        self.cpu.mem_write(ptr, data)

    def _cstr(self, ptr):
        if not ptr:
            return b''
        out = bytearray()
        for base in range(0, 4096, 256):
            try:
                out += self.cpu.mem_read(ptr + base, 256)
            except Exception:
                break
            if 0 in out:
                return bytes(out[:out.index(0)])
        return bytes(out)

    def _fold(self, ch):
        return ch - 32 if 0x61 <= ch <= 0x7a else ch

    def handle_import(self, cpu, address):
        dll, symbol = self.thunks[address]
        table = CRT if dll == 'msvcrt.dll' else KERNEL32 if dll == 'kernel32.dll' else None
        handler = table.get(symbol) if table else None
        if handler is None:
            return False
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        args = struct.unpack('<20I', cpu.mem_read(esp + 4, 80))
        try:
            result = handler(self, *args)
        except Exception as error:
            raise RuntimeError(f'CRT handler {symbol}{tuple(hex(a) for a in args[:5])} failed: '
                               f'{type(error).__name__}: {error}') from error
        if isinstance(result, int):
            cpu.reg_write(UC_X86_REG_EAX, result & 0xffffffff)
        cpu.reg_write(UC_X86_REG_EIP, ret)
        cleanup = 4 if dll == 'msvcrt.dll' else 4 + 4 * KERNEL32_ARGS.get(symbol, 0)
        cpu.reg_write(UC_X86_REG_ESP, esp + cleanup)
        return True

    def handle_gmalloc(self, cpu, address, size):
        slot = (address - HANDLERS) // 16
        esp = cpu.reg_read(UC_X86_REG_ESP)
        ret = struct.unpack('<I', cpu.mem_read(esp, 4))[0]
        args = struct.unpack('<4I', cpu.mem_read(esp + 4, 16))
        if slot == 0:      # Malloc(size, tag)
            cpu.reg_write(UC_X86_REG_EAX, self.allocator.malloc(args[0], args[1]))
            cpu.reg_write(UC_X86_REG_ESP, esp + 12)
        elif slot == 1:    # Realloc(ptr, size, tag)
            cpu.reg_write(UC_X86_REG_EAX, self.allocator.realloc(args[0], args[1], args[2]))
            cpu.reg_write(UC_X86_REG_ESP, esp + 16)
        elif slot == 2:    # Free(ptr)
            self.allocator.free(args[0])
            cpu.reg_write(UC_X86_REG_EAX, 0)
            cpu.reg_write(UC_X86_REG_ESP, esp + 8)
        else:
            cpu.reg_write(UC_X86_REG_EAX, 0)
            cpu.reg_write(UC_X86_REG_ESP, esp + 4)
        cpu.reg_write(UC_X86_REG_EIP, ret)

    def read_init_array(self, a, z):
        return [self.read(a + i * 4, 'I')[0] for i in range((z - a) // 4)]

    def run_initializers(self, ptrs, stop_on_failure=True):
        for i, ptr in enumerate(ptrs):
            if ptr == 0:
                continue
            try:
                self.call(ptr, 0, b'')
            except Exception as error:
                try:
                    eip = self.cpu.reg_read(UC_X86_REG_EIP)
                except Exception:
                    eip = 0
                self.failures.append((i, hex(ptr), f'eip={eip:#x} {type(error).__name__}: {error}'))
                if stop_on_failure:
                    raise
        return len(ptrs)

    def dump_queue(self, limit=40):
        head = self.read(0x102a265c, 'I')[0]
        node = head
        seen = set()
        index = 0
        print(f'registration queue head={head:#x}')
        while node and node not in seen and index < limit:
            seen.add(node)
            nxt = self.read(node + 0x14, 'I')[0]
            outer = self.read(node + 0x18, 'I')[0]
            name = self.read(node + 0x20, 'I')[0]
            cls = self.read(node + 0x24, 'I')[0]
            try:
                outer_text = self._read_wstr(outer, 64)
            except Exception:
                outer_text = '?'
            try:
                name_text = self._read_wstr(name, 64)
            except Exception:
                name_text = '?'
            try:
                cls_index = self.read(cls + 0x20, 'I')[0] if cls else -1
            except Exception:
                cls_index = '?'
            print(f'  q[{index:2d}] obj={node:#010x} outer={outer_text!r} name={name_text!r} class={cls:#x} cls+0x20={cls_index}')
            node = nxt
            index += 1

    def name_entry_text(self, entry):
        if not entry:
            return ''
        raw = bytes(self.cpu.mem_read(entry + 0xc, 128))
        chars = []
        for i in range(0, len(raw) - 1, 2):
            code = raw[i] | (raw[i + 1] << 8)
            if code == 0:
                break
            chars.append(chr(code))
        return ''.join(chars)

    def name_of_index(self, index):
        data = self.read(GNAMES, 'I')[0]
        if not data:
            return ''
        entry = self.read(data + index * 4, 'I')[0]
        return self.name_entry_text(entry)

    def object_text(self, ptr):
        name_idx = self.read(ptr + 0x20, 'I')[0]
        try:
            return self.name_of_index(name_idx)
        except Exception:
            return f'name#{name_idx}'

    def index_table(self):
        data = self.read(GOG, 'I')[0]
        count = self.read(GOG_COUNT, 'I')[0]
        rows = []
        for i in range(count):
            ptr = self.read(data + i * 4, 'I')[0] if data else 0
            rows.append({'index': i, 'pointer': ptr, 'name': self.object_text(ptr) if ptr else None})
        return rows

    def dump_objects(self, limit=80, as_json=False):
        rows = self.index_table()
        if as_json:
            print(json.dumps({'objectCount': len(rows), 'nameCount': self.read(GNAMES + 4, 'I')[0],
                              'objects': rows}, indent=1))
            return rows
        print(f'GObjObjects count={len(rows)}')
        for row in rows[:limit]:
            if row['pointer']:
                print(f"  [{row['index']:5d}] {row['pointer']:#010x} {row['name']}")
        return rows


def format_wide(emu, fmt, argp):
    """Minimal MSVC wide printf for the formats reached during registration."""
    out = []
    argp = [argp]
    i = 0
    n = len(fmt)

    def nextarg():
        value = struct.unpack('<I', emu.cpu.mem_read(argp[0], 4))[0]
        argp[0] += 4
        return value

    while i < n:
        ch = fmt[i]
        if ch != '%':
            out.append(ch)
            i += 1
            continue
        i += 1
        if i >= n:
            break
        if fmt[i] == '%':
            out.append('%')
            i += 1
            continue
        flags = ''
        while i < n and fmt[i] in '-+ 0#':
            flags += fmt[i]
            i += 1
        width = ''
        while i < n and fmt[i].isdigit():
            width += fmt[i]
            i += 1
        prec = ''
        if i < n and fmt[i] == '.':
            prec = '.'
            i += 1
            while i < n and fmt[i].isdigit():
                prec += fmt[i]
                i += 1
        length = ''
        while i < n and fmt[i] in 'hlLw':
            length += fmt[i]
            i += 1
        if i >= n:
            break
        conv = fmt[i]
        i += 1
        value = nextarg()
        if conv == 's':
            rendered = emu._cstr(value).decode('latin1') if 'h' in length else emu._read_wstr(value)
        elif conv == 'S':
            rendered = emu._read_wstr(value) if 'h' in length else emu._cstr(value).decode('latin1')
        elif conv == 'c':
            rendered = chr(value & 0xffff)
        elif conv in 'diu':
            rendered = str(value if value < 0x80000000 else value - 0x100000000) if conv != 'u' else str(value)
        elif conv in 'xX':
            rendered = format(value, conv)
        elif conv == 'p':
            rendered = f'{value:08X}'
        else:
            rendered = f'%{flags}{width}{prec}{length}{conv}'
        if width:
            pad = '0' if '0' in flags else ' '
            if '-' in flags:
                rendered = rendered.ljust(int(width), pad)
            else:
                rendered = rendered.rjust(int(width), pad)
        out.append(rendered)
    return ''.join(out)


def _cmp_wstr(emu, a, b, n=None, fold=True):
    sa, sb = emu._read_wstr(a), emu._read_wstr(b)
    if n is not None:
        sa, sb = sa[:n], sb[:n]
    for ca, cb in zip(sa, sb):
        aa, bb = (emu._fold(ord(ca)), emu._fold(ord(cb))) if fold else (ord(ca), ord(cb))
        if aa != bb:
            return -1 if aa < bb else 1
    return (len(sa) > len(sb)) - (len(sa) < len(sb))


def CRT_TABLE():
    table = {}
    table['__dllonexit'] = lambda e, *a: a[0]
    table['_onexit'] = lambda e, *a: a[0]
    table['malloc'] = lambda e, *a: e.allocator.malloc(a[0])
    table['free'] = lambda e, *a: (e.allocator.free(a[0]), 0)[1]

    def memmove(e, *a):
        dst, src, n = a[0], a[1], a[2]
        e.cpu.mem_write(dst, bytes(e.cpu.mem_read(src, n)))
        return dst
    table['memmove'] = memmove

    table['_wcsicmp'] = lambda e, *a: _cmp_wstr(e, a[0], a[1])
    table['_wcsnicmp'] = lambda e, *a: _cmp_wstr(e, a[0], a[1], a[2])
    table['wcscmp'] = lambda e, *a: _cmp_wstr(e, a[0], a[1], fold=False)
    table['wcsncmp'] = lambda e, *a: _cmp_wstr(e, a[0], a[1], a[2], fold=False)
    table['_wcslen'] = lambda e, *a: len(e._read_wstr(a[0]))
    table['wcslen'] = lambda e, *a: len(e._read_wstr(a[0]))

    def wcscpy(e, *a):
        e._write_wstr(a[0], e._read_wstr(a[1]))
        return a[0]
    table['wcscpy'] = wcscpy

    def wcsncpy(e, *a):
        e._write_wstr(a[0], e._read_wstr(a[1])[:a[2]], maxchars=a[2])
        return a[0]
    table['wcsncpy'] = wcsncpy

    def wcscat(e, *a):
        e._write_wstr(a[0], e._read_wstr(a[0]) + e._read_wstr(a[1]))
        return a[0]
    table['wcscat'] = wcscat

    def wcschr(e, *a):
        text = e._read_wstr(a[0])
        index = text.find(chr(a[1]))
        return a[0] + index * 2 if index >= 0 else 0
    table['wcschr'] = wcschr

    def wcsstr(e, *a):
        text, needle = e._read_wstr(a[0]), e._read_wstr(a[1])
        index = text.find(needle)
        return a[0] + index * 2 if index >= 0 else 0
    table['wcsstr'] = wcsstr

    def wcsupr(e, *a):
        e._write_wstr(a[0], e._read_wstr(a[0]).upper())
        return a[0]
    table['_wcsupr'] = wcsupr

    def wtoi(e, *a):
        text = e._read_wstr(a[0]).strip()
        try:
            return int(text, 10)
        except ValueError:
            return 0
    table['_wtoi'] = wtoi

    def vsnwprintf(e, *a):
        dst, count, fmtptr, argp = a[0], a[1], a[2], a[3]
        text = format_wide(e, e._read_wstr(fmtptr), argp)
        if count:
            text = text[:max(count - 1, 0)]
        e._write_wstr(dst, text)
        return len(text)
    table['_vsnwprintf'] = vsnwprintf
    table['_snwprintf'] = vsnwprintf
    table['_adjust_fdiv'] = lambda e, *a: 0
    table['_controlfp'] = lambda e, *a: 0
    table['_purecall'] = lambda e, *a: 0
    table['_except_handler3'] = lambda e, *a: 0
    table['__CxxFrameHandler'] = lambda e, *a: 0
    table['??1type_info@@UAE@XZ'] = lambda e, *a: 0
    table['_isnan'] = lambda e, *a: 0
    table['srand'] = lambda e, *a: 0
    table['rand'] = lambda e, *a: 0
    table['_initterm'] = lambda e, *a: 0
    return table


CRT = CRT_TABLE()


def KERNEL32_TABLE():
    table = {}
    ticks = [0]

    def get_module_name_a(e, *a):
        path = b'C:\\DeusEx\\System\\Core.dll'
        size = a[2] or 16
        e.cpu.mem_write(a[1], path[:size - 1] + b'\x00')
        return min(len(path), size - 1)

    def get_module_name_w(e, *a):
        path = 'C:\\DeusEx\\System\\Core.dll'.encode('utf-16le')
        size = a[2] or 16
        e.cpu.mem_write(a[1], path[:max(size - 1, 0) * 2] + b'\x00\x00')
        return min(len(path) // 2, size - 1)

    def multibyte_to_wide(e, *a):
        code_page, flags, src, src_len, dst, dst_len = a[:6]
        text = e._cstr(src).decode('latin1')
        if src_len and src_len != -1:
            text = text[:src_len]
        wide = text.encode('utf-16le')
        if dst and dst_len:
            e.cpu.mem_write(dst, wide[:dst_len * 2])
        return len(text) + 1

    def wide_to_multibyte(e, *a):
        code_page, flags, src, src_len, dst, dst_len = a[:6]
        text = e._read_wstr(src)
        if src_len and src_len != -1:
            text = text[:src_len]
        raw = text.encode('latin1', 'replace')
        if dst and dst_len:
            e.cpu.mem_write(dst, raw[:dst_len])
        return len(raw) + 1

    table['GetModuleFileNameA'] = get_module_name_a
    table['GetModuleFileNameW'] = get_module_name_w
    table['GetCurrentProcess'] = lambda e, *a: 0xffffffff
    table['GetLastError'] = lambda e, *a: 0
    table['GetTickCount'] = lambda e, *a: ticks.__setitem__(0, ticks[0] + 16) or ticks[0]
    table['timeGetTime'] = table['GetTickCount']
    table['Sleep'] = lambda e, *a: 0
    table['QueryPerformanceCounter'] = lambda e, *a: e.cpu.mem_write(a[0], b'\x00' * 8) or 1
    table['QueryPerformanceFrequency'] = lambda e, *a: e.cpu.mem_write(a[0], struct.pack('<Q', 1000000)) or 1
    table['GlobalMemoryStatus'] = lambda e, *a: e.cpu.mem_write(a[0], struct.pack('<IIIII', 32, 0x7fff0000, 0, 0x7fff0000, 0x7fffffff)) or 0
    table['GetSystemDefaultLangID'] = lambda e, *a: 0x0409
    table['GetVersionExA'] = lambda e, *a: e.cpu.mem_write(a[0], struct.pack('<IIIIII', 0x94, 4, 10, 0, 0, 0x0a000000)) or 1
    table['GetVersionExW'] = table['GetVersionExA']
    table['SetConsoleCtrlHandler'] = lambda e, *a: 1
    table['GetComputerNameA'] = lambda e, *a: (e.cpu.mem_write(a[0], b'PLAYER\x00'), e.cpu.mem_write(a[1], struct.pack('<I', 6)))[0] or 1
    table['GetComputerNameW'] = lambda e, *a: (e.cpu.mem_write(a[0], 'PLAYER\x00'.encode('utf-16le')), e.cpu.mem_write(a[1], struct.pack('<I', 6)))[0] or 1
    table['GetUserNameA'] = lambda e, *a: (e.cpu.mem_write(a[0], b'player\x00'), e.cpu.mem_write(a[1], struct.pack('<I', 7)))[0] or 1
    table['GetUserNameW'] = lambda e, *a: (e.cpu.mem_write(a[0], 'player\x00'.encode('utf-16le')), e.cpu.mem_write(a[1], struct.pack('<I', 7)))[0] or 1
    table['GetLocalTime'] = lambda e, *a: e.cpu.mem_write(a[0], b'\x00' * 16) or 0
    table['GetSystemInfo'] = lambda e, *a: e.cpu.mem_write(a[0], b'\x00' * 36) or 0
    table['GetProcessWorkingSetSize'] = lambda e, *a: (e.cpu.mem_write(a[1], b'\x00\x00\x00\x00'), e.cpu.mem_write(a[2], b'\x00\x00\x00\x00'))[0] or 1
    table['GlobalAlloc'] = lambda e, *a: e.allocator.malloc(max(a[1], 1))
    table['LoadLibraryA'] = lambda e, *a: 0
    table['LoadLibraryW'] = lambda e, *a: 0
    table['GetProcAddress'] = lambda e, *a: 0
    table['FreeLibrary'] = lambda e, *a: 1
    table['FormatMessageA'] = lambda e, *a: 0
    table['FormatMessageW'] = lambda e, *a: 0
    table['MultiByteToWideChar'] = multibyte_to_wide
    table['WideCharToMultiByte'] = wide_to_multibyte
    table['CreateProcessA'] = lambda e, *a: 0
    table['CreateProcessW'] = lambda e, *a: 0
    table['ExitProcess'] = lambda e, *a: (_ for _ in ()).throw(RuntimeError('ExitProcess reached'))
    # DeusEx.dll statically links its CRT, whose malloc/CRT startup uses the
    # Win32 heap and critical sections. These map onto the harness allocator.
    table['GetProcessHeap'] = lambda e, *a: 0x7000
    table['HeapCreate'] = lambda e, *a: 0x7001
    table['HeapDestroy'] = lambda e, *a: 1
    table['HeapAlloc'] = lambda e, *a: e.allocator.malloc(a[2])
    table['HeapReAlloc'] = lambda e, *a: e.allocator.realloc(a[2], a[3])
    table['HeapFree'] = lambda e, *a: (e.allocator.free(a[2]), 1)[1]
    table['HeapSize'] = lambda e, *a: e.allocator.size(a[2])
    table['InitializeCriticalSection'] = lambda e, *a: 0
    table['InitializeCriticalSectionAndSpinCount'] = lambda e, *a: 1
    table['DeleteCriticalSection'] = lambda e, *a: 0
    table['EnterCriticalSection'] = lambda e, *a: 0
    table['LeaveCriticalSection'] = lambda e, *a: 0
    table['TryEnterCriticalSection'] = lambda e, *a: 1
    table['SetUnhandledExceptionFilter'] = lambda e, *a: 0
    table['GetACP'] = lambda e, *a: 1252
    table['GetOEMCP'] = lambda e, *a: 437
    table['GetCPInfo'] = lambda e, *a: 1
    table['GetStringTypeA'] = lambda e, *a: 1
    table['GetStringTypeW'] = lambda e, *a: 1
    table['LCMapStringA'] = lambda e, *a: 0
    table['LCMapStringW'] = lambda e, *a: 0
    table['GetLocaleInfoA'] = lambda e, *a: 0
    table['GetLocaleInfoW'] = lambda e, *a: 0
    table['GetModuleHandleA'] = lambda e, *a: 0x10000000
    table['GetModuleHandleW'] = lambda e, *a: 0x10000000
    return table


KERNEL32 = KERNEL32_TABLE()

KERNEL32_ARGS = {
    'GetModuleFileNameA': 3, 'GetModuleFileNameW': 3, 'GetCurrentProcess': 0,
    'GetLastError': 0, 'GetTickCount': 0, 'timeGetTime': 0, 'Sleep': 1,
    'QueryPerformanceCounter': 1, 'QueryPerformanceFrequency': 1, 'GlobalMemoryStatus': 1,
    'GetSystemDefaultLangID': 0, 'GetVersionExA': 1, 'GetVersionExW': 1,
    'SetConsoleCtrlHandler': 2, 'GetComputerNameA': 2, 'GetComputerNameW': 2,
    'GetUserNameA': 2, 'GetUserNameW': 2, 'GetLocalTime': 1, 'GetSystemInfo': 1,
    'GetProcessWorkingSetSize': 3, 'GlobalAlloc': 2, 'LoadLibraryA': 1, 'LoadLibraryW': 1,
    'GetProcAddress': 2, 'FreeLibrary': 1, 'FormatMessageA': 7, 'FormatMessageW': 7,
    'MultiByteToWideChar': 6, 'WideCharToMultiByte': 8, 'CreateProcessA': 10,
    'CreateProcessW': 10, 'ExitProcess': 1,
    'GetProcessHeap': 0, 'HeapCreate': 3, 'HeapDestroy': 1, 'HeapAlloc': 3,
    'HeapReAlloc': 4, 'HeapFree': 3, 'HeapSize': 3,
    'InitializeCriticalSection': 1, 'InitializeCriticalSectionAndSpinCount': 2,
    'DeleteCriticalSection': 1, 'EnterCriticalSection': 1, 'LeaveCriticalSection': 1,
    'TryEnterCriticalSection': 1, 'SetUnhandledExceptionFilter': 1,
}


def main():
    argv = sys.argv[1:]
    args = [a for a in argv if not a.startswith('--')]
    options = {a.split('=', 1)[0][2:]: a.split('=', 1)[1] for a in argv if a.startswith('--') and '=' in a}
    debug = '--debug' in argv
    as_json = '--json' in argv
    package_load = '--package-load' in argv
    say = (lambda *a: None) if as_json else print
    if '--help' in argv:
        print('usage: native-boot-replay.py [GAME_ROOT] [--json] [--debug] '
              '[--package-load] [--packages=Core,Engine,...] [--budget=N] '
              '[--package-budget=N] [--out=PATH]')
        return
    root = Path(args[0]) if args else Path('Deus Ex GOTY Edition')
    boot = BootReplay(root, ranged=not (debug or '--trace-fname' in argv))
    if 'budget' in options:
        boot.instruction_budget = int(options['budget'])
    if as_json:
        boot.log = lambda *a: None
    package_names = options.get('packages', 'Core').split(',') if package_load else []
    static_dlls = ('core.dll', 'engine.dll', 'window.dll')
    for label, file, preferred, rebased, ranges in NATIVE_DLLS:
        if file.lower() in static_dlls:
            delta = rebased - preferred
            for start, end in ranges:
                ptrs = boot.read_init_array(start + delta, end + delta)
                say(f'{label} static initializers: {len(ptrs)} ({sum(1 for p in ptrs if p)} non-null)')
                boot.run_initializers(ptrs, stop_on_failure=False)
        elif not package_load:
            boot.load_dll(file)
            say(f'{label} loaded via appGetDllHandle')
    say(f'initializer failures: {len(boot.failures)}')
    for failure in boot.failures[:15]:
        say('  fail', failure)
    if debug:
        boot.dump_queue()
    # appInit calls FName::StaticInit (0x1014bbc0) before the drain: it zeroes
    # the 4096 buckets and seeds the hardcoded name table (None at index 0).
    boot.call(0x1014bbc0, 0, b'')
    # Drain the registration queue exactly as appInit does.
    boot.write(REG_GATE, 'I', 1)
    boot.debug_makeunique = debug
    boot.debug_add = debug
    boot.trace_fname = '--trace-fname' in sys.argv
    boot.trace_low = debug
    boot.debug_mode = debug or boot.trace_fname
    boot.bad = None
    try:
        if package_load:
            # UObject::StaticInit drains the queue and creates the transient
            # package that GetPackageLinker uses as the linker Outer.
            boot.call(0x101011c7, 0, b'')
        else:
            boot.write(REG_GATE, 'I', 1)
            boot.call(PROCESS_REGISTRANTS, 0, b'')
    except Exception as error:
        if boot.bad:
            address, eip = boot.bad
            say(f'ProcessRegistrants bad memory {address:#010x} at eip {eip:#010x} '
                f'regs={ {k: hex(v) for k, v in boot.bad_regs.items()} }')
        say(f'ProcessRegistrants failed: {type(error).__name__}: {error}')
        if debug:
            say('trace head', list(boot.trace)[:24])
            say('trace tail', list(boot.trace)[-40:])
    if package_load:
        boot.log_archive = True
        package_budget = int(options['package-budget']) if 'package-budget' in options else boot.instruction_budget
        boot.drive_package_load(package_names, budget=package_budget)
    rows = boot.index_table()
    payload = {'objectCount': len(rows), 'nameCount': boot.read(GNAMES + 4, 'I')[0], 'objects': rows}
    if 'out' in options:
        Path(options['out']).write_text(json.dumps(payload, indent=1))
        say(f'wrote {options["out"]} ({len(rows)} objects)')
    elif as_json:
        print(json.dumps(payload, indent=1))
    else:
        boot.dump_objects(limit=80)
    say(f'name count={boot.read(GNAMES + 4, "I")[0]}, '
        f'registration queue head={boot.read(0x102a265c, "I")[0]:#x}')



if __name__ == '__main__':
    main()
