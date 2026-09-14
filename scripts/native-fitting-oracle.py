"""Execute original FindSpot and AdjustSpot with controlled point/line queries.

Original math and decision instructions execute from the hash-gated local DLLs.
The default mode supplies explicit query results; it does not prove a world
query implementation. Query arguments and their order are retained for comparison.
"""
import importlib.util
import json
from pathlib import Path
import struct
import sys

spec = importlib.util.spec_from_file_location('native_collision', Path(__file__).with_name('native-collision-oracle.py'))
collision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collision)

pool_spec = importlib.util.spec_from_file_location('oracle_pool', Path(__file__).with_name('oracle_pool.py'))
oracle_pool = importlib.util.module_from_spec(pool_spec)
pool_spec.loader.exec_module(oracle_pool)


class NativeFitting(collision.NativeCollision):
    def __init__(self, root):
        super().__init__(root)
        self.events = None
        self.level, self.info, self.vtable = self.alloc(0x1000), self.alloc(0x1000), self.alloc(0x200)
        self.actor_table, self.location = self.alloc(16), self.alloc(12)
        self.line_thunk, self.point_thunk = 0x700fe000, 0x700fe010
        self.cpu.mem_write(self.line_thunk, bytes.fromhex('c2 24 00'))
        self.cpu.mem_write(self.point_thunk, bytes.fromhex('c2 28 00'))
        self.write(self.level, 'I', self.vtable)
        self.write(self.level + 0x2c, 'III', self.actor_table, 1, 1)
        self.write(self.actor_table, 'I', self.info)
        self.write(self.info + 0x24, 'I', 0x1057bf00)
        self.write(self.vtable + 0xc0, 'I', self.line_thunk)
        self.write(self.vtable + 0xbc, 'I', self.point_thunk)
        self.write(self.vtable + 0xb4, 'I', 0x10398360)  # Execute original AdjustSpot.

    def on_instruction(self, cpu, address, size, data):
        if self.events is None or address not in [self.line_thunk, self.point_thunk]:
            return super().on_instruction(cpu, address, size, data)
        stack = cpu.reg_read(collision.UC_X86_REG_ESP)
        if address == self.line_thunk:
            hit, source, end, start, flags = self.read(stack + 4, '5I')
            if source:
                raise RuntimeError('Unexpected line source actor')
            self.events.append({'line': {'start': list(self.read(start, '3f')), 'end': list(self.read(end, '3f')),
                                         'extent': list(self.read(stack + 24, '3f')), 'flags': flags,
                                         'extra': self.read(stack + 36, 'I')[0]}})
            response = self.case['lines'][self.line_index]
            self.line_index += 1
            self.write(hit + 36, 'f', response['time'])
            self.write(hit + 20, '3f', *response['normal'])
            cpu.reg_write(collision.UC_X86_REG_EAX, int(response['time'] == 1))
        else:
            flags, actor, extra = self.read(stack + 32, '3I')
            if actor != self.info:
                raise RuntimeError('Unexpected point actor')
            self.events.append({'point': {'position': list(self.read(stack + 8, '3f')),
                                          'extent': list(self.read(stack + 20, '3f')), 'flags': flags, 'extra': extra}})
            response = self.case['points'][self.point_index]
            self.point_index += 1
            cpu.reg_write(collision.UC_X86_REG_EAX, response)

    def fit(self, case):
        self.case, self.line_index, self.point_index = case, 0, 0
        self.write(self.location, '3f', *case['position'])
        self.events = []
        result = self.call(0x10398480, self.level, struct.pack('<3fIii', *case['extent'], self.location, *case['options']))
        output = {'success': bool(result), 'position': list(self.read(self.location, '3f')), 'events': self.events}
        self.events = None
        return output


class NativeWorldFitting(NativeFitting):
    """Execute the complete original level/model query chain for BSP-only cases.

    The actor collision hash is absent, so these cases explicitly exclude movers
    and actor cylinders. Sorting zero/one result needs no comparisons; a checked
    CRT qsort bridge rejects any larger input. Original stack allocation executes
    against a bounded, preallocated GMem arena.
    """
    def __init__(self, root, model):
        super().__init__(root)
        self.pending = []
        native_model = self.model(model)
        model_vtable = self.alloc(0x100)
        self.write(model_vtable + 0x54, 'I', 0x103f1570)
        self.write(model_vtable + 0x58, 'I', 0x103f3c20)
        self.write(native_model, 'I', model_vtable)
        self.write(self.level + 0x98, 'I', native_model)
        self.write(self.info + 0xac, 'I', self.level)
        for offset, address in [(0xc0, 0x1039aed0), (0xbc, 0x1039aac0), (0xc4, 0x1039acc0), (0xc8, 0x1039b220)]:
            self.write(self.vtable + offset, 'I', address)
        memory = self.read(0x10599bd8, 'I')[0]
        arena = self.alloc(0x100000)
        self.write(memory, '4I', arena, arena + 0x100000, 0, 0)
        self.sort_thunks = {address for address, symbol in self.thunks.items() if symbol == ('msvcrt.dll', 'qsort')}
        for address in self.sort_thunks:
            self.cpu.mem_write(address, b'\xc3')

    def on_instruction(self, cpu, address, size, data):
        if address in getattr(self, 'sort_thunks', set()):
            stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            if self.read(stack + 8, 'I')[0] > 1:
                raise RuntimeError('The BSP-only qsort bridge rejects more than one result')
            return
        if self.events is not None:
            stack = cpu.reg_read(collision.UC_X86_REG_ESP)
            if self.pending and address == self.pending[-1]['return']:
                pending = self.pending.pop()
                result = self.result(cpu.reg_read(collision.UC_X86_REG_EAX), pending['hit'])
                self.events[pending['index']]['result'] = result
            if address in [0x1039aed0, 0x1039aac0]:
                hit = self.read(stack + 4, 'I')[0]
                if address == 0x1039aed0:
                    source, end, start, flags = self.read(stack + 8, '4I')
                    if source:
                        raise RuntimeError('Unexpected ray source actor')
                    event = {'line': {'start': list(self.read(start, '3f')), 'end': list(self.read(end, '3f')),
                                      'extent': list(self.read(stack + 24, '3f')), 'flags': flags,
                                      'extra': self.read(stack + 36, 'I')[0]}}
                else:
                    flags, actor, extra = self.read(stack + 32, '3I')
                    if actor != self.info:
                        raise RuntimeError('Unexpected point actor')
                    event = {'point': {'position': list(self.read(stack + 8, '3f')),
                                       'extent': list(self.read(stack + 20, '3f')), 'flags': flags, 'extra': extra}}
                self.pending.append({'return': self.read(stack, 'I')[0], 'hit': hit, 'index': len(self.events)})
                self.events.append(event)
        return super().on_instruction(cpu, address, size, data)


_WORKER = None


def _worker_init(root, model_path):
    """Per-worker probe; each Unicorn instance lives in exactly one process."""
    global _WORKER
    _WORKER = (NativeWorldFitting(Path(root), json.loads(Path(model_path).read_text()))
               if model_path else NativeFitting(Path(root)))


def _worker_case(case):
    return _WORKER.fit(case)


if __name__ == '__main__':
    if len(sys.argv) not in [3, 4]:
        sys.exit('Usage: native-fitting-oracle.py GAME_ROOT CASES_JSON [WORLD_MODEL_JSON]')
    # The FindSpot case list is the validate critical path: shard it across
    # worker probes and join the results in input order — identical to the
    # serial run by construction.
    results = oracle_pool.pooled_map(_worker_case, _worker_init,
                                     (sys.argv[1], sys.argv[3] if len(sys.argv) == 4 else None),
                                     json.loads(Path(sys.argv[2]).read_text()))
    print(json.dumps({'hashes': collision.HASHES, 'results': results}))
