#!/usr/bin/env python3
"""验收新唯一服务器 8.209.232.216 上的发布件是否与本地**逐字节一致**。

## 为什么不能只看 HTTP 200

本项目已经踩过两次同类坑：
  · 上一台机器对任何路径都返回 200（内容是别的服务的 SPA 兜底 HTML）
  · 双源上传被打断，留下一个 1.8MB / 83MB 的**半截 7z**，而它正挂在首选源上

所以验收标准是**证据**，不是状态码：
  1. 远端大小 == 本地大小（半截文件第一步就能看出来）
  2. 关键文件（安装包 / 7z / NapCat 包）**远端 sha256 == 本地 sha256**
  3. latest.json 能解析且 version 与 package.json 一致
"""
import hashlib
import json
import os
import sys
import urllib.request

import paramiko

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HOST = os.environ.get('MXBOT_RELEASE_HOST', '8.209.232.216')
PW = os.environ['MXBOT_SSH_PASSWORD']
REMOTE = '/var/www/html/mxbot'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DONE = os.environ.get('MXBOT_DONE_DIR') or os.path.join(ROOT, '..', '..', 'MX机器人启动器成品')

with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
    VER = json.load(f)['version']

# (本地文件, 远端相对路径, 是否校验 sha256)
#
# ★ 版本清单**自动发现**（不再写死 0.1.0/0.1.1/0.1.2）：
# 每次发版都手改这个列表，迟早会漏掉一个版本，而"漏掉"的表现是
# 验收通过、用户下不到 —— 所以改成扫描成品目录里所有的
# AstriaX-Setup-*.exe，按版本号排序后逐个核对。
import glob
import re as _re

FILES = []
_versions = sorted(
    {
        m.group(1)
        for p in glob.glob(os.path.join(DONE, 'AstriaX-Setup-*.exe'))
        if (m := _re.search(r'AstriaX-Setup-([\d.]+)\.exe$', os.path.basename(p)))
    },
    key=lambda v: [int(x) for x in v.split('.')],
)
print(f'发现 {len(_versions)} 个版本：{", ".join(_versions)}')
# ★ 联网安装包（nsis-web）已下线：不再验收 WebSetup / nsis.7z / latest-web.yml
#（它们不会被产出，留着会让验收永远失败 —— 主人 2026-09-26「web安装包不搞了」）
for v in _versions:
    FILES.append((os.path.join(DONE, f'AstriaX-Setup-{v}.exe'), f'AstriaX-Setup-{v}.exe', True))
FILES += [
    (os.path.join(DONE, 'latest.json'), 'latest.json', False),
    (os.path.join(DONE, 'latest.yml'), 'latest.yml', False),
    (os.path.join(DONE, 'NapCat.Shell.zip'), 'files/napcat/NapCat.Shell.zip', True),
]


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1024 * 1024), b''):
            h.update(c)
    return h.hexdigest()


def http_size(url):
    """用 HTTP HEAD 拿远端大小（外网视角，顺便证明"用户真能下到"）"""
    req = urllib.request.Request(url, method='HEAD')
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, int(r.headers.get('Content-Length') or 0)
    except Exception as ex:  # noqa: BLE001
        return None, str(ex)


c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, 22, 'root', PW, timeout=20)


def run(cmd, t=300):
    _i, o, e = c.exec_command(cmd, timeout=t)
    o.channel.settimeout(t)
    try:
        out = o.read().decode('utf-8', 'replace')
    except Exception:
        out = '<timeout>'
    return out.strip()


bad = []
try:
    print(f'版本 {VER}；核对 {len(FILES)} 个文件\n')
    for local, rel, want_hash in FILES:
        if not os.path.exists(local):
            print(f'  [本地缺] {rel}')
            bad.append(rel)
            continue
        lsize = os.path.getsize(local)
        # 外网视角的大小
        st, rsize = http_size(f'http://{HOST}/mxbot/{rel}')
        size_ok = st == 200 and rsize == lsize
        line = f'  [{"OK  " if size_ok else "FAIL"}] {rel}  远端={rsize}  本地={lsize}'
        if want_hash:
            rh = run(f'sha256sum {REMOTE}/{rel} 2>/dev/null | cut -d" " -f1')
            lh = sha256(local)
            hash_ok = rh == lh
            line += f'  sha256={"一致" if hash_ok else "不一致!"}'
            if not hash_ok:
                bad.append(rel)
        if not size_ok:
            bad.append(rel)
        print(line)

    body = urllib.request.urlopen(f'http://{HOST}/mxbot/latest.json', timeout=15).read().decode('utf-8')
    j = json.loads(body)
    ok = j.get('version') == VER
    print(f'\n  latest.json version={j.get("version")}（本地 package.json={VER}）'
          f'  {"一致" if ok else "不一致!"}')
    if not ok:
        bad.append('latest.json')

    files_json = json.loads(
        urllib.request.urlopen(f'http://{HOST}/mxbot/files/versions.json', timeout=15).read().decode('utf-8')
    )
    print(f'  files/versions.json: napcat={[r.get("tag") for r in files_json.get("napcat", [])]} '
          f'astrbot={[r.get("tag") for r in files_json.get("astrbot", [])]}')
finally:
    c.close()

print('\n' + ('[OK] 发布件已完整就位，与本地逐字节一致' if not bad else f'[FAIL] 有 {len(bad)} 项不一致：{bad}'))
sys.exit(0 if not bad else 1)
