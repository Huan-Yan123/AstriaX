#!/usr/bin/env python3
"""在官方源服务器上装「下载统计」+「重启自恢复」（需求清单 二 的两条待办）。

## 与老实现（scripts/deploy-server.py）的三处关键差异

### 1. 不再把原始 IP 的统计暴露在公网
老实现把 `stats.json` 写进 `/var/www/html/mxbot/` —— 那是**任何人都能下载**的
目录，里面逐条列着下载者的 IP、时间、UA。这是隐私泄露，不该有。
现在：
  · 明细（含 IP）→ `/var/log/nginx/mxbot-stats.json`（只有 root/SSH 能读）
  · 公网只看得到**聚合数**（下载次数、按包分布、按天分布），不含 IP

### 2. 统计的是「下载」不是「请求」
nginx 会给大文件记多条**分片（Range）请求**，一次 80MB 下载能打出几十行日志；
再加上 HEAD/404 也会进日志。老实现 print(len(rows)) 直接数行 → 严重虚高。
现在：
  · 只算 `status ∈ {200, 206}` 且 URI 指向**产物文件**（exe/7z/zip/whl/blockmap）
  · 同一 (IP, URI) 在**同一小时**内只算一次（分片去重）
  · 清单类（latest.json / versions.json）单独计数，不混进"下载次数"

### 3. 重启后自动恢复（需求清单同一条待办）
  · `systemctl enable nginx`（开机起）
  · cron 里同时装**每小时**与 **@reboot**
  · 脚本自己幂等：重复跑不会重复插 cron / 不会重复加 log_format

用法：
  set MXBOT_SSH_PASSWORD=...
  python scripts/deploy-stats.py
"""
import os
import sys
import time

import paramiko

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HOST = os.environ.get('MXBOT_RELEASE_HOST', '8.209.232.216')
PW = os.environ['MXBOT_SSH_PASSWORD']
LOG = '/var/log/nginx/mxbot-dl.log'

STATS_PY = r'''#!/usr/bin/env python3
"""AstriaX 官方源下载统计（由 cron 每小时跑一次）。

输出两份：
  · /var/log/nginx/mxbot-stats.json  —— 明细（含 IP），**只给服务器自己看**
  · /var/www/html/mxbot/stats.json   —— 公网聚合版（**不含 IP**）
"""
import json
import re
from collections import Counter, defaultdict

LOG = '/var/log/nginx/mxbot-dl.log'
OUT_DETAIL = '/var/log/nginx/mxbot-stats.json'
OUT_PUBLIC = '/var/www/html/mxbot/stats.json'

# 只统计"产物文件"的下载；清单类（latest.json/versions.json）另算
ARTIFACT = re.compile(r'/mxbot/[^ ]*\.(exe|7z|zip|whl|blockmap)$', re.I)
MANIFEST = re.compile(r'/mxbot/(latest\.(json|yml)|files/versions\.json)$', re.I)

rows = []
try:
    with open(LOG, 'r', errors='replace') as f:
        for line in f:
            line = line.strip()
            if '|' not in line or '[' not in line:
                continue
            parts = line.split('|')
            if len(parts) < 5:
                continue
            ip = parts[0]
            # 内网/本机自检不算用户下载
            if ip in ('127.0.0.1', '::1') or ip.startswith(('172.', '10.', '192.168.')):
                continue
            ts = line[line.index('[') + 1: line.index(']')]
            status = parts[2].strip()
            req = parts[3].strip()
            ua = parts[4][3:] if parts[4].startswith('UA=') else ''
            rows.append({'ip': ip, 'ts': ts, 'status': status, 'req': req, 'ua': ua})
except FileNotFoundError:
    pass

def uri_of(req):
    # request 形如 "GET /mxbot/AstriaX-Setup-0.1.3.exe HTTP/1.1"
    bits = req.split(' ')
    return bits[1] if len(bits) > 1 else req

downloads = []   # 去重后的"真实下载"
manifests = []
for r in rows:
    u = uri_of(r['req'])
    if ARTIFACT.search(u):
        if r['status'] in ('200', '206'):
            downloads.append({**r, 'uri': u})
    elif MANIFEST.search(u) and r['status'] == '200':
        manifests.append({**r, 'uri': u})

# 分片去重：同一 IP + 同一文件 + 同一小时，只算一次下载
seen = set()
uniq = []
for d in downloads:
    hour = d['ts'][:14]  # 形如 15/Sep/2026:14
    key = (d['ip'], d['uri'], hour)
    if key in seen:
        continue
    seen.add(key)
    uniq.append(d)

by_file = Counter(d['uri'].rsplit('/', 1)[-1] for d in uniq)
by_ip = Counter(d['ip'] for d in uniq)
by_day = Counter(d['ts'].split(':')[0] for d in uniq)   # 15/Sep/2026

detail = {
    'generatedAt': __import__('time').strftime('%Y-%m-%d %H:%M:%S'),
    'downloads': len(uniq),
    'uniqueIps': len(by_ip),
    'rawRangeLines': len(downloads),
    'manifestHits': len(manifests),
    'byFile': dict(by_file.most_common()),
    'byDay': dict(by_day.most_common(14)),
    'byIp': dict(by_ip.most_common(50)),
    'recent': [
        {'ts': d['ts'], 'ip': d['ip'], 'file': d['uri'].rsplit('/', 1)[-1], 'ua': d['ua'][:60]}
        for d in uniq[-30:]
    ],
}
with open(OUT_DETAIL, 'w', encoding='utf-8') as f:
    json.dump(detail, f, ensure_ascii=False, indent=2)

# 公网版：**去掉 IP**（只留聚合）—— 不给外人看下载者是谁
public = {k: v for k, v in detail.items() if k not in ('byIp', 'recent')}
public['note'] = '聚合统计，不含访客 IP'
with open(OUT_PUBLIC, 'w', encoding='utf-8') as f:
    json.dump(public, f, ensure_ascii=False, indent=2)

print('downloads=%d uniqueIps=%d files=%d' % (len(uniq), len(by_ip), len(by_file)))
'''

# 给 /mxbot 的 location 加专用日志（幂等：已存在就不重复加）
LOG_SNIPPET = f"""
    # AstriaX 下载统计专用日志（scripts/deploy-stats.py 管理）
    access_log {LOG} mxbot;
"""


def conn():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, 'root', PW, timeout=20)
    return c


def run(c, cmd, timeout=120):
    _i, o, e = c.exec_command(cmd, timeout=timeout)
    o.channel.settimeout(timeout)
    try:
        out = o.read().decode('utf-8', 'replace')
    except Exception:
        out = '<read timeout>'
    try:
        err = e.read().decode('utf-8', 'replace')
    except Exception:
        err = ''
    return (out + err).strip()


c = conn()
try:
    conf = '/etc/nginx/sites-available/mxbot'
    print('[1] 装 log_format（幂等）')
    has_fmt = 'log_format mxbot' in run(c, 'grep -c "log_format mxbot" /etc/nginx/nginx.conf || true')
    if not has_fmt or run(c, 'grep -c "log_format mxbot" /etc/nginx/nginx.conf || true') == '0':
        # 塞到 http{} 里：放在 include 之前
        run(c, "sed -i '/^http {/a\\\\tlog_format mxbot \\'$remote_addr|[$time_local]|$status|$request|UA=$http_user_agent|Ref=$http_referer\\';' /etc/nginx/nginx.conf")
    print('   ', run(c, 'grep -n "log_format mxbot" /etc/nginx/nginx.conf || echo "(没加上)"'))

    print('[2] 给 /mxbot 挂专用 access_log（幂等）')
    if LOG not in run(c, f'cat {conf}'):
        # 在 location /mxbot/ { 之后插入
        run(c, f"python3 - <<'PYEOF'\n"
               f"p = '{conf}'\n"
               f"s = open(p, encoding='utf-8').read()\n"
               f"anchor = 'location /mxbot/ {{'\n"
               f"snippet = '''{LOG_SNIPPET}'''\n"
               f"if 'mxbot-dl.log' not in s:\n"
               f"    s = s.replace(anchor, anchor + snippet, 1)\n"
               f"    open(p, 'w', encoding='utf-8').write(s)\n"
               f"    print('inserted')\n"
               f"else:\n"
               f"    print('already')\n"
               f"PYEOF")
    print('   ', run(c, f"grep -c mxbot-dl.log {conf}"))

    print('[3] 装统计脚本')
    sftp = c.open_sftp()
    try:
        with sftp.open('/usr/local/bin/astriax-stats.py', 'w') as f:
            f.write(STATS_PY)
    finally:
        sftp.close()
    print('   ', run(c, 'chmod +x /usr/local/bin/astriax-stats.py && wc -l /usr/local/bin/astriax-stats.py'))

    print('[4] cron：每小时 + @reboot（幂等）')
    for line in (
        '17 * * * * /usr/bin/python3 /usr/local/bin/astriax-stats.py >/dev/null 2>&1',
        '@reboot sleep 30 && /usr/bin/python3 /usr/local/bin/astriax-stats.py >/dev/null 2>&1',
    ):
        cron = run(c, 'crontab -l 2>/dev/null || true')
        if 'astriax-stats.py' in cron and line.split('/')[-1] in cron:
            print('   已存在，跳过:', line[:40])
            continue
        run(c, f'(crontab -l 2>/dev/null; echo "{line}") | crontab -')
    print('   当前 cron:')
    print('   ', run(c, 'crontab -l 2>/dev/null | grep astriax || echo "(空)"'))

    print('[5] 重启自恢复：nginx enable + cron 服务 enable')
    print('   ', run(c, 'systemctl enable nginx 2>&1 | tail -1'))
    print('   ', run(c, 'systemctl enable cron 2>&1 | tail -1; systemctl is-enabled cron 2>&1'))

    print('[6] nginx 配置检查 + 重载（配置有误就不重载，避免弄挂线上源）')
    check = run(c, 'nginx -t 2>&1')
    print('   ', check)
    if 'successful' not in check:
        print('[FAIL] nginx 配置不对，已放弃重载')
        sys.exit(1)
    run(c, 'systemctl reload nginx && echo reloaded')

    print('[7] 手动跑一次统计（此时还没有下载记录也应当正常产出）')
    print('   ', run(c, 'python3 /usr/local/bin/astriax-stats.py'))
    print('   详细统计:')
    print('   ', run(c, 'ls -la /var/log/nginx/mxbot-stats.json /var/www/html/mxbot/stats.json 2>&1'))
    print('   公网版内容:')
    print('   ', run(c, 'cat /var/www/html/mxbot/stats.json'))
finally:
    c.close()
print('\n[DONE] 现在去做一次真实下载，等一分钟再看统计是否记上')
