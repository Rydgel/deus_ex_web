"""Unicorn oracle for Extension XListWindow::SetSortColumn (native 1780).

Executes the real method body 0x10030860 (rebased 0x12030860): column
validation 0x10033240, the reset loop over every column's sort state, the
target column's priority/flag stores, and — when the window sorting flag is
set — the sort driver 0x100329b0 with the real MSVCRT qsort behind Core
appQsort 0x1010194c and the real comparator 0x100326d0.  The export is void;
leftover EAX is recorded as rawEax evidence only.
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
    _PROBE.oracle_main('SetSortColumn', 'void', 'setSortColumn')
