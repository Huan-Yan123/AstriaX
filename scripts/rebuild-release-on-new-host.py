#!/usr/bin/env python3
"""重建 /mxbot/ 发布目录并上传到**唯一**服务器 8.209.232.216。

## 背景

主人：「8.209.232.216，服务器换到这里了，只有这一个了」
实测：原两台（47.109.177.13 / 8.216.57.182）**都已下线**（ping 与 HTTP 全失败），
新机 8.209.232.216 的 80 端口对外可达、nginx 已装，但 /var/www/html/mxbot 是空的。

所以只能**从本地重建**。本地有的：
  · dist/            0.1.1 与 0.1.2 的全量包 + 联网包 + latest.json/yml
  · 成品/            0.1.0 也在，另有 NapCat.Shell.zip 与 astrbot whl
本地**没有**的：files/ 那份运行时分发目录（versions.json + napcat 包），
按 scripts/publish-runtime.py 的同一套 schema 现场重建：
  · AstrBot 走 PyPI，服务器不分包体，清单里只留一条提示条目
  · NapCat 的 Shell 包从成品目录拿，sha256/size 实际计算后写进清单

上传用 SFTP（老 rsync 依赖的源机已经没了）。
"""
import hashlib
import json
import os
import posixpath
import shutil
import sys
import time

import paramiko

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HOST = os.environ.get('MXBOT_RELEASE_HOST', '8.209.232.216')
PW = os.environ['MXBOT_SSH_PASSWORD']
REMOTE = '/var/www/html/mxbot'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
DIST_WEB = os.path.join(DIST, 'nsis-web')
"""
成品目录：`E:\MX机器人启动器成品`。

★ 这里我第一版算错了路径（写成 ROOT/.. = `E:\MX`，而它实际是 `E:\MX` 的同级），
结果**所有安装包被静默跳过**、远端只剩一个 versions.json —— 一个"看起来
上传成功"的假部署。教训：部署脚本里**任何"找不到就跳过"都必须改成硬失败**，
否则最坏情况是用户拿到一个空源还以为发好了。
"""
DONE = os.environ.get('MXBOT_DONE_DIR') or os.path.join(ROOT, '..', '..', 'MX机器人启动器成品')
STAGE = os.path.join(ROOT, 'release-staging', 'mxbot')

NAP_TAG = 'v4.18.19'


def preflight() -> None:
    """发之前先把"本地到底有没有那些文件"问清楚，缺一个就停。"""
    need = []
    for v in ('0.1.0', '0.1.1', '0.1.2'):
        need += [
            os.path.join(DONE, f'AstriaX-Setup-{v}.exe'),
            os.path.join(DONE, f'AstriaX-WebSetup-{v}.exe'),
            os.path.join(DONE, f'mxbot-launcher-{v}-x64.nsis.7z'),
        ]
    need += [
        os.path.join(DONE, 'latest.json'),
        os.path.join(DONE, 'latest.yml'),
        os.path.join(DONE, 'latest-web.yml'),
        os.path.join(DONE, 'NapCat.Shell.zip'),
    ]
    missing = [p for p in need if not os.path.exists(p)]
    if missing:
        print('[FAIL] 发布件不全，停止（不做"跳过缺失文件"的假部署）：')
        for m in missing:
            print('   ', m)
        sys.exit(1)
    print(f'前置校验通过：{len(need)} 个必需文件都在 {DONE}')


def mb(n):
    return f'{n / 1048576:.2f} MB'


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    preflight()

    # ── 1) 本地搭出 stage 目录（幂等：先清后建）────────────────────────
    if os.path.exists(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(os.path.join(STAGE, 'files', 'napcat'), exist_ok=True)

    copied = []

    def cp(src, rel):
        if not os.path.exists(src):
            # preflight 已经把必需文件查过了；走到这里说明是可选件，如实说明
            print(f'  [可选件缺失] {os.path.basename(src)}')
            return
        dst = os.path.join(STAGE, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        copied.append((rel, os.path.getsize(dst)))

    # 全量安装包（三个版本都留：老用户可能从任意低版本更新）
    for v in ('0.1.0', '0.1.1', '0.1.2'):
        cp(os.path.join(DONE, f'AstriaX-Setup-{v}.exe'), f'AstriaX-Setup-{v}.exe')
        cp(os.path.join(DONE, f'AstriaX-Setup-{v}.exe.blockmap'), f'AstriaX-Setup-{v}.exe.blockmap')
        cp(os.path.join(DONE, f'AstriaX-WebSetup-{v}.exe'), f'AstriaX-WebSetup-{v}.exe')
        cp(os.path.join(DONE, f'mxbot-launcher-{v}-x64.nsis.7z'), f'mxbot-launcher-{v}-x64.nsis.7z')

    # 清单
    cp(os.path.join(DONE, 'latest.json'), 'latest.json')
    cp(os.path.join(DONE, 'latest.yml'), 'latest.yml')
    cp(os.path.join(DONE, 'latest-web.yml'), 'latest-web.yml')

    # NapCat 运行时分发（启动器靠 files/versions.json 探测版本）
    nap_src = os.path.join(DONE, 'NapCat.Shell.zip')
    nap_rel = 'files/napcat/NapCat.Shell.zip'
    cp(nap_src, nap_rel)

    # ── 2) 生成 files/versions.json（schema 与 publish-runtime.py 一致）──
    nap_size = os.path.getsize(nap_src) if os.path.exists(nap_src) else 0
    nap_sha = sha256_file(nap_src) if os.path.exists(nap_src) else ''
    manifest = {
        'updated': time.strftime('%Y-%m-%dT%H:%M:%S+08:00'),
        'astrbot': [
            {
                'tag': 'pypi',
                'asset': 'pypi:astrbot',
                'sha256': '',
                'size': 0,
                'added': time.strftime('%Y-%m-%d'),
                'note': 'AstrBot 由内置 Python 从 PyPI 直接安装，不经本服务器分发',
            }
        ],
        'napcat': [
            {
                'tag': NAP_TAG,
                'asset': 'napcat/NapCat.Shell.zip',
                'sha256': nap_sha,
                'size': nap_size,
                'added': time.strftime('%Y-%m-%d'),
            }
        ],
    }
    with open(os.path.join(STAGE, 'files', 'versions.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    total = sum(s for _r, s in copied) + os.path.getsize(os.path.join(STAGE, 'files', 'versions.json'))
    print(f'stage 就绪：{len(copied) + 1} 个文件，共 {mb(total)}')
    for rel, size in copied:
        print(f'  {rel}  {mb(size)}')

    # ── 3) SFTP 上传（幂等：远端同大小则跳过）──────────────────────────
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, 'root', PW, timeout=20)
    try:
        sftp = c.open_sftp()
        try:
            def ensure(remote_dir):
                parts = remote_dir.strip('/').split('/')
                cur = ''
                for p in parts:
                    cur += '/' + p
                    try:
                        sftp.stat(cur)
                    except IOError:
                        sftp.mkdir(cur)

            ensure(REMOTE)
            ensure(REMOTE + '/files')
            ensure(REMOTE + '/files/napcat')

            files = []
            for dirpath, _dirs, names in os.walk(STAGE):
                for n in names:
                    full = os.path.join(dirpath, n)
                    rel = os.path.relpath(full, STAGE).replace(os.sep, '/')
                    files.append((full, rel, os.path.getsize(full)))

            uploaded = skipped = 0
            for full, rel, size in sorted(files, key=lambda x: x[2]):
                rp = posixpath.join(REMOTE, rel)
                try:
                    same = sftp.stat(rp).st_size == size
                except IOError:
                    same = False
                if same:
                    skipped += 1
                    continue
                t0 = time.time()
                sftp.put(full, rp)
                uploaded += 1
                print(f'  上传 {rel}  {mb(size)}  {time.time() - t0:.1f}s')
            print(f'上传完成：新传 {uploaded}，跳过（已一致）{skipped}')

            # 权限：让 nginx 读得到
            _i, o, _e = c.exec_command(f'chmod -R a+rX {REMOTE}', timeout=120)
            o.channel.settimeout(120)
            o.read()

            # 远端核对：文件数与 versions.json 内容
            for cmd in (f'ls {REMOTE} | wc -l', f'cat {REMOTE}/files/versions.json',
                        f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1/mxbot/latest.json"):
                _i, o, _e = c.exec_command(cmd, timeout=60)
                o.channel.settimeout(60)
                print('  $', cmd, '→', o.read().decode('utf-8', 'replace').strip()[:200])
        finally:
            sftp.close()
    finally:
        c.close()
    print('[DONE]')
    return 0


if __name__ == '__main__':
    sys.exit(main())
