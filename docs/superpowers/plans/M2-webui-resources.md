# M2 计划：内嵌 WebUI · 凭据告知 · 资源面板

前置：M1 已完成（骨架/首启/迁移/设置/打包冒烟全绿，30 tests）。

## 任务列表（TDD 顺序）

1. **stats 模块（实例资源占用）**
   - 模块 `src/main/proc/stats.ts`：接口 `createStats({ pidusage })`，方法 `forPids(pids) -> [{memMB, cpuPct}]`；磁盘占用走>>, 异步目录增量扫描（记录 sizeTotal 于内存，实例文件变更后 rescan）
   - 实例 pid 来源：process-manager start 返回/记录 pid 到 repo 记录内存态（不落盘 pid）
   - 单测：注入假 pidusage 验证换算（bytes→MB、cpu 0-100 归一）
2. **disk 总览 + 余量**
   - `fs.statfs(dataRoot)`: {总容量, 剩余}；`os.totalmem/freemem`
   - ipc `stats:overview` -> { totalMemMB, freeMemMB, totalDiskMB, freeDiskMB, perInstance: [...] }（一次拉全）
3. **UI：卡片露资源行（运行中显示内存MB+CPU%）+ 顶栏总览条**
   - App 定时（2s）调 `stats:overview`，总线状态透传 InstanceCard
   - UI 测试：mount 后 stats mock 返回样例，闪现数字、运行中实例才渲染
4. **内嵌 WebUI（WebContentsView）**
   - main：`webui:open(id)` → 按 rec.port 开 `http://127.0.0.1:port`，attach 到主窗口顶部视图栈，可关/可切；窗口 resize 时 view 跟随
   - renderer：卡片「WebUI」按钮三态（未运行禁用 / 运行可开 / 打开后变「收起」）；状态纯前端
   - IPC 测试（mock 视图层），UI 测试按钮态
5. **凭据告知**
   - AstrBot：扫 `<dir>/data/config` 读 dashboard 用户名密码；NapCat：Instagram webui token 从 `<napcat 配置>` 读取；卡片「凭据」小卡显示（可复制、可隐藏）
   - 单测扫描函数；UI 测试显示
6. **M2 验收**：全部测试绿 + 打包真窗口：开一个假 AstrBot 实例（python http server 模拟）验证 WebUI 内嵌、资源邦数出现、凭据卡显示

验收定义：以上 6 项测试全绿 + 真窗口人工验收截图归档。
