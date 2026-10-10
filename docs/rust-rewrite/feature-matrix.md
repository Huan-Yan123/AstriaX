# Rust 重构功能覆盖与验收矩阵

基线：2026-10-10，Git `341683d`，应用 1.0.1。本表保留初始验收要求和 Electron 源码基线，阶段表示依赖关系。当前已实现范围和验证状态见 [实施记录](./implementation.md)，不能将接口已迁移等同于本表全部验收通过。配合 [主规划](./README.md) 和 [接口快照](./inventory.json) 使用。

## 功能到实现的映射

| ID | 功能与接口 | 当前源码依据 | Rust 归属 | 关键验收 | 阶段 |
|---|---|---|---|---|---|
| F01 | 窗口控制：`window:minimize/toggleMaximize/close/isMaximized`；最大化事件 | `index.ts`、`preload/index.ts`、`TitleBar.vue` | desktop/window | 实际窗口状态与标题栏一致；高 DPI 和恢复通过 | M0/M5 |
| F02 | 单实例、提权、托盘、关窗策略：`close:ask/answer` | `index.ts`、`elevate.ts`、`tray/tray.ts` | platform-win + desktop/lifecycle | 第二次启动唤醒；UAC拒绝可解释；首次询问保留；托盘退出清理受控实例 | M0/M3/M5 |
| F03 | 配置/首启：`app:ping`、`paths:defaults`、`config:get/set`、`dialog:pickDataDir` | `ipc.ts`、`root-pointer.ts`、`FirstRunWizard.vue` | storage/config + desktop/wizard | 无配置、BOM、坏目录恢复；保存普通设置不重置运行状态；不凭 cwd 生成假根 | M1/M5 |
| F04 | 数据根迁移：`config:moveDataRoot/moving` | `store/relocate.ts`、`root-pointer.ts`、`ipc.ts`、SettingsPanel | services/relocation | 先停实例、跨盘、空间不足、重入拒绝、复制失败不切根、旧根保留、指针和卸载注册表一致 | M1/M4/M5 |
| F05 | 实例列表/创建：`instance:list/create` | `instance-repo.ts`、`instances/create.ts`、`templates.ts`、CreateWizard | storage/instances + services/instance | 自动命名、QQ号、绑定已装版本、每类端口段；创建不复制runtime；索引与目录事务一致 | M1/M3/M5 |
| F06 | 启动：`instance:start` | `ipc.ts`、`layout.ts`、`process-manager.ts`、`startup-guard.ts`、`allocator.ts` | services/instance/process + platform-win | 防重入、修复无效端口、第三方占用拒绝、正确cwd/env、真实健康就绪、失败可重试 | M3/M5 |
| F07 | 停止/删除/退出清理：`instance:stop/remove`、内部退出清理 | `ipc.ts`、`proc-identity.ts`、`process-manager.ts` | services/process + storage | QQ脱链确认、PID复用、普通QQ共存；停止失败保留数据/索引；退出使用同一归属规则 | M0/M3/M5 |
| F08 | 绑定/显示版本：`instance:setRuntime` | `ipc.ts`、`instance-version.ts`、`builtin-version.ts`、InstanceCard | services/instance + domain/version | 升级和降级保留数据；运行实例先停后换并尝试恢复；重启失败单独报告；未知版本不伪造 | M3/M5 |
| F09 | 手动更新：`instance:update` | `ipc.ts`、`version-catalog.ts`、`runtime-store.ts` | services/instance/update | 要求停止；找最新稳定版；未装则先装；安装后换指针；未知/已最新反馈；全过程锁住实例 | M2/M3/M5 |
| F10 | QQ检测/导航：`qq:status`、`app:openExternal` | `qq-check.ts`、`ipc.ts`、SettingsPanel | platform-win/qq/shell | 两类注册表与目录兜底；QQ build兼容；缺QQ说明可操作；URL解析/协议约束 | M0/M3/M5 |
| F11 | Python环境：`python:status/install` | `python-runtime.ts`、`ipc.ts`、`workdir.ts` | services/python | embed/._pth/sitecustomize/pywin32、pip与build tools；取消重试；不借系统解释器；缓存在数据根 | M2/M5 |
| F12 | 版本目录：`versions:list/prewarm` | `version-catalog.ts`、`template-source.ts` | services/sources/catalog + domain/version | PyPI元数据与安装源分开；GitHub资产筛选；缓存/强刷；预发布可选；PEP440正确；预热不挡首页 | M2/M5 |
| F13 | GitHub镜像：`mirrors:test/state/add/remove/pref` | `mirror-store.ts`、`mirror-store-test.ts`、`publish-urls.ts` | services/sources/github | 并发测速限时、禁删内置源、首选持久化、坏源回落；proxy/files模式正确构造真实URL | M2/M5 |
| F14 | Python源：`pysrc:state/test/pref/add/remove` | `python-source.ts`、`python-source-test.ts`、`mirror-store.ts` | services/sources/python | 自定义索引、名称/URL偏好兼容；用户点击的-i一致；元数据源缺失不误报无版本 | M2/M5 |
| F15 | 运行时安装：`runtime:install`、`templates:download/status` | `runtime-download.ts`、`templates.ts`、`template-dl.ts`、`ipc.ts` | services/runtime/install | AstrBot pip、NapCat Shell、Dashboard独立；旧模板兼容接口有等价实现；先stage再验证注册；失败保住旧版 | M2/M5 |
| F16 | 运行时管理：`runtimes:list/remove` | `runtime-store.ts`、`ipc.ts`、`safe-segment.ts`、`workdir.ts` | storage/runtimes + services/runtime | 清单自愈/体积后台计算；引用校验；未知绑定不猜；正在运行不可删；顽固目录延迟清理与重试 | M1/M2/M3/M5 |
| F17 | 导入：`runtimes:pickFile/probeFile/importFile` | `import-archive.ts`、`ipc.ts` | services/runtime/import + desktop/dialog | ZIP/WHL/源码/NapCat识别；版本与hash；缺注入器拒绝；Dashboard-only拒绝；完整依赖；路径/解压上限 | M2/M5 |
| F18 | 指定版本补库：`runtime:installPip` | `ipc.ts`、`pip-run.ts`、`python-source.ts` | services/runtime/pip | 精确所选tag，作用同版本所有实例；串行化与影响说明；不写全局site；失败/取消可回退 | M2/M3/M5 |
| F19 | 进度与取消：`download:sessions`、`runtimes:cancel`、`download:progress` | `running-tasks.ts`、`progress.ts`、`pip-progress.ts`、`ipc.ts`、DownloadPage | services/tasks + desktop/task_state | 同type/tag锁、跨页面快照、耗时续存；网络/缓存速率区分；所有安装路径可取消；终态和注册一致 | M1/M2/M5 |
| F20 | 凭据：`instance:creds/resetCreds` | `creds.ts`、`constants.ts`、`ipc.ts` | services/credentials | 保留未知配置；MD5/PBKDF2格式一致；自改token不覆盖；重置停机；坏配置留证；无法读明文不伪造 | M4/M5 |
| F21 | 实例日志：`instance:log` | `process-manager.ts`、`napcat-log.ts`、`read-snippet.ts`、`ipc.ts` | services/diagnostics/logs | 当前启动偏移、截断/轮转/跨午夜、UTF8/GB18030；NapCat HTTP真实token；停止后终止采集 | M3/M4/M5 |
| F22 | 日志导出/崩溃：`logs:export/exportBusy`、`app:lastCrash` | `logger.ts`、`device-info.ts`、`crash-handler.ts`、`boot-watch.ts`、`crash-logs.ts`、`index.ts` | services/diagnostics + desktop/native_dialog | 导出ZIP含设备/异常/操作信息；忙态重进可见；窗口未建立也能诊断导出；连续崩溃阈值与marker一致 | M4/M5 |
| F23 | 审计：`audit:days/read` | `audit.ts`、`ipc.ts` | services/diagnostics/audit | actor/action/result/时间可追溯；新数据根生效；非法日期/路径拒绝；凭据脱敏 | M1/M4/M5 |
| F24 | 实例备份：`backup:make/list/del/restore/openFolder` | `backup.ts`、`backup-list.ts`、`ipc.ts`、App.vue/BackupPage参考实现 | services/backup + desktop | 停机一致性；私有gzip reader；内嵌/旁manifest；双hash历史兼容；scope分流；全验证后事务恢复 | M4/M5 |
| F25 | 覆盖升级备份：`backup:updateList` | `update-backups.ts`、`installer.nsh` | services/backup/update + packaging | 标准tar快照与实例包分区展示；时间戳/目录校验；保留策略只删自身合法快照；迁移后可见 | M4/M6 |
| F26 | 系统信息：`stats:overview`、公开/内部显示 | `ipc.ts`、`proc/stats.ts`、`device-info.ts`、`hardware-override.ts`、`build-flags.ts` | platform-win/system + build profile | 内存/磁盘/设备信息；不恢复已移除的实例资源轮询；公开构建无内部固定硬件字符串 | M3/M4/M6 |
| F27 | 内嵌面板：`webui:open/close/list/visible`、`webui:closed` | `webui-manager.ts`、`ipc.ts`、App.vue | desktop/webui + services readiness | AstrBot /与NapCat /webui/?token编码；只一视图；旧异步回调失效；75%缩放；快捷键/焦点/DPI/遮挡 | M0/M3/M5 |
| F28 | 应用更新：`app:version/checkUpdate/downloadUpdate/skipVersion`、`update:progress` | `app-update.ts`、`app-updater.ts`、`publish-urls.ts`、`ipc.ts`、SettingsPanel/App | services/app_update + packaging | 24h/强制/跳过、多源、Downloads、hash、差分重建与全量回落；无退出自动安装；更新失败按兼容策略记录 | M6 |
| F29 | 系统文件定位：`shell:showItem`、备份定位/导出后打开 | `ipc.ts`、`logger.ts` | platform-win/shell | Windows真实资源管理器打开且选中正确文件；只存在/授权范围路径；中文与空格 | M4/M5 |
| F30 | UI交互与资源 | 当前App/DownloadPage/SettingsPanel/InstanceCard/CreateWizard/FirstRunWizard/AppDialog/TitleBar/tokens/assets | desktop/pages/components/assets | 首启、空态、源选择、版本弹窗、文本确认、进度停滞、导航回来、反馈入口、角色动画、中文排版 | M0/M5 |
| F31 | 安装/升级/卸载 | `electron-builder.yml`、`installer.nsh`、installer验证脚本 | packaging + xtask + Rust辅助工具 | 自定义目录、WebView2离线、旧卸载器顺序、跨版/同版/不同产物、默认保留/显式删除/取消、数据抢救失败 | M0/M6 |
| F32 | 发布与维护工作流 | package scripts、release/publish/build/full-check、自检/源测试/压力/备份脚本 | xtask + cli/tests | Rust可构建/验证/发布；清单与hash一致；脚本活跃/历史归档清单齐全；不带旧服务凭据 | M0/M6 |

## 阶段验收记录模板

每个功能编号填写：实现提交、执行入口、fixture/上游版本、Windows版本与权限、实际结果、证据文件、失败与回退结果、尚未覆盖的情况。没有实际执行证据只能标“已实现未验证”，不能标“完成”。

每个接口需要记录参数、返回、错误、落盘副作用和事件副作用。`inventory.json` 是通道盘点，不包含完整参数/结果schema，schema冻结属于M0工作。

## 重点回归测试来源

| 回归主题 | 当前测试样本，需改造成行为验证 |
|---|---|
| 根/索引/原子写 | `config-single-truth`、`config-restore`、`data-root-pointer`、`instance-meta-atomic`、`instance-repo-corrupt-quarantine`、`runtime-store` |
| 停止归属与启动 | `process-ownership`、`proc-identity`、`proc-zombie`、`stop-really-stops`、`detached-process-kill`、`startup-guard`、`launch-cwd`、`napcat-direct-launch` |
| 取消与任务锁 | `all-installs-cancellable`、`cancel-latency`、`cancel-cleanup`、`cancel-not-register`、`cancel-wiring-guard`、`running-tasks` |
| 安装/源/导入 | `pick-source-strict`、`pick-version-source`、`bad-source-fallback`、`pip-cache-fallback`、`import-astrbot-full`、`import-whl-runnable`、`runtime-reinstall-safe`、`sitecustomize` |
| 凭据 | `astrbot-creds`、`creds-astrbot-password`、`creds-atomic-write`、`creds-corrupt-config`、`napcat-creds` |
| 备份与迁移 | `backup-legacy-compat`、`backup-self-describing`、`backup-safety`、`backup-path-guard`、`relocate-full`、`relocate-faildir`、`move-guard` |
| 面板 | `webui-manager`、`webui-stacking`、`instance-status`、`rapid-switch` |
| 更新/安装器 | `app-update-sha256`、`app-update-same-version`、`app-updater`、`updater-tolerance`、`version-any-to-any`、`update-auto-backup`、`uninstall-script`；真实installer脚本 |
| UI任务恢复 | `elapsed-survives-nav`、`progress-stall`、`first-run-wizard`、`dialog-text-confirm`、`app-dialog-dismiss`、`settings-update-check` |
| 真实上游链 | integration下8个文件：Python环境、PyPI、官方源、导入包/WHL依赖、版本回填、实例启动、全链 |

这些名称用于定位当前 `.spec.ts` 文件，不能将190文件数描述为190条已通过测试。
