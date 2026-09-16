"""Unicorn oracle for Extension XListWindow::GetField (native 1735).

Executes the real method body 0x1002f250 (rebased 0x1202f250): returns the
field FString data pointer, the shared empty wstring 0x10099ea8 for an
unallocated field text, or 0 for a null row / out-of-range column.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

_SPEC = importlib.util.spec_from_file_location(
    'probe', Path(__file__).with_name('native-listwindow-probe.py'))
_PROBE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PROBE)

if __name__ == '__main__':
    _PROBE.oracle_main('GetField', 'fieldstr', 'getField')
