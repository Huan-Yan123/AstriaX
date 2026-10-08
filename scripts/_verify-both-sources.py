#!/usr/bin/env python3
"""核对两个官方源的发布件是否与本地一致（大小 + latest.json 内容）。

背景：上一次 `upload-release.py` 双源上传被工具超时（10 分钟上限）打断，
可能留下**半截文件** —— 用户下载到半个安装包是最坏的情况之一，
所以必须立刻核对，而不是假设"大概传完了"。

判据（三重，缺一不可）：
  1. 远端文件大小 == 本地大小（半截文件的第一步就能看出来）
  2. latest.json 能解析、version 与 package.json 一致
  3. 关键文件 sha256 与本地一致（**决定性**：大小相同也可能是坏内容）
"""
import hashlib
import json
import os
import sys

import paramiko

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

PASSWORD = os.environ['MXBOT_SSH_PASSWORD']
HOSTS = [h.strip() for h in os.environ.get(
    'MXBOT_RELEASE_HOSTS', '8.216.57.182,47.109.177.13').split(',') if h.strip()]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
DIST_WEB = os.path.join(DIST, 'nsis-web')

with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
    VER = json.load(f)['version']

# (本地路径, 远端名)
FILES = [
    (os.path.join(DIST, f'AstriaX-Setup-{VER}.exe'), f'AstriaX-Setup-{VER}.exe'),
    (os.path.join(DIST, 'latest.json'), 'latest.json'),
    (os.path.join(DIST_WEB, f'AstriaX-WebSetup-{VER}.exe'), f'AstriaX-WebSetup-{VER}.exe'),
    (os.path.join(DIST_WEB, f'mxbot-launcher-{VER}-x64.nsis.7z'), f'mxbot-launcher-{VER}-x64.nsis.7z'),
]

# 只对**装器本体**做 sha256（80MB；其余小文件用大小+内容对比就够）
HASH_ONLY = {f'AstriaX-Setup-{VER}.exe'}


def sha256_local(p: str) -> str:
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    print(f'版本 {VER}；核对 {len(HOSTS)} 个源 × {len(FILES)} 个文件\n')
    bad = 0
    for host in HOSTS:
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect(host, 22, 'root', PASSWORD, timeout=20)
        try:
            print(f'=== {host} ===')
            for local, remote in FILES:
                size = os.path.getsize(local)
                _i, o, _e = c.exec_command(f'stat -c %s /var/www/html/mxbot/{remote} 2>/dev/null || echo MISSING')
                got = o.read().decode().strip()
                if got == 'MISSING':
                    print(f'  [FAIL] {remote} 远端不存在')
                    bad += 1
                    continue
                size_ok = got == str(size)
                if remote in HASH_ONLY:
                    _i, o2, _e2 = c.exec_command(f'sha256sum /var/www/html/mxbot/{remote} | cut -d" " -f1')
                    rhash = o2.read().decode().strip()
                    lhash = sha256_local(local)
                    ok = size_ok and rhash == lhash
                    print(f'  [{"OK " if ok else "FAIL"}] {remote}  {got}/{size} B  sha256 {"一致" if rhash == lhash else "不一致!"}')
                    if not ok:
                        bad += 1
                else:
                    print(f'  [{"OK " if size_ok else "FAIL"}] {remote}  {got}/{size} B')
                    if not size_ok:
                        bad += 1

            # latest.json 内容（★ 读**完整**文件再解析：
            # 第一版用 head -c 400 截断后 json.loads，必然抛
            # "substring not found: '}'" —— 那是检查脚本自己的 bug，
            # 却会被误读成"服务器上的 json 坏了"。校验必须读全。）
            _i, o, _e = c.exec_command('cat /var/www/html/mxbot/latest.json 2>/dev/null')
            body = o.read().decode('utf-8', 'replace')
            try:
                j = json.loads(body)
                same = j.get('version') == VER
                print(f'  [{"OK " if same else "FAIL"}] latest.json version={j.get("version")}（期望 {VER}）')
                if not same:
                    bad += 1
            except Exception as ex:  # noqa: BLE001
                print(f'  [FAIL] latest.json 解析失败：{ex} :: {body[:160]!r}')
                bad += 1
        finally:
            c.close()
        print()

    print('[OK] 两个源都与本地一致' if bad == 0 else f'[FAIL] 有 {bad} 项不一致/缺失 —— 需要重传')
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
