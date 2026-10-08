# AstriaX

NapCat + AstrBot 多开管理器。装环境、建实例、启动、开面板，一个界面搞定。

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
- NapCat 需要新版 QQNT

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
| 停止后进程仍在 | 再次点击停止 |
| 已装 QQ 但检测不到 | 若修改过安装目录名，重装 QQ 以更新注册表 |

## 从源码构建

需要 Node.js 20+ 与 pnpm。

```bash
pnpm install
npm run dev      # 开发
npm test         # 测试
npm run dist     # 打包
```

## 许可

[MIT](LICENSE)
