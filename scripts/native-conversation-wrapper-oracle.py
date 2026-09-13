"""Execute the three original DeusEx ConBindEvents bodies with explicit services.

This probe maps the hash-checked GOTY Engine/Core pair and DeusEx.dll at its
preferred image base.  The body itself performs actor-class walking and all
mission/path decisions.  Only the imported boundaries that cannot be run
without a live Unreal process are serviced here: appStricmp, appStrcpy,
appSprintf, GLog.Logf, StaticLoadObject, and DConversationList.BindConversations.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP

_spec = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
native = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(native)


DEUS_EX_HASH = 'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04'
DEUS_EX = {'hash': DEUS_EX_HASH, 'base': 0x10000000}

# These are the body entry points called by the generated exec wrappers.  The
# wrappers only consume EndFunctionParms and then call the corresponding body;
# calling the no-argument bodies keeps this probe at the recovered contract.
BODIES = {
    'Player': 0x10014320,
    'Decoration': 0x1000ea50,
    'ScriptedPawn': 0x10019140,
}

IAT = {
    'sprintf': 0x10027100,
    'strcpy': 0x10027104,
    'stricmp': 0x10027108,
    'logf': 0x1002710c,
    'glog': 0x10027110,
    'conversationClass': 0x10027004,
    'staticLoadObject': 0x100270fc,
    'bindConversations': 0x10027014,
}

TARGET_LEVEL_INFO_CLASS = 0x1003A0D8
GLOG_FIRST_WORD = 0xfeedface


class WrapperProbe(native.NativeCollision):
    """Run original body instructions while recording each imported service."""

    def __init__(self, root):
        super().__init__(Path(root), {'DeusEx.dll': DEUS_EX})
        self.services = {}
        self.next_service = 0x700F0000
        self.events = []
        self.current = None

        # ConBindEvents reads GLog's first word only to pass it as the hidden
        # vararg receiver used by the original Logf call sequence.  A fake
        # object makes that read explicit while keeping Logf itself serviced.
        self.glog = self.alloc(8)
        self.write(self.glog, 'I', GLOG_FIRST_WORD)
        self.write(IAT['glog'], 'I', self.glog)

        # StaticLoadObject receives the imported DConversationList class
        # pointer.  No ConSys.dll mapping is needed when this pointer and the
        # BindConversations call are explicit boundaries.
        self.conversation_class = self.alloc(8)
        self.write(IAT['conversationClass'], 'I', self.conversation_class)

        self._patch_service(IAT['sprintf'], 'sprintf', b'\xc3')
        self._patch_service(IAT['strcpy'], 'strcpy', b'\xc3')
        self._patch_service(IAT['stricmp'], 'stricmp', b'\xc3')
        self._patch_service(IAT['logf'], 'logf', b'\xc3')
        self._patch_service(IAT['staticLoadObject'], 'staticLoadObject', b'\xc3')
        # BindConversations is __thiscall and its callee removes the Actor
        # argument before the caller's epilogue proceeds.
        self._patch_service(IAT['bindConversations'], 'bindConversations', b'\xc2\x04\x00')

    def _patch_service(self, iat, name, code):
        address = self.next_service
        self.next_service += 0x10
        self.cpu.mem_write(address, code)
        # NativeCollision treats unresolved thunks as failures.  These are
        # deliberately resolved, synchronous boundary implementations.
        self.thunks.pop(address, None)
        self.services[address] = name
        self.write(iat, 'I', address)

    def _utf16(self, address):
        """Read a terminated original TCHAR string (all three bodies are Unicode)."""
        units = []
        for _ in range(4096):
            unit = self.read(address, 'H')[0]
            if unit == 0:
                return ''.join(chr(value) for value in units)
            units.append(unit)
            address += 2
        raise RuntimeError('unterminated TCHAR string in wrapper service')

    def _put_utf16(self, address, text):
        raw = text.encode('utf-16-le') + b'\x00\x00'
        self.cpu.mem_write(address, raw)
        return len(text)

    @staticmethod
    def _compare(left, right):
        # appStricmp is the Core case-insensitive TCHAR comparator.  The body
        # only tests zero/nonzero; this code preserves the usual signed lexical
        # result for the recorded boundary as well.
        left = left.lower()
        right = right.lower()
        for a, b in zip(left, right):
            if a != b:
                return ord(a) - ord(b)
        return len(left) - len(right)

    def _service(self, cpu, address):
        name = self.services[address]
        stack = cpu.reg_read(UC_X86_REG_ESP)

        if name == 'stricmp':
            left_pointer, right_pointer = self.read(stack + 4, '2I')
            left, right = self._utf16(left_pointer), self._utf16(right_pointer)
            result = self._compare(left, right)
            self.events.append({
                'op': 'stricmp', 'left': left, 'right': right,
                'equal': result == 0, 'result': result,
            })
            cpu.reg_write(native.UC_X86_REG_EAX, result & 0xffffffff)
            return

        if name == 'strcpy':
            destination, source = self.read(stack + 4, '2I')
            text = self._utf16(source)
            self._put_utf16(destination, text)
            self.events.append({'op': 'strcpy', 'source': text, 'destination': 'prefix'})
            return

        if name == 'sprintf':
            destination, format_pointer = self.read(stack + 4, '2I')
            format_text = self._utf16(format_pointer)
            if format_text == 'ConList_Mission%02d':
                mission = self.read(stack + 12, 'i')[0]
                result = format_text.replace('%02d', f'{mission:02d}')
                arguments = [mission]
                destination_name = 'mission'
            elif format_text == '%sText.%s':
                prefix_pointer, mission_pointer = self.read(stack + 12, '2I')
                prefix, mission = self._utf16(prefix_pointer), self._utf16(mission_pointer)
                result = f'{prefix}Text.{mission}'
                arguments = [prefix, mission]
                destination_name = 'path'
            else:
                raise RuntimeError(f'unexpected appSprintf format: {format_text!r}')
            self._put_utf16(destination, result)
            self.events.append({
                'op': 'sprintf', 'format': format_text,
                'arguments': arguments, 'result': result,
                'destination': destination_name,
            })
            cpu.reg_write(native.UC_X86_REG_EAX, len(result))
            return

        if name == 'logf':
            # The recovered call pushes GLog's first word followed by the
            # diagnostic format.  Preserve both values so an accidental plain
            # Logf stub cannot silently satisfy the probe.
            hidden, format_pointer = self.read(stack + 4, '2I')
            if hidden != GLOG_FIRST_WORD:
                raise RuntimeError(f'unexpected GLog hidden argument {hidden:#x}')
            message = self._utf16(format_pointer)
            self.events.append({'op': 'logf', 'message': message})
            return

        if name == 'staticLoadObject':
            class_pointer, outer, path_pointer, filename, flags, sandbox = self.read(stack + 4, '6I')
            if class_pointer != self.conversation_class:
                raise RuntimeError('StaticLoadObject received an unexpected ConversationList class')
            if outer != 0 or filename != 0 or flags != 2 or sandbox != 0:
                raise RuntimeError('StaticLoadObject argument contract changed')
            path = self._utf16(path_pointer)
            loaded = bool(self.current['loaded'])
            self.events.append({
                'op': 'staticLoadObject', 'class': 'consys.conversationlist',
                'outer': None, 'path': path, 'filename': None,
                'flags': flags, 'sandbox': None, 'loaded': loaded,
            })
            cpu.reg_write(native.UC_X86_REG_EAX, self.loaded_pointer if loaded else 0)
            return

        if name == 'bindConversations':
            conversation_list = cpu.reg_read(UC_X86_REG_ECX)
            actor = self.read(stack + 4, 'I')[0]
            if conversation_list != self.loaded_pointer or actor != self.current['receiver']:
                raise RuntimeError('BindConversations receiver/actor mismatch')
            self.events.append({'op': 'bindConversations', 'list': 'loaded', 'actor': 'receiver'})
            return

        raise RuntimeError(f'unhandled wrapper service {name}')

    def on_instruction(self, cpu, address, size, data):
        if address in self.services:
            self._service(cpu, address)
        return super().on_instruction(cpu, address, size, data)

    def _string_field(self, info, package):
        if package == '':
            self.write(info + 0x37c, 'I', 0)
            self.write(info + 0x380, 'I', 0)
            return
        raw = package.encode('utf-16-le') + b'\x00\x00'
        pointer = self.alloc(len(raw))
        self.cpu.mem_write(pointer, raw)
        self.write(info + 0x37c, 'I', pointer)
        self.write(info + 0x380, 'I', len(package) + 1)

    def _actor_chain(self, actor_kinds, mission, package):
        """Build the exact XLevel/Actors/Class/Super graph read by the body."""
        receiver = self.alloc(0x500)
        level = self.alloc(0x100)
        actor_data = self.alloc(max(4, len(actor_kinds) * 4))
        self.write(receiver + 0xac, 'I', level)
        self.write(level + 0x2c, 'I', actor_data)
        self.write(level + 0x30, 'I', len(actor_kinds))

        info = None
        for index, kind in enumerate(actor_kinds):
            if kind == 'null':
                self.write(actor_data + index * 4, 'I', 0)
                continue
            candidate = self.alloc(0x500)
            class_record = self.alloc(0x40)
            if kind == 'level-info':
                class_pointer = TARGET_LEVEL_INFO_CLASS
                info = candidate
            elif kind == 'level-info-subclass':
                class_pointer = class_record
                self.write(class_record + 0x28, 'I', TARGET_LEVEL_INFO_CLASS)
                info = candidate
            elif kind == 'generic':
                class_pointer = class_record
                self.write(class_record + 0x28, 'I', 0)
            else:
                raise RuntimeError(f'unknown actor graph kind {kind!r}')
            self.write(candidate + 0x24, 'I', class_pointer)
            self.write(actor_data + index * 4, 'I', candidate)

        if info is not None:
            self.write(info + 0x33c, 'i', mission)
            self._string_field(info, package)
        return receiver, info

    def run_case(self, body_name, spec):
        self.events = []
        self.current = spec
        self.loaded_pointer = self.alloc(0x80)
        receiver, info = self._actor_chain(spec['actors'], spec['mission'], spec['package'])
        self.current['receiver'] = receiver
        self.call(BODIES[body_name], receiver, b'')
        return {
            'body': body_name,
            'case': spec['case'],
            'mission': spec['mission'],
            'package': spec['package'],
            'loaded': bool(spec['loaded']),
            'foundLevelInfo': info is not None,
            'events': self.events,
        }


CASES = [
    {
        'case': 'missing-level-info', 'actors': ['null', 'generic'],
        'mission': 0, 'package': 'DeusExConversations', 'loaded': True,
    },
    {
        'case': 'negative-mission', 'actors': ['generic', 'level-info'],
        'mission': -1, 'package': 'DeusExConversations', 'loaded': True,
    },
    {
        'case': 'default-package-alias', 'actors': ['null', 'level-info'],
        'mission': 0, 'package': 'DeusExConversations', 'loaded': True,
    },
    {
        'case': 'default-package-alias-case-insensitive',
        'actors': ['generic', 'level-info-subclass'],
        'mission': 7, 'package': 'dEuSeXcOnVeRsAtIoNs', 'loaded': True,
    },
    {
        'case': 'custom-package-prefix', 'actors': ['generic', 'level-info'],
        'mission': 12, 'package': 'MyConversationPack', 'loaded': True,
    },
    {
        'case': 'empty-package', 'actors': ['level-info'],
        'mission': 2, 'package': '', 'loaded': True,
    },
    {
        'case': 'loaded-null', 'actors': ['level-info'],
        'mission': 3, 'package': 'DeusExConversations', 'loaded': False,
    },
]


def main():
    if len(sys.argv) != 2:
        sys.exit('Usage: native-conversation-wrapper-oracle.py GAME_ROOT')
    probe = WrapperProbe(sys.argv[1])
    results = []
    for spec in CASES:
        for body_name in BODIES:
            # Each case mutates only the probe's current service context; copy
            # the dictionary so receiver pointers do not leak between runs.
            results.append(probe.run_case(body_name, dict(spec)))
    print(json.dumps({
        'hashes': {'Engine.dll': native.HASHES['Engine.dll'],
                   'Core.dll': native.HASHES['Core.dll'],
                   'DeusEx.dll': DEUS_EX_HASH},
        'bodies': {name: hex(address) for name, address in BODIES.items()},
        'results': results,
    }))


if __name__ == '__main__':
    main()
