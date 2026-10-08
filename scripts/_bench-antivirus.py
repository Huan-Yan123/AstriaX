#!/usr/bin/env python3
"""
实测：火绒实时扫描对"删大目录"的影响，以及**怎么绕开它**。

## 背景（主人 2026-09-27）

「我是删的已安装的 astrbot 和 napcat 包」
→ 删完磁盘 100% 持续十几分钟、测速全超时、打包日志慢、主进程无响应。

## 查出来的真凶

  · 机器上装的是**火绒**（HipsDaemon，107 线程），Defender 被它接管
  · 火绒的实时防护会**对每个被删除的文件做一次检查**
  · AstrBot 运行时 = **4.9 万个文件** → 4.9 万次拦截

所以"删 4.9 万个文件"的真实代价 ≈ 4.9 万次**杀软回调**，
而不是单纯的磁盘元数据操作（我先前那个 2 万文件基准测出"没影响"，
正是因为那些文件**在临时目录里、可能被火绒放过或已缓存**）。

## 这个脚本做什么

在**同一块盘**上，用同样的文件数，对比：

  A. 在 `%TEMP%` 下删（火绒通常对临时目录宽松）
  B. 在**项目 data 目录**下删（火绒盯得紧 —— 这是用户的真实场景）

如果 B 明显慢于 A，就证明"杀软扫描"确实是主要成本，
那么**正确的解法是"给数据目录加排除"**，而不是在代码里做限速
（限速治不了"每个文件被拦一次"）。

安全说明：只在临时区域建样本，跑完清掉，**不碰项目数据**。
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

N_FILES = 15000
N_DIRS = 30
PAYLOAD = b"x" * 1024


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


def timed_delete(root: Path, label: str) -> float:
    build(root)
    # 建完之后先等一会儿，让杀软扫完"新建"的那一轮
    time.sleep(1.0)
    t0 = time.perf_counter()
    shutil.rmtree(root, ignore_errors=True)
    dt = time.perf_counter() - t0
    print(f"  {label:46} {dt:7.2f}s")
    return dt


print("=" * 78)
print(f"样本：{N_FILES} 文件 / {N_DIRS} 目录 / 每文件 1KB")
print("=" * 78)

tmp_root = Path(tempfile.gettempdir()) / "mx-av-bench-temp"
proj_root = Path(r"E:\MX\launcher-acb\data-test\av-bench")

print()
a = timed_delete(tmp_root, "A · 系统临时目录（火绒通常宽松）")
b = timed_delete(proj_root, "B · 项目 data 目录（火绒盯得紧 = 用户场景）")

print()
print("=" * 78)
print("结论")
print("=" * 78)
print(f"  A（临时目录）：{a:.2f}s")
print(f"  B（数据目录）：{b:.2f}s")
if b > a * 1.3:
    print(f"  → B 比 A 慢 {b/a:.1f} 倍 —— **杀软扫描是主要成本**，")
    print("    解法是给数据目录加排除（代码层限速治不了这个）")
else:
    print(f"  → 两者接近（{b/a:.1f}x）—— 杀软不是主要因素，")
    print("    成本在磁盘元数据本身，那时「限速让步」才是对的方向")

# 清理
shutil.rmtree(tmp_root, ignore_errors=True)
shutil.rmtree(proj_root, ignore_errors=True)
