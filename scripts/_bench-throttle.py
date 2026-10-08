#!/usr/bin/env python3
"""
实测：**限速删除**到底有没有用 —— 一边删、一边量"别的 IO 有多快"。

## 为什么必须这样测

主人报告：「删了东西之后再测连通就是全部超时，日志打包也慢很多，
磁盘 100% 持续十几分钟，主进程无响应」。

所以我不能只证明"限速后仍然删得掉" —— 那太弱了。要证明的是
**"限速期间，别的 IO 确实没被饿死"**。

## 做法

造一棵 2 万文件的树，然后：

  阶段 A（无限速）：一边 rmtree，一边每 50ms 量一次"打开并读一个小文件"的耗时
  阶段 B（限速）  ：用分片 + 让路的方式删，同样量

对比两种情况下"别人"的延迟 —— 这就是用户真实的体感。
"""
import os
import shutil
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path(tempfile.gettempdir()) / "mx-throttle-bench"
N_FILES = 20000
N_DIRS = 40
PAYLOAD = b"x" * 512


def build(root: Path) -> None:
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)
    per = N_FILES // N_DIRS
    for d in range(N_DIRS):
        sub = root / f"pkg{d:03d}"
        sub.mkdir(exist_ok=True)
        for i in range(per):
            (sub / f"m{i:05d}.py").write_bytes(PAYLOAD)


class Probe:
    """
    一边删、一边量"别人的 IO 延迟"。

    用一个**独立的小文件**（在另一个目录里）反复打开+读取，
    记录每次耗时 —— 它代表"与此同时另一个功能想读盘，要等多久"。
    """

    def __init__(self, watch_dir: Path):
        self.file = watch_dir / "probe.txt"
        watch_dir.mkdir(parents=True, exist_ok=True)
        self.file.write_text("hello world", encoding="utf-8")
        self.samples: list[float] = []
        self._stop = threading.Event()
        self._t: threading.Thread | None = None

    def _loop(self) -> None:
        while not self._stop.is_set():
            t0 = time.perf_counter()
            try:
                with open(self.file, "rb") as f:
                    f.read()
            except OSError:
                pass
            self.samples.append((time.perf_counter() - t0) * 1000)  # ms
            time.sleep(0.02)

    def start(self) -> None:
        self._t = threading.Thread(target=self._loop, daemon=True)
        self._t.start()

    def stop(self) -> None:
        self._stop.set()
        if self._t:
            self._t.join(timeout=2)


def unlimited_rmtree(root: Path) -> None:
    """无限速：一次 rmtree（= 现在 fsp.rm recursive 的行为）"""
    shutil.rmtree(root, ignore_errors=True)


def throttled_rmtree(root: Path, yield_ms: float = 0.008) -> int:
    """
    限速：自底向上，每删完一个子目录就 `sleep(yield_ms)` 让一次。
    （与 src/main/util/slow-remove.ts 的 slowRemoveDir 同一策略）
    """
    deleted = 0

    def walk(cur: Path) -> None:
        nonlocal deleted
        try:
            entries = list(os.scandir(cur))
        except OSError:
            return
        for e in entries:
            if e.is_dir(follow_symlinks=False):
                walk(Path(e.path))
            else:
                try:
                    os.unlink(e.path)
                    deleted += 1
                except OSError:
                    pass
            if e.is_dir(follow_symlinks=False):
                time.sleep(yield_ms / 1000.0)
        try:
            os.rmdir(cur)
            deleted += 1
        except OSError:
            pass

    walk(root)
    return deleted


def measure(label: str, do_delete) -> dict:
    build(BASE / "tree")
    tree = BASE / "tree"
    probe = Probe(BASE / "watch")
    probe.start()
    time.sleep(0.3)  # 先采一段"没在删"的基线
    base_n = len(probe.samples)

    t0 = time.perf_counter()
    do_delete(tree)
    dt = time.perf_counter() - t0
    probe.stop()

    # 分成"删之前"（基线）与"删期间"两段
    baseline = probe.samples[:base_n]
    during = probe.samples[base_n:]

    def stat(xs: list[float]) -> tuple[float, float]:
        if not xs:
            return (0.0, 0.0)
        return (statistics.median(xs), max(xs))

    bm, bx = stat(baseline)
    dm, dx = stat(during)
    print(f"\n  {label}")
    print(f"    删除耗时          : {dt:6.2f}s")
    print(f"    别人的 IO 基线中位 : {bm:6.3f} ms（最大 {bx:.2f}）")
    print(f"    删除期间 IO 中位   : {dm:6.3f} ms（最大 {dx:.2f}）")
    print(f"    → 被拖慢倍数       : {(dm / bm) if bm else 0:.1f}x")
    return {"dt": dt, "median": dm, "max": dx, "slowdown": (dm / bm) if bm else 0}


print("=" * 78)
print(f"样本：{N_FILES} 文件 / {N_DIRS} 目录")
print("=" * 78)

a = measure("A · 无限速（现在 fsp.rm 的行为）", unlimited_rmtree)
b = measure("B · 限速（每子目录让 8ms）", lambda p: throttled_rmtree(p, 8))

print("\n" + "=" * 78)
print("汇总")
print("=" * 78)
print(f"  无限速：删 {a['dt']:.2f}s，期间别人的 IO 被拖慢 {a['slowdown']:.1f}x（中位 {a['median']:.3f} ms）")
print(f"  限速  ：删 {b['dt']:.2f}s，期间别人的 IO 被拖慢 {b['slowdown']:.1f}x（中位 {b['median']:.3f} ms）")
print()
if b["slowdown"] < a["slowdown"]:
    print(f"  ✔ 限速有效：别人被拖慢的倍数从 {a['slowdown']:.1f}x 降到 {b['slowdown']:.1f}x")
    print(f"    代价是删除本身从 {a['dt']:.2f}s 变成 {b['dt']:.2f}s（后台慢慢删，用户看不见）")
else:
    print("  ✘ 限速没看出效果 —— 需要调整让步策略")
