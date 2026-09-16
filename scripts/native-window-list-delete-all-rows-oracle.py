"""Unicorn oracle for Extension XListWindow::DeleteAllRows (native 1733).

Executes the real method body 0x1002f020 (rebased 0x1202f020): clears the
selection cache, destructs every row's fields and frees each node in reverse
order, empties the rows array, runs the selection broadcast when a selection
existed, then AskParentForReconfigure.  The reported value is the leftover
EAX (the broadcast return, or 0).
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
    _PROBE.oracle_main('DeleteAllRows', 'int', 'deleteAllRows')
