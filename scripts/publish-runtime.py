#!/usr/bin/env python3
"""在发布服务器上架 AstrBot / NapCat 运行时原文件（AstriaX官方源）。

做三件事：
  1. 查 GitHub 最新（可选指定版本）release，拿到官方资产直链与 sha256
  2. 下载到 /var/www/html/mxbot/files/<type>/ 并校验 sha256
  3. 生成/更新 /var/www/html/mxbot/files/versions.json（启动器靠它探测版本）

服务器直连 api.github.com 很快（实测 0.67s），所以不做任何本地探测逻辑，纯搬运。
下载事件由 nginx 的 /mxbot/ 访问日志统计（含 IP/地域），启动器不去读统计。

用法（本机运行，或直接在服务器上跑）：
  set MXBOT_SSH_PASSWORD=***
  python scripts/publish-runtime.py                # 最新正式版
  python scripts/publish-runtime.py --only n       # 只上 NapCat
  python scripts/publish-runtime.py --tag a=v4.27.2 # 指定版本
"""
import argparse
import hashlib
import json
import os
import posixpath
import sys

from shlex import quote as shlex_quote

try:
    import paramiko
except ImportError:
    print('缺 paramiko：python -m pip install paramiko')
    sys.exit(2)

HOST = os.environ.get('MXBOT_SSH_HOST', '8.209.232.216')
USER = os.environ.get('MXBOT_SSH_USER', 'root')
PASSWORD = os.environ.get('MXBOT_SSH_PASSWORD', '')
PORT = int(os.environ.get('MXBOT_SSH_PORT', '22'))
WEBROOT = '/var/www/html/mxbot'
FILES_DIR = f'{WEBROOT}/files'

REPOS = {
    # AstrBot：**不要发 dashboard zip**。
    #
    # 曾经这里写的是 r'AstrBot-v[\d.]+(-[\w.]+)?-dashboard\.zip$'，
    # 抓到的是官方 release 里的「WebUI 静态资源包」（6MB，只有 dist/ 前端），
    # 不是能跑的后端。后果很实在：启动器把它当运行时下下来，
    # data\runtimes\a\v4.28.0 里就只有 dist\、没有 astrbot 包，
    # 实例一启动就失败，e2e 也跟着红。
    #
    # AstrBot 的正确来源是 **PyPI**：安装时走
    #   pip install --target <运行时目录> astrbot==<版本>
    # （见 src/main/ipc.ts 的 runtime:install，kind === 'pypi' 那条分支）。
    # 所以 a 这一项不再从 GitHub 抓资产；保留键位只是为了 --only 参数不报错。
    'a': None,
    # NapCat：官方已经提供 Shell 版（NapCat.Shell.zip，约 28MB），
    # 里面就是 NapCatWinBootMain.exe + NapCatWinBootHook.dll + napcat.mjs，
    # 正是我们直接注入 QQ 启动要用的那套。
    # 早先发的 NapCat.Shell.Windows.Node.zip（117MB）是自带 node 的旧形态，
    # 我们的启动路径根本不用它，白白多 89MB 流量。
    'n': ('NapNeko/NapCatQQ', r'NapCat\.Shell\.zip$'),
}
SUB = {'a': 'astrbot', 'n': 'napcat'}

# AstrBot 只从 PyPI 装，服务器不镜像它的包体；但仍要在清单里留一条，
# 让启动器知道「AstrBot 走 PyPI」，而不是以为官方源坏了。
PYPI_HINT = {
    'tag': 'v4.28.0',
    'asset': 'pypi:astrbot',
    'sha256': '',
    'size': 0,
    'added': '',
    'note': 'AstrBot 由内置 Python 从 PyPI 直接安装，不经本服务器分发',
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', choices=['a', 'n'], help='只处理某个类型')
    ap.add_argument('--tag', action='append', default=[], help='指定版本，如 a=v4.27.2（可多次）')
    args = ap.parse_args()

    if not PASSWORD:
        print('未设置 MXBOT_SSH_PASSWORD')
        return 2

    tags = {}
    for t in args.tag:
        k, _, v = t.partition('=')
        tags[k] = v

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=25)

    def run(cmd: str, timeout: int = 120) -> str:
        _, out, err = ssh.exec_command(cmd, timeout=timeout)
        o = out.read().decode('utf-8', 'replace')
        e = err.read().decode('utf-8', 'replace')
        if e.strip():
            print('[remote]', e.strip()[:400])
        return o.strip()

    def run_bg(cmd: str, log: str, timeout_s: int = 1800, poll: int = 10) -> str:
        """后台执行长任务（大文件下载）并轮询，避免 paramiko 通道读超时。"""
        run(f"rm -f {log}")
        run(f"nohup bash -c {shlex_quote(cmd + ' ; echo MX_DONE=$? >> ' + log)} >/dev/null 2>&1 & echo started")
        waited = 0
        while waited < timeout_s:
            time.sleep(poll)
            waited += poll
            tail = run(f'tail -1 {log} 2>/dev/null || true')
            if tail.startswith('MX_DONE='):
                code = tail.split('=', 1)[1].strip()
                print(f'  [bg] 完成，退出码 {code}（耗时约 {waited}s）')
                return code
            print(f'  [bg] 下载中… {waited}s')
        raise TimeoutError(f'后台任务超过 {timeout_s}s 未完成：{cmd[:80]}')

    run(f'mkdir -p {FILES_DIR}')

    manifest = {'updated': '', 'astrbot': [], 'napcat': []}
    raw = run(f'cat {FILES_DIR}/versions.json 2>/dev/null || true')
    if raw.startswith('{'):
        try:
            manifest = json.loads(raw)
            manifest.setdefault('astrbot', [])
            manifest.setdefault('napcat', [])
        except Exception:
            pass

    keys = [args.only] if args.only else ['a', 'n']
    for key in keys:
        repo, pattern = REPOS[key]
        if repo is None:
            # AstrBot 不经服务器分发：清掉历史遗留的错误资产（dashboard zip），
            # 把清单里 astrbot 那桶重置成「走 PyPI」的提示条目。
            print(f'== {key}：AstrBot 走 PyPI，服务器不分发包体')
            run(f'rm -f {FILES_DIR}/astrbot/AstrBot-*-dashboard.zip')
            run(f'rmdir {FILES_DIR}/astrbot 2>/dev/null || true')
            manifest['astrbot'] = [dict(PYPI_HINT, added=run('date +%F'))]
            continue
        tag = tags.get(key)
        if tag:
            api = f'https://api.github.com/repos/{repo}/releases/tags/{tag}'
        else:
            api = f'https://api.github.com/repos/{repo}/releases/latest'
        print(f'== {key} ({repo}) 查询 {api}')
        info = run(f"curl -s --max-time 30 '{api}'")
        try:
            j = json.loads(info)
        except Exception:
            print('  GitHub 返回解析失败，跳过')
            continue
        rel_tag = j.get('tag_name')
        if not rel_tag:
            print('  拿不到 tag，跳过：', str(j)[:200])
            continue
        import re
        asset = None
        for a in j.get('assets', []):
            if re.search(pattern, a.get('name', '')):
                asset = a
                break
        if not asset:
            print('  没有匹配的资产，跳过')
            continue

        name = asset['name']
        url = asset['browser_download_url']
        size = asset.get('size', 0)
        digest = (asset.get('digest') or '').replace('sha256:', '')
        sub = SUB[key]
        run(f'mkdir -p {FILES_DIR}/{sub}')

        # 已存在且 sha256 一致则跳过下载
        exist_sha = run(f"sha256sum {FILES_DIR}/{sub}/{name} 2>/dev/null | awk '{{print $1}}' || true")
        if digest and exist_sha == digest:
            print(f'  已存在且校验一致，跳过下载：{name}')
        else:
            print(f'  下载 {name}（{size/1048576:.1f} MB）…')
            log = f'/tmp/mxpub-{key}.log'
            run_bg(
                f"curl -sL --max-time 1500 -o {FILES_DIR}/{sub}/{name}.part '{url}' && "
                f'mv -f {FILES_DIR}/{sub}/{name}.part {FILES_DIR}/{sub}/{name} && '
                f"sha256sum {FILES_DIR}/{sub}/{name} | awk '{{print $1}}' > {log}.sha",
                log,
                timeout_s=1800,
            )
            got = run(f'cat {log}.sha 2>/dev/null || sha256sum {FILES_DIR}/{sub}/{name} | awk \'{{print $1}}\'').split('\n')[-1].strip()
            print(f'  sha256={got[:16]}…')
            if digest and got != digest:
                print(f'  校验不一致！官方 {digest[:16]}… → 删除该文件')
                run(f'rm -f {FILES_DIR}/{sub}/{name}')
                continue
            digest = digest or got

        rel_path = f'{sub}/{name}'
        row = {'tag': rel_tag, 'asset': rel_path, 'sha256': digest, 'size': size, 'added': run('date +%F')}
        bucket = 'astrbot' if key == 'a' else 'napcat'
        # NapCat：清掉旧形态的资产。NapCat.Shell.Windows.Node.zip 是自带 node 的版本，
        # 我们的启动路径（直接塞 NapCatWinBootMain.exe 注入 QQ）用不上它，
        # 留着既占服务器空间又会让版本列表里出现一个下下来没用的选项。
        if key == 'n':
            run(f'rm -f {FILES_DIR}/napcat/NapCat.Shell.Windows.Node.zip')
            manifest['napcat'] = [r for r in manifest['napcat'] if 'Node.zip' not in str(r.get('asset', ''))]
        manifest[bucket] = [r for r in manifest[bucket] if r.get('tag') != rel_tag]
        manifest[bucket].insert(0, row)
        print(f'  上架 {rel_tag} -> {rel_path}')

    manifest['updated'] = run('date -Iseconds')
    payload = json.dumps(manifest, ensure_ascii=False, indent=2)

    sftp = ssh.open_sftp()
    with sftp.open(f'{FILES_DIR}/versions.json', 'w') as f:
        f.write(payload)
    sftp.close()

    run(f'ls -lh {FILES_DIR} {FILES_DIR}/astrbot {FILES_DIR}/napcat 2>/dev/null')
    run('chmod -R a+r ' + FILES_DIR)
    print('---- 线上清单 ----')
    print(payload)
    print('OK -> http://%s/mxbot/files/versions.json' % HOST)
    ssh.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
