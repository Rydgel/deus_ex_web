"""Unicorn oracle for Extension XListWindow::SetColumnType (native 1775).

Executes the real method body 0x10030480 (rebased 0x12030480) with the probe's
FMalloc, leaf, and kernel32 models — including the context-gated reparse loop
through setFieldText/measureField and the auto-expand driver.  The export is
void; leftover EAX is recorded as rawEax evidence only.
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
    _PROBE.oracle_main('SetColumnType', 'void', 'setColumnType')
