# Upstream Python adapter, managed by AstriaX. No launcher business logic here.
import os
import sys
import site

_root = os.environ.get("MXBOT_SITE")
if _root:
    site.addsitedir(_root)
    if _root in sys.path:
        sys.path.remove(_root)
    sys.path.insert(0, _root)
    for _name in ("win32", os.path.join("win32", "lib"), "pythonwin"):
        _path = os.path.join(_root, _name)
        if os.path.isdir(_path) and _path not in sys.path:
            sys.path.append(_path)
    try:
        import pywin32_bootstrap
    except ImportError:
        pass
