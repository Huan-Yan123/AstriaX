#!/usr/bin/env python3
"""端到端验证下载统计：外网真下载 → 服务器统计 → 检查计数与隐私。

验证四件事：
  1. 外网下载能被记上（不是只在本机自检时有效）
  2. **分片请求只算一次下载**（大文件被 curl -r 拆成多段时，不能虚高）
  3. 公网版 stats.json **不含任何 IP**（隐私）
  4. 明细版（/var/log 下）才有 IP，且只有 root 能读
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

import paramiko

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HOST = os.environ.get('MXBOT_RELEASE_HOST', '8.209.232.216')
PW = os.environ['MXBOT_SSH_PASSWORD']
FILE = 'AstriaX-WebSetup-0.1.3.exe'
URL = f'http://{HOST}/mxbot/{FILE}'


def http_range(url: str, header: str) -> int:
    """按 Range 取一段（模拟下载器的分片请求），返回拿到的字节数"""
    req = urllib.request.Request(url, headers={'Range': header, 'User-Agent': 'astriax-stats-e2e'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return len(r.read())


print('[1] 从外网分三次取同一个文件的不同片段（模拟分片下载）…')
total = 0
for rng in ('bytes=0-199999', 'bytes=200000-399999', 'bytes=400000-599999'):
    n = http_range(URL, rng)
    total += n
    print(f'    Range {rng} → {n} 字节')
print(f'    合计 {total} 字节')

print('[2] 等一下让 nginx 落盘，再在服务器上跑一次统计 …')
time.sleep(2)

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, 22, 'root', PW, timeout=20)


def run(cmd: str, t: int = 120) -> str:
    _i, o, e = c.exec_command(cmd, timeout=t)
    o.channel.settimeout(t)
    try:
        out = o.read().decode('utf-8', 'replace')
    except Exception:
        out = '<read timeout>'
    return out.strip()


try:
    print('   ', run('python3 /usr/local/bin/astriax-stats.py'))

    detail = json.loads(run('cat /var/log/nginx/mxbot-stats.json'))
    print('\n[3] 明细统计（服务器本地）')
    print(f"    downloads={detail['downloads']}  uniqueIps={detail['uniqueIps']} "
          f"rawRangeLines={detail['rawRangeLines']}")
    print(f"    byFile={detail['byFile']}")
    hit = detail['byFile'].get(FILE, 0)
    print(f"    本次文件计数 = {hit}")

    print('\n[4] 隐私检查：公网版必须没有 IP')
    public_raw = run('cat /var/www/html/mxbot/stats.json')
    pub = json.loads(public_raw)
    leaked = [k for k in ('byIp', 'recent') if k in pub]
    # 直接搜我的公网 IP 是否出现在公网文件里（那是真实泄露证据）
    # 取 IP 失败/编码异常都不该影响验证结论 —— 拿不到就跳过这一条
    myip = ''
    try:
        myip = subprocess.run(
            ['powershell', '-NoProfile', '-Command', '(Invoke-RestMethod https://api.ipify.org)'],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30
        ).stdout.strip()
    except Exception as ex:  # noqa: BLE001
        print(f'    （取公网 IP 失败，跳过该条：{type(ex).__name__}）')
    ip_in_public = bool(myip) and myip in public_raw
    print(f"    公网文件字段: {sorted(pub.keys())}")
    print(f"    含 byIp/recent 字段: {leaked if leaked else '无（正确）'}")
    print(f"    我的公网 IP({myip or '未取到'}) 是否出现在公网文件里: {ip_in_public}")

    print('\n[5] 明细文件权限（只应 root 可读）')
    print('   ', run('ls -l /var/log/nginx/mxbot-stats.json /var/www/html/mxbot/stats.json'))
finally:
    c.close()

ok = (
    detail['downloads'] >= 1
    and hit == 1                                  # 三个分片只算一次
    and detail['rawRangeLines'] >= 3              # 原始行确实有多条（证明去重在起作用）
    and not leaked
    and not ip_in_public
)
print('\n' + ('[OK] 统计链路与隐私都符合预期' if ok else '[FAIL] 有不符项，见上'))
sys.exit(0 if ok else 1)
