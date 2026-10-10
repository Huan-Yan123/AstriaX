# AstriaX

NapCat + AstrBot 多开管理器。装环境、建实例、启动、开面板，一个界面搞定。

本分支使用 Tauri + Vue，启动器、控制台及安装维护由 Rust 实现。发布包使用系统 WebView2，无需捆绑 Electron 或启动器用 Node.js；AstrBot、NapCat 保持上游运行方式。

- [AstrBot](https://github.com/AstrBotDevs/AstrBot) —— 聊天机器人框架
- [NapCat](https://github.com/NapNeko/NapCatQQ) —— 基于 NTQQ 的协议端

## 功能

- **运行环境**：自动识别 PATH 中的 64 位 Python 3.12+，支持手动选择解释器与内置 Python 下载；NapCat 注入 QQ 运行
- **多源下载**：并发测速选最快源，失效源自动置灰
- **实例管理**：新建 / 启停 / 删除、版本升降级、重置账密、备份回滚、实时日志、内嵌面板
- **pip 库**：为指定 AstrBot 版本补装 Python 库
- **启动器更新**：从 [Soffd/AstriaX](https://github.com/Soffd/AstriaX/releases) 检查、下载并校验更新，手动确认退出安装；覆盖升级备份与卸载数据选择
- **桌面界面**：参考 Codex Windows 的侧栏、设置导航与组件样式

## 环境要求

- Windows 10 / 11 (x64)
- 系统 Microsoft Edge WebView2；安装器会在缺失时下载 Bootstrapper
- NapCat 需要新版 QQNT（当前检测门槛 build ≥40768）

## 快速开始

1. 「资源与环境」页 → 确认可用 Python；未识别时选择 `python.exe` 或下载安装，再安装 AstrBot 与 NapCat
2. 「实例」页 → 新建实例，选择已安装版本
3. 启动实例 → 状态变为「运行中」后打开 WebUI

NapCat 首次启动需要十余秒完成 QQ 注入。多开只需重复第 2 步，端口与数据自动隔离。

## 反馈

遇到问题请先导出日志（设置 → 日志 → 导出日志），再带日志加群 [1077554004](https://qm.qq.com/q/1077554004)。

| 现象 | 处理 |
|---|---|
| 下载失败 | 更换下载源 |
| 版本列表为空 | 安装对应运行环境 |
| WebUI 无法打开 | 等待 QQ 注入完成 |
| 停止未确认 | 导出日志排查；未确认停止时不会继续删除、恢复或迁移 |
| 已装 QQ 但检测不到 | 若修改过安装目录名，重装 QQ 以更新注册表 |

## 从源码构建

构建需要 Node.js 20+、pnpm、Rust MSVC 工具链，以及 Visual Studio C++ Build Tools 与 Windows SDK。Node.js 仅用于编译 Vue 和运行前端测试。

```powershell
pnpm install
pnpm dev          # Tauri + Vue 开发
pnpm test         # Vue 类型检查、当前 UI/桥接测试、Rust 核心测试
pnpm check:clippy # Rust 工作区静态检查
pnpm build        # 编译桌面程序
pnpm dist         # 生成 NSIS 安装包
pnpm test:installer # 对生成的安装器做隔离安装、升级、卸载验证
```

更新发布、卸载数据选项和 Python 切换注意事项见 [安装与更新](docs/install-and-update.md)。实现边界与验证记录见 [重构实施记录](docs/rust-rewrite/implementation.md)。

## 许可

[MIT](LICENSE)
