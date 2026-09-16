"""Unicorn oracle for Extension XListWindow::IndexToRowId (native 1720).

Executes the real method body 0x1002ecf0 (rebased 0x1202ecf0): bounds-check
the index against this+0x174 and return the rows[index] node pointer.
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
    _PROBE.oracle_main('IndexToRowId', 'ptr', 'indexToRowId')
