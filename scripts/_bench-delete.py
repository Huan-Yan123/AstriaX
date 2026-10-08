#!/usr/bin/env python3
"""
实测：删 4.9 万个小文件，哪种方式最省 IO？

## 背景（主人 2026-09-27 的实测现象）

删掉已安装的 AstrBot 运行时（546 MB / **4.9 万个文件**）之后：
磁盘 100% 持续十几分钟、测速全超时、打包日志变慢、主进程无响应。
他的盘是 Colorful SL500 2TB（**SATA SSD**），4K 随机写是它最弱项。

主人的想法：「有没有可能可以直接把包打包，然后改成无后缀文件直接删除」

## 这个脚本要回答

NTFS 上删一个"4.9 万个小文件"的树，代价主要在 **MFT 记录**（每条 1KB）
和目录索引的逐条更新。所以关键问题是：**能不能把"条目数"降下来**。

对比四种做法（都在临时目录里真跑，不碰项目数据）：

  A. 原样递归删（= 现在的 fsp.rm recursive）
  B. 先打成一个 tar → 删原树 → 删那个 tar
  C. 先打成一个**无后缀**文件 → 删原树 → 删它
  D. 只做 rename（改名成无后缀），**不删** —— 看单次改名有多快

D 是主人思路的核心：**rename 是一次操作**（只改一个 MFT 记录 + 父目录索引），
无论里面有多少文件。所以"改名"本身必然是毫秒级的 ——
真正贵的永远是"最终把内容抹掉"。
"""
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

# 在一个**独立临时盘位置**造样本（不碰项目数据）
BASE = Path(tempfile.gettempdir()) / "mx-del-bench"
N_FILES = 20000
N_DIRS = 40
PAYLOAD = b"x" * 512  # 每个文件 512 字节：模拟真实的小文件（.py/.pyc/.json）


def build_sample(root: Path) -> None:
    """造一棵 2 万文件 / 40 子目录的树（缩比 4.9 万，跑得快但仍能看出差别）"""
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)
    per_dir = N_FILES // N_DIRS
    for d in range(N_DIRS):
        sub = root / f"pkg{d:03d}"
        sub.mkdir(exist_ok=True)
        for i in range(per_dir):
            (sub / f"mod_{i:05d}.py").write_bytes(PAYLOAD)


def count_entries(root: Path) -> int:
    n = 0
    for _, dirs, files in os.walk(root):
        n += len(dirs) + len(files)
    return n


def timed(label: str, fn) -> float:
    t0 = time.perf_counter()
    fn()
    dt = time.perf_counter() - t0
    print(f"  {label:38} {dt:7.2f}s")
    return dt


print("=" * 78)
print(f"样本：{N_FILES} 文件 / {N_DIRS} 目录，每文件 {len(PAYLOAD)} 字节")
print("=" * 78)

results: dict[str, float] = {}

# ── D. rename 有多快（主人思路的核心）──
print("\n[D] 只 rename（改名成无后缀），不删内容")
build_sample(BASE / "D")
src = BASE / "D"
target = BASE / "d_noext"
t0 = time.perf_counter()
os.rename(src, target)
results["D_rename"] = time.perf_counter() - t0
print(f"  {'rename 整棵树（一次操作）':38} {results['D_rename']:7.4f}s")
print(f"  条目数仍为 {count_entries(target)}（只是换了个名字）")
timed("  + 再删它（无后缀文件树）", lambda: shutil.rmtree(target, ignore_errors=True))

# ── A. 原样递归删 ──
print("\n[A] 原样递归删")
build_sample(BASE / "A")
a = BASE / "A"
results["A_rmtree"] = timed("递归删除", lambda: shutil.rmtree(a, ignore_errors=True))

# ── B/C. 先打包再删 ──
print("\n[B/C] 先打包成单个文件，再删原树")
build_sample(BASE / "B")
b = BASE / "B"
archive = BASE / "b_archive_noext"  # 无后缀
t_pack = timed(
    "打成单个无后缀文件（tar）",
    lambda: subprocess.run(
        ["tar", "-cf", str(archive), "-C", str(b), "."],
        check=False,
        capture_output=True,
    ),
)
results["pack"] = t_pack
sz = archive.stat().st_size if archive.exists() else 0
print(f"  归档大小：{sz/1024/1024:.1f} MB")
results["B_rmtree_after_pack"] = timed(
    "删原树（打包之后）", lambda: shutil.rmtree(b, ignore_errors=True)
)
timed("删那个归档单文件", lambda: archive.unlink(missing_ok=True))

# ── 汇总 ──
print("\n" + "=" * 78)
print("汇总")
print("=" * 78)
total_old = results["A_rmtree"]
total_new = results.get("pack", 0) + results.get("B_rmtree_after_pack", 0)
print(f"  A 直接删             : {total_old:7.2f}s")
print(f"  B 打包+删（两步）     : {total_new:7.2f}s   （打包 {results.get('pack',0):.2f}s + 删 {results.get('B_rmtree_after_pack',0):.2f}s）")
print(f"  D 单单 rename        : {results['D_rename']:7.4f}s   ← 用户点删除后的**即时**反馈")
print()
print("结论提示：")
print("  · rename 是「一次操作」，与里面有多少文件无关 —— 所以界面能**立刻**响应")
print("  · 但「把内容真正抹掉」这件事本身，无论用什么顺序都躲不掉要动几万条 MFT")
print("  · 所以正确的方向不是「少删」，而是「慢慢删、别和别的 IO 抢」")
