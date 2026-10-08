#!/usr/bin/env python3
"""实测各个 Python 源（pip 索引 + 元数据接口）是否真的可用。

为什么必须实测：源"看起来对"和"真能装"是两件事。刚才这个项目里
已经吃过一次亏 —— 内置的 GitHub 代理源在国内基本不通，却一直挂在列表里，
每次探测白等 15 秒超时。

测三件事：
  1. 索引页可达（pip 的 -i 就指着它）
  2. 元数据接口（列版本用）能返回 astrbot 的版本
  3. 真正下一个包（取 astrbot wheel 的 HEAD），量首字节与速度
"""
import json
import ssl
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

SOURCES = [
    ("清华 TUNA（推荐）", "https://pypi.tuna.tsinghua.edu.cn/simple/", "https://pypi.tuna.tsinghua.edu.cn/pypi/{pkg}/json"),
    ("阿里云", "https://mirrors.aliyun.com/pypi/simple/", "https://mirrors.aliyun.com/pypi/{pkg}/json"),
    ("腾讯云", "https://mirrors.cloud.tencent.com/pypi/simple/", "https://mirrors.cloud.tencent.com/pypi/{pkg}/json"),
    ("PyPI 官方", "https://pypi.org/simple/", "https://pypi.org/pypi/{pkg}/json"),
]

CTX = ssl.create_default_context()


def timed_get(url: str, timeout: int = 20):
    t0 = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": "AstriaX/0.1.6"})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        data = r.read()
    return time.time() - t0, data


print("=" * 74)
print("Python 源实测（astrbot 的安装源）")
print("=" * 74)

for label, index, api in SOURCES:
    print(f"\n【{label}】")
    print(f"  索引 {index}")

    # 1) 索引页（pip 用它）
    try:
        dt, data = timed_get(index + "astrbot/")
        print(f"    ✔ 索引可达  {dt*1000:.0f}ms  {len(data)/1024:.0f}KB")
    except Exception as e:
        print(f"    ✘ 索引失败: {type(e).__name__} {str(e)[:70]}")

    # 2) 元数据接口（列版本用它）
    try:
        dt, data = timed_get(api.format(pkg="astrbot"))
        j = json.loads(data)
        ver = j.get("info", {}).get("version", "?")
        n = len(j.get("releases", {}))
        print(f"    ✔ 元数据 {dt*1000:.0f}ms  最新={ver}  共{n}个版本")
    except Exception as e:
        print(f"    ✘ 元数据失败: {type(e).__name__} {str(e)[:70]}")

    # 3) 真下一点数据（量首字节与速度）
    try:
        dt, data = timed_get(api.format(pkg="astrbot"))
        j = json.loads(data)
        urls = j.get("urls") or []
        wheel = next((u for u in urls if u["filename"].endswith(".whl")), None)
        if wheel:
            req = urllib.request.Request(
                wheel["url"],
                headers={"User-Agent": "AstriaX/0.1.6", "Range": "bytes=0-1048575"},
            )
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
                got = 0
                while got < 1048576:
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    got += len(chunk)
            ms = (time.time() - t0) * 1000
            speed = got / 1024 / (ms / 1000) if ms else 0
            print(f"    ✔ 下载 {wheel['filename']}  {got/1024:.0f}KB  {ms:.0f}ms  {speed:.0f} KB/s")
        else:
            print("    · 没有 wheel 可测")
    except Exception as e:
        print(f"    ✘ 下载失败: {type(e).__name__} {str(e)[:70]}")

print("\n" + "=" * 74)
print("结论：把最快且元数据可用的源排在 BUILTIN_PYTHON_SOURCES 第一位。")
