#!/usr/bin/env python3
"""补传单个发布件到指定服务器（修"半截文件"）。

## 为什么需要这个脚本

上一次双源上传被工具超时打断，在新源上留下了一个 **1.8MB / 83MB** 的
残缺 nsis.7z —— 而新源是**首选源**，用户下联网安装器会拿到坏包。
`upload-release.py` 是"全量发一套"，重跑它要传 200MB×2，慢且没必要；
这里只补那一个文件，并做 sha256 回读验证。

用法：
  set MXBOT_SSH_PASSWORD=...
  python scripts/fix-partial-upload.py <host> <本地文件> <远端名>
例：
  python scripts/fix-partial-upload.py 8.209.232.216 dist/nsis-web/mxbot-launcher-0.1.2-x64.nsis.7z mxbot-launcher-0.1.2-x64.nsis.7z
"""
import hashlib
import os
import sys

import paramiko

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

REMOTE_DIR = '/var/www/html/mxbot'


def sha256(p: str) -> str:
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    host, local, remote_name = sys.argv[1], sys.argv[2], sys.argv[3]
    if not os.path.exists(local):
        print('[FAIL] 本地文件不存在:', local)
        return 1

    pw = os.environ['MXBOT_SSH_PASSWORD']
    size = os.path.getsize(local)
    lhash = sha256(local)
    print(f'本地 {local}\n  {size} B  sha256={lhash[:16]}…')

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, 22, 'root', pw, timeout=20)
    try:
        sftp = c.open_sftp()
        try:
            # 传之前先看远端现状（可能正是那个残缺文件）
            try:
                before = sftp.stat(f'{REMOTE_DIR}/{remote_name}').st_size
            except IOError:
                before = -1
            print(f'远端现状: {before} B（目标 {size} B）')
            print('上传中…（大文件较慢，请耐心）')
            sftp.put(local, f'{REMOTE_DIR}/{remote_name}')
            after = sftp.stat(f'{REMOTE_DIR}/{remote_name}').st_size
            print(f'上传完成: {after} B')
        finally:
            sftp.close()

        # 远端 sha256 回读（决定性验证：大小对不等于内容对）
        _i, o, _e = c.exec_command(
            f'sha256sum {REMOTE_DIR}/{remote_name} | cut -d" " -f1', timeout=300
        )
        rhash = o.read().decode().strip()
        ok = rhash == lhash and after == size
        print(f'远端 sha256={rhash[:16]}…  {"一致 ✔" if rhash == lhash else "不一致 ✘"}')
        print('[OK] 已修复' if ok else '[FAIL] 仍不一致，请重试')
        return 0 if ok else 1
    finally:
        c.close()


if __name__ == '__main__':
    sys.exit(main())
