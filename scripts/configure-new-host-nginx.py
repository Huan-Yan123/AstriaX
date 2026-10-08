#!/usr/bin/env python3
"""给新服务器的 /mxbot/ 加上与老源一致的响应头（CORS + 缓存策略）。

## 为什么需要（这是 e2e 测试抓出来的真实部署差异）

`tests/integration/official-source.e2e.spec.ts` 换到新源之后红了，
报的是 `Cross-Origin Request Blocked` —— 新 nginx 用的是默认配置，
**没有 Access-Control-Allow-Origin**；而老服务器上有，
所以这两条 e2e 以前一直是绿的。

生产环境其实不吃 CORS（拉清单发生在 Electron 主进程，走 Node 的 fetch，
不受同源策略约束）。但：
  1. 已发布的旧版本里，渲染层也有走网络的地方（WebUI 探测等），
     少一个头就可能在某处静默失败；
  2. 与老服务器保持行为一致，能避免"搬家之后某些功能时好时坏"这种
     最难查的差异；
  3. 这几条 e2e 是**线上资产的守门人**（服务器发错东西时必须红），
     让它们能正常跑起来比改测试绕开 CORS 有价值得多。

顺带加上安装包的缓存策略：静态大文件允许长缓存，但清单类
（latest.json / versions.json）必须**不缓存**，否则用户拿到的版本信息会是旧的。
"""
import os
import sys

import paramiko

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HOST = '8.209.232.216'
PW = os.environ['MXBOT_SSH_PASSWORD']
CONF = '/etc/nginx/sites-available/mxbot'

BLOCK = """# /mxbot/ 发布目录（AstriaX 官方源）—— 由 scripts/deploy-to-new-host.py 管理
#
# 为什么单独写一个 location：
#   · **CORS**：老服务器带 Access-Control-Allow-Origin，新机默认配置没有。
#     生产拉清单走主进程（Node fetch，不受同源策略约束），但已发布版本里
#     渲染层也有走网络的地方，行为不一致会导致"某些功能时好时坏"。
#   · **缓存**：安装包/7z 这类大文件可以长缓存；而 latest.json 与
#     files/versions.json 是**版本清单**，必须每次都问服务器 ——
#     否则用户会因为缓存看到旧版本号，"检查更新"永远说已是最新。
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root /var/www/html;
    index index.nginx-debian.html;

    # 静态文件走 nginx 自己的 sendfile，别让 nginx 去解析符号链接之外的东西
    location /mxbot/ {
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Access-Control-Allow-Headers "*" always;
        add_header Cache-Control "no-cache" always;

        # 清单类：绝对不缓存（版本信息必须实时）
        location ~* /mxbot/(latest.*\\.(json|yml)|files/versions\\.json)$ {
            add_header Access-Control-Allow-Origin "*" always;
            add_header Cache-Control "no-store, no-cache, must-revalidate" always;
            expires -1;
        }

        # 大文件（安装包 / 7z / 运行时压缩包）：允许长缓存，省用户带宽
        location ~* \\.(exe|7z|zip|whl|blockmap)$ {
            add_header Access-Control-Allow-Origin "*" always;
            add_header Cache-Control "public, max-age=86400" always;
            expires 1d;
        }
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, 22, 'root', PW, timeout=20)


def run(cmd: str, t: int = 60) -> str:
    _i, o, e = c.exec_command(cmd, timeout=t)
    o.channel.settimeout(t)
    try:
        out = o.read().decode('utf-8', 'replace')
    except Exception:
        out = '<timeout>'
    try:
        err = e.read().decode('utf-8', 'replace')
    except Exception:
        err = ''
    return (out + err).strip()


try:
    print('[1] 备份现有默认站点配置 …')
    print('   ', run('cp -n /etc/nginx/sites-available/default /etc/nginx/sites-available/default.bak-astriax 2>&1 || echo "(已存在备份)"'))

    print('[2] 写入 /mxbot 专用配置 …')
    sftp = c.open_sftp()
    try:
        with sftp.open(CONF, 'w') as f:
            f.write(BLOCK)
    finally:
        sftp.close()
    print('   ', run(f'wc -l {CONF}'))

    print('[3] 启用并禁用默认站点（避免 default_server 冲突）…')
    print('   ', run(f'ln -sf {CONF} /etc/nginx/sites-enabled/mxbot && rm -f /etc/nginx/sites-enabled/default && echo ok'))

    print('[4] 配置检查 + 重载 …')
    check = run('nginx -t 2>&1')
    print('   ', check)
    if 'successful' not in check:
        print('[FAIL] 配置有误，**不重载**（避免把线上源弄挂）')
        sys.exit(1)
    print('   ', run('systemctl reload nginx && echo reloaded'))

    print('[5] 服务器本机自检（含响应头）…')
    print('   ', run("curl -sI http://127.0.0.1/mxbot/latest.json | tr -d '\\r' | grep -Ei 'HTTP/|access-control|cache-control'"))
finally:
    c.close()
print('[DONE]')
