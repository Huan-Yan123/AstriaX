# 安装、更新与 Python 环境

## 更新来源与发布

启动器只接受 Tauri 更新清单。检测地址固定为：

`https://github.com/Soffd/AstriaX/releases/latest/download/tauri-latest.json`

安装包必须来自 `https://github.com/Soffd/AstriaX/releases/download/`，必须提供 SHA-256，且是 Windows `.exe`。AstrBot、NapCat 及 Python 的上游下载来源与启动器更新独立。

发布者先构建，再根据实际安装包生成清单：

```powershell
pnpm dist
powershell -ExecutionPolicy Bypass -File scripts/with-msvc.ps1 run -p astriax-core --bin astriax-release -- target/release/bundle/nsis/AstriaX_1.0.2_x64-setup.exe 1.0.2 target/release/bundle/nsis/tauri-latest.json
```

将 `AstriaX_1.0.2_x64-setup.exe` 和 `tauri-latest.json` 上传到 **Soffd/AstriaX** 的同一 Release，标签为 `v1.0.2`；后续版本同时修改工作区 Cargo、package.json、Tauri 配置与应用清单中的版本。该 Release 需要被 GitHub 的 `latest` 地址选中。开发分支名称不影响检测，应用读取 Release 附件。

构建与清单生成不会上传或发布。未发布这两个附件时，应用会提示无法读取更新清单，不将失败检测记入 24 小时节流。有效检测仍有 24 小时间隔，手动检查可强制刷新。

下载后显示「退出并安装更新」。点击时再次校验安装包，等待任务取消和受控实例停止，然后退出并启动安装器。下载记录保存在数据根中，再次进入设置或重启应用后仍可安装。安装器不会因为下载完成而自行执行。

## 升级与备份

NSIS 安装器通过临时提取的 `astriax-maintenance.exe` 调用 Rust 业务核心；辅助程序没有桌面程序的管理员权限清单，且不作为运行依赖安装。维护前检查程序、数据锁与实例端口；仍有运行占用时中止安装或卸载。

覆盖安装前保存 `AstriaX-update-backups/<时间与 UUID>/upgrade.zip` 和 SHA-256 清单。目录位于安装目录的父目录，与应用目录并列。备份包含旧程序、配置、实例和插件数据；共享运行时、日志、缓存及已有实例备份不重复打包，升级时原位保留。

安装后恢复数据根指针并记录安装位置；设置迁移成功后同步数据根登记。识别到旧 Electron 文件时，先备份，再清理旧启动器与 Chromium 文件。旧卸载登记仅在名称与安装位置均匹配且具备写权限时清理。

升级备份用于**手动恢复**，不是实例备份格式。失败后先退出安装器与应用，校验旁边 `manifest.json` 的 SHA-256，将 ZIP 的 `app/` 内容还原到原安装目录、`data/` 内容还原到记录的数据根；共享运行时保留原目录。当前不提供自动回滚或差分更新。跨技术栈历史安装器及机器级安装仍需专门验收，不将隔离 Tauri 升级测试等同于所有旧安装兼容。

## 卸载

交互卸载提供三种选择：

- 是：删除 AstriaX 配置、实例、共享运行时、日志、缓存和实例备份；系统 Python、QQ、下载目录中的更新安装包以及升级 ZIP 保留。
- 否（默认）：仅卸载程序，保留数据及数据根指针，重装后继续识别。
- 取消：中止卸载。

只删除已知的 AstriaX 数据条目，不对自定义数据根整个目录递归删除。未知用户文件保留；发现链接或不安全的路径时中止维护。静默卸载默认保留数据，测试/部署工具可显式使用 `/S /DELETE_DATA` 删除应用数据。`/UPDATE` 供覆盖升级内部使用，保留数据。

## Python

进入资源页时自动检测 PATH 中已有解释器，包括 `python.exe`、`python3.exe` 和 Python Launcher `py.exe`；忽略 Windows Store 的空占位别名。已有有效选择会继续使用，点击「重新检测」优先选择系统 Python。未加入 PATH 的 Python 可以通过浏览或填写 `python.exe` 绝对路径添加，也支持填写其所在目录。未找到可用解释器时可下载内置 Python 3.12.10。

每次选择都会实际运行解释器，验证 CPython、64 位、版本至少 3.12 及 pip 可用；拒绝不满足条件的解释器并保留原选择。探测有超时。Python 更新版本能否使用特定 AstrBot 及其依赖仍由上游兼容性决定。

外部 Python 以隔离模式运行，依赖安装到 AstriaX 的运行时目录，不更改系统 Python 的文件或全局库。AstrBot 实例运行或正在安装依赖时禁止更换 Python。新安装的 AstrBot 运行时记录 Python 主次版本；例如从 3.12 切换到 3.13，需要重新安装对应 AstrBot 版本及依赖，补丁版本变化不触发此要求。历史运行时若没有版本记录，需自行确认依赖兼容性。

## 验证

```powershell
pnpm check:web
pnpm test
pnpm check:clippy
pnpm dist
pnpm test:installer
```

安装器脚本使用独立目录、产品名与注册表标识，验证首次安装、模拟版本覆盖升级、保留数据卸载、重装识别原根及删除数据，同时检查升级备份与无关用户文件保留。报告位于 `tmp/installer-smoke-*/report.json`。桌面与上游联网环境的验证边界见 [重构实施记录](rust-rewrite/implementation.md)。
