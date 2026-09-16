"""Unicorn oracle for Extension XListWindow::Sort (native 1784).

Executes the real method body 0x10030c10 (rebased 0x12030c10) — a thin call
to the sort driver 0x100329b0, which rebuilds the sort-column list
0x10032560, runs the real shipped MSVCRT qsort 0x7802543d through Core
appQsort 0x1010194c with the qsort callback 0x10032a50 / comparator
0x100326d0 (Core appStrcmp/appStricmp over MSVCRT wcscmp/_wcsicmp for text
columns, f32 compares for type 1/2, row-id tie-break), then renumbers row
ids at 0x10031660.  The export is void; leftover EAX is recorded as rawEax
evidence only.
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
    _PROBE.oracle_main('Sort', 'void', 'sort')
