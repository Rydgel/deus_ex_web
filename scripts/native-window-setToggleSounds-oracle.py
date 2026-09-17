"""Unicorn oracle for the Extension setToggleSounds native — thin wrapper over the shared
control-window probe. Executes the real registered exec trampoline from the
hash-checked Extension.dll and reports canonical accesses/events/state."""
import importlib.util
import sys
from pathlib import Path
_spec = importlib.util.spec_from_file_location(
    'native_controlwindow_probe',
    Path(__file__).with_name('native-controlwindow-probe.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
_mod.oracle_main('setToggleSounds')
