# 在 8.209.232.216 上为 astriax.huanyan.fun 建立下载服务
#
# 现状（已实测）：
#   · astriax.huanyan.fun → 腾讯 EdgeOne CDN → 回源失败 521
#   · 本机 nginx 只监听 80(default_server: mxbot) / 443(nat.huanyan.fun)
#   · 没有 astriax.huanyan.fun 的 server 块、没有该域名证书、18080 无监听
#
# 做法：
#   1) 写独立片段 /etc/nginx/conf.d/mx-astriax-download.conf
#      —— 独立文件，出问题直接删掉即可，不动别的站点
#   2) 监听 **18080**（主人指定的回源端口）服务 /mxbot/
#      同时监听 80，便于 EdgeOne 用 HTTP 回源
#   3) 自签证书先顶上 443（EdgeOne 回源可用 http，443 只是备用；
#      正式证书走 certbot 单独申请）
#   4) nginx -t 通过才 reload（配错了也不至于把线上站点弄挂）
import os, sys, paramiko
sys.stdout.reconfigure(encoding='utf-8')

HOST = '8.209.232.216'
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, 22, username='root', password=os.environ['MXBOT_SSH_PASSWORD'], timeout=15)


def run(cmd, timeout=60, label=None):
    i, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode('utf-8', 'replace').strip()
    err = e.read().decode('utf-8', 'replace').strip()
    code = o.channel.recv_exit_status()
    if label:
        print(f'--- {label}  (exit {code})')
        if out:
            print(out)
        if err:
            print('[stderr]', err[:600])
    return code, out, err


CONF = '''# AstriaX 官方下载源 —— astriax.huanyan.fun
# 由 scripts/setup-astriax-download.py 生成；删掉本文件即可完全撤销。
#
# 为什么单独一个文件：这台机器上还跑着 nat.huanyan.fun 与 mxbot 主站，
# 把它们和下载源混在一个文件里，以后改任何一个都要动到别人。
#
# 回源端口 18080 是主人指定的；同时监听 80 方便 EdgeOne 走 HTTP 回源。
# EdgeOne 回源默认走 80 —— 所以 80 必须能按 Host 精确匹配到这个 server。
server {
    listen 18080;
    listen [::]:18080;
    listen 80;
    listen [::]:80;
    server_name astriax.huanyan.fun;

    root /var/www/html;

    # 下载源根路径
    location /mxbot/ {
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Access-Control-Allow-Headers "*" always;

        # 清单类绝不缓存：否则用户"检查更新"永远说已是最新
        location ~* /mxbot/(latest.*\\.(json|yml)|files/versions\\.json)$ {
            add_header Access-Control-Allow-Origin "*" always;
            add_header Cache-Control "no-store, no-cache, must-revalidate" always;
            expires -1;
        }

        # 大文件长缓存
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
'''

# 1) 写配置（经 SFTP，避免 shell 吞掉 $ 与引号 —— 项目里踩过这个坑）
sftp = c.open_sftp()
remote = '/etc/nginx/conf.d/mx-astriax-download.conf'
with sftp.file(remote, 'w') as f:
    f.write(CONF)
sftp.close()
print(f'[OK] 已写入 {remote}')

# 2) 语法检查 → 通过才 reload
code, out, err = run('nginx -t', label='nginx -t')
if code != 0:
    print('[FATAL] 配置有语法错误，已中止（未 reload，线上不受影响）')
    sys.exit(1)
run('systemctl reload nginx', label='reload nginx')

# 3) 本地自测：18080 与 80(带 Host) 都应能取到 latest.json
run('curl -s -o /dev/null -w "18080 -> %{http_code}\\n" -m 8 http://127.0.0.1:18080/mxbot/latest.json',
    label='本机 18080')
run('curl -s -o /dev/null -w "80(Host) -> %{http_code}\\n" -m 8 -H "Host: astriax.huanyan.fun" http://127.0.0.1/mxbot/latest.json',
    label='本机 80 + Host 头')

# 4) 开放 18080（腾讯云还有安全组，那层要在控制台开）
run('ss -lntp | grep -E "18080|:80 |:443 " | head', label='监听状态')

c.close()
print('\n完成。注意：腾讯云**安全组**还要放行 18080，否则外部仍不通。')
