#!/usr/bin/env python3
"""修 CDN 缓存导致的"发新版但用户拿到旧包"—— nginx 侧配置。

## 问题（实测）

发布 0.1.6 修复版之后：

    源站 http://8.209.232.216:18080/mxbot/AstriaX-Setup-0.1.6.exe → 84834189 字节（新版）
    CDN  https://astriax.huanyan.fun/mxbot/AstriaX-Setup-0.1.6.exe
         → EO-Cache-Status: HIT
         → Content-Length: 84833595（**旧版**）
         → Cache-Control: public, max-age=86400

也就是说：**同名安装包在 CDN 上被缓存了 24 小时**，
发布新版本（尤其像这次"同版本号重发修复版"）时，用户拿到的仍是旧包。

## 修法

1. **安装包 / blockmap 不再长缓存** —— 改成 `no-cache`（允许缓存但要回源校验）。
   代价是每次下载多一次很小的校验请求；收益是**发版立刻生效**。
   对于 80MB 的安装包，这点校验开销完全可以忽略。
2. 同时打上 **ETag / Last-Modified**（nginx 默认就有），
   没变时回 304，不变的文件也不会重复传。

保留长缓存的只有 `files/` 下的运行时压缩包（它们**内容不变、文件名带版本**）。
"""
import os
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST = "8.209.232.216"
CONF = "/etc/nginx/conf.d/mx-astriax-download.conf"

NEW_CONF = r'''# AstriaX 官方下载源 —— astriax.huanyan.fun
# 由 scripts/fix-cdn-cache.py 生成；删掉本文件即可完全撤销。
#
# ## 缓存策略（这里踩过一个真坑，务必看清）
#
# 现象：发布 0.1.6 修复版后，源站已经是新文件，但 CDN（腾讯 EdgeOne）返回
#   `EO-Cache-Status: HIT` + 旧的 Content-Length —— 用户拿到的是**旧包**。
#   根因是原来给 `.exe` 设了 `Cache-Control: public, max-age=86400`（1 天）。
#
# 为什么安装包**不能**长缓存：
#   · 文件名里虽然有版本号，但我们出现过"同版本号重发修复版"（0.1.4/0.1.6），
#     这时文件名完全一样、内容不同 → 长缓存会把用户钉在旧包上整整一天
#   · 用户在"下载页"点下载、在"设置里检查更新"，期望的都是**立刻拿到最新**
#
# 所以：
#   · 清单类（latest.json / versions.json）→ no-store，绝不缓存
#   · 安装包 / blockmap（.exe/.blockmap）→ **no-cache**（可缓存但每次回源校验）
#     配合 ETag/Last-Modified，文件没变时回 304，开销极小
#   · 运行时压缩包（files/ 下的 .zip/.7z）→ 仍然长缓存：它们**文件名带版本**、
#     内容永不变化，缓存收益大
server {
    listen 18080;
    listen [::]:18080;
    listen 80;
    listen [::]:80;
    server_name astriax.huanyan.fun;

    root /var/www/html;

    location /mxbot/ {
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Access-Control-Allow-Headers "*" always;

        # 清单类：绝对不缓存（版本信息必须实时）
        location ~* /mxbot/(latest.*\.(json|yml)|files/versions\.json)$ {
            add_header Access-Control-Allow-Origin "*" always;
            add_header Cache-Control "no-store, no-cache, must-revalidate" always;
            expires -1;
        }

        # ★ 安装包与 blockmap：**每次回源校验**（修"发新版用户拿到旧包"）
        location ~* \.(exe|blockmap)$ {
            add_header Access-Control-Allow-Origin "*" always;
            add_header Cache-Control "no-cache" always;
            etag on;
            if_modified_since exact;
        }

        # 运行时压缩包：文件名带版本、内容不变 → 长缓存（省用户带宽）
        location ~* /mxbot/files/.*\.(zip|7z|whl)$ {
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


def main() -> int:
    pw = os.environ.get("MXBOT_SSH_PASSWORD")
    if not pw:
        print("[FAIL] 没设 MXBOT_SSH_PASSWORD")
        return 1
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, username="root", password=pw, timeout=20)

    def run(cmd, timeout=60):
        _i, o, e = c.exec_command(cmd, timeout=timeout)
        out = o.read().decode("utf-8", "replace").strip()
        err = e.read().decode("utf-8", "replace").strip()
        return o.channel.recv_exit_status(), out, err

    # ① 备份现有配置
    code, out, err = run(f"cp {CONF} {CONF}.bak-$(date +%s) && echo backed-up")
    print("备份配置:", out or err)

    # ② 写入新配置（经 SFTP，避免 shell 吞掉 $ 与引号）
    sftp = c.open_sftp()
    with sftp.file(CONF, "w") as f:
        f.write(NEW_CONF)
    sftp.close()
    print("[OK] 已写入新配置")

    # ③ 语法检查 → 通过才 reload
    code, out, err = run("nginx -t")
    print("nginx -t:", out or err)
    if code != 0:
        print("[FATAL] 语法错误，已中止（未 reload，线上不受影响）")
        c.close()
        return 1
    run("systemctl reload nginx")
    print("[OK] nginx 已重载")

    # ④ 本机自测
    for url in [
        "http://127.0.0.1:18080/mxbot/AstriaX-Setup-0.1.6.exe",
        "http://127.0.0.1:18080/mxbot/latest.json",
    ]:
        code, out, err = run(
            f"curl -sI -m 10 {url} | grep -iE '^(HTTP|content-length|cache-control|etag)' | tr '\\n' ' '"
        )
        print("  ", url.split("/mxbot/")[1], "→", out or err)

    c.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
