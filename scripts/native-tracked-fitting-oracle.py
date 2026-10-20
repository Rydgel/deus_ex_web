"""Engine's ULevel::FindSpot over the tracked Level->Model and the real collision hash.

native-level-oracle.py builds the original level (hash, SetActorCollision, every
bCollideActors actor with its brush through ABrush::ToWorld, the model's
PointCheck / LineCheck) and runs the unchanged FindSpot (0x10398480) on it. This
oracle changes two things and records more:

* The level model is given as raw 64-byte FBspNode records ("rawNodes", flat
  words), the nodes the brush tracker left in Level->Model (Play's dump, or
  native-brush-tracker-oracle.py's), instead of the static BSP's nodes.
* The actors' values are the scene's own (current Location, Rotation, ...).
* Every query word is reported as bits ("w" lists), so NaN payloads and signed
  zeros survive JSON, and every call of the chain is listed in order with its
  arguments and result: AdjustSpot, SingleLineCheck, MultiLineCheck, the
  model's LineCheck, the hash's ActorLineCheck (with the cells it visited), the
  primitives' checks and the point checks. A call's `depth` is its nesting.

  native-tracked-fitting-oracle.py GAME_ROOT SCENE_JSON CASES_JSON
  scene: {"model": {"bounds", "rootOutside", "leafHulls", "rawNodes"}, "actors": [...]}
         (native-level-oracle.py's scene; the model's nodes are `rawNodes`)
  cases: [{"position": [3 float bits], "extent": [3 float bits], "options": [2 ints]}] (FindSpot), or with "kind": "line" / "point"
         the SingleLineCheck / SinglePointCheck cases of line() and point() below
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys

_SPEC = importlib.util.spec_from_file_location('native_level', Path(__file__).with_name('native-level-oracle.py'))
_LEVEL = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_LEVEL)
hash_module = _LEVEL.hash_module
UC_X86_REG_ESP = hash_module.UC_X86_REG_ESP
UC_X86_REG_EAX = hash_module.UC_X86_REG_EAX
UC_X86_REG_EBP = hash_module.UC_X86_REG_EBP
from unicorn.x86_const import UC_X86_REG_ESI, UC_X86_REG_ECX, UC_X86_REG_EIP as _EIP, UC_X86_REG_FPCW as _FPCW, UC_X86_REG_FPSW as _FPSW, UC_X86_REG_FPTAG as _FPTAG

# Calls reported, by entry address: (name, argument words read from the stack
# after the return address, then the out structures read back at the return).
SINGLE_LINE, SINGLE_POINT, MULTI_LINE, MULTI_POINT = 0x1039aed0, 0x1039aac0, 0x1039b220, 0x1039acc0
ADJUST_SPOT, MODEL_POINT, MODEL_LINE, HASH_LINE = 0x10398360, 0x103f1570, 0x103f3c20, 0x10359160
PRIM_POINT, PRIM_LINE, TO_WORLD = 0x103d87e0, 0x103d8af0, 0x1030f310
CALLS = {
    ADJUST_SPOT: 'AdjustSpot', SINGLE_LINE: 'SingleLineCheck', SINGLE_POINT: 'SinglePointCheck',
    MULTI_LINE: 'MultiLineCheck', MULTI_POINT: 'MultiPointCheck', MODEL_LINE: 'ModelLineCheck',
    MODEL_POINT: 'ModelPointCheck', HASH_LINE: 'HashActorLineCheck', PRIM_LINE: 'PrimitiveLineCheck',
    PRIM_POINT: 'PrimitivePointCheck',
}
CELL_STORE = 0x1035933c  # NativeHash.query_cells: after the cell range of an ActorLineCheck is stored


class TrackedLevel(_LEVEL.NativeLevel):
    def __init__(self, root, scene):
        self.calls = None
        self.open_calls = []  # (return address, record) of the calls still running
        super().__init__(root, scene)
        self.calls = None

    # The model as raw node words (the tracker's), everything else as native-model.mjs.
    def real_model(self, model):
        if 'rawNodes' not in model:
            return super().real_model(model)
        raw = model['rawNodes']
        count = len(raw) // 16
        address = self.alloc(0x100)
        nodes = self.alloc(64 * count)
        hulls = self.alloc(4 * len(model['leafHulls']))
        self.cpu.mem_write(nodes, struct.pack(f'<{len(raw)}I', *raw))
        self.write(address + 0x58, 'III', nodes, count, count)
        self.write(hulls, str(len(model['leafHulls'])) + 'i', *model['leafHulls'])
        self.write(address + 0xcc, 'III', hulls, len(model['leafHulls']), len(model['leafHulls']))
        self.write(address + 0xf0, 'I', model['rootOutside'])
        self.write(address, 'I', self.model_table)
        bounds = model['bounds']
        self.write(address + 0x28, '6fB', *bounds['min'], *bounds['max'], bounds.get('valid', True))
        return address

    # collision.NativeCollision.call with the instruction budget a request can raise (a NaN walk of the tree is not bounded by the 4M of the other oracles)
    budget = 4000000

    def call(self, address, this, args):
        for reg, value in [(UC_X86_REG_ESP, self.stack), (UC_X86_REG_ECX, this), (_FPCW, self.control_word), (_FPSW, 0), (_FPTAG, 0xffff)]:
            self.cpu.reg_write(reg, value)
        self.write(self.stack, 'I', self.done)
        self.cpu.mem_write(self.stack + 4, args)
        self.cpu.emu_start(address, self.done + 1, count=self.budget)
        if self.cpu.reg_read(_EIP) != self.done:
            raise RuntimeError(f'Native instruction budget ({self.budget}) exceeded')
        return self.cpu.reg_read(UC_X86_REG_EAX)

    def words(self, address, count):
        return list(self.read(address, f'{count}I'))

    def actor_name(self, pointer):
        return self.actor_ids.get(pointer) if pointer else None

    def hit_record(self, hit):
        """An FCheckResult (0x2c bytes) as words: Next, Actor, Location, Normal, Primitive, Time, Item."""
        words = self.words(hit, 11)
        return {'actor': self.actor_name(words[1]), 'location': words[2:5], 'normal': words[5:8],
                'primitive': words[8], 'time': words[9], 'item': words[10]}

    def hit_list(self, head):
        out, seen = [], set()
        while head and head not in seen and len(out) < 4096:
            seen.add(head)
            out.append(self.hit_record(head))
            head = self.read(head, 'I')[0]
        return out

    def on_instruction(self, cpu, address, size, data):
        if self.calls is not None:
            while self.open_calls and address == self.open_calls[-1][0]:
                self.leave(cpu, *self.open_calls.pop()[1:])
            if address in CALLS:
                self.enter(cpu, address)
            elif address == CELL_STORE and self.open_calls and self.open_calls[-1][1]['name'] == 'HashActorLineCheck' and 'cells' not in self.open_calls[-1][1]:
                bp = cpu.reg_read(UC_X86_REG_EBP)
                mins = [cpu.reg_read(UC_X86_REG_ESI), self.read(bp - 0x34, 'i')[0], self.read(bp - 0x3c, 'i')[0]]
                maxs = [self.read(bp - 0x28, 'i')[0], self.read(bp - 0x2c, 'i')[0], self.read(bp - 0x40, 'i')[0]]
                self.open_calls[-1][1]['cells'] = {'min': mins, 'max': maxs}
        # (self.events stays None: this oracle reports its own `calls`, not the base class's float events)
        return super().on_instruction(cpu, address, size, data)

    def enter(self, cpu, address):
        sp = cpu.reg_read(UC_X86_REG_ESP)
        name = CALLS[address]
        record = {'name': name, 'depth': len(self.open_calls)}
        arg = lambda i, n=1: self.words(sp + 4 + 4 * i, n)
        info = None
        if name == 'AdjustSpot':
            # AdjustSpot(FVector& Adjusted, FVector TraceDest, FLOAT Size, FCheckResult& Hit): FindSpot's pushes at 0x1039872a..
            adjusted = arg(0)[0]
            record['args'] = {'adjusted': self.words(adjusted, 3), 'dest': arg(1, 3), 'size': arg(4)[0]}
            info = ('adjusted', adjusted)
        elif name == 'SingleLineCheck':
            hit, source, end, start, flags = arg(0, 5)
            record['args'] = {'source': self.actor_name(source), 'end': self.words(end, 3), 'start': self.words(start, 3),
                              'flags': flags, 'extent': arg(5, 3), 'extra': arg(8)[0]}
            info = ('hit', hit)
        elif name == 'SinglePointCheck':
            hit = arg(0)[0]
            record['args'] = {'position': arg(1, 3), 'extent': arg(4, 3), 'flags': arg(7)[0], 'world': self.actor_name(arg(8)[0]),
                              'checkActors': arg(9)[0]}
            info = ('hit', hit)
        elif name == 'MultiPointCheck':
            record['args'] = {'position': arg(1, 3), 'extent': arg(4, 3), 'flags': arg(7)[0], 'world': self.actor_name(arg(8)[0]),
                              'checkActors': arg(9)[0]}
            info = ('list', None)
        elif name == 'MultiLineCheck':
            record['args'] = {'end': arg(1, 3), 'start': arg(4, 3), 'extent': arg(7, 3), 'checkActors': arg(10)[0],
                              'world': self.actor_name(arg(11)[0]), 'extra': arg(12)[0]}
            info = ('list', None)
        elif name == 'ModelLineCheck':
            hit, owner = arg(0, 2)
            record['args'] = {'owner': self.actor_name(owner), 'end': arg(2, 3), 'start': arg(5, 3), 'extent': arg(8, 3), 'extra': arg(11)[0]}
            info = ('hit', hit)
        elif name == 'ModelPointCheck':
            hit, owner = arg(0, 2)
            record['args'] = {'owner': self.actor_name(owner), 'position': arg(2, 3), 'extent': arg(5, 3), 'extra': arg(8)[0]}
            info = ('hit', hit)
        elif name == 'HashActorLineCheck':
            record['args'] = {'end': arg(1, 3), 'start': arg(4, 3), 'extent': arg(7, 3), 'extra': arg(10)[0]}
            info = ('list', None)
        elif name in ('PrimitiveLineCheck', 'PrimitivePointCheck'):
            hit, owner = arg(0, 2)
            record['args'] = {'owner': self.actor_name(owner), 'words': arg(2, 10)}
            info = ('hit', hit)
        self.calls.append(record)
        self.open_calls.append((self.read(sp, 'I')[0], record, info))

    def leave(self, cpu, record, info):
        eax = cpu.reg_read(UC_X86_REG_EAX)
        record['return'] = eax
        kind, pointer = info or (None, None)
        if kind == 'hit':
            record['hit'] = self.hit_record(pointer)
        elif kind == 'adjusted':
            record['adjustedAfter'] = self.words(pointer, 3)
        elif kind == 'list':
            record['hits'] = self.hit_list(eax)

    def line(self, case):
        """ULevel::SingleLineCheck (0x1039aed0) on word vectors: {"start", "end", "extent" (default zero), "flags", "extra", "source" (an actor id)}."""
        hit, start, end = self.alloc(48), self.alloc(12), self.alloc(12)
        self.cpu.mem_write(hit, bytes(48))
        self.write(hit + 36, 'f', 1)
        self.write(start, '3I', *case['start'])
        self.write(end, '3I', *case['end'])
        return self.run(lambda: self.call(0x1039aed0, self.level, struct.pack('<5I3II', hit, self.actor_ptrs.get(case.get('source'), 0), end, start,
                                                                                 case['flags'], *case.get('extent', [0, 0, 0]), case.get('extra', 0))),
                        lambda clear: {'clear': bool(clear & 0xff), 'hit': self.hit_record(hit)})

    def point(self, case):
        """ULevel::SinglePointCheck (0x1039aac0): {"position", "extent", "flags", "checkActors", "world" (true: Level's LevelInfo)}."""
        hit = self.alloc(48)
        self.cpu.mem_write(hit, bytes(48))
        self.write(hit + 36, 'f', 1)
        self.write(hit + 40, 'i', -1)
        return self.run(lambda: self.call(0x1039aac0, self.level, struct.pack('<I3I3I3I', hit, *case['position'], *case['extent'], case['flags'],
                                                                              self.info if case.get('world', True) else 0, case['checkActors'])),
                        lambda clear: {'clear': bool(clear & 0xff), 'hit': self.hit_record(hit)})

    def run(self, execute, describe):
        self.calls, self.open_calls = [], []
        try:
            out = describe(execute())
            out['calls'] = self.calls
        except RuntimeError as error:
            out = {'error': str(error)[:400], 'calls': self.calls, 'open': [call['name'] for _, call, _ in self.open_calls]}
        self.calls = None
        return out

    def fit(self, case):
        # (the scene's actor and primitive vtables are native-level-oracle.py's)
        self.write(self.location, '3I', *case['position'])
        self.calls, self.open_calls = [], []
        try:
            success = self.call(0x10398480, self.level, struct.pack('<3II2I', *case['extent'], self.location, *case['options']))
            out = {'success': bool(success & 0xff), 'position': self.words(self.location, 3), 'calls': self.calls}
        except RuntimeError as error:
            out = {'error': str(error)[:400], 'calls': self.calls, 'open': [call['name'] for _, call, _ in self.open_calls]}
        self.calls = None
        return out


def main():
    if len(sys.argv) != 4:
        sys.exit('Usage: native-tracked-fitting-oracle.py GAME_ROOT SCENE_JSON CASES_JSON')
    scene_bytes, case_bytes = Path(sys.argv[2]).read_bytes(), Path(sys.argv[3]).read_bytes()
    scene, cases = json.loads(scene_bytes), json.loads(case_bytes)
    level = TrackedLevel(Path(sys.argv[1]), scene)
    level.budget = int(os.environ.get('ORACLE_BUDGET', '4000000'))
    results = [getattr(level, case.get('kind', 'fit'))(case) for case in cases]
    print(json.dumps({'hashes': _LEVEL.base.HASHES | {'MSVCRT.dll': hash_module.CRT_HASH},
                      'sceneSha256': hashlib.sha256(scene_bytes).hexdigest(), 'casesSha256': hashlib.sha256(case_bytes).hexdigest(),
                      'registration': level.registration, 'results': results}))


if __name__ == '__main__':
    main()
