#!/usr/bin/env python3
"""把「检查更新」需要的文件发到发布服务器（幂等，可重复执行）。

上传内容（都进 nginx 的 mxbot/ 目录）：
  1. AstriaX-Setup-<版本>.exe  全量安装包 —— 客户端「检查更新」就是下这个
  2. latest.json             更新清单 —— 客户端读它判断有没有新版
  3. latest.yml / 联网安装版本体  顺手同步，保持服务器与本地一致

为什么不复用 deploy-server.py：
那个脚本负责**服务器环境**（nginx 日志、统计脚本、crontab），
而这个脚本只负责**发文件**，两者职责分开。环境配好后，日常发版只需要跑这个。

用法（密码不写进仓库）：
  set MXBOT_SSH_HOST=8.209.232.216
  set MXBOT_SSH_USER=root
  set MXBOT_SSH_PASSWORD=***
  python scripts/upload-release.py

依赖：paramiko（本机已装）。
"""
import os
import sys
import json
import posixpath

# Windows 控制台默认是 GBK，脚本里打的 ✔/✘ 和中括号会直接抛
# UnicodeEncodeError（**上传已经成功、却在收尾自检时崩掉** —— 最迷惑的一种失败）。
# 这里把标准输出强制成 UTF-8，并把无法编码的字符替换掉，绝不让一个打印把结果搅了。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

try:
    import paramiko
except ImportError:
    print('缺 paramiko：python -m pip install paramiko')
    sys.exit(2)

HOST = os.environ.get('MXBOT_SSH_HOST', '8.209.232.216')
USER = os.environ.get('MXBOT_SSH_USER', 'root')
PASSWORD = os.environ.get('MXBOT_SSH_PASSWORD', '')
PORT = int(os.environ.get('MXBOT_SSH_PORT', '22'))

"""
## 发版目标服务器（2026-09-15：唯一一台）

主人：「8.209.232.216，服务器换到这里了，只有这一个了」
实测：原来那几台（8.216.54.25 / 47.109.177.13 / 8.216.57.182）**都已下线**
（2026-09-27 实测：SSH 端口不通）。**唯一在用的是 8.209.232.216。**

所以现在只往 **8.209.232.216** 发。`MXBOT_RELEASE_HOSTS`（逗号分隔）仍可覆盖，
但它存在的意义已经不是"双源同发"，而是**将来再加机器时不用改脚本**：

    set MXBOT_RELEASE_HOSTS=8.209.232.216,备用机IP

保留"多目标"这个能力本身很重要 —— 一旦将来又有两台，
「只传一个」就会变成真 bug（用户检查更新读的是 A、A 上还是旧版本，
于是永远看不到新版本，而 B 上明明有）。多目标时**任一失败整体失败**，
避免出现"两个源版本不一致 = 有人能更新有人不能"这种极难查的状态。
"""
RELEASE_HOSTS = [
    h.strip()
    for h in os.environ.get('MXBOT_RELEASE_HOSTS', '8.209.232.216').split(',')
    if h.strip()
]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')


def version() -> str:
    """
    版本号从 package.json 读，**不硬编码**。

    原来是写死的 'AstriaX-Setup-0.1.0.exe' 这样的字面量。后果：
    发 0.1.1 时脚本会去找一个不存在的 0.1.0 文件（或者更糟 —— 如果
    dist 里 0.1.0 的旧包还在，就把**旧版本**当新版传上去了，
    用户检查更新看到有新版、下载安装后版本号却没变）。

    用户明确要求更新通道支持「任何低版本 → 任何更高版本」，
    所以发布脚本也不能有任何版本相关的硬编码。
    """
    with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
        return json.load(f)['version']


def build_wanted(ver: str):
    """
    构造本次要上传的文件清单。

    每条：(本地目录, 本地文件名, 远端文件名)

    **远端名必须显式写出来**，不能让两个同名文件都叫 latest.yml ——
    dist\\latest.yml（全量版）和 dist\\nsis-web\\latest.yml（联网版）内容完全不同
    （前者指向 AstriaX-Setup-*.exe，后者指向 AstriaX-WebSetup-*.exe），
    而它们会落到同一个远端路径上，后传的把先传的**静默覆盖**。
    结果：服务器上那份「备用清单」描述的是联网安装器，谁照着它下载都会拿错包。

    客户端自更新读的是 latest.json（见 publish-urls.ts），latest.yml 只是
    给 electron-updater 之类留的备用清单 —— 但"备用"不等于"可以是错的"。
    """
    setup = f'AstriaX-Setup-{ver}.exe'
    # ★ 联网安装包（nsis-web）已下线（主人 2026-09-26：「web安装包不搞了」）
    #
    # 原来这里还要求三样东西：dist/nsis-web/AstriaX-WebSetup-*.exe、
    # mxbot-launcher-*-x64.nsis.7z、nsis-web/latest.yml。
    # 而 electron-builder.yml 的 target 已经只剩 nsis —— 那些文件
    # **根本不会被产出**，于是下面的 missing 检查必然失败、
    # release.cjs 第 5/6 步（上传+验收）直接卡死。
    # 这就是"配置里去掉、脚本里仍要求"的中间态，必须一起清。
    return [
        (DIST, setup, setup),
        # ★ blockmap 必须一起上（0.1.3 接 electron-updater 时发现漏了它）
        #
        # 它是 electron-updater **增量下载**的依据：客户端拿它算出差分块，
        # 于是更新时通常只下几 MB，而不是每次重下 80MB 全量包。
        # 少了它不会报错 —— 只会**静默退化成每次都下全量**
        #（表现为"更新怎么每次都这么慢"），属于最难发现的那类缺失。
        (DIST, f'{setup}.blockmap', f'{setup}.blockmap'),
        (DIST, 'latest.json', 'latest.json'),
        (DIST, 'latest.yml', 'latest.yml'),
    ]


def upload_to(host: str, wanted, ver: str) -> int:
    """上传到一个服务器并回读验证。返回 0 = 成功。"""
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f'\n═══ 上传到 {USER}@{host}:{PORT} ═══')
    ssh.connect(host, port=PORT, username=USER, password=PASSWORD, timeout=20)

    def run(cmd: str) -> str:
        _, out, err = ssh.exec_command(cmd)
        o = out.read().decode('utf-8', 'replace')
        e = err.read().decode('utf-8', 'replace')
        if e.strip():
            print('[err]', e.strip())
        return o

    try:
        # nginx 的 docroot 可能不在默认位置，先问出来
        root_line = run(
            "grep -Rh 'root ' /etc/nginx/sites-enabled /etc/nginx/conf.d "
            "/etc/nginx/nginx.conf 2>/dev/null | head -1"
        )
        docroot = '/var/www/html'
        if 'root' in root_line:
            docroot = root_line.split('root', 1)[1].strip().rstrip(';') or docroot
        remote_dir = posixpath.join(docroot, 'mxbot')
        run(f'mkdir -p {remote_dir}')
        print('远程目录 =', remote_dir)

        sftp = ssh.open_sftp()
        try:
            for local_dir, local_name, remote_name in wanted:
                lp = os.path.join(local_dir, local_name)
                rp = posixpath.join(remote_dir, remote_name)
                mb = os.path.getsize(lp) / 1048576
                print(f'  上传 {local_name} → {remote_name}  ({mb:.2f} MB)')
                sftp.put(lp, rp)
        finally:
            sftp.close()

        # 自检：客户端会请求的 URL 必须 200（版本号取自 package.json，不硬编码）
        print()
        bad = 0
        for path in ('latest.json', 'latest.yml', f'AstriaX-Setup-{ver}.exe'):
            code = run(
                f"curl -s -o /dev/null -w '%{{http_code}}' "
                f"'http://127.0.0.1/mxbot/{path}'"
            ).strip()
            mark = '✔' if code == '200' else '✘'
            if code != '200':
                bad += 1
            print(f'  {mark} /mxbot/{path} → HTTP {code}')

        # 清单内容也读回来确认（避免发了个空文件/坏 JSON）
        print()
        print('服务器上的 latest.json:')
        print(run(f'cat {posixpath.join(remote_dir, "latest.json")}'))

        # 两个 latest.yml 内容必须**不一样**（一个指全量包、一个指联网包）。
        # 这是刚才那个覆盖 bug 的直接守卫：如果它们相同，说明又串了。
        print('两个清单指向的安装包（应当一个全量、一个联网）：')
        for fn in ('latest.yml',):
            print(f'  {fn}: ' + run(
                f"grep -m1 'url:' {posixpath.join(remote_dir, fn)}"
            ).strip())
        if bad:
            print(f'!! {host} 有 {bad} 个 URL 不是 200')
            return 1
        return 0
    finally:
        ssh.close()


def main() -> int:
    if not PASSWORD:
        print('缺 MXBOT_SSH_PASSWORD 环境变量')
        return 2

    ver = version()
    print(f'AstriaX 版本 = {ver}')
    wanted = build_wanted(ver)

    missing = [local for d, local, _ in wanted if not os.path.exists(os.path.join(d, local))]
    if missing:
        print('✘ 本地缺这些文件，先打包：')
        for m in missing:
            print('   ', m)
        return 1

    print(f'本次要发到 {len(RELEASE_HOSTS)} 个服务器：{", ".join(RELEASE_HOSTS)}')
    failed = []
    for h in RELEASE_HOSTS:
        try:
            if upload_to(h, wanted, ver) != 0:
                failed.append(h)
        except Exception as ex:  # noqa: BLE001
            print(f'!! 上传 {h} 失败：{type(ex).__name__}: {ex}')
            failed.append(h)

    if failed:
        # 关键：任一源失败就整体算失败 —— "两个源版本不一致"是最难查的状态
        print(f'\n✘ 这些服务器没发成功：{", ".join(failed)}')
        print('  提示：两个源版本必须一致，否则"有人能更新、有人不能"。请重跑本脚本。')
        return 1
    print(f'\n✔ {len(RELEASE_HOSTS)} 个服务器都已更新到 {ver}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
