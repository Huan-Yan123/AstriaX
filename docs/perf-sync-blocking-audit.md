# 主进程事件循环阻塞审计（只读审查，未改任何代码）

审查对象：`E:\MX\launcher-acb`，Electron + TypeScript 主进程。
审查者：性能与并发审查专家（子代理会话 `e07cc78f-cc55-4d41-8ed2-e250c454177a`）。

**真实数据根**：`E:\MXBot\AstriaX\data`（由 `E:\MXBot\AstriaX\data-root.txt` 指向）。
注意：`E:\MX\launcher-acb\data` 是近乎空的开发桩（日志 842 字节），**不能拿它当量级依据**。

---

## 0. 最重要的一句话

两个现有审计脚本**当前都判全绿**：

```
audit-sync-calls.cjs    → BANNED 0 / HEAVY 14（全部"已论证例外"）/ LIGHT 237 → [OK]
audit-sync-in-loops.cjs → 共 90 处；递归函数里 0 处                    → ✔
```

而同一个数据根的日志里躺着：

```
[ERROR] [perf] IPC logs:export    耗时 30871ms（严重）
[ERROR] [perf] IPC versions:list  耗时 21584ms（严重）
[ERROR] [perf] IPC runtime:install 耗时 102666ms（严重）
[WARN]  主进程事件循环疑似被同步代码阻塞：窗口内约有 7634ms 不在此定时器上
[ERROR] [perf] IPC config:moving   耗时 7642ms（严重）   ← 纯读状态，应当 <1ms
```

**盲区不是"漏了几个点"，是结构性的。** 我实测统计了 `src/main` 全部 `*Sync` 调用：

| | 数量 |
|---|---|
| 有循环上下文（脚本能看见） | 99 |
| **无循环上下文（脚本直接跳过，连记录都不做）** | **243** |

**71% 的同步调用对 `audit-sync-in-loops.cjs` 完全不可见。** 根因见第 5 节 MISS-2。

---

## 1. 🔴 P0 冻结（单次可能 >50ms，且在 IPC / 启动路径上）

### P0-1 `src/main/util/workdir.ts:108` — 启动时同步递归删 45,391 个文件 / 592 MB

```ts
 98:   for (const name of entries) {
106:       const st = statSync(p)
107:       if (st.mtimeMs > cutoff) continue
108:       rmSync(p, { recursive: true, force: true })   // ← 同步递归删
109:       removed++
```

- **阻塞类型**：同步 fs 递归删除（**不在源码循环的判定里**——它在 `for...of` 里，而脚本要求 `for (` 带括号，见 MISS-2）。
- **量级（实测本机，非估算）**：
  - `E:\MX\launcher-acb\data\cache\tmp` → **289 个条目 / 47,317 个文件**
  - 其中 **>6h 陈旧、会被删掉的：137 个条目 / 45,391 个文件 / 592.4 MB**
  - 内容不是小文件——里面是**完整的 AstrBot 运行时**（`runtimes\a\v4.28.0`，含 `libopenblas.dll`、`big-model.bin` 等）
  - 我实测 `rmSync(recursive)` = **0.31 ms/文件**（3,000 文件 942ms，两次取样一致）
  - **→ 0.31 ms × 45,391 ≈ 14 秒的事件循环完全冻结**
- **触发路径**：`index.ts:505` ← `void (async () => { ... sweepStaleTmp(root) ... })()`，**每次启动**。
- **用户表现**：双击图标后窗口虽然立刻出现（`index.ts:301` 的 `win.show()`），但**接下来约 14 秒整个界面点不动**——所有 IPC 排队。用户描述正是"启动后点什么都没反应"。
- **改法**：`sweepStaleTmp` 改成 async，用项目**已有的** `removeDirAsync`（`workdir.ts:135`，走 `fsp.rm` + 重试）。它就在同一个文件里，是现成的正确实现。
  - **注意**：`wait` 语义要保留——目前靠返回值 `removed` 记日志，改成 async 后 `index.ts:506` 要 `await`（那里本来就是 async IIFE，零成本）。
  - **注意**：不要并发删 137 个目录，`Promise` 串行或限流 2~4，否则线程池被打满反而拖慢其它 IO。
- **优先级**：**P0 —— 这是本次审计收益最大的单点。**

---

### P0-2 `src/main/creds/creds.ts:259` — `pbkdf2Sync` 600,000 轮，且在候选循环里

```ts
256:   for (const cand of candidates.reverse()) {
259:       digest = pbkdf2Sync(cand, salt, iterations, 32, 'sha256').toString('hex')
```

配套 `creds.ts:68`（重置账密路径，单次调用）：

```ts
 68:   const digest = pbkdf2Sync(raw, Buffer.from(salt, 'hex'), ASTRBOT_PBKDF2_ITERATIONS, 32, 'sha256').toString('hex')
```

- **阻塞类型**：**纯 CPU**（PBKDF2-HMAC-SHA256 是故意设计成慢的）。两个脚本的词汇表里**完全没有 `pbkdf2Sync`**，三级评分一个都进不去。
- **量级（实测）**：`pbkdf2Sync(…, 600000, …)` = **256 ms / 259 ms**（两次取样）。`ASTRBOT_PBKDF2_ITERATIONS = 600_000`（`creds.ts:62`）。
  - `:259` 在循环里，每次迭代 256ms。候选数 = 实例日志里 `Initial password:` 出现次数（每次首启一行）→ **N × 256ms**。
  - `:140` → `:68` 单次就是 256ms。
- **触发路径**：`scanCredentials`（`creds.ts:402`）← `instance:creds` handler（`ipc.ts:2449`）。用户点实例卡片的「查看账密」。
- **用户表现**：点「查看账密」后界面**整段僵死 0.26 秒起**（日志候选多则 1 秒以上），期间所有 IPC 排队、窗口无响应。
- **改法**：`crypto.pbkdf2`（异步回调版，走 libuv 线程池）替代 `pbkdf2Sync`，把 `astrbotHashPassword` 与 `astrbotPasswordFromLog` 改成 async。
  - **注意**：`resetAstrBotConfig`（`:91`）与 `scanCredentials`（`:402`）要跟着改 async 签名；两者调用方都是 async handler，改动可控。
  - **注意**：`astrbotPasswordFromLog` 的候选循环改成**并行** `Promise.all` 会同时占用 N 个线程池槽位（默认 4），建议串行 `await`（256ms × N 比"占满线程池"更可预测）。更优解是把回调结果做进程内缓存，同一 (hash, log mtime) 只算一次。
- **优先级**：**P0**

---

### P0-3 `src/main/update/backup.ts:330-331` — 回滚时同步读 + `gunzipSync` 整个备份包

```ts
330:   const tarBuf = readFileSync(deps.file)
331:   const gzDecompressed = gunzipSync(tarBuf)
```

- **阻塞类型**：同步 fs 读 + **纯 CPU zlib 解压**。`gunzipSync` 不在任何脚本的词汇表里。
- **关键**：`restoreBackup` 是 `async` 函数，但这两行在**第一个 `await` 之前**（下一个 await 在 `:516`）。**async 外壳不提供任何让出点。**
- **量级**：`backup.ts:488` 自己的注释写"AstrBot 的 data\ 几百 MB"。整包入内存 + 全量 gunzip ≈ **数百 ms ~ 数秒**。
  - （本机 `E:\MXBot\AstriaX\data\backups` 里是 599 字节的空包，**不能当依据**；按代码注释与 `templates.ts:48` 的"49133 文件/565MB"评估。）
- **触发路径**：`backup:restore`（`ipc.ts:3167`）→ `restoreBackup`。
- **用户表现**：点「回滚」后界面完全不动，转圈数秒。
- **改法**：`await fsp.readFile` + `zlib.gunzip`（promise 版）。后续 `:455-475` 的 `renameSync`/`writeFileSync` **可以保留同步**——那里有"先全量校验再动文件"的原子性论证（`:445-449`），只把 330-331 两行异步化即可，`out` 数组构建是纯内存操作。
- **优先级**：**P0**

---

### P0-4 `src/main/update/backup.ts:410` — `Buffer.concat` 全量拷贝 + 同步 sha256（回滚路径第二次冻结）

```ts
410:     const actual = createHash('sha256').update(Buffer.concat(bodyParts)).digest('hex')
```

- **阻塞类型**：**纯 CPU**。`bodyParts` 是 gunzip 后正文的 `subarray` 数组 → `Buffer.concat` **再复制一份完整正文**（几百 MB 峰值 + memcpy），随后 sha256 再过一遍。
- **为什么两个脚本都看不见**：单行调用、**不在循环里**、**没有 `Sync` 后缀** → `BANNED` 不认、`HEAVY` 不认、`LIGHT` 也不认，**三个桶全进不去**。
- **量级**：几百 MB → memcpy 100~300ms + sha256（~1–2 GB/s）150~400ms ≈ **0.3~0.7s**。与 P0-3 叠加，回滚路径**连续冻结 1~3 秒**。
- **改法（极简、零风险）**：**删掉 `Buffer.concat`**，改流式：
  ```ts
  const h = createHash('sha256')
  for (const p of bodyParts) h.update(p)
  const actual = h.digest('hex')
  ```
  语义完全等价（sha256 是流式的），零拷贝。
- **优先级**：**P0**（性价比最高的改动之一：删一个函数调用）

---

### P0-5 `src/main/update/import-archive.ts:82` + `:134` — 同步读整个 zip，且重复读 2~3 次

```ts
 81: export function listZipEntriesSync(zip: string): string[] {
 82:   const buf = readFileSync(zip)          // ← 整个 zip 进内存
```
```ts
131: export function readZipEntrySync(zip: string, wantName: string): string | undefined {
134:     buf = readFileSync(zip)              // ← 每次调用又整个读一遍
```

- **阻塞类型**：同步 fs 读。`probeArchive`（`:355`）是 `async`，但 `:362` 的 `listZipEntriesSync` 在第一个 `await`（`:370`）之前。
- **量级（实测）**：`NapCat.Shell.zip` = **28.12 MB**。且 `:369` `classifyArchive(entries, (name) => readZipEntrySync(file, name))` 会调 1~3 次（`:257` 读 `napcat.mjs`，`:287-302` 再试 `topPkg`/`nestedPkg`）→ **28MB × 2~3 = 56~84 MB 同步读**。
- **实证**：日志 `runtimes:pickFile 耗时 11628ms`、`runtimes:importFile 耗时 6741ms / 6250ms` —— 正是这条路径。
- **用户表现**：点「手动导入」选好包、点确认那一刻界面卡住，进度条还没弹出来就已经冻了。
- **改法**：`listZipEntriesSync` → 异步版（`await fsp.readFile`）；**并把 buffer 作为参数复用到 `readZipEntrySync`**，消掉重复读。更优：zip 中央目录在**文件尾部**，只需读尾部 64KB + 按需读条目，不必整文件进内存。
  - **注意**：`:178` 的 `inflateRawSync`（解压条目内容）同样是同步 zlib——正常包几十 KB，但**未设解压上限**，理论上可被 deflate 炸弹打爆。顺手加个 size 上限。
- **优先级**：**P0**

---

### P0-6 `src/main/update/update-backups.ts:170` — 启动路径上 `rmSync` 递归删整个更新备份

```ts
170:       rmSync(join(updateBackupsRoot(dataRoot), item.stamp), { recursive: true, force: true })
```

- **阻塞类型**：同步递归删目录。
- **触发路径**：`index.ts:535`（**启动路径**，包在 `void (async () => ...)()` 里）与 `ipc.ts:3021`（`backup:updateList`）。
- **量级**：安装器打的整库备份 `mxbot-data.tar.gz`，真实用户装完实例后**单份可达几百 MB**。删几百 MB 递归 ≈ **0.5~3s**。
- **★ 这里有个认知陷阱**：`index.ts:526-542` 用 `void + catch` 包着，注释写"清理失败绝不能挡住启动"。**但 `void` 只解决"谁来等"，不解决"事件循环是否被占"。** 同步 `rmSync` 照样冻结主进程。
  - **同一项目里就有正确对照**：`runtime-store.ts:294` 也写"刻意不 await、不抛错"，但 `sweepTrash`（`:308-341`）**正确地**用了异步 `fsp.rm`（`:329-330`）。两种做法并存 → 系统性认知盲点。
- **改法**：`await removeDirAsync(...)`（已有实现）。`index.ts` 处已在 async IIFE 内；`ipc.ts:3021` 的 `pruneUpdateBackups` 改成 async 并 await。
- **优先级**：**P0**

---

## 2. 🟠 P1 卡顿（5–50ms，但被循环/高频路径放大）

### P1-1 `src/main/update/backup.ts:560-577` — `pruneBackups` 循环 `unlinkSync` 删几百 MB 的包

```ts
560:   const files = readdirSync(backupsDir).filter((f) => f.endsWith('.tar.gz')).sort((a, b) => (a < b ? 1 : -1))
561:   const toRemove = files.slice(deps.keep)
564:       unlinkSync(join(backupsDir, f))
```
- 调用点 `ipc.ts:2982`，**紧跟 `await backupRuntime(...)` 之后**——用户正等备份结果。
- 循环上界 = `config.backupKeep`（用户可配），**每次迭代是几百 MB 的真实删除**。留 10 份淘汰 5 份 ≈ 0.5~2s。
- **这就是"循环上界小可留"假设的漏洞**：`audit-sync-in-loops.cjs` 把 `backup.ts` 的 8 处判为"上界通常很小，可留"。
- 改法：`fsp.readdir` + `fsp.unlink`；**注意**保持倒序保留 keep 份的语义。**P1**（视 keep 与单份体积可升 P0）。

### P1-2 `src/main/logs/logger.ts:53-59` — 每写一行日志都 `mkdirSync` 一次

```ts
53:   const write = (level, scope, msg, detail?) => {
54:     mkdirSync(logsDir, { recursive: true })
59:     appendFileSync(file(), line, 'utf8')
```
- **实测**：`mkdirSync`+`appendFileSync` 一对 = **0.359 ms**（2,000 次 717ms）。
- **单次不构成 >50ms 冻结**——所以不要把它误报成单次 P0。但它是**高频聚合**：`instance:list` 每次 `refresh()` 都调（`App.vue` 有 12+ 处 `refresh()`），任何循环里逐条记日志都会累加。
- 正确分类是 **P1-聚合**。`logger.ts:59` 的注释"同步写：崩溃前最后一口气也要落盘"是**成立的**，不要改成 async（会破坏崩溃保证）。
- 改法：(a) 首次成功后**缓存** `mkdirSync` 结果，别每行都建目录；(b) 补上**轮转**——`prune.ts:8` 与 `read-snippet.ts:8-11` 两处注释都明说"全项目没有任何轮转"，实例日志"单个能到几百 MB"。**P1**

### P1-3 `src/main/proc/process-manager.ts:360` — 实例 stdout 每个 data chunk 同步 append

```ts
356:         const rows = s.toString('utf8').split(/\r?\n/).filter((r) => r.length > 0)
358:         const chunk = rows.map((row) => `[${stamp}][${stream}] ${row}\n`).join('')
360:           appendFileSync(spec.logFile, chunk, 'utf8')
```
- `:339-355` 的长注释说明已经把"逐行 append"合并成"每 chunk 一次"（这是**已修好的**）。
- 残留风险：仍按 chunk 同步写，实例输出密集时（NapCat 消息流水）频率很高 → **P1-聚合**，与 P1-2 同类。
- 改法：改 `fs.createWriteStream`（保持顺序、异步背压），或至少做 50–100ms 合并队列。**注意**进程退出前要 flush（`proc/startup-guard` 会读 tail）。**P1**

### P1-4 `src/main/update/backup-list.ts:32-51` — 三层嵌套 `readdirSync` + 每项 `statSync`

```ts
32:   for (const kindDir of readdirSync(base, { withFileTypes: true })) {
34:     for (const instDir of readdirSync(join(base, kindDir.name), { withFileTypes: true })) {
39:       for (const f of readdirSync(backups)) {
51:           sizeMB: sizeMBOf(join(backups, f)),      // ← statSync
```
- 调用点 `ipc.ts:2993`（`backup:list`）。量级 = 实例数 × 每实例备份数；20 实例各 10 份 → 220 次同步调用 ≈ 20~60ms。
- 脚本已列出 `backup-list.ts (4)`，但**它数的是"4 处调用"，看不出是三层嵌套 × 实例数**。
- 改法：`fsp.readdir` + `Promise.all`。**P1**

### P1-5 `src/main/update/runtime-download.ts:306 / 322` — 下载完成瞬间 `rmSync` 大文件

```ts
306:       rmSync(tmp, { force: true })
322:       rmSync(deps.destFile, { force: true })
323:       const { renameSync } = await import('fs')
324:       renameSync(tmp, deps.destFile)
```
- `:322` 删的是已存在的旧包（NapCat 28MB / 117MB）；Windows 删大文件 + 杀软扫描 ≈ 50~300ms。
- 用户表现：进度到 100% 显示"落盘中"时界面卡一下。
- 改法：`await fsp.rm` / `fsp.unlink`。**注意** `:306` 必须在 `fetchToFile` **之前**完成（否则续传拿到脏 `.part`）→ 改 await 天然保序。**P1**

### P1-6 `src/main/update/import-archive.ts:178` — `inflateRawSync` 无上限

```ts
178:         if (method === 8) return inflateRawSync(raw).toString('utf8')
```
- 解压 `napcat.mjs` / `package.json`。正常几十 KB~几 MB，但 `compSize` 由中央目录给出、**未校验解压后大小** → 恶意/异常包可放大到任意大小（deflate 炸弹）。
- 与 `backup.ts:331 gunzipSync` 同属 zlib 同步家族。改法：`zlib.inflateRaw` 异步 + 解压后 size 上限。**P1**

### P1-7 `src/main/update/update-backups.ts:81-109` — 循环内 `existsSync` + `statSync`

```ts
81:   for (const name of names) {
89:     if (existsSync(file)) {
92:         const st = statSync(file)
```
- 每时间戳目录 2 次同步 stat，目录数 = 累积更新次数（**不清理可到几百**）。本机仅 3 个 → 微秒，属"可能慢"而非"确定慢"。改法：`fsp` 版本 + 并行。**P1（条件性）**

---

## 3. 🟡 P2 可优化（串行 await，**不冻结**，只是等得久）

> 明确区分：P2 期间**事件循环照常转**，界面不卡，只是总时长变长。**不要与 P0/P1 混为一谈。**

- **P2-1 `ipc.ts:4736-4739`** — 对 4 个独立注册表键**串行** `await run('reg.exe', …)`，每个 8s 超时 → 最坏 **32 秒延迟**（UI 仍响应，因为 `run` 是 `spawn` 不是 `spawnSync`）。改 `Promise.all`；**注意**重组 `found` 时保持数组顺序。
  - 同一批键在 `ipc.ts:5249` 是**同步**查的——那里才是冻结所在（见 P0 讨论）。
- **P2-2 `runtime-download.ts:280-331`** — 逐个镜像源串行尝试，且 `fetchToFileWithRetry`（`:193-211`）对同一 URL 重试 3 次（退避 1s+3s）。改法：源之间并行**竞速**（首个成功即取消其余）；**注意**并行下载抢带宽，建议只并行"可用性探测"。
- **P2-3 `version-catalog.ts:332-340`** — PyPI 版本查询 `await` 在 `Promise.all`（`:359`）**之前**，串行多等一轮。**注意** PyPI 结果合并优先级最高，并行后要保持"PyPI 优先"的合并顺序。
- **P2-4 `backup.ts:560` 的 `sort`** / `runtime-store.ts:395` / `version-catalog.ts:377` 的版本排序 — 元素是版本字符串，数量 ≤168 → 微秒级。**无需改**。

---

## 4. ⚪ 可接受（确实必须同步 / 微秒级）—— 避免被误报带偏

| 位置 | 理由 |
|---|---|
| `index.ts:120` `spawnSync('whoami.exe')` | **窗口出现之前**，且在单实例锁之前（`index.ts:105-109` 论证过顺序依赖）。最多 1.5s，无界面可冻。 |
| `index.ts:140` `spawnSync('powershell.exe')` | 提权重启，本质是"等用户在 UAC 上做决定"，30s 上限。同理无界面。 |
| `logger.ts:394/419` 崩溃现场 `spawnSync` + `rmSync` | 进程即将消失，异步的会随进程一起丢。**必须同步。** |
| `ipc.ts:304` `runSync('netstat')` / `ipc.ts:868` `runSync('taskkill')` | 只在 `killEverythingForExit`（退出路径）。退出时"阻塞"恰恰是想要的。 |
| `runtime-store.ts:519-562` `remove` 的 `renameSync` | **必须同步**：先改名让列表立刻干净（`:502-517` 论证），rename 是元数据操作，49133 文件也是一瞬间；真删除交给调用方异步。 |
| `runtime-store.ts:182-187` `writeManifest` | tmp + `renameSync` 原子写小 JSON，必须同步保原子性。 |
| `backup.ts:472-475` 回滚写盘 `mkdirSync`/`writeFileSync` | 回滚是"点了就等结果"，且 `:445-449` 论证"先全量校验再写"，同步更易保证原子。 |
| `util/json-file.ts:27` `readFileSync` | 配置文件都是几百字节~几十 KB（`config.json` 本机 166 字节）。27 处调用点全是小 JSON。 |
| `util/crash-logs.ts:102/131/183` | 运行锁 / 上次运行结论，几十字节。崩溃判据要求同步落盘。 |
| `logs/audit.ts:146` `readFileSync` | 每次用户动作一行；`:92-99` 的日期白名单已堵住任意读。 |
| `logs/prune.ts` | 仅启动跑一次，量级由 `LOG_KEEP_DAYS` 限定。 |
| `logs/read-snippet.ts:64-87` | **正面样板**：768KB 上限的 openSync/readSync 窗口，~1ms。**这正是其余大文件读该照抄的形状。** |
| `runtime-store.ts:105-131` `dirSizeMBAsync` | **正面样板**：正确的异步孪生，走 libuv 线程池。 |
| `runtime-store.ts:308-341` `sweepTrash` | **正面样板**：列表同步读小目录，删除走 `void ...then(fsp.rm)`。 |
| `update/backup.ts:135-289` `backupRuntime` | **正面样板**：全 `fsp.*` + `gzip`(callback)。（唯 `:410` 的 CPU 见 P0-4） |
| `import-archive.ts:520,538-557` | **正面样板**：rename 元数据操作，跨设备回退用 `await fsp.cp`。 |
| `store/relocate.ts:348-359` `copyInto` | **正面样板**：已从 `cpSync` 改成 `fsp.cp`（`:351`），注释 `:334-347` 明确论证。 |
| `proc/health.ts` | **干净**：`probePort` 全异步，`:33` 的端口范围守卫还堵了 `RangeError`。`waitPort` 是 await 循环，90s 启动等待**不冻 UI**。 |
| `proc/stats.ts` | **干净**（且**全仓库零调用点**，是死代码）：`await Promise.all` + 异步 pidusage。 |
| `update/progress.ts`、`pip-progress.ts`、`publish-urls.ts` | **零 I/O、零子进程**，纯计算/常量。 |
| `update/mirror-store-test.ts` 的 8 秒 | **不是同步阻塞**：`:48` `timeoutMs ?? 8000` 的网络超时，`Promise.all`(`:102`) 等最慢的源。事件循环正常转。 |

---

## 5. ★★ 现有脚本抓不到、但确实造成冻结的模式（本次最有价值的发现）

### MISS-1 `audit-sync-in-loops.cjs` 的正则**要求 `for (` 带括号**，而本代码库大量使用裸 `for...of`

```js
// scripts/audit-sync-in-loops.cjs:59
if (/\b(for|while)\s*\(/.test(line)) return line.trim()
```

`for (const x of readdirSync(dir))` **没有配对的 `)` 在行内且不以 `(` 紧邻 `for`** —— 实测 `inLoop()` 返回 `null`，于是 `:131-132` 的 `if (!loop) continue` **直接跳过该行，连记录都不做**。

我用脚本自身的 `inLoop` 逻辑实测 `creds.ts` 的 `walkJson`（一个真递归函数）：

```
line 181: if (depth > 4 || !existsSync(dir)) return []   → inLoop = NULL（脚本跳过）
line 183: for (const name of readdirSync(dir, ...))      → inLoop = NULL（脚本跳过）
```

**这就是它报"递归函数里 0 处"的机械原因**——不是真的没有，是**根本没看到**。量级实测：243 处无循环上下文的同步调用对脚本完全不可见（对比 99 处可见）。

**修法**：正则加裸 `for...of` 形态，或改为**缩进块**判定（`for (const … of readdirSync())` / `for await`）。

### MISS-2 `audit-sync-calls.cjs` 的 `HEAVY` 靠**字面量文件名后缀**

```js
// scripts/audit-sync-calls.cjs:113
/(?:…|readFileSync\s*\([^)]*\.(?:exe|zip|tar\.gz|7z|whl|dll)|…)/
```

真实代码是 `readFileSync(zip)`（`import-archive.ts:82`，**真读 28 MB**）、`readFileSync(deps.file)`（`backup.ts:330`）、`readFileSync(f)`（`builtin-version.ts:40`）——**参数是变量名，正则一个都匹配不到**，全部掉进 `LIGHT`，而 `:148` 明说 LIGHT "不拦"。

**这解释了为什么 237 处 LIGHT 里藏着真冻结源。**

### MISS-3 两个脚本的词汇表里**没有 zlib 同步 API、没有 `pbkdf2Sync`、没有纯 CPU**

`BANNED`/`HEAVY`/`LIGHT` 三个正则都不含 `gunzipSync` / `inflateRawSync` / `gzipSync` / `pbkdf2Sync`。于是：
- `backup.ts:331 gunzipSync`（几百 MB 解压，秒级）**连 LIGHT 计数都进不去**
- `creds.ts:259 pbkdf2Sync`（实测 256ms）完全隐形

**修法**：加入 HEAVY 词表。

### MISS-4 **纯 CPU 重活**对三级评分完全隐形

`backup.ts:410` 的 `Buffer.concat(bodyParts)` + `createHash(...).update(...)`：单行、不在循环、**无 `Sync` 后缀** → 三个桶**全进不去**。同类：大 `JSON.parse`、大 `Buffer.concat`。

**修法**：加一条 CPU 规则：`Buffer.concat` / `createHash(...).update(<大buffer>)` / 大 `JSON.parse` / 大 `sort`。

### MISS-5 "循环上界小可留"的假设对 `*Sync` **删除**不成立

脚本输出"其余 90 处（循环上界通常很小，可留）"。但 `backup.ts:564 unlinkSync` 上界 = `backupKeep`（**用户配置**），每项几百 MB；`workdir.ts:108 rmSync(recursive)` 每次是 GB 级。**"循环次数少" ≠ "代价小"。**

**修法**：按"迭代次数 × 单次最坏代价"估算，而非默认上界小。

### MISS-6 **`async` 函数第一个 `await` 之前的同步段**（可静态检测）

- `probeArchive`（`import-archive.ts:355-362`）是 `async`，但 356-362 **无任何 await**。
- `restoreBackup`（`backup.ts:324-331`）是 `async`，330-331 在首个 await 前。
- `qqChecker`（`ipc.ts:4749-4775`）是 `async`，但**所有同步工作都在最后一个 await 之后**——没有任何让出点。

**为什么两个脚本都漏**：按"是否在循环里"和"单 API 是否 LIGHT"判，**完全不看"这段是否在 await 之前"**。而 `ipc.ts:4962` 把所有 handler 包成 `ipcMain.handle(ch, async (...))`——**"async handler 所以不阻塞"的错觉正是最危险的地方**。

**修法**：纯静态检测"`async` 函数体首个 `await` 之前的 `*Sync` 调用"。**这是最值得加的一条规则。**

### MISS-7 启动路径上 `void (async () => …)()` 里的同步操作

`index.ts:526-542` 用 `void + catch` 包 `pruneUpdateBackups`，注释写"清理失败绝不能挡住启动"——**但内部是同步 `rmSync(recursive)`**。

**`void` 只解决"谁来等"，不解决"事件循环是否被占"。** 项目内已有正确对照（`runtime-store.ts:308-341` 的 `sweepTrash` 用异步 `fsp.rm`），**两种做法并存 = 系统性认知盲点**。

**修法**：标记"启动路径可达的所有 `*Sync`"，**不论是否被 `void` 包装**。

### MISS-8 没有调用图

`dashboard.ts:107 dashboardReady` ← `instance:start`、`qq-check.ts:188` ← `ipc.ts:4775`，跨文件的同步叶子在 IPC 热路径上，脚本**逐文件独立分析，看不见**。

---

## 6. 建议动手顺序（按"收益/风险"排序）

1. **`workdir.ts:108` sweepStaleTmp → `removeDirAsync`**（P0-1）
   收益最大：**每次启动省下约 14 秒冻结**（实测 45,391 文件 / 592MB）。项目里已有现成的异步删除实现，同一个文件内。**先做这个。**

2. **`backup.ts:410` 删掉 `Buffer.concat` → 流式 `h.update(p)`**（P0-4）
   一行改动、零风险、零拷贝，直接砍掉回滚路径上一次 0.3~0.7s 的纯 CPU 冻结。

3. **`creds.ts:259/68` `pbkdf2Sync` → 异步 `crypto.pbkdf2`**（P0-2）
   实测 256ms/次，"查看账密"按钮的直接病因，改动局部。

4. **`backup.ts:330-331` → `fsp.readFile` + `zlib.gunzip`**（P0-3）
   与第 2 步同文件，一起改省一次回归。

5. **`import-archive.ts:82/134` → 异步读 + buffer 复用**（P0-5）
   解掉 `pickFile 11628ms` / `importFile 6741ms` 的同步部分。

6. **`update-backups.ts:170` → `removeDirAsync`**（P0-6）
   启动路径收尾；同时顺手把 `index.ts:502-542` 那两个 `void` IIFE 的注释补一句"清理本身也必须是异步的"。

7. **`backup.ts:560-577` `pruneBackups` → `fsp.unlink`**（P1-1）
8. **`backup-list.ts:32-51` → `fsp.readdir` + `Promise.all`**（P1-4）
9. **`runtime-download.ts:306/322` → `fsp.rm`**（P1-5）
10. **审计脚本加固**：先加 MISS-1（裸 `for...of`）与 MISS-3（zlib/pbkdf2 词表）——两处都是一行正则，却能立刻让现有 243 处隐形调用中的一部分现形；再加 MISS-6（await 前同步段），这是最系统的一条。
11. **补日志轮转**（P1-2）：`prune.ts:8` 与 `read-snippet.ts:8-11` 两处注释自己都承认"全项目没有轮转"，而这正是 `logs:export 30871ms` 的上游成因（实例日志能到几百 MB，导出要整目录 cp）。

---

## 7. 我核实后认为**不必改**（避免被误报带偏）

- **`mirrors:test` 的 8012ms** —— **不是同步阻塞**。那是 `mirror-store-test.ts:48` 的 8000ms 网络超时，`Promise.all`(`:102`) 等最慢的源；事件循环全程正常。`ipc.ts:4959` 的 perf 门槛（>1000ms 记 ERROR）会把**纯网络等待**也标成"严重"，用这个日志归因时要当心。这是"IPC 耗时 ≠ 阻塞"的最好例子。
- **`templates.ts:71 verifyArchive`** —— **死代码，全仓库零调用点**（grep 确认只有定义）。与活的 `app-update.ts:295` 不是一回事。建议标 `@deprecated`，但**当前不产生冻结，别排进队列前面**。
- **`version-catalog.ts:96-113 writeCachedVersions`** —— 实测 PyPI `astrbot` JSON = **276,821 字节 / 0.26MB / 168 版本**，缓存 JSON 才 30~60KB → **1~5ms**，可接受。我在审查过程中一度以为它是 P0（"JSON.parse 几十 MB"），实测才知道不是。
- **`runtime-store.ts:391 statSync`** —— 与那条 `runtimes:list 1541ms` **不是因果关系**。1541ms 那版代码里 `sizeMB: dirSizeMB(dir)` 还在（`:374` 注释自述"2 万个小文件 ≈950ms，AstrBot 49133 文件 → 秒级"），而**当前代码已改成 `rec?.sizeMB` + 后台 `dirSizeMBAsync`**。残留的 `statSync(dir)` 量级 = 版本数（本机 4）。**别把已修好的问题重新排进队列。**
- **`builtin-version.ts:40` 读 3MB `napcat.mjs`** —— 我实测 **11ms**（读）+ **0ms**（正则）。虽然无缓存、且在 `instance:create` 路径上被逐实例调用，但**~11ms 是 P2 级，不是 P0**。审计过程中有分析把它报成 P0，我实测后降级。（正确形状仍是 `read-snippet.ts` 的窗口读 + 按 mtime 记忆化，值得做，但不紧急。）
- **`qq-check.ts:188-239` 的版本目录扫描** —— 循环上界 = 机器上装了几个 QQ 构建目录（通常 1~3），且 QQ 自己只保留当前版本。真实量级是**个位数 ms**，不是 P0。
- **`ipc.ts:5249 runSync('reg.exe')` 的例外表预算** —— `ALLOWED` 里写"超时已压到 1.5 秒"，但 `qqInstallFromRegistry`（`qq-check.ts:98-120`）**跑两个 `readValue` 循环**（`QQ_INSTALL_REGISTRY_KEYS` 然后 `QQ_REGISTRY_KEYS`）→ 最坏 **2 × 1500 = 3 秒**。**例外表里的预算写错了**（且 `ipc.ts:5234` 还留着"两条就是 10 秒"的旧注释）。不过 `instance:start` 会**先** `await opts.qqChecker()`（`ipc.ts:1622`）把缓存预热，只有 `instance:create`/测试才走冷路径。**建议修预算与注释，但优先级低于上面各条。**
- **`index.ts:120/140` 的两个 `spawnSync`** —— 提权判定与 UAC 等待，都在**窗口出现之前**、单实例锁之前，有明确顺序依赖（`:105-109`）。**可接受**，不要动。
- **`store/relocate.ts` 整体** —— `copyInto`（`:348-359`）已经用 `fsp.cp`，`assertRelocatable` 保持同步是**对的**（参数校验要早于任何 IO，且只读元数据）。`MOVE_FILES` 的 `cpSync`（`:271`）是几十 KB 的 JSON。**这一块已经修好了。**

---

## 8. 证据与复现

本报告所有量级都来自实测，命令可复现：

```powershell
# 1) cache/tmp 到底有多少文件（P0-1 的依据）
Get-ChildItem E:\MX\launcher-acb\data\cache\tmp -Force        # → 289 个条目
#   逐目录递归计数 → 47,317 个文件；>6h 陈旧的 137 个目录含 45,391 个文件 / 592.4 MB

# 2) rmSync 的单位成本
#   node 脚本建 3,000 文件 → rmSync 942 ms / fsp.rm 650 ms  ⇒ 0.31 ms/文件
#   0.31 ms × 45,391 ≈ 14 秒

# 3) pbkdf2Sync 成本
#   pbkdf2Sync(pw, salt, 600000, 32, 'sha256') → 256 ms / 259 ms

# 4) 3MB napcat.mjs 的真实读代价（用于把一条误报降级）
#   readFileSync 3,092,561 B → 11 ms；正则 → 0 ms

# 5) 现有脚本的盲区比例
#   遍历 src/main 全部 *Sync：有循环上下文 99 处，无循环上下文 243 处
```

真实日志证据：`E:\MXBot\AstriaX\data\logs\app-2026-09-15.log`（`:95` runtimes:list 1541ms、`:96` 阻塞 1520ms、`:107` 阻塞 7634ms、`:118` logs:export 30871ms）、`app-2026-09-26.log`（`:64` pickFile 11628ms、`:67/71` importFile 6741/6250ms、`:11` mirrors:test 8009ms）。

**本次审查全程只读，未修改任何文件。**
