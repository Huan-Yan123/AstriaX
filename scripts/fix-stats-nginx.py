#!/usr/bin/env python3
"""修复：log_format 没装上去导致 nginx -t 失败（站点引用了不存在的 format）。

## 事故经过（值得记一笔）

`deploy-stats.py` 用 `sed -i ... '$remote_addr...'` 往 nginx.conf 里插
log_format —— 而那条命令经过两层 shell（ssh + sed）之后，`$remote_addr`
被**当成 shell 变量展开成空串**，于是什么都没插进去。

后果比"没装统计"严重得多：`sites-enabled/mxbot` 里的
`access_log ... mxbot;` 引用了一个**不存在的 format** →
`nginx -t` 直接失败。当时因为脚本发现失败就中止、没有 reload，
站点还在跑；但**服务器一旦重启**，nginx 会因为配置错误起不来 ——
官方源就整体下线了。这类"改了配置但没生效，直到重启才炸"最阴。

## 修法

不去 sed 那行（引号地狱），改成**新写一个 conf.d 片段**：
`/etc/nginx/conf.d/mxbot-log.conf` 里只放 log_format，
通过 SFTP 写（内容原样落盘，不经 shell）。
nginx.conf 默认 `include /etc/nginx/conf.d/*.conf;`（在 http{} 内），
所以放这里等价于写在 http 块里，而且**幂等、可单独删**。
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
FRAG = '/etc/nginx/conf.d/mxbot-log.conf'
LOG = '/var/log/nginx/mxbot-dl.log'

# 注意：$remote_addr 这些**必须原样写进文件**，绝不能让 shell 碰
FORMAT = (
    "log_format mxbot '$remote_addr|[$time_local]|$status|$request"
    "|UA=$http_user_agent|Ref=$http_referer';\n"
)

CRON_LINES = [
    '17 * * * * /usr/bin/python3 /usr/local/bin/astriax-stats.py >/dev/null 2>&1',
    '@reboot sleep 30 && /usr/bin/python3 /usr/local/bin/astriax-stats.py >/dev/null 2>&1',
]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, 22, 'root', PW, timeout=20)


def run(cli, cmd: str, t: int = 120) -> str:
    """
    执行远端命令并读取输出。

    ★ 参数顺序是 (client, cmd)：我第一版写成 `run(cmd, t=...)`，
    而调用点全是 `run(c, '...')` —— 于是 SSHClient 被当成命令、命令被当成
    超时，paramiko 抛 `unsupported operand type(s) for +: 'float' and 'str'`。
    这类"签名与调用点不一致"编译器不报错（都是对象），只能靠跑一次发现。
    """
    _i, o, e = cli.exec_command(cmd, timeout=t)
    o.channel.settimeout(t)
    try:
        out = o.read().decode('utf-8', 'replace')
    except Exception:
        out = '<read timeout>'
    try:
        err = e.read().decode('utf-8', 'replace')
    except Exception:
        err = ''
    return (out + err).strip()


try:
    print('[1] 用 SFTP 写 log_format 片段（不经 shell，变量不会被吃掉）')
    sftp = c.open_sftp()
    try:
        with sftp.open(FRAG, 'w') as f:
            f.write(FORMAT)
    finally:
        sftp.close()
    print('   文件内容:', run(c, f'cat {FRAG}'))

    print('[2] 确认 conf.d 被 include（默认在 http{} 内）')
    print('   ', run(c, "grep -n 'conf.d' /etc/nginx/nginx.conf"))

    print('[3] cron 幂等补齐（用完整行比对，不再用之前那个不可靠的判断）')
    cur = run(c, 'crontab -l 2>/dev/null || true')
    for line in CRON_LINES:
        if line in cur:
            print('   已存在:', line[:46])
            continue
        run(c, f'(crontab -l 2>/dev/null; echo "{line}") | crontab -')
        print('   已添加:', line[:46])
    print('   当前 cron:')
    print('   ', run(c, 'crontab -l 2>/dev/null | grep -c astriax') + ' 条 astriax 任务')
    print('   ', run(c, 'crontab -l 2>/dev/null | grep astriax'))

    print('[4] nginx -t（这次必须 successful）')
    check = run(c, 'nginx -t 2>&1')
    print('   ', check)
    if 'successful' not in check:
        print('[FAIL] 还是不对，**不重载**，请人工看一眼')
        sys.exit(1)
    print('   ', run(c, 'systemctl reload nginx && echo reloaded && systemctl is-active nginx'))

    print('[5] 实测：本机请求一次，日志要出现该条记录')
    run(c, f'truncate -s 0 {LOG} 2>/dev/null || true')
    run(c, "curl -s -o /dev/null -H 'User-Agent: astriax-stats-selftest' http://127.0.0.1/mxbot/latest.json")
    time.sleep(1)
    print('   日志行数:', run(c, f'wc -l < {LOG} 2>/dev/null || echo 0'))
    print('   内容:', run(c, f'cat {LOG} 2>/dev/null | tail -2'))

    print('[6] 重启自恢复状态（需求清单同一条待办）')
    print('   nginx 开机自启:', run(c, 'systemctl is-enabled nginx 2>&1'))
    print('   cron  开机自启:', run(c, 'systemctl is-enabled cron 2>&1'))
finally:
    c.close()
print('\n[DONE]')
