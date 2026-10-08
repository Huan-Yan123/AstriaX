# AstriaX 重构任务清单

根据 REFACTOR.md 完成以下迁移任务。

## ✅ 已完成

- [x] 安装 Pinia 状态管理库
- [x] 创建基础组件库（AButton / AEmptyState / ALoadingSkeleton / AToast / AVirtualList）
- [x] 创建 Pinia Store（instance / dialog / ui）
- [x] 创建 Composables（useToast / useWebUI / useInstanceActions）
- [x] 主进程模块化拆分（error / shutdown / startup / window）
- [x] 创建重构后的入口文件（index.refactored.ts / InstanceCard.refactored.vue）
- [x] 在 main.ts 中启用 Pinia
- [x] 创建状态同步管理器（instance-state-manager.ts）
- [x] 编写重构总结文档（REFACTOR.md）

## 🚧 进行中

- [ ] 迁移 App.vue 的状态到 Pinia store
- [ ] 替换 InstanceCard 使用新的重构版本
- [ ] 测试所有功能是否正常

## 📋 待办

### 渲染进程迁移

- [ ] App.vue 重构
  - [ ] 将 `list` 改为使用 `instanceStore.instances`
  - [ ] 将 `busyIds` / `updatingIds` / `switching` 改为使用 store
  - [ ] 将 `dlg` 改为使用 `dialogStore`
  - [ ] 将 `page` / `wizardOpen` / `settingsOpen` 改为使用 `uiStore`
  - [ ] 重构实例操作函数使用 `useInstanceActions`
  - [ ] 重构 WebUI 操作使用 `useWebUI`

- [ ] InstanceCard 迁移
  - [ ] 将 `InstanceCard.vue` 备份为 `InstanceCard.legacy.vue`
  - [ ] 将 `InstanceCard.refactored.vue` 重命名为 `InstanceCard.vue`
  - [ ] 更新所有引用

- [ ] 其他组件优化
  - [ ] CreateWizard.vue - 使用 AButton
  - [ ] SettingsPanel.vue - 使用 AButton
  - [ ] DownloadPage.vue - 使用 ALoadingSkeleton 和 AEmptyState
  - [ ] BackupPage.vue - 使用 AButton 和 AEmptyState

### 主进程迁移（可选）

- [ ] 备份 `src/main/index.ts` 为 `index.legacy.ts`
- [ ] 将 `index.refactored.ts` 重命名为 `index.ts`
- [ ] 测试启动流程
- [ ] 测试崩溃恢复
- [ ] 测试托盘功能

### 性能优化

- [ ] 在实例列表页引入 AVirtualList
- [ ] 测试 100+ 实例的渲染性能
- [ ] 优化切页耗时（目标 < 50ms）

### 测试

- [ ] 功能测试
  - [ ] 实例 CRUD
  - [ ] 启动/停止
  - [ ] WebUI 开关
  - [ ] 一键更新
  - [ ] 换版本
  - [ ] 查看日志
  - [ ] 查看凭据
  - [ ] 设置页
  - [ ] 托盘菜单

- [ ] 性能测试
  - [ ] 20+ 实例列表滚动
  - [ ] 切页耗时记录
  - [ ] 启动时间
  - [ ] 内存占用

- [ ] 边界测试
  - [ ] 端口冲突
  - [ ] 运行时缺失
  - [ ] 更新中断
  - [ ] 崩溃恢复

### 文档

- [ ] 更新 README.md
- [ ] 添加迁移指南
- [ ] 更新开发文档

## 🐛 已知问题

1. **WebUI 端口冲突**
   - 现象：启动残留进程导致端口被占用
   - 位置：日志显示 "实例「NapCat 实例」没有在本次启动器会话中成功启动"
   - 建议：添加端口占用检测和清理功能

2. **日志轮询未清理**
   - 问题：closeLog() 可能未清理定时器
   - 建议：在 App.vue 的 closeLog() 中添加 clearInterval()

## 💡 改进建议

### 短期
- 引入 Vue Router 替换手动页面切换
- 添加 ErrorBoundary 组件
- 提取国际化字符串

### 中期
- E2E 测试（Playwright）
- CI/CD 流水线
- 更新通道（beta/stable）

### 长期
- 插件系统
- 云端同步
- 远程管理 Web 端

## 📝 注意事项

1. **渐进式迁移**：不要一次性替换所有文件，逐个组件迁移并测试
2. **保留备份**：重命名前先备份原文件为 `.legacy.vue`
3. **测试优先**：每迁移一个组件，立即测试相关功能
4. **性能监控**：关注 `window.__astriaxSwitchPerf` 的切页耗时记录
5. **错误处理**：确保新代码的错误边界完善

## 🚀 下一步

1. 先完成 App.vue 的状态迁移（不改 UI，只改状态管理）
2. 测试基本功能是否正常
3. 逐个替换组件使用新基础组件
4. 引入虚拟列表优化性能
5. （可选）迁移主进程入口

---

**进度**: 9/40 (22.5%)

**预计完成时间**: 2-3 天（全职开发）
