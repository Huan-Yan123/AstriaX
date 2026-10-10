# Bootstrap upstream AstrBot in an isolated interpreter without modifying that interpreter.
import os
import runpy
import site
import sys

runtime, mode, entry = sys.argv[1:4]
sys.argv = [entry, *sys.argv[4:]]
site.addsitedir(runtime)
sys.path.insert(0, runtime)
for name in ("win32", os.path.join("win32", "lib"), "pythonwin"):
    path = os.path.join(runtime, name)
    if os.path.isdir(path):
        sys.path.append(path)
try:
    import pywin32_bootstrap
except ImportError:
    pass
if mode == "file":
    runpy.run_path(entry, run_name="__main__")
else:
    runpy.run_module(entry, run_name="__main__", alter_sys=True)
