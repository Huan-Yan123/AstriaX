# M3 计划：更新链路 + 模板接线（MX 机器人启动器）

日期：2026-09-12 ｜ 状态：进行中 ｜ 上游：`2026-09-12-napcat-astrbot-launcher-design.md` §3.4/§10

## 1. 目标

- **更新链**：检测更新（镜像 HEAD/manifest 测速）→ 下载（校验 SHA256）→ 备份（manifest+tar.gz）→ 换 runtime → 失败可回滚
- **模板接线**：创建实例真正复制模板（不再只登记目录）；`defaultCommandFor` 按真实模板布局启动
- **自包含**：AstrBot=便携 Python embeddable；NapCat=Node 版，调系统 QQ；镜像下载 + SHA256 校验 + 失败重试
- **缓存**：`data\downloads\` 下载缓存，清理入口在设置页

## 2. 任务

1. **backup 模块**（TDD）：
   - `backupRuntime(dir)` → `backups\<utc时间戳>-v<模板版>.tar.gz`（Node 原生 zlib tar 打包，无依赖）
   - `restoreBackup(dir, file)` → 解包覆盖前先清 runtime（原子：换名目录交换）
   - `pruneBackups(dir, keep)` 超量淘汰
2. **template 模块**（TDD）：
   - 模板注册表：`getTemplate(type)` → `{ dir, version, ready }`（ready=目录存在且含标记文件）
   - `instantiateFromTemplate(srcDir, destDir)`：复制模板（排除 logs/tmp）
   - `verifyArchive(path, sha256)` SHA256 校验（node:crypto）
3. **更新 IPC**（`instance:update`）：测速（并列镜像 HEADRTT）→ 选最快 → 下载 → verify → backup → 替换 → 失败自动回滚；卡片「更新」按钮改成可用
4. **模板接线**：模板缺失时 UI 提示「运行时模板未就绪，请到设置下载模板」；设置页加「下载模板」按钮（双段：AstrBot/NapCat）
5. **M3 验收**：假模板 + 单测覆盖全链路；真窗口手工过一遍创建→启动(ASTB_DEV诱饵)→备份→回滚

## 3. 不做

- 不引入第三方压缩/加密库（纯 node API）
- 不动端口/名字/目录规则（已定案）

## 4. 验收标准

- 单元全绿：backup/restore/verify/instantiate 全链可测
- 手工：删除 runtime.exe → 备份恢复后可再启动（假 runtime）
- 更新失败注入（坏 SHA）→ 自动回滚到旧 runtime，实例状态恢复可用
