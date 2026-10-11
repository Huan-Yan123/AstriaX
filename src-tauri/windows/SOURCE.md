# NSIS 模板来源

`installer.nsi` 是 Tauri 官方 NSIS 模板（MIT / Apache-2.0），用于框架安装流程。
来源：https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
获取日期：2026-10-10；实际构建依赖由 `pnpm-lock.yaml` 固定。

自有维护逻辑位于 `hooks.nsh` 及 Rust `maintenance/`。1.0.3 模板的行为调整：

1. 删除框架的重装/卸载选择页及调用旧卸载器的分支。双击安装、同版本修复、`/S`、`/P` 和 `/UPDATE` 均直接覆盖目标目录。
2. 在 `.onInit` 对所有模式检查版本，拒绝降级；没有已安装登记时按首次安装处理。
3. 在覆盖程序文件前通过 `NSIS_HOOK_PREINSTALL` 检查占用并备份，显式启用覆盖并检查主程序写入错误。安装后由 `NSIS_HOOK_POSTINSTALL` 维护原数据根和安装登记。
4. 欢迎页及目录页明确说明可安装到原目录直接更新。控制面板中的独立卸载器继续支持保留或删除数据。

升级 Tauri 时需与官方模板比较这些改动，并重跑安装器验证。测试使用独立产品与注册表标识，并设置旧卸载器调用陷阱，确认覆盖更新从未运行旧卸载器。
