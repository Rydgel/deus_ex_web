"""Execute the original ULinkerLoad lazy-loader bodies in x86 Unicorn.

The oracle runs Core.dll's ULinkerLoad::AttachLazyLoader,
ULinkerLoad::DetachLazyLoader and ULinkerLoad::DetachAllLazyLoaders bodies.  FArray::Realloc, FArray::Remove, the
reader Tell slot and GLog::Logf are explicit harness boundaries: their
arguments and publication order are recorded, and the small array operations
are serviced by the probe so the original linker bodies can complete.  No
reader or allocator implementation is inferred from a browser substitute.
"""

import importlib.util
import json
from pathlib import Path
import struct
import sys

_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


ATTACH_BODY = 0x10162BF0
DETACH_BODY = 0x10162DD0
DETACH_ALL_BODY = 0x10162F80      # ULinkerLoad::DetachAllLazyLoaders(INT Load); this = the linker.
ARCHIVE_VTABLE = 0x1017A430
ARRAY_OFFSET = 0x4D8              # ULinkerLoad +0x4d8 == archive +0x434.
READER_OFFSET = 0x4E4             # ULinkerLoad +0x4e4 == archive +0x440.
TELL_BODY = 0x10163110
TELL_STUB = 'reader-tell'
REALLOC_BODY = 0x10145440
REMOVE_BODY = 0x101454F0
LOG_BODY = 0x101453E0
LOG_FORMAT = 0x101B0F44
LOG_GLOBAL = 0x101A7C38
LOG_FALLBACK_NAME = 0x101EF654


DEFAULT_CASES = [
    {
        'id': 'attach-empty',
        'initial': [],
        'max': 0,
        'operations': [{'operation': 'attach', 'loader': 'A', 'tell': 0x1234}],
    },
    {
        'id': 'attach-with-capacity',
        'initial': ['A'],
        'max': 4,
        'operations': [{'operation': 'attach', 'loader': 'B', 'tell': 0x2345}],
    },
    {
        'id': 'detach-duplicates-and-missing',
        'initial': ['A', 'A', 'B'],
        'max': 3,
        'operations': [
            {'operation': 'detach', 'loader': 'A'},
            {'operation': 'detach', 'loader': 'C'},
        ],
    },
    {
        # ULinkerLoad::Destroy's call: every loader's SavedAr/SavedPos zeroed, the array emptied.
        'id': 'detach-all',
        'initial': ['A', 'B', 'A'],
        'max': 5,
        'operations': [{'operation': 'detachAll', 'load': 0}],
    },
]


class LinkerLazyLoaderProbe(_NATIVE.NativeCollision):
    """Run the two concrete Core bodies with narrow helper stubs."""

    def __init__(self, root):
        super().__init__(Path(root))
        self.events = []
        self.linker = None
        self.current_operation = None
        self.tell_value = 0
        self.tell_stub = self.alloc(16)
        self.cpu.mem_write(self.tell_stub, b'\xc3')

    def return_from_call(self, stack_pop):
        sp = self.cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
        return_address = self.read(sp, 'I')[0]
        self.cpu.reg_write(_NATIVE.UC_X86_REG_ESP, sp + stack_pop)
        self.cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def array_header(self, array):
        return self.read(array, '3I')

    def array_values(self, array, count=None):
        data, num, _ = self.array_header(array)
        count = num if count is None else count
        if not data:
            return []
        return [self.read(data + index * 4, 'I')[0] for index in range(count)]

    def emulate_realloc(self, array, element_size, source):
        data, num, max_count = self.array_header(array)
        before = self.array_values(array, num)
        byte_count = max_count * element_size
        # The attach cases always have positive Max.  A zero-sized native
        # realloc result is an allocator-owned boundary, so keep it null rather
        # than claiming a browser allocation result.
        new_data = self.alloc(byte_count) if byte_count else 0
        if new_data:
            for index, value in enumerate(before):
                self.write(new_data + index * element_size, 'I', value)
        self.write(array, 'I', new_data)
        self.events.append({
            'operation': 'array-realloc',
            'address': REALLOC_BODY,
            'source': source,
            'arrayOffset': array - self.linker,
            'elementSize': element_size,
            'num': num,
            'max': max_count,
            'oldData': data,
            'newData': new_data,
            'valuesBefore': before,
        })

    def emulate_remove(self, array, index, count, element_size):
        data, num, max_count = self.array_header(array)
        before = self.array_values(array, num)
        if count != 1 or element_size != 4:
            raise ValueError('The ULinkerLoad body must call FArray::Remove(index,1,4)')
        if index < 0 or index + count > num:
            raise ValueError('Native Remove boundary received an invalid index')
        after = before[:index] + before[index + count:]
        for position, value in enumerate(after):
            self.write(data + position * element_size, 'I', value)
        new_num = num - count
        self.write(array + 4, 'I', new_num)
        shrunk = False
        # This is the visible FArray::Remove condition.  The focused fixture
        # keeps Max=3, so it does not cross the allocator's zero-size branch.
        if (3 * new_num) < (2 * max_count) and (max_count - new_num > 0x40 or new_num == 0):
            self.write(array + 8, 'I', new_num)
            shrunk = True
            self.emulate_realloc(array, element_size, 'remove')
        self.events.append({
            'operation': 'array-remove',
            'address': REMOVE_BODY,
            'arrayOffset': array - self.linker,
            'index': index,
            'count': count,
            'elementSize': element_size,
            'numBefore': num,
            'maxBefore': max_count,
            'valuesBefore': before,
            'valuesAfter': after,
            'numAfter': new_num,
            'maxAfter': self.read(array + 8, 'I')[0],
            'shrunk': shrunk,
        })

    def on_instruction(self, cpu, address, size, data):
        if address == self.tell_stub:
            self.events.append({
                'operation': 'reader-tell',
                'address': TELL_BODY,
                'slot': 0x28,
                'value': self.tell_value,
            })
            cpu.reg_write(_NATIVE.UC_X86_REG_EAX, self.tell_value)
            return super().on_instruction(cpu, address, size, data)

        if address == REALLOC_BODY:
            array = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
            element_size = self.read(stack + 4, 'I')[0]
            self.emulate_realloc(array, element_size, self.current_operation)
            # Realloc is thiscall with ret 4; skip the allocator body while
            # preserving the caller's exact return convention.
            self.return_from_call(8)
            return

        if address == REMOVE_BODY:
            array = cpu.reg_read(_NATIVE.UC_X86_REG_ECX)
            stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
            index, count, element_size = [self.read(stack + 4 + 4 * i, 'I')[0] for i in range(3)]
            self.emulate_remove(array, index, count, element_size)
            # Remove is thiscall with ret 0xc.
            self.return_from_call(16)
            return

        if address == LOG_BODY:
            stack = cpu.reg_read(_NATIVE.UC_X86_REG_ESP)
            # This call is serviced as an explicit FOutputDevice boundary.  A
            # cdecl body leaves its four pushed arguments for the caller.
            self.events.append({
                'operation': 'logf',
                'address': LOG_BODY,
                'formatAddress': self.read(stack + 8, 'I')[0],
                'removed': self.read(stack + 12, 'I')[0],
                'nameAddress': self.read(stack + 16, 'I')[0],
                'globalAddress': LOG_GLOBAL,
            })
            self.return_from_call(0)
            return

        return super().on_instruction(cpu, address, size, data)

    def setup(self, initial, max_count, tell):
        self.linker = self.alloc(0x600)
        self.cpu.mem_write(self.linker, b'\0' * 0x600)
        archive = self.linker + 0xA4
        self.write(archive, 'I', ARCHIVE_VTABLE)

        reader = self.alloc(0x100)
        reader_vtable = self.alloc(0x100)
        self.cpu.mem_write(reader, b'\0' * 0x100)
        self.cpu.mem_write(reader_vtable, b'\0' * 0x100)
        self.write(reader_vtable + 0x28, 'I', self.tell_stub)
        self.write(reader, 'I', reader_vtable)
        self.write(self.linker + READER_OFFSET, 'I', reader)

        # Detach's format string is passed through GLog.  Supplying a valid
        # filename Data/Num pair exercises the native selected-name branch;
        # Logf itself remains an explicit boundary and is not guessed.
        self.write(LOG_GLOBAL, 'I', 0x2F000000)
        self.write(self.linker + 0x94, 'I', 0x2F000100)
        self.write(self.linker + 0x98, 'I', 1)

        if initial:
            data = self.alloc(max(1, max_count * 4))
            for index, value in enumerate(initial):
                self.write(data + index * 4, 'I', value)
        else:
            data = 0
        self.write(self.linker + ARRAY_OFFSET, '3I', data, len(initial), max_count)
        self.tell_value = tell
        return archive

    def allocate_loader(self, initial_value=0x11111111, saved_position=0x22222222):
        loader = self.alloc(0x20)
        self.write(loader + 4, 'I', initial_value)
        self.write(loader + 8, 'I', saved_position)
        return loader

    def run_native(self, archive, operation, loader, load=0):
        before = len(self.events)
        self.current_operation = operation
        if operation == 'detachAll':
            self.call(DETACH_ALL_BODY, self.linker, struct.pack('<I', load))
        else:
            self.call(ATTACH_BODY if operation == 'attach' else DETACH_BODY, archive, struct.pack('<I', loader))
        return self.events[before:]

    def loaders(self, symbols):
        return {name: {'archive': self.read(loader + 4, 'I')[0], 'savedPosition': self.read(loader + 8, 'I')[0]}
                for name, loader in symbols.items()}

    def state(self, loader):
        data, num, max_count = self.array_header(self.linker + ARRAY_OFFSET)
        return {
            'array': {
                'data': data,
                'num': num,
                'max': max_count,
                'values': self.array_values(self.linker + ARRAY_OFFSET, num),
            },
            'loader': {
                'archive': self.read(loader + 4, 'I')[0],
                'savedPosition': self.read(loader + 8, 'I')[0],
            },
        }

    def execute_cases(self, cases):
        results = []
        for case in cases:
            symbols = {}

            def symbol(name):
                if name not in symbols:
                    symbols[name] = self.allocate_loader()
                return symbols[name]

            initial_names = case.get('initial', [])
            initial = [symbol(name) for name in initial_names]
            max_count = int(case.get('max', len(initial)))
            operations = case.get('operations') or [case]
            tell = int(case.get('tell', 0))
            archive = self.setup(initial, max_count, tell)
            operation_results = []
            for operation in operations:
                kind = operation.get('operation', case.get('operation'))
                if kind not in ('attach', 'detach', 'detachAll'):
                    raise ValueError(f'Unsupported oracle operation {kind!r}')
                loader = symbol(operation.get('loader', case.get('loader', 'A')))
                if 'tell' in operation:
                    self.tell_value = int(operation['tell'])
                self.events = []
                native_events = self.run_native(archive, kind, loader, int(operation.get('load', 0)))
                state = self.state(loader)
                names = {value: name for name, value in symbols.items()}
                state['array']['names'] = [names.get(value) for value in state['array']['values']]
                operation_results.append({
                    'operation': kind,
                    'loaderName': operation.get('loader', case.get('loader', 'A')),
                    'events': native_events,
                    'state': state,
                    'loaders': self.loaders(symbols),
                })
            results.append({'id': case.get('id', f'case-{len(results)}'), 'operations': operation_results})
        return results


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit('Usage: native-linker-lazy-loader-oracle.py GAME_ROOT [CASES_JSON]')
    cases = DEFAULT_CASES if len(sys.argv) == 2 else json.loads(Path(sys.argv[2]).read_text())
    probe = LinkerLazyLoaderProbe(Path(sys.argv[1]))
    print(json.dumps({
        'hashes': _NATIVE.HASHES,
        'contract': {
            'attachBody': ATTACH_BODY,
            'detachBody': DETACH_BODY,
            'detachAllBody': DETACH_ALL_BODY,
            'archiveVtable': ARCHIVE_VTABLE,
            'arrayOffset': ARRAY_OFFSET,
            'reallocBody': REALLOC_BODY,
            'removeBody': REMOVE_BODY,
            'tellBody': TELL_BODY,
            'logFormat': LOG_FORMAT,
        },
        'results': probe.execute_cases(cases),
    }))


if __name__ == '__main__':
    main()
