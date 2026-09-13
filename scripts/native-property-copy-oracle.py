"""Execute the original Core.dll property-copy virtuals in an x86 emulator.

This is a focused Stage 3 evidence tool.  It uses the hash-verified GOTY Core.dll
and calls the real UProperty/scalar/complex vtable entries.  FArray::Realloc is
patched to a no-op for the string and dynamic-array cases; all value buffers are
preallocated, so the oracle records copy order and bytes without pretending to
recover the host allocator.
"""
import importlib.util
import json
import struct
import sys
from pathlib import Path


_script_dir = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "native_collision", _script_dir / "native-collision-oracle.py"
)
_native_collision = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_native_collision)
NativeCollision = _native_collision.NativeCollision


# Property vtables in Core.dll .rdata.  Their slots contain import thunks; the
# addresses below are the vtable addresses, not guesses based on body names.
VTABLES = {
    "UProperty": 0x10175A44,
    "UByteProperty": 0x10175B04,
    "UIntProperty": 0x10175BC4,
    "UBoolProperty": 0x10175C84,
    "UFloatProperty": 0x10175D44,
    "UObjectProperty": 0x10175E04,
    "UClassProperty": 0x10175EC4,
    "UNameProperty": 0x10175F84,
    "UStrProperty": 0x10176044,
    "UFixedArrayProperty": 0x10176104,
    "UArrayProperty": 0x101761C4,
    "UMapProperty": 0x10176284,
    "UStructProperty": 0x10176344,
}

COPY_SINGLE_BODIES = {
    "UProperty": 0x10165560,
    "UByteProperty": 0x10165790,
    "UIntProperty": 0x10165D00,
    "UBoolProperty": 0x101665F0,
    "UFloatProperty": 0x10166740,
    "UObjectProperty": 0x10166B30,
    "UClassProperty": 0x10166B30,
    "UNameProperty": 0x101672F0,
    "UStrProperty": 0x10167B30,
    "UFixedArrayProperty": 0x10168290,
    "UArrayProperty": 0x10168A70,
    "UMapProperty": 0x10168F40,
    "UStructProperty": 0x10169C40,
}

COPY_COMPLETE_BODIES = {
    "UProperty": 0x10165600,
    "UByteProperty": 0x101657A0,
    "UIntProperty": 0x10165D10,
    "UBoolProperty": 0x10165600,  # inherited UProperty body
    "UFloatProperty": 0x10166750,
    "UObjectProperty": 0x10166B40,
    "UClassProperty": 0x10166B40,
    "UNameProperty": 0x10167300,
    "UStrProperty": 0x10165600,  # inherited UProperty body
    "UFixedArrayProperty": 0x10165600,
    "UArrayProperty": 0x10165600,
    "UMapProperty": 0x10165600,
    "UStructProperty": 0x10165600,
}

UCLASS = 0x102A7AF0
REALLOC_BODY = 0x10145440


def u32(value):
    return value & 0xFFFFFFFF


class CopyProbe(NativeCollision):
    """NativeCollision with preallocated storage and tiny tracing stubs."""

    def __init__(self, game_root):
        super().__init__(game_root)
        # The copy bodies call FArray::Realloc for FString/TArray storage.  A
        # no-op keeps the supplied data pointers stable; no allocation result is
        # inferred from this harness.
        self.cpu.mem_write(REALLOC_BODY, b"\xc2\x04\x00")

    def bytes_at(self, address, length):
        return list(self.cpu.mem_read(address, length))

    def words_at(self, address, count):
        return list(self.read(address, f"{count}I"))

    def property(self, vtable, array_dim=1, element_size=4, flags=0):
        record = self.alloc(0x100)
        self.write(record, "I", vtable)
        self.write(record + 0x34, "I", u32(array_dim))
        self.write(record + 0x38, "I", u32(element_size))
        self.write(record + 0x3C, "I", u32(flags))
        return record

    def custom_vtable(self, slots):
        table = self.alloc(0xA0)
        for slot, address in slots.items():
            self.write(table + slot, "I", address)
        return table

    def array_value(self, items, element_size=4, capacity=None):
        capacity = len(items) if capacity is None else capacity
        if capacity < len(items):
            raise ValueError("capacity smaller than item count")
        data = self.alloc(max(1, capacity * element_size))
        if element_size == 4 and items:
            self.write(data, f"{len(items)}I", *[u32(item) for item in items])
        elif items:
            raw = bytes(items)
            self.cpu.mem_write(data, raw)
        record = self.alloc(0xC)
        self.write(record, "3I", data, len(items), capacity)
        return record, data

    def utf16_value(self, words, capacity=None):
        """FString record: +4 is ArrayNum, +8 is ArrayMax/capacity."""
        count = len(words)
        capacity = count if capacity is None else capacity
        if capacity < count:
            raise ValueError("capacity smaller than FString ArrayNum")
        data = self.alloc(max(2, capacity * 2))
        self.write(data, f"{count}H", *words)
        record = self.alloc(0xC)
        self.write(record, "3I", data, count, capacity)
        return record, data

    def slot(self, vtable, offset):
        return self.read(vtable + offset, "I")[0]

    def invoke(self, property_record, offset, destination, source):
        vtable = self.read(property_record, "I")[0]
        return self.call(self.slot(vtable, offset), property_record,
                         struct.pack("<II", destination, source))

    def callback_stub(self, order_base, dest_base, src_base, *, identifier=0,
                      count_base=None, marker=None, mutate=None):
        """Build a callee-saved callback that records native pointer arguments.

        Arrays are indexed by call count.  `mutate=(array_dim, element_size)`
        changes the live property metadata only on the first callback, exposing
        the generic complete body's reread order.
        """
        if count_base is None:
            count_base = self.alloc(4)
            self.write(count_base, "I", 0)
        code = bytearray()
        # eax = callback count; edx = destination; record both pointers.
        code += b"\xa1" + struct.pack("<I", count_base)
        code += b"\x8b\x54\x24\x04"
        code += b"\x89\x14\x85" + struct.pack("<I", dest_base)
        code += b"\x8b\x54\x24\x08"
        code += b"\x89\x14\x85" + struct.pack("<I", src_base)
        if marker is not None:
            # Use eax for the marker write so edx remains available for the
            # property pointer used by the optional metadata mutation.  Save
            # the callback count first because it indexes all trace arrays.
            code += b"\x50"
            # One extra stack word (the saved count) precedes the call
            # arguments while the marker is written.
            code += b"\x8b\x44\x24\x08"
            code += b"\xc7\x00" + struct.pack("<I", u32(marker))
            code += b"\x58"
        code += b"\x8b\xd1"
        code += b"\xb9" + struct.pack("<I", u32(identifier))
        code += b"\x89\x0c\x85" + struct.pack("<I", order_base)
        if mutate is not None:
            # `eax` still contains the count.  Skip metadata mutation once it
            # is nonzero; this intentionally leaves flags and vtable untouched.
            code += b"\x85\xc0"
            jump = len(code)
            code += b"\x75\x00"
            code += b"\xc7\x42\x34" + struct.pack("<I", u32(mutate[0]))
            code += b"\xc7\x42\x38" + struct.pack("<I", u32(mutate[1]))
            skip = len(code)
            code[jump + 1] = skip - (jump + 2)
        code += b"\xff\x05" + struct.pack("<I", count_base)
        code += b"\xc2\x08\x00"
        address = self.alloc(len(code))
        self.cpu.mem_write(address, bytes(code))
        return address, count_base

    def super_stub(self):
        # UStructProperty::CopySingleValue calls the inner Struct vtable +0x68.
        # A test struct stores its next superclass at +0x3c.
        code = bytes.fromhex("8b 41 3c c3")
        address = self.alloc(len(code))
        self.cpu.mem_write(address, code)
        return address

    def make_struct(self, children, superclass=None, super_stub=None):
        record = self.alloc(0x90)
        table = self.custom_vtable({0x68: super_stub or self.super_stub()})
        self.write(record, "I", table)
        self.write(record + 0x38, "I", children or 0)
        self.write(record + 0x3C, "I", superclass or 0)
        return record

    def make_child(self, next_child=0, offset=0, callback=None, class_ptr=UCLASS):
        child = self.alloc(0x100)
        table = self.custom_vtable({0x90: callback or 0})
        self.write(child, "I", table)
        self.write(child + 0x24, "I", class_ptr)
        self.write(child + 0x2C, "I", next_child)
        self.write(child + 0x34, "I", 1)
        self.write(child + 0x38, "I", 4)
        self.write(child + 0x48, "I", offset)
        return child

    def traced_case(self, identifier, *, mutate=None, marker=None):
        order = self.alloc(0x20)
        dests = self.alloc(0x20)
        srcs = self.alloc(0x20)
        count = self.alloc(4)
        self.write(order, "8I", *([0] * 8))
        self.write(dests, "8I", *([0] * 8))
        self.write(srcs, "8I", *([0] * 8))
        self.write(count, "I", 0)
        callback, _ = self.callback_stub(
            order, dests, srcs, identifier=identifier, count_base=count,
            marker=marker, mutate=mutate
        )
        return callback, order, dests, srcs, count


def words_hex(native, address, count):
    return [f"0x{word:08x}" for word in native.words_at(address, count)]


def bytes_hex(native, address, length):
    return [f"0x{byte:02x}" for byte in native.bytes_at(address, length)]


def vtable_report(native):
    report = {}
    for name, table in VTABLES.items():
        report[name] = {
            "vtable": f"0x{table:08x}",
            "copySingleSlot": f"0x{native.slot(table, 0x8c):08x}",
            "copyCompleteSlot": f"0x{native.slot(table, 0x90):08x}",
            "copySingleBody": f"0x{COPY_SINGLE_BODIES[name]:08x}",
            "copyCompleteBody": f"0x{COPY_COMPLETE_BODIES[name]:08x}",
        }
    return report


def run(native):
    results = {}

    # Generic single raw copy and its forward-overlap behavior.
    generic = native.property(VTABLES["UProperty"], element_size=7)
    overlap = native.alloc(24)
    native.cpu.mem_write(overlap, bytes(range(1, 17)))
    native.invoke(generic, 0x8c, overlap + 1, overlap)
    results["generic_single_overlap"] = {
        "elementSize": 7,
        "buffer": bytes_hex(native, overlap, 16),
    }

    # Generic complete reads ElementSize/vtable and rereads ArrayDim after the
    # callback.  The first callback changes 3 -> 1 and 4 -> 8, so only one call
    # is made and its pointer remains the old zero-offset destination.
    complete = native.property(0, array_dim=3, element_size=4)
    callback, order, dests, srcs, count = native.traced_case(
        0xC0, mutate=(1, 8), marker=0xC0C0C0C0
    )
    complete_vtable = native.custom_vtable({0x8C: callback, 0x90: COPY_COMPLETE_BODIES["UProperty"]})
    native.write(complete, "I", complete_vtable)
    destination = native.alloc(32)
    source = native.alloc(32)
    native.cpu.mem_write(destination, bytes([0xDD] * 32))
    native.cpu.mem_write(source, bytes(range(32)))
    native.invoke(complete, 0x90, destination, source)
    results["generic_complete_live_metadata"] = {
        "calls": native.read(count, "I")[0],
        "order": native.words_at(order, 2),
        "destinations": [f"0x{x:08x}" for x in native.words_at(dests, 2)],
        "sources": [f"0x{x:08x}" for x in native.words_at(srcs, 2)],
        "postArrayDim": native.read(complete + 0x34, "I")[0],
        "postElementSize": native.read(complete + 0x38, "I")[0],
        "destination": bytes_hex(native, destination, 12),
    }

    # Scalar specialized bodies.
    byte_property = native.property(VTABLES["UByteProperty"], array_dim=5, element_size=1)
    byte_dest = native.alloc(8)
    byte_src = native.alloc(8)
    native.cpu.mem_write(byte_dest, b"\xdd" * 8)
    native.cpu.mem_write(byte_src, bytes([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]))
    native.invoke(byte_property, 0x90, byte_dest, byte_src)
    results["byte_complete_array_dim_5"] = {
        "arrayDim": 5,
        "destination": bytes_hex(native, byte_dest, 8),
    }

    int_property = native.property(VTABLES["UIntProperty"], array_dim=3, element_size=4)
    int_dest = native.alloc(16)
    int_src = native.alloc(16)
    native.write(int_dest, "4I", 0, 0, 0, 0)
    native.write(int_src, "4I", 0x11223344, 0x55667788, 0x99AABBCC, 0xDDEEFF00)
    native.invoke(int_property, 0x90, int_dest, int_src)
    results["int_complete_array_dim_3"] = {
        "arrayDim": 3,
        "destination": words_hex(native, int_dest, 4),
    }

    bool_property = native.property(VTABLES["UBoolProperty"], element_size=4)
    native.write(bool_property + 0x5C, "I", 0x00FF0000)
    bool_dest = native.alloc(4)
    bool_src = native.alloc(4)
    native.write(bool_dest, "I", 0xA5A5A5A5)
    native.write(bool_src, "I", 0x12345678)
    native.invoke(bool_property, 0x8C, bool_dest, bool_src)
    results["bool_single_mask"] = {
        "mask": "0x00ff0000",
        "destination": words_hex(native, bool_dest, 1),
    }

    # FString copy: +4 is ArrayNum and +8 is ArrayMax.  The body sets both
    # destination words to source ArrayNum, reallocates with element size 2,
    # then copies 2*ArrayNum bytes forward.  The no-op Realloc keeps data stable.
    string_property = native.property(VTABLES["UStrProperty"], element_size=12)
    string_source, string_source_data = native.utf16_value([0x31, 0x32, 0x00], capacity=7)
    string_dest, string_dest_data = native.utf16_value([0xDEAD, 0xDEAD, 0xDEAD, 0xDEAD], capacity=8)
    native.invoke(string_property, 0x8C, string_dest, string_source)
    results["str_single_count_capacity"] = {
        "source": {"arrayNum": native.read(string_source + 4, "I")[0],
                   "arrayMax": native.read(string_source + 8, "I")[0]},
        "destination": {"arrayNum": native.read(string_dest + 4, "I")[0],
                        "arrayMax": native.read(string_dest + 8, "I")[0],
                        "data": words_hex(native, string_dest_data, 4)},
    }
    native.invoke(string_property, 0x8C, string_source, string_source)
    results["str_single_alias"] = {
        "record": words_hex(native, string_source, 3),
        "data": words_hex(native, string_source_data, 3),
    }

    # Dynamic array raw branch (inner flags clear).
    inner_int = native.property(VTABLES["UIntProperty"], element_size=4)
    array_property = native.property(VTABLES["UArrayProperty"], element_size=12)
    native.write(array_property + 0x5C, "I", inner_int)
    array_source, array_source_data = native.array_value([7, 9, 11], 4, capacity=5)
    array_dest, array_dest_data = native.array_value([0, 0], 4, capacity=6)
    native.invoke(array_property, 0x8C, array_dest, array_source)
    results["array_single_raw"] = {
        "sourceArrayNum": native.read(array_source + 4, "I")[0],
        "destination": {
            "arrayNum": native.read(array_dest + 4, "I")[0],
            "arrayMax": native.read(array_dest + 8, "I")[0],
            "data": words_hex(native, array_dest_data, 5),
        },
    }

    # Dynamic array recursive branch (inner flags 0x400000).  The callback
    # receives each element as a complete-value copy.
    recursive_inner = native.property(0, element_size=4, flags=0x400000)
    callback, order, dests, srcs, count = native.traced_case(
        0xA0, marker=0xA0A0A0A0
    )
    recursive_inner_vtable = native.custom_vtable({0x90: callback})
    native.write(recursive_inner, "I", recursive_inner_vtable)
    recursive_array = native.property(VTABLES["UArrayProperty"], element_size=12)
    native.write(recursive_array + 0x5C, "I", recursive_inner)
    rec_source, rec_source_data = native.array_value([1, 2, 3], 4)
    rec_dest, rec_dest_data = native.array_value([], 4, capacity=4)
    native.invoke(recursive_array, 0x8C, rec_dest, rec_source)
    results["array_single_recursive"] = {
        "calls": native.read(count, "I")[0],
        "order": native.words_at(order, 4),
        "destinations": [f"0x{x:08x}" for x in native.words_at(dests, 4)],
        "sources": [f"0x{x:08x}" for x in native.words_at(srcs, 4)],
        "destination": {
            "arrayNum": native.read(rec_dest + 4, "I")[0],
            "data": words_hex(native, rec_dest_data, 3),
        },
    }

    # Fixed-array single recursively dispatches inner +0x90 count times and
    # performs no allocation itself.
    fixed_inner = native.property(0, element_size=4)
    callback, order, dests, srcs, count = native.traced_case(
        0xF0, marker=0xF0F0F0F0
    )
    native.write(fixed_inner, "I", native.custom_vtable({0x90: callback}))
    fixed_property = native.property(VTABLES["UFixedArrayProperty"], element_size=12)
    native.write(fixed_property + 0x5C, "I", fixed_inner)
    native.write(fixed_property + 0x60, "I", 3)
    fixed_dest = native.alloc(16)
    fixed_src = native.alloc(16)
    native.cpu.mem_write(fixed_dest, b"\xdd" * 16)
    native.cpu.mem_write(fixed_src, bytes(range(16)))
    native.invoke(fixed_property, 0x8C, fixed_dest, fixed_src)
    results["fixed_array_single_recursive"] = {
        "arrayCount": 3,
        "calls": native.read(count, "I")[0],
        "order": native.words_at(order, 4),
        "destinations": [f"0x{x:08x}" for x in native.words_at(dests, 4)],
        "sources": [f"0x{x:08x}" for x in native.words_at(srcs, 4)],
        "destination": bytes_hex(native, fixed_dest, 16),
    }

    # Map CopySingleValue is an immediate ret; record bytes prove no write.
    map_property = native.property(VTABLES["UMapProperty"], element_size=8)
    map_dest = native.alloc(12)
    map_src = native.alloc(12)
    native.cpu.mem_write(map_dest, bytes(range(12)))
    native.cpu.mem_write(map_src, bytes(range(12, 24)))
    before = bytes_hex(native, map_dest, 12)
    native.invoke(map_property, 0x8C, map_dest, map_src)
    results["map_single_noop"] = {
        "before": before,
        "after": bytes_hex(native, map_dest, 12),
    }

    # Struct CopySingleValue walks direct child properties first, then the
    # inheritance-super chain.  A non-UProperty child is included to expose the
    # native IsA filter.  Each callback records its member offset-derived pointer.
    struct_dest = native.alloc(32)
    struct_src = native.alloc(32)
    native.cpu.mem_write(struct_dest, b"\xdd" * 32)
    native.cpu.mem_write(struct_src, bytes(range(32)))
    struct_order = native.alloc(0x20)
    struct_dests = native.alloc(0x20)
    struct_srcs = native.alloc(0x20)
    struct_count = native.alloc(4)
    native.write(struct_order, "8I", *([0] * 8))
    native.write(struct_dests, "8I", *([0] * 8))
    native.write(struct_srcs, "8I", *([0] * 8))
    native.write(struct_count, "I", 0)

    def struct_callback(identifier, marker):
        callback, _ = native.callback_stub(
            struct_order, struct_dests, struct_srcs, identifier=identifier,
            count_base=struct_count, marker=marker
        )
        return callback

    child_super = native.make_child(offset=8, callback=struct_callback(3, 0x33333333))
    child_nonprop = native.make_child(next_child=0, offset=4,
                                      callback=struct_callback(99, 0x99999999), class_ptr=0)
    child_direct = native.make_child(next_child=child_nonprop, offset=0,
                                     callback=struct_callback(1, 0x11111111))
    super_struct = native.make_struct(child_super)
    root_struct = native.make_struct(child_direct, superclass=super_struct)
    struct_property = native.property(VTABLES["UStructProperty"], element_size=12)
    native.write(struct_property + 0x5C, "I", root_struct)
    native.invoke(struct_property, 0x8C, struct_dest, struct_src)
    results["struct_single_inheritance_filter"] = {
        "calls": native.read(struct_count, "I")[0],
        "order": native.words_at(struct_order, 4),
        # Keep this named separately for validators that want to compare the
        # actual shared callback trace.  It is the same buffer as `order`, so
        # the sequence cannot accidentally be assembled from per-child traces.
        "visitOrder": native.words_at(struct_order, native.read(struct_count, "I")[0]),
        "destinations": [f"0x{x:08x}" for x in native.words_at(struct_dests, 4)],
        "sources": [f"0x{x:08x}" for x in native.words_at(struct_srcs, 4)],
        "destination": bytes_hex(native, struct_dest, 16),
    }

    return results


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: native-property-copy-oracle.py GAME_ROOT")
    native = CopyProbe(Path(sys.argv[1]))
    print(json.dumps({"hashes": _native_collision.HASHES, "vtables": vtable_report(native),
                      "bodies": {
                          "genericSingle": "0x10165560",
                          "genericComplete": "0x10165600",
                          "reallocBoundary": "0x10145440",
                      }, "results": run(native)}, sort_keys=True))


if __name__ == "__main__":
    main()
