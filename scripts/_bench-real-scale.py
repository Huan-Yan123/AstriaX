#!/usr/bin/env python3
"""
用**真实规模**（4.9 万文件）验证限速删除是否解决问题。

## 关键洞察（从日志里算出来的）

日志显示：
    runtimes:remove 耗时 520ms / 919ms / 1170ms / 1596ms   ← 删除**很快**
    mirrors:test(8003ms)  pysrc:test(20350ms)              ← 紧接着的测速**超慢**

原因：`store.remove()` 只做 **rename**（瞬时），真正的删除在**后台**跑。
于是用户点完删除、界面立刻好了，他**紧接着去点测速** ——
正好撞上后台那 4.9 万文件的删除，两个抢盘 → 测速超时 → "全部不可用"。

所以问题不是"删除慢"，而是**"后台删除和用户下一个操作抢 IO"**。

## 这个脚本验证什么

造一个**真实规模**的目录（4.9 万文件），对比：

  A. 无限速后台删（现在的行为）—— 同时量"别人"的 IO 延迟
  B. 限速后台删（每子目录让 8ms）—— 同样量

判据：**B 期间，"别人"的延迟应当明显更低**。
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

N_FILES = 49000
N_DIRS = 120
PAYLOAD = b"x" * 1024


def build(root: Path) -> None:
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    per = N_FILES // N_DIRS
    for d in range(N_DIRS):
        sub = root / f"pkg{d:03d}" / "sub"
        sub.mkdir(parents=True, exist_ok=True)
        for i in range(per):
            (sub / f"m{i:05d}.py").write_bytes(PAYLOAD)


class Probe:
    """边删边量"别人读盘要等多久" —— 用 30 个小文件轮着读，更接近真实。"""

    def __init__(self, watch: Path):
        watch.mkdir(parents=True, exist_ok=True)
        self.files = []
        for i in range(30):
            f = watch / f"p{i}.txt"
            f.write_text("x" * 4096, encoding="utf-8")
            self.files.append(f)
        self.samples: list[float] = []
        self._stop = threading.Event()

    def _loop(self) -> None:
        i = 0
        while not self._stop.is_set():
            f = self.files[i % len(self.files)]
            i += 1
            t0 = time.perf_counter()
            try:
                with open(f, "rb") as fh:
                    fh.read()
            except OSError:
                pass
            self.samples.append((time.perf_counter() - t0) * 1000)

    def start(self) -> None:
        threading.Thread(target=self._loop, daemon=True).start()

    def stop(self) -> None:
        self._stop.set()


def unlimited(root: Path) -> None:
    shutil.rmtree(root, ignore_errors=True)


def throttled(root: Path, yield_ms: float) -> int:
    n = 0

    def walk(cur: Path) -> None:
        nonlocal n
        try:
            entries = list(os.scandir(cur))
        except OSError:
            return
        for e in entries:
            isdir = e.is_dir(follow_symlinks=False)
            if isdir:
                walk(Path(e.path))
            else:
                try:
                    os.unlink(e.path)
                    n += 1
                except OSError:
                    pass
            if isdir:
                time.sleep(yield_ms / 1000.0)
        try:
            os.rmdir(cur)
        except OSError:
            pass

    walk(root)
    return n


def run(label: str, fn) -> dict:
    tree = Path(tempfile.gettempdir()) / "mx-real-bench"
    build(tree)
    probe = Probe(Path(tempfile.gettempdir()) / "mx-real-watch")
    probe.start()
    time.sleep(0.5)
    base_n = len(probe.samples)

    t0 = time.perf_counter()
    fn(tree)
    dt = time.perf_counter() - t0
    probe.stop()

    base = probe.samples[:base_n] or [0.1]
    during = probe.samples[base_n:] or [0.1]
    bm, bx, bp95 = (
        statistics.median(base),
        max(base),
        sorted(base)[int(len(base) * 0.95)],
    )
    dm, dx, dp95 = (
        statistics.median(during),
        max(during),
        sorted(during)[int(len(during) * 0.95)],
    )

    print(f"\n  {label}")
    print(f"    删除耗时        : {dt:6.2f}s  （{N_FILES} 文件）")
    print(f"    别人 IO 基线    : 中位 {bm:6.3f} / P95 {bp95:6.3f} / 最大 {bx:7.3f} ms")
    print(f"    删除期间 IO     : 中位 {dm:6.3f} / P95 {dp95:6.3f} / 最大 {dx:7.3f} ms")
    print(f"    → 中位被拖慢    : {dm/bm:5.2f}x     P95 被拖慢: {dp95/bp95:5.2f}x")
    return {"dt": dt, "med": dm / bm, "p95": dp95 / bp95, "max": dx}


print("=" * 78)
print(f"真实规模：{N_FILES} 文件 / {N_DIRS} 目录")
print("=" * 78)

a = run("A · 无限速（现在 fsp.rm 的行为）", unlimited)
b = run("B · 限速（每子目录让 8ms）", lambda p: throttled(p, 8))

print("\n" + "=" * 78)
print("汇总")
print("=" * 78)
print(f"  无限速：删 {a['dt']:.2f}s，别人中位拖慢 {a['med']:.2f}x、P95 {a['p95']:.2f}x")
print(f"  限速  ：删 {b['dt']:.2f}s，别人中位拖慢 {b['med']:.2f}x、P95 {b['p95']:.2f}x")
print()
if b["p95"] < a["p95"] * 0.9:
    print(f"  ✔ 限速有效：别人被拖慢的 P95 从 {a['p95']:.2f}x 降到 {b['p95']:.2f}x")
    print(f"    （删除本身从 {a['dt']:.1f}s 变成 {b['dt']:.1f}s —— 后台任务，用户看不见）")
else:
    print("  → 效果不明显：这块盘上的瓶颈不在"请求密度"，而在别处")
    print("    （那就该换思路：比如让删除期间的操作排队/提示，而不是硬抢）")
