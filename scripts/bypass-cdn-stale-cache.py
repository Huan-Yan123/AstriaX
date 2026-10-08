#!/usr/bin/env python3
"""绕过 CDN 旧缓存：把安装包换成**带内容指纹的新文件名**。

## 为什么需要这个（实测的问题）

发布 0.1.6 修复版之后：

    源站   84834189 字节（新版，sha256 1f617834…）
    latest.json 指向 AstriaX-Setup-0.1.6.exe，size/sha256 都是**新版**
    CDN    返回 84833595 字节（**旧版**），EO-Cache-Status: HIT，
           Cache-Control: public, max-age=86400（还剩约一天）

同名的旧文件被 CDN 钉住了 —— 用户下载到旧包，然后**校验不通过**。
主人选择"等它自然过期"，但那意味着这段时间内**更新是坏的**。

## 解决思路：换一个 CDN 从未见过的 URL

文件名里塞进 sha256 的前 12 位 → `AstriaX-Setup-0.1.6-<指纹>.exe`。
- CDN 上**没有**这个 URL 的缓存 → 第一次请求就回源拿到新版
- 清单里指向它，客户端按新 URL 下载 → 立即生效
- 旧那份留在服务器上（不影响，等缓存自然过期后可以清理）

这也是"内容寻址"的常规做法：**内容变了，名字就变** ——
从根上消除"同名不同内容"这类缓存问题。

执行内容：
  1. 读本地成品里的 0.1.6 安装包，算 sha256
  2. 传到服务器为新文件名 `<原名>-<指纹>.exe`（连同 blockmap）
  3. 改 latest.json 的 url 指向它（size/sha256 保持真实值）
  4. 逐文件回读校验
"""
import hashlib
import json
import os
import posixpath
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8")

HOST = "8.209.232.216"
REMOTE = "/var/www/html/mxbot"
DONE = os.environ.get("MXBOT_DONE_DIR", r"E:\MX机器人启动器成品")
VER = "0.1.6"


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    pw = os.environ.get("MXBOT_SSH_PASSWORD")
    if not pw:
        print("[FAIL] 没设 MXBOT_SSH_PASSWORD")
        return 1

    exe = os.path.join(DONE, f"AstriaX-Setup-{VER}.exe")
    bm = exe + ".blockmap"
    if not os.path.exists(exe):
        print(f"[FAIL] 找不到 {exe}")
        return 1

    digest = sha256_of(exe)
    print(f"本地安装包 sha256 = {digest}")
    print(f"本地大小         = {os.path.getsize(exe)}")

    # 内容寻址的新文件名（取指纹前 12 位，够区分且不至于太长）
    stamp = digest[:12]
    new_exe = f"AstriaX-Setup-{VER}-{stamp}.exe"
    new_bm = new_exe + ".blockmap"
    print(f"新文件名         = {new_exe}")

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, username="root", password=pw, timeout=20)
    sftp = c.open_sftp()

    # ① 上传安装包（新名字）
    remote_exe = posixpath.join(REMOTE, new_exe)
    print(f"上传 → {remote_exe} …")
    sftp.put(exe, remote_exe)
    # ② blockmap（增量下载用，名字要与安装包配套）
    if os.path.exists(bm):
        print(f"上传 → {posixpath.join(REMOTE, new_bm)} …")
        sftp.put(bm, posixpath.join(REMOTE, new_bm))

    # ③ 回读校验
    st = sftp.stat(remote_exe)
    if st.st_size != os.path.getsize(exe):
        print(f"[FAIL] 远端大小不一致：{st.st_size} != {os.path.getsize(exe)}")
        sftp.close()
        c.close()
        return 1
    import subprocess

    _i, o, _e = c.exec_command(f"sha256sum {remote_exe}", timeout=120)
    remote_sha = o.read().decode().split()[0]
    if remote_sha != digest:
        print(f"[FAIL] 远端 sha256 不一致：{remote_sha} != {digest}")
        sftp.close()
        c.close()
        return 1
    print("[OK] 远端逐字节一致")

    # ④ 改写 latest.json（url 指向新文件名；size/sha256 保持真实值）
    lj = posixpath.join(REMOTE, "latest.json")
    with sftp.file(lj, "r") as f:
        manifest = json.loads(f.read().decode("utf-8"))
    print(f"原 url = {manifest.get('url')}")
    manifest["url"] = new_exe
    manifest["size"] = os.path.getsize(exe)
    manifest["sha256"] = digest
    with sftp.file(lj, "w") as f:
        f.write(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"[OK] latest.json → url={new_exe}")

    sftp.close()
    c.close()
    print("\n完成。用户下次检查更新会拿到这个**新 URL**，不会再命中 CDN 旧缓存。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
