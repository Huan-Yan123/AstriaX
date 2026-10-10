# NSIS 模板来源

`installer.nsi` 是 Tauri 官方 NSIS 模板（MIT / Apache-2.0），用于框架安装流程。
来源：https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
获取日期：2026-10-10；实际构建依赖由 `pnpm-lock.yaml` 固定。

自有逻辑位于短文件 `hooks.nsh` 及 Rust `maintenance/`。模板只有两处行为调整：

1. 调用旧卸载器前插入 `NSIS_HOOK_PREUPGRADE`，先检查运行状态并完成备份。
2. 覆盖升级向旧 Tauri 卸载器传入 `/UPDATE`，始终保留数据，不显示删除数据选择。

升级 Tauri 时需与官方模板比较这两处改动，并重跑安装器验证。模板不能简化为普通安装后钩子：安装后钩子晚于旧程序删除，无法保护旧版本文件。
