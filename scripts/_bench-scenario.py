#!/usr/bin/env python3
"""
**真实场景**：连续删两三个运行时包，然后马上去做别的事（测速/打包）。

## 主人 2026-09-27 的原话

  「我是连续删除两三个文件包」
  「我删了东西之后再测连通就是全部超时，日志打包也时长会慢很多很多，
    好像是删除文件导致磁盘 IO 受限导致的，大半天都在 100% 磁盘占用，
    持续十几分钟，期间测速和打包日志都异常，甚至主进程无响应」

## 从日志算出来的关键事实

    runtimes:remove 耗时 520ms / 919ms / 1170ms / 1596ms   ← 删除**本身很快**
    mirrors:test(8003ms)  pysrc:test(20350ms)              ← 紧接着的测速**极慢**

删除快是因为 `store.remove()` 只做 **rename**（瞬时），真删在后台。
所以问题是：**用户点完删除立刻去测速，撞上后台那几万文件的删除。**

## 这个脚本对比三种策略（都在真实规模上跑）

  A. 无限速：删完为止，中间不让路（改之前的行为）
  B. 每子目录让 8ms（我上一轮加的 slowRemoveDir）
  C. 让路 + **给删除降优先级**：更小的片、更频繁的让路

并量：**删除期间，"另一个功能"的 IO 延迟分布**
（P95 才是用户能感觉到的"卡" —— 中位数会被大量快样本冲淡）
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

# 一个 AstrBot 运行时的真实规模
N_FILES = 49000
N_DIRS = 120
PAYLOAD = b"x" * 1024


def build(root: Path) -> None:
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    per = N_FILES // N_DIRS
    for d in range(N_DIRS):
        # 模仿真实布局：包目录/子目录/很多小文件
        sub = root / f"pkg{d:03d}" / "sub"
        sub.mkdir(parents=True, exist_ok=True)
        for i in range(per):
            (sub / f"m{i:05d}.py").write_bytes(PAYLOAD)


class Probe:
    """
    模拟"与此同时，另一个功能在读写盘"。
    用 200 个小文件轮读 —— 样本够多，P95 才稳。
    """

    def __init__(self, watch: Path):
        watch.mkdir(parents=True, exist_ok=True)
        self.files = []
        for i in range(200):
            f = watch / f"p{i:03d}.txt"
            f.write_text("x" * 2048, encoding="utf-8")
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
        self._t = threading.Thread(target=self._loop, daemon=True)
        self._t.start()

    def stop(self) -> None:
        self._stop.set()
        self._t.join(timeout=2)


def rm_unlimited(root: Path) -> None:
    shutil.rmtree(root, ignore_errors=True)


def rm_throttled(root: Path, yield_ms: float, per_files: int | None = None) -> int:
    """
    限速删除。
      yield_ms  —— 每片之后让多久
      per_files —— 每多少**个文件**让一次（None = 只按子目录让）
    """
    n = 0
    since = 0

    def walk(cur: Path) -> None:
        nonlocal n, since
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
                    since += 1
                except OSError:
                    pass
            # 让路条件：删完一个子目录，或每 per_files 个文件
            need = isdir or (per_files is not None and since >= per_files)
            if need:
                since = 0
                time.sleep(yield_ms / 1000.0)
        try:
            os.rmdir(cur)
        except OSError:
            pass

    walk(root)
    return n


def run(label: str, fn) -> dict:
    tree = Path(tempfile.gettempdir()) / "mx-scenario-tree"
    watch = Path(tempfile.gettempdir()) / "mx-scenario-watch"
    build(tree)
    probe = Probe(watch)
    probe.start()
    time.sleep(0.5)
    base_n = len(probe.samples)

    t0 = time.perf_counter()
    fn(tree)
    dt = time.perf_counter() - t0
    probe.stop()

    base = probe.samples[:base_n] or [0.2]
    during = probe.samples[base_n:] or [0.2]

    def p(xs, q):
        s = sorted(xs)
        return s[min(len(s) - 1, int(len(s) * q))]

    print(f"\n  {label}")
    print(f"    删完耗时      : {dt:6.2f}s")
    print(f"    别人的 IO（删之前）: 中位 {statistics.median(base):6.3f}  P95 {p(base,0.95):7.3f}  最大 {max(base):8.3f} ms")
    print(f"    别人的 IO（删期间）: 中位 {statistics.median(during):6.3f}  P95 {p(during,0.95):7.3f}  最大 {max(during):8.3f} ms")
    return {
        "dt": dt,
        "base_p95": p(base, 0.95),
        "during_p95": p(during, 0.95),
        "during_max": max(during),
        "during_med": statistics.median(during),
    }


print("=" * 78)
print(f"真实规模：{N_FILES} 文件 / {N_DIRS} 目录（≈ 一个 AstrBot 运行时）")
print("=" * 78)

a = run("A · 无限速（改之前 fsp.rm 的行为）", rm_unlimited)
b = run("B · 每子目录让 8ms（我上一轮加的）", lambda p: rm_throttled(p, 8))
c = run("C · 每 200 个文件让 2ms（更细的片）", lambda p: rm_throttled(p, 2, 200))

print("\n" + "=" * 78)
print("汇总（P95 才代表用户能感觉到的「卡」）")
print("=" * 78)
for name, r in (("A 无限速", a), ("B 每目录让 8ms", b), ("C 每 200 文件让 2ms", c)):
    print(
        f"  {name:22} 删完 {r['dt']:6.2f}s   别人 P95 {r['during_p95']:7.3f} ms"
        f"   （基线 {r['base_p95']:.3f}）"
    )
print()
best = min((a, b, c), key=lambda r: r["during_p95"])
winner = "A" if best is a else ("B" if best is b else "C")
print(f"  别人 IO 最不受影响的：**{winner}**（P95 {best['during_p95']:.3f} ms）")
print(f"  参考：基线 P95 = {a['base_p95']:.3f} ms")
