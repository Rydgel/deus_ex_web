"""Execute the original Core.dll property DestroyValue virtuals.

This is a small source/evidence probe, never imported by the browser.  The
property bodies themselves run from the hash-verified GOTY Core.dll.  The
probe supplies only the unresolved GMalloc virtuals needed by FString and
TArray destruction; those stubs return the old pointer from Realloc and do
not reclaim guest memory, which makes the native free/reset order observable.
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path

_script_dir = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    'native_collision', _script_dir / 'native-collision-oracle.py')
_native_collision = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_native_collision)
NativeCollision = _native_collision.NativeCollision

CORE_GMALLOC_PTR = 0x101a7c44
UPROPERTY_VTABLE = 0x10175a44
INT_VTABLE = 0x10175bc4
STR_VTABLE = 0x10176044
ARRAY_VTABLE = 0x101761c4
FIXED_ARRAY_VTABLE = 0x10176104
MAP_VTABLE = 0x10176284
STRUCT_VTABLE = 0x10176344


class DestroyProbe(NativeCollision):
    """Run DestroyValue with a logging, non-reclaiming GMalloc adapter."""

    # FArray::Realloc pushes (data, byte-count, allocation-tag), so this
    # replacement must pop twelve bytes.  It returns the old pointer; the
    # native FString destructor then exercises its conditional Free branch.
    REALLOC_STUB = bytes.fromhex('8b 44 24 04 c2 0c 00')
    FREE_STUB = bytes.fromhex('c2 04 00')

    def __init__(self, game_root):
        super().__init__(game_root)
        self.events = []
        allocator = self.alloc(0x20)
        vtable = self.alloc(0x20)
        self.realloc_stub = self.alloc(0x10)
        self.free_stub = self.alloc(0x10)
        self.cpu.mem_write(self.realloc_stub, self.REALLOC_STUB)
        self.cpu.mem_write(self.free_stub, self.FREE_STUB)
        self.write(vtable + 0x04, 'I', self.realloc_stub)
        self.write(vtable + 0x08, 'I', self.free_stub)
        self.write(allocator, 'I', vtable)
        self.write(CORE_GMALLOC_PTR, 'I', allocator)

    def on_instruction(self, cpu, address, size, data):
        if address == self.realloc_stub:
            sp = cpu.reg_read(_native_collision.UC_X86_REG_ESP)
            self.events.append({
                'op': 'realloc',
                'pointer': self.read(sp + 0x04, 'I')[0],
                'bytes': self.read(sp + 0x08, 'I')[0],
                'tag': self.read(sp + 0x0c, 'I')[0],
            })
        elif address == self.free_stub:
            sp = cpu.reg_read(_native_collision.UC_X86_REG_ESP)
            self.events.append({
                'op': 'free',
                'pointer': self.read(sp + 0x04, 'I')[0],
            })
        return super().on_instruction(cpu, address, size, data)

    def property(self, vtable, **slots):
        record = self.alloc(0x100)
        self.write(record, 'I', vtable)
        for offset, value in slots.items():
            self.write(record + int(offset, 0), 'I', value)
        return record

    def fstring(self, text, array_num=None, array_max=None):
        if array_num is None:
            array_num = len(text) + 1
        if array_max is None:
            array_max = array_num
        data = self.alloc(max(array_max, 1) * 2)
        units = [ord(char) for char in text] + [0]
        units.extend([0] * max(0, array_max - len(units)))
        self.write(data, f'{max(array_max, 1)}H', *units[:max(array_max, 1)])
        record = self.alloc(0x0c)
        # FString/TArray layout in this build is Data, ArrayNum (+4),
        # ArrayMax (+8).  The destructor clears both counters before Realloc.
        self.write(record, '3I', data, array_num, array_max)
        return record

    def tarray(self, pointer, array_num, array_max=None):
        if array_max is None:
            array_max = array_num
        record = self.alloc(0x0c)
        self.write(record, '3I', pointer, array_num, array_max)
        return record

    def destroy(self, body, property_record, value_record):
        self.events = []
        result = self.call(body, property_record, struct.pack('<I', value_record))
        return result

    def words(self, record, count=3):
        return list(self.read(record, f'{count}I'))


def run(game_root):
    native = DestroyProbe(game_root)
    results = {}

    # Base UProperty::DestroyValue and UMapProperty::DestroyValue are returns;
    # leave sentinels in their storage to make the no-op behavior explicit.
    primitive = native.property(UPROPERTY_VTABLE)
    primitive_value = native.alloc(0x0c)
    native.write(primitive_value, '3I', 0x11111111, 0x22222222, 0x33333333)
    native.destroy(0x10165590, primitive, primitive_value)
    results['primitive'] = native.words(primitive_value)

    map_property = native.property(MAP_VTABLE)
    map_value = native.alloc(0x0c)
    native.write(map_value, '3I', 0x44444444, 0x55555555, 0x66666666)
    native.destroy(0x10168f50, map_property, map_value)
    results['map'] = native.words(map_value)

    # UStrProperty::DestroyValue loops ArrayDim records by ElementSize.  The
    # two strings have deliberately different capacities; destruction itself
    # always asks Realloc for zero bytes after clearing +4/+8.
    str_property = native.property(STR_VTABLE, **{'0x34': 2, '0x38': 0x0c})
    str_values = native.alloc(0x18)
    first = native.fstring('A', array_num=2, array_max=4)
    second = native.fstring('BC', array_num=3, array_max=6)
    native.cpu.mem_write(str_values, bytes(native.cpu.mem_read(first, 0x0c)))
    native.cpu.mem_write(str_values + 0x0c, bytes(native.cpu.mem_read(second, 0x0c)))
    str_pointers = [native.words(str_values)[0], native.words(str_values + 0x0c)[0]]
    native.destroy(0x10167ba0, str_property, str_values)
    results['str'] = {
        'records': [native.words(str_values), native.words(str_values + 0x0c)],
        'pointers': str_pointers,
        'events': list(native.events),
    }

    # UArrayProperty destroys Inner values only when Inner.Flags has
    # CPF_NeedCtorLink (0x400000), then frees/zeros the TArray header either
    # way.  Compare an owning FString inner with a scalar non-owning inner.
    int_inner = native.property(INT_VTABLE, **{'0x38': 4, '0x3c': 0})
    int_array_property = native.property(ARRAY_VTABLE, **{'0x5c': int_inner})
    int_data = native.alloc(0x08)
    native.write(int_data, '2I', 7, 9)
    int_array = native.tarray(int_data, 2, 2)
    int_container_pointer = int_data
    native.destroy(0x10168bb0, int_array_property, int_array)
    results['array_scalar_inner'] = {
        'header': native.words(int_array),
        'elements': native.words(int_data, 2),
        'pointers': {'container': int_container_pointer},
        'events': list(native.events),
    }

    str_inner = native.property(STR_VTABLE, **{
        '0x34': 1, '0x38': 0x0c, '0x3c': 0x400000,
    })
    str_array_property = native.property(ARRAY_VTABLE, **{'0x5c': str_inner})
    str_data = native.alloc(0x18)
    a = native.fstring('D')
    b = native.fstring('E')
    native.cpu.mem_write(str_data, bytes(native.cpu.mem_read(a, 0x0c)))
    native.cpu.mem_write(str_data + 0x0c, bytes(native.cpu.mem_read(b, 0x0c)))
    str_array = native.tarray(str_data, 2, 2)
    array_string_pointers = {
        'element0': native.words(str_data)[0],
        'element1': native.words(str_data + 0x0c)[0],
        'container': str_data,
    }
    native.destroy(0x10168bb0, str_array_property, str_array)
    results['array_string_inner'] = {
        'header': native.words(str_array),
        'elements': [native.words(str_data), native.words(str_data + 0x0c)],
        'pointers': array_string_pointers,
        'events': list(native.events),
    }

    # UFixedArrayProperty walks count * Inner.ElementSize and leaves the
    # containing inline storage untouched apart from Inner destruction.
    fixed_inner = native.property(STR_VTABLE, **{'0x34': 1, '0x38': 0x0c})
    fixed_property = native.property(FIXED_ARRAY_VTABLE, **{
        '0x5c': fixed_inner, '0x60': 2,
    })
    fixed_values = native.alloc(0x18)
    c = native.fstring('F')
    d = native.fstring('G')
    native.cpu.mem_write(fixed_values, bytes(native.cpu.mem_read(c, 0x0c)))
    native.cpu.mem_write(fixed_values + 0x0c, bytes(native.cpu.mem_read(d, 0x0c)))
    fixed_pointers = [native.words(fixed_values)[0], native.words(fixed_values + 0x0c)[0]]
    native.destroy(0x101682e0, fixed_property, fixed_values)
    results['fixed_string_inner'] = {
        'elements': [native.words(fixed_values), native.words(fixed_values + 0x0c)],
        'pointers': fixed_pointers,
        'events': list(native.events),
    }

    # UStructProperty walks the linked Children chain for each outer
    # ArrayDim, using the outer ElementSize as its record stride and the
    # member Offset (+0x48) inside each record.
    member = native.property(STR_VTABLE, **{
        '0x34': 1, '0x38': 0x0c, '0x48': 4, '0x54': 0,
    })
    struct_object = native.alloc(0x80)
    native.write(struct_object + 0x68, 'I', member)
    struct_property = native.property(STRUCT_VTABLE, **{
        '0x5c': struct_object, '0x34': 2, '0x38': 0x20,
    })
    struct_values = native.alloc(0x40)
    e = native.fstring('H')
    f = native.fstring('I')
    native.cpu.mem_write(struct_values + 4, bytes(native.cpu.mem_read(e, 0x0c)))
    native.cpu.mem_write(struct_values + 0x20 + 4, bytes(native.cpu.mem_read(f, 0x0c)))
    struct_pointers = [native.words(struct_values + 4)[0], native.words(struct_values + 0x20 + 4)[0]]
    native.destroy(0x10169cf0, struct_property, struct_values)
    results['struct_string_member'] = {
        'elements': [native.words(struct_values + 4), native.words(struct_values + 0x20 + 4)],
        'pointers': struct_pointers,
        'events': list(native.events),
    }

    return {
        'hashes': _native_collision.HASHES,
        'offsets': {
            'fStringData': 0x00,
            'fStringArrayNum': 0x04,
            'fStringArrayMax': 0x08,
            'tArrayData': 0x00,
            'tArrayArrayNum': 0x04,
            'tArrayArrayMax': 0x08,
            'propertyArrayDim': 0x34,
            'propertyElementSize': 0x38,
            'propertyFlags': 0x3c,
            'propertyOffset': 0x48,
            'propertyInner': 0x5c,
            'fixedArrayCount': 0x60,
            'structChildren': 0x68,
            'propertyNext': 0x54,
        },
        'results': results,
    }


def main():
    if len(sys.argv) != 2:
        sys.exit('Usage: native-property-destroy-oracle.py GAME_ROOT')
    print(json.dumps(run(Path(sys.argv[1]))))


if __name__ == '__main__':
    main()
