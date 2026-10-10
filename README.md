# AstriaX

NapCat + AstrBot 多开管理器。装环境、建实例、启动、开面板，一个界面搞定。

此项目为 main 分支的 Rust 实现，安装包体积更小，性能占用更低，但是兼容性和稳定性会有所下降。

- [AstrBot](https://github.com/AstrBotDevs/AstrBot) —— 聊天机器人框架
- [NapCat](https://github.com/NapNeko/NapCatQQ) —— 基于 NTQQ 的协议端

## 功能

- **运行环境**：一键安装内置 Python 3.12 与 NapCat（注入 QQ 运行）
- **多源下载**：并发测速选最快源，失效源自动置灰
- **实例管理**：新建 / 启停 / 删除、版本升降级、重置账密、备份回滚、实时日志、内嵌面板
- **pip 库**：为指定 AstrBot 版本补装 Python 库
- **自动更新**

## 环境要求

- Windows 10 / 11 (x64)
- 系统 Microsoft Edge WebView2；安装器会在缺失时下载 Bootstrapper
- NapCat 需要新版 QQNT（当前检测门槛 build ≥40768）

## 快速开始

1. 「资源与环境」页 → 安装 Python，再安装 AstrBot 与 NapCat
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
```

## 许可

[MIT](LICENSE)
