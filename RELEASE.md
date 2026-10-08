# MX 机器人启动器 · 发布说明

版本 0.1.0（2026-09-12）· Electron + Vue3 · Windows x64

## 产物（dist\）

| 文件 | 用途 |
| --- | --- |
| `MX机器人启动器 0.1.0.exe` (~72MB) | **绿色版**：单文件便携程序，数据固定在程序同目录 `data\`，整个文件夹可拷贝迁移 |
| `nsis-web\MX机器人启动器 Web Setup 0.1.0.exe` (~0.7MB) | **联网安装版**：小安装器，安装时从发布服务器拉程序本体 |
| `nsis-web\launcher-acb-0.1.0-x64.nsis.7z` | 联网安装版的程序本体包——**与 Web Setup 一起上传到发布服务器** |
| `nsis-web\latest.yml` | 版本 manifest——**与上者放同一目录** |

## 发布清单（主人发布时照做）

1. 选定发布站点（比如自己的服务器/对象存储），把 `publish.url`（electron-builder.yml 里 `https://dl.example.com/mx-launcher/`）替换成真实地址后重跑 `npx electron-builder`，或直接保持域名占位并告知用户手动下载
2. 上传 `launcher-acb-0.1.0-x64.nsis.7z` + `latest.yml` 到该地址对应目录，Web Setup 即可安装
3. **日志随发布**：导出最新日志压缩包（`data\logs\` 里 `app-*.log`）与安装包同目录发布，供崩溃后回溯
4. 官方标示：产品名「MX 机器人启动器」；版本徽章 0.1.0

## 功能里程碑

- M1 骨架：实例模型（JSON 索引 + 原子重命名）、创建/启动/停止、端口分配
- M2：分段端口（AstrBot 6100-6199 / NapCat 6200-6299）、实例名全局唯一、目录按类型分流、内嵌 WebUI 全屏、资源统计、PCL2 风崩溃弹窗+日志压缩包、凭据告知、设置页日志导出
- M3：备份(tar.gz 系 SHA256 manifest)/回滚/保留 N 份、模板注册表/SHA 校验/实例化、更新链路（check→verify→backup→swap）
- M4：托盘 + 关闭策略（首点 ✕ 询问记住/设置页随时改）、开机自启（HKCU Run）、双版本打包

## 手工验收清单（生成端）

- [x] 78 个单元/UI 测试全绿（`pnpm vitest run`）
- [x] `npx electron-vite build` 无错
- [x] 真窗口：titlebar 品牌「MX 机器人启动器」、卡片操作（启动/停止 + WebUI + 三横菜单 + 全名删除）、过渡动画
- [ ] 实机跑真包（主人端）：绿色版拷到固定盘 → 创建实例 → 预配模板 → 扫码
