#!/usr/bin/env python3
"""把 0.1.0 的三个安装文件恢复回服务器。

## 为什么要恢复（主人的实测反馈）

主人要求「服务器只保留最新版 0.1.1」，我照做删掉了 0.1.0。但**漏了一个关键机制**：

    0.1.0 的**联网安装器**（`AstriaX-WebSetup-0.1.0.exe`，只有 986KB）
    在安装时要去服务器下载配套的包体
    `mxbot-launcher-0.1.0-x64.nsis.7z`（83MB）。

包体一删，已经下载了 0.1.0 联网安装器的人就**装不上了** ——
安装器还在用户手里，依赖的远端文件却没了。

所以正确做法是：**「只保留最新版」只适用于不依赖外部文件的独立产物**
（全量安装包 `AstriaX-Setup-*.exe` 自己带全部内容，删掉旧版没问题），
而**联网安装器 + 它的 7z 包体必须成套保留**。

现在按主人的新要求：0.1.0 与 0.1.1 **两个版本都保留**。

## 为什么从本地成品目录传（而不是重新打包）

成品目录里那三个文件的字节数与服务器上被删的**完全一致**
（84452749 / 986535 / 83679833），就是当初上传的那一份。
重新用 electron-builder 打包**做不到字节一致**（时间戳、压缩差异），
那样会让已经下过 0.1.0 的人校验 sha256 失败。原样传回才正确。

用法：
    set MXBOT_SSH_PASSWORD=...
    python scripts/restore-0.1.0.py
"""
import hashlib
import os
import sys

import paramiko

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HOST = os.environ.get('MXBOT_SSH_HOST', '8.209.232.216')
USER = os.environ.get('MXBOT_SSH_USER', 'root')
PASSWORD = os.environ['MXBOT_SSH_PASSWORD']
REMOTE = '/var/www/html/mxbot'

# 本地成品目录（主人要求这里保留旧版，正好用来恢复）
LOCAL_DIR = os.environ.get('MXBOT_LOCAL_DIR', r'E:\MX机器人启动器成品')

# 要恢复的文件：**成套的**。联网安装器离了 7z 就是块砖。
FILES = [
    'AstriaX-Setup-0.1.0.exe',
    'AstriaX-Setup-0.1.0.exe.blockmap',
    'AstriaX-WebSetup-0.1.0.exe',
    'mxbot-launcher-0.1.0-x64.nsis.7z',
]


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    # 先确认本地文件齐全 —— 缺一个就别开始传，避免传一半留个更糟的状态
    missing = [f for f in FILES if not os.path.exists(os.path.join(LOCAL_DIR, f))]
    if missing:
        print('[FAIL] 本地成品目录缺文件，无法恢复：')
        for m in missing:
            print('   ', m)
        return 1

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, USER, PASSWORD, timeout=20)
    sftp = c.open_sftp()

    print('上传 0.1.0 的成套文件（安装器 + 它的 7z 包体）：')
    for name in FILES:
        local = os.path.join(LOCAL_DIR, name)
        remote = f'{REMOTE}/{name}'
        size = os.path.getsize(local)
        sftp.put(local, remote)
        # 回读远端大小，确认真的传上去了（不信 put 不报错就等于成功）
        got = sftp.stat(remote).st_size
        flag = 'OK ' if got == size else 'FAIL'
        print(f'  [{flag}] {name}  本地 {size} / 远端 {got}')
        if got != size:
            print('        大小不一致，中止')
            return 1

    # 逐项验证：文件在、大小对、HTTP 可达
    print('\n回读验证：')
    ok = True
    for name in FILES:
        local_size = os.path.getsize(os.path.join(LOCAL_DIR, name))
        got = sftp.stat(f'{REMOTE}/{name}').st_size
        _i, o, _e = c.exec_command(
            f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1/mxbot/{name}"
        )
        code = o.read().decode().strip()
        good = got == local_size and code == '200'
        ok = ok and good
        print(f'  [{"OK " if good else "FAIL"}] {name}  大小 {got}  HTTP {code}')

    # 0.1.1 不能被影响
    print('\n确认 0.1.1 仍然正常：')
    for name in ('latest.json', 'AstriaX-Setup-0.1.1.exe'):
        _i, o, _e = c.exec_command(
            f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1/mxbot/{name}"
        )
        code = o.read().decode().strip()
        good = code == '200'
        ok = ok and good
        print(f'  [{"OK " if good else "FAIL"}] {name}  HTTP {code}')

    sftp.close()
    c.close()
    print('\n' + ('[OK] 0.1.0 已恢复，两个版本的安装文件都在' if ok else '[FAIL] 有项目没通过，见上面'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
