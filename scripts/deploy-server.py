#!/usr/bin/env python3
"""MXBot 发布服务器部署脚本（幂等，可重复执行）。

作用：
  1. 把 dist/nsis-web 下的 program 本体 + latest.yml 上传到 nginx 站点目录（联网安装版从这里拉）
  2. 为 /mxbot/ 挂专用访问日志（IP / 时间 / UA / Referer），用于统计下载人数与地域
  3. 安装 /usr/local/bin/mxbot-stats.py，由 crontab 每小时生成 stats.txt + stats.json
  4. nginx -t + reload，并自检 URL 可达

用法（密码不写进仓库）：
  set MXBOT_SSH_HOST=8.209.232.216
  set MXBOT_SSH_USER=root
  set MXBOT_SSH_PASSWORD=***
  python scripts/deploy-server.py

依赖：paramiko（本机已装）。
"""
import os
import sys
import json
import posixpath

try:
    import paramiko
except ImportError:
    print('缺 paramiko：python -m pip install paramiko')
    sys.exit(2)

HOST = os.environ.get('MXBOT_SSH_HOST', '8.209.232.216')
USER = os.environ.get('MXBOT_SSH_USER', 'root')
PASSWORD = os.environ.get('MXBOT_SSH_PASSWORD', '')
PORT = int(os.environ.get('MXBOT_SSH_PORT', '22'))
REMOTE_DIR_NAME = 'mxbot'
# 项目根目录（package.json 所在），用来读版本号
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL = os.environ.get('MXBOT_DIST', os.path.join(ROOT, 'dist', 'nsis-web'))

STATS_PY = r'''#!/usr/bin/env python3
# MXBot 下载统计：解析 nginx 的 mxbot-dl.log -> stats.txt / stats.json
import json
import urllib.request
from collections import Counter

LOG = '/var/log/nginx/mxbot-dl.log'
OUT_TXT = '/var/www/html/mxbot/stats.txt'
OUT_JSON = '/var/www/html/mxbot/stats.json'
GEO_CACHE = '/var/log/nginx/.mxbot-geo.json'

rows = []
try:
    for line in open(LOG, 'r', errors='replace'):
        line = line.strip()
        if not line or '[' not in line:
            continue
        parts = line.split('|')
        if len(parts) < 5:
            continue
        ip = parts[0]
        if ip in ('127.0.0.1', '::1') or ip.startswith('172.') or ip.startswith('10.'):
            continue
        rows.append({
            'ip': ip,
            'ts': line[line.index('[') + 1: line.index(']')],
            'status': parts[2],
            'req': parts[3],
            'ua': parts[4][3:] if parts[4].startswith('UA=') else '',
        })
except FileNotFoundError:
    print('log not created yet')

geo = {}
try:
    with open(GEO_CACHE, 'r') as f:
        geo = json.load(f)
except Exception:
    geo = {}

def lookup(ip):
    try:
        with urllib.request.urlopen('https://ipinfo.io/' + ip + '/json', timeout=8) as r:
            j = json.loads(r.read().decode('utf-8'))
        return (str(j.get('country', '?')) + ' ' + str(j.get('region', '')) + ' ' + str(j.get('city', ''))).strip()
    except Exception:
        return 'unknown'

ips = Counter(r['ip'] for r in rows)
for ip in list(ips):
    if ip not in geo:
        geo[ip] = lookup(ip)
try:
    with open(GEO_CACHE, 'w') as f:
        json.dump(geo, f)
except Exception:
    pass

regions = Counter(geo.get(ip, 'unknown') for ip in ips)
updated = rows[-1]['ts'] if rows else ''

out = []
out.append('MXBot 下载统计：累计 ' + str(len(rows)) + ' 次请求 / ' + str(len(ips)) + ' 个唯一 IP / 更新于 ' + (updated or '暂无记录'))
out.append('')
out.append('== 地域分布 ==')
for reg, n in regions.most_common():
    out.append('  ' + str(n).rjust(4) + '  ' + reg)
out.append('')
out.append('== 最近 10 条 ==')
for r in rows[-10:]:
    out.append('  ' + r['ts'] + ' ' + r['ip'].ljust(16) + ' ' + r['status'] + ' ' + r['req'][:60] + ' UA=' + r['ua'][:50])

with open(OUT_TXT, 'w', encoding='utf-8') as f:
    f.write('\n'.join(out))

data = {
    'requests': len(rows),
    'uniqueIps': len(ips),
    'updated': updated,
    'regions': [{'region': reg, 'count': n} for reg, n in regions.most_common()],
    'recent': [{'ts': r['ts'], 'ip': r['ip'], 'status': r['status'], 'uri': r['req'], 'ua': r['ua'][:80]} for r in rows[-20:]],
}
with open(OUT_JSON, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print('written', len(rows), 'rows /', len(ips), 'ips')
'''

NGINX_LOG_FORMAT = """# MXBot 下载计数日志（location /mxbot/ 使用）
log_format mxbot '$remote_addr|[$time_local]|$status|$request|UA=$http_user_agent|Ref=$http_referer';
"""

LOCATION_BLOCK = (
    '\tlocation /mxbot/ {\n'
    '\t\taccess_log /var/log/nginx/mxbot-dl.log mxbot;\n'
    '\t\ttry_files $uri =404;\n'
    '\t}\n\n'
)

CRON_LINE = '17 * * * * /usr/bin/python3 /usr/local/bin/mxbot-stats.py >/dev/null 2>&1'


def main() -> int:
    if not PASSWORD:
        print('未设置 MXBOT_SSH_PASSWORD 环境变量')
        return 2

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=25)

    def run(cmd: str, timeout: int = 120) -> str:
        _, out, err = ssh.exec_command(cmd, timeout=timeout)
        o = out.read().decode('utf-8', 'replace')
        e = err.read().decode('utf-8', 'replace')
        print(f'$ {cmd}')
        if o.strip():
            print(o.strip())
        if e.strip():
            print('[err]', e.strip())
        return o

    try:
        # 1) docroot
        root_line = run("grep -Rh 'root ' /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/nginx/nginx.conf 2>/dev/null | head -1")
        docroot = '/var/www/html'
        if 'root' in root_line:
            docroot = root_line.split('root', 1)[1].strip().rstrip(';') or docroot
        remote_dir = posixpath.join(docroot, REMOTE_DIR_NAME)
        run(f'mkdir -p {remote_dir}')
        print('docroot =', docroot, '/ remote =', remote_dir)

        # 2) 上传安装包本体 + latest.yml
        #
        # 版本号从 package.json 读，**不硬编码**。
        # 原来写死 'mxbot-launcher-0.1.0-x64.nsis.7z'：发 0.1.1 时这里会
        # 「跳过（本地没有）」—— 于是服务器上的 7z 包**永远停在 0.1.0**，
        # 而 nsis-web 联网安装器正是从服务器拉这个 7z 当程序本体。
        # 后果：用户下 web 版安装包，装出来的还是旧版本
        # （清单说有新版、装完版本号没变）—— 用户最容易以为"更新坏了"的那种。
        try:
            with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
                ver = json.load(f)['version']
        except Exception as e:
            print('读 package.json 版本失败：', e)
            return 1
        print('MXBot 版本 =', ver)

        sftp = ssh.open_sftp()
        for name in (f'mxbot-launcher-{ver}-x64.nsis.7z', 'latest.yml'):
            lp = os.path.join(LOCAL, name)
            if not os.path.exists(lp):
                print('跳过（本地没有）：', lp)
                continue
            print('upload', name, round(os.path.getsize(lp) / 1048576, 1), 'MB')
            sftp.put(lp, posixpath.join(remote_dir, name))

        # 3) nginx 专用日志配置
        with sftp.open('/etc/nginx/conf.d/mxbot-logs.conf', 'w') as f:
            f.write(NGINX_LOG_FORMAT)

        with sftp.open('/etc/nginx/sites-enabled/default', 'r') as f:
            default = f.read().decode('utf-8')
        if 'location /mxbot/' not in default:
            default = default.replace('\tlocation / {\n', LOCATION_BLOCK + '\tlocation / {\n', 1)
            with sftp.open('/etc/nginx/sites-enabled/default', 'w') as f:
                f.write(default)
            print('已注入 location /mxbot/')

        # 4) 统计脚本 + crontab
        with sftp.open('/usr/local/bin/mxbot-stats.py', 'w') as f:
            f.write(STATS_PY)
        sftp.close()
        run('chmod +x /usr/local/bin/mxbot-stats.py')
        cron = run('crontab -l 2>/dev/null')
        if 'mxbot-stats' not in cron:
            run(f'(crontab -l 2>/dev/null; echo "{CRON_LINE}") | crontab -')
        run('crontab -l | tail -2')

        # 5) 应用 nginx 并自检
        run('nginx -t')
        run('systemctl reload nginx')
        run('python3 /usr/local/bin/mxbot-stats.py')
        run('curl -s -o /dev/null -w "latest.yml=%{http_code}\\n" http://127.0.0.1/mxbot/latest.yml')
        run(f'curl -s -o /dev/null -w "nsis.7z=%{{http_code}}\\n" -r 0-512 http://127.0.0.1/mxbot/mxbot-launcher-{ver}-x64.nsis.7z')
        run('curl -s -o /dev/null -w "stats.json=%{http_code}\\n" http://127.0.0.1/mxbot/stats.json')
        print('DEPLOY OK -> http://%s/mxbot/' % HOST)
        return 0
    finally:
        ssh.close()


if __name__ == '__main__':
    sys.exit(main())
