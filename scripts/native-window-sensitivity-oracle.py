"""Run the unchanged Extension.dll XWindow sensitivity and tree bodies on x86.

Only the nine recovered normal bodies execute in this probe.  Focus/grab,
accelerator-dirty, and the recursive SensitivityChanged notification are
intercepted as explicit synchronous leaves, and the FFrame expression
evaluators are harness services: Core's runtime-initialized GNatives table is
not present in the static image, so the probe installs the exact EndFunctionParms
and boolean-expression entries it exercises and leaves every other entry at the
image's default.  The probe is deliberately small: it records raw
window/leaf accesses for the recovered sensitivity transitions and tree walks
rather than attempting a broad UI corpus.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

from unicorn import UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE, UC_MEM_WRITE
from unicorn.x86_const import UC_X86_REG_ECX, UC_X86_REG_ESP


_SPEC = importlib.util.spec_from_file_location(
    'native_collision', Path(__file__).with_name('native-collision-oracle.py'))
_NATIVE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_NATIVE)


EXTENSION_HASH = '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c'
EXTENSION_BASE = 0x12000000
EXTENSION = {'Extension.dll': {'hash': EXTENSION_HASH, 'base': EXTENSION_BASE}}

EXEC_SET_SENSITIVITY = EXTENSION_BASE + 0x51ab0
EXEC_SET_SENSITIVITY_END = EXTENSION_BASE + 0x51af6
EXEC_ENABLE_WINDOW = EXTENSION_BASE + 0x51b20
EXEC_ENABLE_WINDOW_END = EXTENSION_BASE + 0x51b66
EXEC_DISABLE_WINDOW = EXTENSION_BASE + 0x51b90
EXEC_DISABLE_WINDOW_END = EXTENSION_BASE + 0x51ba1
EXEC_IS_SENSITIVE = EXTENSION_BASE + 0x51bd0
EXEC_IS_SENSITIVE_END = EXTENSION_BASE + 0x51c4c
EXEC_GET_TOP_CHILD = EXTENSION_BASE + 0x52d40
EXEC_GET_TOP_CHILD_END = EXTENSION_BASE + 0x52d8c
EXEC_GET_BOTTOM_CHILD = EXTENSION_BASE + 0x52db0
EXEC_GET_BOTTOM_CHILD_END = EXTENSION_BASE + 0x52dfc
EXEC_GET_HIGHER_SIBLING = EXTENSION_BASE + 0x52e20
EXEC_GET_HIGHER_SIBLING_END = EXTENSION_BASE + 0x52e6c
EXEC_GET_LOWER_SIBLING = EXTENSION_BASE + 0x52e90
EXEC_GET_LOWER_SIBLING_END = EXTENSION_BASE + 0x52edc
EXEC_GET_CLIENT_OBJECT = EXTENSION_BASE + 0x52650
EXEC_GET_CLIENT_OBJECT_END = EXTENSION_BASE + 0x5266a

SET_SENSITIVITY = EXTENSION_BASE + 0x4c890
SET_SENSITIVITY_END = EXTENSION_BASE + 0x4c947
GET_LOWER_SIBLING = EXTENSION_BASE + 0x4c650
GET_LOWER_SIBLING_END = EXTENSION_BASE + 0x4c676
GET_HIGHER_SIBLING = EXTENSION_BASE + 0x4c680
GET_HIGHER_SIBLING_END = EXTENSION_BASE + 0x4c6a6
GET_TOP_CHILD = EXTENSION_BASE + 0x4c6b0
GET_TOP_CHILD_END = EXTENSION_BASE + 0x4c70a
GET_BOTTOM_CHILD = EXTENSION_BASE + 0x4c740
GET_BOTTOM_CHILD_END = EXTENSION_BASE + 0x4c79a

CHECK_FOCUS_WINDOW = EXTENSION_BASE + 0x50b80
CHECK_GRABBED_WINDOW = EXTENSION_BASE + 0x50c90
MAKE_ACCELERATOR_TABLE_DIRTY = EXTENSION_BASE + 0x4c1d0
NOTIFY_SENSITIVITY_CHANGED = EXTENSION_BASE + 0x50ef0
SENSITIVITY_CHANGED_SLOT = 0x98

# Core.dll's GNatives array.  It is BSS in the unchanged image and filled only
# by runtime native registration, so the probe supplies the expression entries
# it exercises as explicit harness services.
GNATIVES = 0x101f41b8
EXTENSION_GNATIVES_IAT = EXTENSION_BASE + 0x59064
EX_END_FUNCTION_PARMS = 0x16
EX_TRUE = 0x27
EX_FALSE = 0x28

WINDOW_FLAGS = 0x30
CLIENT_OBJECT = 0x118
PARENT = 0x138
BOTTOM_CHILD = 0x13c
TOP_CHILD = 0x140
LOWER_SIBLING = 0x144
HIGHER_SIBLING = 0x148

BODY_RANGES = (
    ('setSensitivity', SET_SENSITIVITY, SET_SENSITIVITY_END),
    ('getLowerSibling', GET_LOWER_SIBLING, GET_LOWER_SIBLING_END),
    ('getHigherSibling', GET_HIGHER_SIBLING, GET_HIGHER_SIBLING_END),
    ('getTopChild', GET_TOP_CHILD, GET_TOP_CHILD_END),
    ('getBottomChild', GET_BOTTOM_CHILD, GET_BOTTOM_CHILD_END),
)
EXEC_RANGES = (
    ('setSensitivity', EXEC_SET_SENSITIVITY, EXEC_SET_SENSITIVITY_END),
    ('enableWindow', EXEC_ENABLE_WINDOW, EXEC_ENABLE_WINDOW_END),
    ('disableWindow', EXEC_DISABLE_WINDOW, EXEC_DISABLE_WINDOW_END),
    ('isSensitive', EXEC_IS_SENSITIVE, EXEC_IS_SENSITIVE_END),
    ('getTopChild', EXEC_GET_TOP_CHILD, EXEC_GET_TOP_CHILD_END),
    ('getBottomChild', EXEC_GET_BOTTOM_CHILD, EXEC_GET_BOTTOM_CHILD_END),
    ('getHigherSibling', EXEC_GET_HIGHER_SIBLING, EXEC_GET_HIGHER_SIBLING_END),
    ('getLowerSibling', EXEC_GET_LOWER_SIBLING, EXEC_GET_LOWER_SIBLING_END),
    ('getClientObject', EXEC_GET_CLIENT_OBJECT, EXEC_GET_CLIENT_OBJECT_END),
)


class WindowSensitivityProbe(_NATIVE.NativeCollision):
    """Execute the nine sensitivity/tree bodies with leaf interception."""

    def __init__(self, root):
        self.root = Path(root)
        super().__init__(Path(root), EXTENSION)
        self.events = []
        self.accesses = []
        self.case_name = None
        self.objects = {}
        self.vtable = self.alloc(0x100)
        self.script_dispatch = self.read(EXTENSION_GNATIVES_IAT, 'I')[0]
        if self.script_dispatch != GNATIVES:
            raise RuntimeError(
                f'Extension GNatives import resolved to {self.script_dispatch:#x}, '
                f'expected {GNATIVES:#x}')
        self.native_leaves = {
            CHECK_FOCUS_WINDOW: ('CheckFocusWindow', 0),
            CHECK_GRABBED_WINDOW: ('CheckGrabbedWindow', 0),
            MAKE_ACCELERATOR_TABLE_DIRTY: ('MakeAcceleratorTableDirty', 0),
            NOTIFY_SENSITIVITY_CHANGED: ('NotifySensitivityChanged', 4),
        }
        self.leaf_stubs = {}
        for name, argument_bytes in self.native_leaves.values():
            address = self.alloc(16)
            self.cpu.mem_write(address, b'\xc3')
            self.leaf_stubs[address] = (name, argument_bytes, address)
        # The inline optional-parameter parse dispatches one expression token
        # through GNatives.  EndFunctionParms must leave the destination's
        # pre-stored default untouched; EX_True/EX_False write the native word.
        self.end_parameters_stub = self.alloc(16)
        self.cpu.mem_write(self.end_parameters_stub, bytes.fromhex('c20800'))
        self.boolean_stubs = {}
        for token, value in ((EX_TRUE, 1), (EX_FALSE, 0)):
            stub = self.alloc(16)
            self.cpu.mem_write(stub, bytes.fromhex('8b442408c700') +
                               struct.pack('<I', value) + bytes.fromhex('c20800'))
            self.write(GNATIVES + token * 4, 'I', stub)
            self.boolean_stubs[token] = (stub, value)
        self.write(GNATIVES + EX_END_FUNCTION_PARMS * 4, 'I', self.end_parameters_stub)
        self.exec_code = 0
        self.cpu.hook_add(UC_HOOK_MEM_READ | UC_HOOK_MEM_WRITE, self.on_memory)

    @staticmethod
    def _return(cpu, stack, argument_bytes=0):
        return_address = int.from_bytes(cpu.mem_read(stack, 4), 'little')
        cpu.reg_write(UC_X86_REG_ESP, stack + 4 + argument_bytes)
        cpu.reg_write(_NATIVE.UC_X86_REG_EIP, return_address)

    def _pointer_name(self, value):
        if not value:
            return None
        for name, pointer in self.objects.items():
            if value == pointer:
                return name
        return None

    def _record_memory(self, op, address, size, value):
        for name, pointer in self.objects.items():
            if pointer <= address < pointer + 0x200:
                self.accesses.append({
                    'op': op, 'region': 'object', 'object': name,
                    'offset': address - pointer, 'size': size, 'value': value,
                })
                return
        if self.vtable <= address < self.vtable + 0x100:
            self.accesses.append({
                'op': op, 'region': 'vtable', 'offset': address - self.vtable,
                'size': size, 'value': value,
            })

    def on_memory(self, cpu, access, address, size, value, data):
        op = 'write' if access == UC_MEM_WRITE else 'read'
        actual = value if op == 'write' else int.from_bytes(cpu.mem_read(address, size), 'little')
        self._record_memory(op, address, size, actual)

    def on_instruction(self, cpu, address, size, data):
        stack = cpu.reg_read(UC_X86_REG_ESP)
        leaf = self.native_leaves.get(address)
        if leaf:
            name, argument_bytes = leaf
            receiver = cpu.reg_read(UC_X86_REG_ECX)
            event = {
                'op': name,
                'object': self._pointer_name(receiver) or receiver,
                'native': address,
            }
            if argument_bytes:
                raw = self.read(stack + 4, 'I')[0]
                event['rawArgument'] = raw
                event['effectiveSensitivity'] = bool(raw)
            self.events.append(event)
            self._return(cpu, stack, argument_bytes)
            return
        return super().on_instruction(cpu, address, size, data)

    def _object(self, name, flags=0, client=None):
        pointer = self.alloc(0x200)
        # Every native read in this probe is an explicit link/flag field, so
        # zero-filled storage gives unwired links the original null semantics.
        self.cpu.mem_write(pointer, b'\0' * 0x200)
        self.write(pointer, 'I', self.vtable)
        self.write(pointer + WINDOW_FLAGS, 'I', flags)
        self.write(pointer + CLIENT_OBJECT, 'I', client or 0)
        self.objects[name] = pointer
        return pointer

    def _prepare(self, objects, links=()):
        self.events = []
        self.accesses = []
        self.objects = {}
        for spec in objects:
            self._object(spec['name'], spec.get('flags', 0), spec.get('client'))
        for target, offset, source in links:
            self.write(self.objects[target] + offset, 'I', self.objects[source])
        # Setup writes above are not part of the function trace.
        self.accesses = []

    def _state(self):
        state = {}
        for name, pointer in self.objects.items():
            state[name] = {
                'pointer': pointer,
                'flags': self.read(pointer + WINDOW_FLAGS, 'I')[0],
                'parent': self._pointer_name(self.read(pointer + PARENT, 'I')[0]),
            }
        return state

    def _call_exec(self, entry, target, tokens, result_size=4):
        code = self.alloc(len(tokens) + 1)
        self.cpu.mem_write(code, bytes(tokens))
        frame = self.alloc(0x20)
        self.write(frame + 8, '2I', 0, code)
        result = self.alloc(max(result_size, 4))
        self.cpu.mem_write(result, b'\0' * max(result_size, 4))
        self.exec_code = code
        self.call(entry, self.objects[target], struct.pack('<II', frame, result))
        return frame, result

    def _case_result(self, entry, target, tokens, result_size=4):
        self.events = []
        frame, result = self._call_exec(entry, target, tokens, result_size)
        code_advance = self.read(frame + 12, 'I')[0] - self.exec_code
        accesses = list(self.accesses)
        state = self._state()
        raw = self.read(result, 'I')[0]
        self.accesses = accesses
        return {
            'events': list(self.events),
            'accesses': accesses,
            'state': state,
            'rawResult': raw,
            'result': self._pointer_name(raw) if self._pointer_name(raw) else raw,
            'codeAdvance': code_advance,
        }

    def _exec_case(self, name, entry, objects, links, tokens, target, result_size=4):
        self.case_name = name
        self._prepare(objects, links)
        return self._case_result(entry, target, tokens, result_size)

    def run(self):
        end = [EX_END_FUNCTION_PARMS]
        hidden = 0xa5a5a5a0
        visible = 0xa5a5a5a1
        sensitive = 0xa5a5a5a2
        insensitive = 0x2468ace0
        sensitive_parent = 0x2468ace2

        cases = {}
        cases['setSensitivityNoArgument'] = self._exec_case(
            'setSensitivityNoArgument', EXEC_SET_SENSITIVITY,
            [{'name': 'target', 'flags': sensitive}], (), end, 'target')
        cases['enableWindowNoArgument'] = self._exec_case(
            'enableWindowNoArgument', EXEC_ENABLE_WINDOW,
            [{'name': 'target', 'flags': hidden}], (), end, 'target')
        cases['disableWindowNoArgument'] = self._exec_case(
            'disableWindowNoArgument', EXEC_DISABLE_WINDOW,
            [{'name': 'target', 'flags': sensitive}], (), end, 'target')
        cases['setSensitivityNoOp'] = self._exec_case(
            'setSensitivityNoOp', EXEC_SET_SENSITIVITY,
            [{'name': 'target', 'flags': hidden}], (), end, 'target')
        cases['setSensitivityExplicitTrue'] = self._exec_case(
            'setSensitivityExplicitTrue', EXEC_SET_SENSITIVITY,
            [{'name': 'target', 'flags': hidden}], (),
            [EX_TRUE, EX_END_FUNCTION_PARMS], 'target')
        cases['setSensitivityBlockedByInsensitiveParent'] = self._exec_case(
            'setSensitivityBlockedByInsensitiveParent', EXEC_SET_SENSITIVITY,
            [{'name': 'parent', 'flags': insensitive},
             {'name': 'target', 'flags': sensitive}],
            [('target', PARENT, 'parent')], end, 'target')
        cases['setSensitivityEffectiveViaSensitiveParent'] = self._exec_case(
            'setSensitivityEffectiveViaSensitiveParent', EXEC_SET_SENSITIVITY,
            [{'name': 'parent', 'flags': sensitive_parent},
             {'name': 'target', 'flags': hidden}],
            [('target', PARENT, 'parent')],
            [EX_TRUE, EX_END_FUNCTION_PARMS], 'target')

        sibling_chain = [
            {'name': 'receiver', 'flags': visible},
            {'name': 'lower1', 'flags': hidden},
            {'name': 'lower2', 'flags': hidden},
            {'name': 'visible', 'flags': visible},
        ]
        sibling_links = [
            ('receiver', LOWER_SIBLING, 'lower1'),
            ('lower1', LOWER_SIBLING, 'lower2'),
            ('lower2', LOWER_SIBLING, 'visible'),
        ]
        cases['lowerSiblingFilteredHiddenChain'] = self._exec_case(
            'lowerSiblingFilteredHiddenChain', EXEC_GET_LOWER_SIBLING,
            sibling_chain, sibling_links, end, 'receiver')
        cases['lowerSiblingRawUnfiltered'] = self._exec_case(
            'lowerSiblingRawUnfiltered', EXEC_GET_LOWER_SIBLING,
            sibling_chain, sibling_links, [EX_FALSE, EX_END_FUNCTION_PARMS], 'receiver')
        cases['lowerSiblingFirstVisible'] = self._exec_case(
            'lowerSiblingFirstVisible', EXEC_GET_LOWER_SIBLING,
            [{'name': 'receiver', 'flags': hidden},
             {'name': 'visible', 'flags': visible}],
            [('receiver', LOWER_SIBLING, 'visible')], end, 'receiver')
        cases['lowerSiblingHiddenToNull'] = self._exec_case(
            'lowerSiblingHiddenToNull', EXEC_GET_LOWER_SIBLING,
            [{'name': 'receiver', 'flags': hidden},
             {'name': 'hidden', 'flags': hidden}],
            [('receiver', LOWER_SIBLING, 'hidden')], end, 'receiver')

        higher_chain = [
            {'name': 'receiver', 'flags': visible},
            {'name': 'higher1', 'flags': hidden},
            {'name': 'higher2', 'flags': hidden},
            {'name': 'visible', 'flags': visible},
        ]
        higher_links = [
            ('receiver', HIGHER_SIBLING, 'higher1'),
            ('higher1', HIGHER_SIBLING, 'higher2'),
            ('higher2', HIGHER_SIBLING, 'visible'),
        ]
        cases['higherSiblingFilteredHiddenChain'] = self._exec_case(
            'higherSiblingFilteredHiddenChain', EXEC_GET_HIGHER_SIBLING,
            higher_chain, higher_links, end, 'receiver')
        cases['higherSiblingRawUnfiltered'] = self._exec_case(
            'higherSiblingRawUnfiltered', EXEC_GET_HIGHER_SIBLING,
            higher_chain, higher_links, [EX_FALSE, EX_END_FUNCTION_PARMS], 'receiver')
        cases['higherSiblingHiddenToNull'] = self._exec_case(
            'higherSiblingHiddenToNull', EXEC_GET_HIGHER_SIBLING,
            [{'name': 'receiver', 'flags': hidden},
             {'name': 'hidden', 'flags': hidden}],
            [('receiver', HIGHER_SIBLING, 'hidden')], end, 'receiver')

        top_chain = [
            {'name': 'parent', 'flags': visible},
            {'name': 'top1', 'flags': hidden},
            {'name': 'lower1', 'flags': hidden},
            {'name': 'visible', 'flags': visible},
        ]
        top_links = [
            ('parent', TOP_CHILD, 'top1'),
            ('top1', LOWER_SIBLING, 'lower1'),
            ('lower1', LOWER_SIBLING, 'visible'),
        ]
        cases['topChildVisibleFirst'] = self._exec_case(
            'topChildVisibleFirst', EXEC_GET_TOP_CHILD,
            [{'name': 'parent', 'flags': visible},
             {'name': 'top1', 'flags': visible}],
            [('parent', TOP_CHILD, 'top1')], end, 'parent')
        cases['topChildHiddenDelegatesLower'] = self._exec_case(
            'topChildHiddenDelegatesLower', EXEC_GET_TOP_CHILD,
            top_chain, top_links, end, 'parent')
        cases['topChildRawUnfiltered'] = self._exec_case(
            'topChildRawUnfiltered', EXEC_GET_TOP_CHILD,
            top_chain, top_links, [EX_FALSE, EX_END_FUNCTION_PARMS], 'parent')
        cases['topChildHiddenNoLower'] = self._exec_case(
            'topChildHiddenNoLower', EXEC_GET_TOP_CHILD,
            [{'name': 'parent', 'flags': visible},
             {'name': 'top1', 'flags': hidden}],
            [('parent', TOP_CHILD, 'top1')], end, 'parent')
        cases['topChildNull'] = self._exec_case(
            'topChildNull', EXEC_GET_TOP_CHILD,
            [{'name': 'parent', 'flags': visible}], (), end, 'parent')

        bottom_chain = [
            {'name': 'parent', 'flags': visible},
            {'name': 'bottom1', 'flags': hidden},
            {'name': 'higher1', 'flags': hidden},
            {'name': 'visible', 'flags': visible},
        ]
        bottom_links = [
            ('parent', BOTTOM_CHILD, 'bottom1'),
            ('bottom1', HIGHER_SIBLING, 'higher1'),
            ('higher1', HIGHER_SIBLING, 'visible'),
        ]
        cases['bottomChildVisibleFirst'] = self._exec_case(
            'bottomChildVisibleFirst', EXEC_GET_BOTTOM_CHILD,
            [{'name': 'parent', 'flags': visible},
             {'name': 'bottom1', 'flags': visible}],
            [('parent', BOTTOM_CHILD, 'bottom1')], end, 'parent')
        cases['bottomChildHiddenDelegatesHigher'] = self._exec_case(
            'bottomChildHiddenDelegatesHigher', EXEC_GET_BOTTOM_CHILD,
            bottom_chain, bottom_links, end, 'parent')
        cases['bottomChildRawUnfiltered'] = self._exec_case(
            'bottomChildRawUnfiltered', EXEC_GET_BOTTOM_CHILD,
            bottom_chain, bottom_links, [EX_FALSE, EX_END_FUNCTION_PARMS], 'parent')
        cases['bottomChildNull'] = self._exec_case(
            'bottomChildNull', EXEC_GET_BOTTOM_CHILD,
            [{'name': 'parent', 'flags': visible}], (), end, 'parent')

        cases['isSensitiveNoArgumentRecursiveRootSensitive'] = self._exec_case(
            'isSensitiveNoArgumentRecursiveRootSensitive', EXEC_IS_SENSITIVE,
            [{'name': 'target', 'flags': sensitive}], (), end, 'target', 4)
        cases['isSensitiveNoArgumentSelfInsensitive'] = self._exec_case(
            'isSensitiveNoArgumentSelfInsensitive', EXEC_IS_SENSITIVE,
            [{'name': 'target', 'flags': hidden}], (), end, 'target', 4)
        cases['isSensitiveExplicitFalseLocal'] = self._exec_case(
            'isSensitiveExplicitFalseLocal', EXEC_IS_SENSITIVE,
            [{'name': 'parent', 'flags': insensitive},
             {'name': 'target', 'flags': sensitive}],
            [('target', PARENT, 'parent')],
            [EX_FALSE, EX_END_FUNCTION_PARMS], 'target', 4)
        cases['isSensitiveRecursiveAncestorInsensitive'] = self._exec_case(
            'isSensitiveRecursiveAncestorInsensitive', EXEC_IS_SENSITIVE,
            [{'name': 'parent', 'flags': insensitive},
             {'name': 'target', 'flags': sensitive}],
            [('target', PARENT, 'parent')], end, 'target', 4)
        cases['isSensitiveRecursiveAllSensitive'] = self._exec_case(
            'isSensitiveRecursiveAllSensitive', EXEC_IS_SENSITIVE,
            [{'name': 'parent', 'flags': sensitive_parent},
             {'name': 'target', 'flags': sensitive}],
            [('target', PARENT, 'parent')], end, 'target', 4)

        client = self._exec_case(
            'getClientObject', EXEC_GET_CLIENT_OBJECT,
            [{'name': 'target', 'flags': visible, 'client': 0x13579bdf}],
            (), end, 'target', 4)
        cases['getClientObject'] = client

        extension_path = self.root / 'System' / 'Extension.dll'
        body_hashes = {}
        exec_hashes = {}
        if extension_path.exists():
            image = _NATIVE.Image(extension_path, EXTENSION_HASH)
            for name, start, stop in BODY_RANGES:
                body = image.data[image.offset(start - EXTENSION_BASE):
                                  image.offset(stop - EXTENSION_BASE)]
                body_hashes[name] = hashlib.sha256(body).hexdigest()
            for name, start, stop in EXEC_RANGES:
                body = image.data[image.offset(start - EXTENSION_BASE):
                                  image.offset(stop - EXTENSION_BASE)]
                exec_hashes[name] = hashlib.sha256(body).hexdigest()
        return {
            'hashes': {'Extension.dll': EXTENSION_HASH, **_NATIVE.HASHES},
            'extensionBase': EXTENSION_BASE,
            'gnatives': GNATIVES,
            'addresses': {
                'setSensitivity': SET_SENSITIVITY,
                'setSensitivityEnd': SET_SENSITIVITY_END,
                'getLowerSibling': GET_LOWER_SIBLING,
                'getLowerSiblingEnd': GET_LOWER_SIBLING_END,
                'getHigherSibling': GET_HIGHER_SIBLING,
                'getHigherSiblingEnd': GET_HIGHER_SIBLING_END,
                'getTopChild': GET_TOP_CHILD,
                'getTopChildEnd': GET_TOP_CHILD_END,
                'getBottomChild': GET_BOTTOM_CHILD,
                'getBottomChildEnd': GET_BOTTOM_CHILD_END,
                'checkFocusWindow': CHECK_FOCUS_WINDOW,
                'checkGrabbedWindow': CHECK_GRABBED_WINDOW,
                'makeAcceleratorTableDirty': MAKE_ACCELERATOR_TABLE_DIRTY,
                'notifySensitivityChanged': NOTIFY_SENSITIVITY_CHANGED,
                'sensitivityChangedSlot': SENSITIVITY_CHANGED_SLOT,
            },
            'bodySha256': body_hashes,
            'execSha256': exec_hashes,
            'cases': cases,
        }


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: native-window-sensitivity-oracle.py GAME_ROOT')
    probe = WindowSensitivityProbe(Path(sys.argv[1]))
    print(json.dumps(probe.run()))


if __name__ == '__main__':
    main()
