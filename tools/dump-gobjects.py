#!/usr/bin/env python3
"""Dump the running original Deus Ex GObjObjects registry (index -> name).

The project recovered these Core.dll structures:
  GObjObjects FArray  data +0x19e628, count +0x19e62c, capacity +0x19e630
  GNames     FArray    data +0x1961f0, count +0x1961f4
  object +0x04 = global UObject index, +0x20 = FName index, +0x24 = class UClass*
  FNameEntry +0x0c = UTF-16 text (case-insensitive, NUL terminated)

This is measurement against the original game, which the project rules prefer
over an emulated or modelled N0. Run it while a map is loaded (e.g. training),
then use the printed index of the actor you need (e.g. LightSwitch0).

Usage (Windows Python, or Python for Windows under Wine/CrossOver):
  python dump-gobjects.py                 # attach to DeusEx.exe, print all
  python dump-gobjects.py --json out.json # write the full table as JSON
  python dump-gobjects.py --find LightSwitch
"""
import argparse
import ctypes
import json
import struct
import sys
from ctypes import wintypes

CORE_MODULE = 'Core.dll'
OFF_GOG_DATA = 0x19E628
OFF_GOG_COUNT = 0x19E62C
OFF_NAMES_DATA = 0x1961F0
OFF_NAMES_COUNT = 0x1961F4
OFF_OBJECT_INDEX = 0x04
OFF_OBJECT_NAME = 0x20
OFF_OBJECT_CLASS = 0x24
OFF_NAMEENTRY_TEXT = 0x0C

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MAX_PATH = 260
TH32CS_SNAPPROCESS = 0x00000002
LIST_MODULES_ALL = 0x03

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
psapi = ctypes.WinDLL('psapi', use_last_error=True)


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD),
                ('th32DefaultHeapID', ctypes.c_size_t),
                ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                ('th32ParentProcessID', wintypes.DWORD),
                ('pcPriClassBase', ctypes.c_long), ('dwFlags', wintypes.DWORD),
                ('szExeFile', ctypes.c_char * MAX_PATH)]


def find_process(name):
    snapshot = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == -1:
        raise OSError('CreateToolhelp32Snapshot failed')
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
    try:
        if not k32.Process32First(snapshot, ctypes.byref(entry)):
            raise OSError(f'process {name} not found')
        while True:
            if entry.szExeFile.decode('latin1').lower() == name.lower():
                return entry.th32ProcessID
            if not k32.Process32Next(snapshot, ctypes.byref(entry)):
                raise OSError(f'process {name} not found')
    finally:
        k32.CloseHandle(snapshot)


def module_base(pid, name):
    hmods = (wintypes.HMODULE * 1024)()
    needed = wintypes.DWORD()
    process = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not process:
        raise OSError(f'OpenProcess failed: {ctypes.get_last_error()}')
    try:
        if not psapi.EnumProcessModulesEx(process, hmods, ctypes.sizeof(hmods),
                                          ctypes.byref(needed), LIST_MODULES_ALL):
            raise OSError('EnumProcessModulesEx failed')
        count = needed.value // ctypes.sizeof(wintypes.HMODULE)
        for i in range(count):
            buffer = ctypes.create_string_buffer(MAX_PATH)
            if psapi.GetModuleBaseNameA(process, hmods[i], buffer, MAX_PATH):
                if buffer.value.decode('latin1').lower() == name.lower():
                    return hmods[i]
        raise OSError(f'module {name} not loaded')
    finally:
        k32.CloseHandle(process)


class Reader:
    def __init__(self, pid):
        self.process = k32.OpenProcess(PROCESS_VM_READ, False, pid)
        if not self.process:
            raise OSError(f'OpenProcess(VM_READ) failed: {ctypes.get_last_error()}')

    def read(self, address, size):
        buffer = ctypes.create_string_buffer(size)
        read = ctypes.c_size_t()
        if not k32.ReadProcessMemory(self.process, ctypes.c_void_p(address), buffer,
                                     size, ctypes.byref(read)) or read.value != size:
            raise OSError(f'ReadProcessMemory({address:#x}, {size}) failed')
        return buffer.raw

    def u32(self, address):
        return struct.unpack('<I', self.read(address, 4))[0]

    def wstr(self, address, limit=256):
        raw = self.read(address, limit * 2)
        end = 0
        while end + 1 < len(raw) and (raw[end] or raw[end + 1]):
            end += 2
        return raw[:end].decode('utf-16le', 'replace')


def dump(reader, core):
    gog_data = reader.u32(core + OFF_GOG_DATA)
    gog_count = reader.u32(core + OFF_GOG_COUNT)
    names_data = reader.u32(core + OFF_NAMES_DATA)
    names_count = reader.u32(core + OFF_NAMES_COUNT)
    name_cache = {}

    def name_at(index):
        if index in name_cache:
            return name_cache[index]
        text = ''
        try:
            entry = reader.u32(names_data + index * 4)
            if entry:
                text = reader.wstr(entry + OFF_NAMEENTRY_TEXT)
        except OSError:
            text = f'<name {index}>'
        name_cache[index] = text
        return text

    rows = []
    for slot in range(gog_count):
        try:
            obj = reader.u32(gog_data + slot * 4)
        except OSError:
            break
        if not obj:
            continue
        try:
            index = reader.u32(obj + OFF_OBJECT_INDEX)
            name_index = reader.u32(obj + OFF_OBJECT_NAME)
            class_ptr = reader.u32(obj + OFF_OBJECT_CLASS)
            class_name = name_at(reader.u32(class_ptr + OFF_OBJECT_NAME)) if class_ptr else ''
            rows.append({'slot': slot, 'index': index,
                         'name': name_at(name_index), 'class': class_name})
        except OSError:
            continue
    return {'coreBase': core, 'objectCount': gog_count, 'nameCount': names_count,
            'objects': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--process', default='DeusEx.exe')
    parser.add_argument('--module', default=CORE_MODULE)
    parser.add_argument('--json', metavar='PATH')
    parser.add_argument('--find', action='append', default=[])
    args = parser.parse_args()
    if sys.platform != 'win32' and not hasattr(ctypes, 'WinDLL'):
        sys.exit('This tool requires Windows (or Python for Windows under Wine).')

    pid = find_process(args.process)
    core = module_base(pid, args.module)
    reader = Reader(pid)
    result = dump(reader, core)
    result['processId'] = pid
    print(f"{args.process} pid={pid} {args.module} base={core:#x} "
          f"objects={result['objectCount']} names={result['nameCount']}")
    for row in result['objects']:
        if not args.find or any(f.lower() in row['name'].lower() for f in args.find):
            print(f"  slot {row['slot']:6d} index {row['index']:6d} "
                  f"{row['class']}.{row['name']}")
    if args.json:
        with open(args.json, 'w') as handle:
            json.dump(result, handle, indent=1)
        print(f'wrote {args.json}')


if __name__ == '__main__':
    main()
