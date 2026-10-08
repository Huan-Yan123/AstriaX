#!/usr/bin/env node
/**
 * 指导书 0.1.3 自检 3 的产品化：**同步阻塞调用清单**
 *
 * 原文要求「全局搜索 sendSync、execSync、readFileSync、writeFileSync、
 *  existsSync 出现在 IPC handler 里的位置，逐个改成异步」。
 *
 * 现实里不能一刀切：读一个几百字节的 config.json（`readFileSync`）是微秒级、
 * 完全无害；而 `spawnSync('netstat')` 最坏 8 秒。所以本脚本做**分类**：
 *
 *   BANNED   sendSync / execSync           → 直接失败（指导书明确点名）
 *   HEAVY    会跑子进程/递归整棵目录的同步调用 → 必须出现在「已论证的例外」表里，
 *                                           否则失败（这类才是"卡几秒"的真凶）
 *   LIGHT    小文件读写 / existsSync        → 只统计数量，不拦（信息用）
 *
 * 例外表里的每一条都写了**为什么可以留**。新增同步重调用如果不在表里，
 * 这个脚本会红 —— 逼着改动者要么改异步、要么补一条带理由的例外。
 *
 * 用法：node scripts/audit-sync-calls.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'main')

/**
 * 已论证的同步例外。
 *
 * 判据用 `文件:行号特征`（不写死行号，避免每次改文件都要同步维护）：
 * 用「文件 + 该行包含的片段」唯一定位一处调用。
 */
const ALLOWED = [
  {
    file: 'index.ts',
    needle: "spawnSync('whoami.exe'",
    why: '窗口出现之前的提权判定；必须在单实例锁之前出结果（异步化要重排启动顺序，风险更大）；超时已收紧到 1.5 秒且有阻塞监视器盯着'
  },
  {
    file: 'async-exec.ts',
    needle: "spawnSync('taskkill'",
    why:
      '**取消路径**里杀进程树。必须同步的原因有两条，都不是"图省事"：' +
      '① 取消动作**本身不能被取消** —— 用异步的 run 会把 signal 再传一层，' +
      '语义上自相矛盾（取消一个取消操作）；' +
      '② 必须**在 resolve 之前真的把 kill 发出去** —— 异步的话 done() 会先返回，' +
      '调用方以为进程没了、实际它还活着并在写文件（那正是"取消后目录更乱"的来源）。' +
      '超时压在 5 秒，且只在用户**主动点取消**时才走这条路（不是热路径）'
  },
  {
    file: 'index.ts',
    needle: "spawnSync('powershell.exe'",
    why: '提权重启，本质是"等用户在 UAC 上做决定"；此刻没有窗口可冻，超时 30 秒'
  },
  {
    file: 'logger.ts',
    needle: 'spawnSync(c, a',
    why: '崩溃现场打包日志：进程马上就要死，必须同步一口气做完（异步的会随进程一起消失）'
  },
  {
    file: 'ipc.ts',
    needle: "runSync('netstat'",
    why: '只在 killEverythingForExit（退出路径）里用；交互路径已改用 findListenerPidAsync。退出时"阻塞"恰恰是我们想要的，改异步要重排 will-quit 时序，收益为负'
  },
  {
    file: 'ipc.ts',
    needle: "runSync('taskkill'",
    why: '同上：退出清理路径（按端口补杀），必须在进程咽气前完成'
  },
  {
    file: 'ipc.ts',
    needle: "runSync('reg.exe'",
    why: 'qqInstallDir 的**冷兜底**：正常路径由异步 qqChecker 预热缓存；万一没预热，超时已压到 1.5 秒（原来 5 秒×2）'
  },
  {
    file: 'logger.ts',
    needle: 'code = runSync(cmd, args)',
    why: '与上面那条同类：崩溃现场（exportZipSync）的同步压缩调用，进程即将消失，必须同步完成'
  },
  {
    file: 'logger.ts',
    needle: 'rmSync(staging',
    why: '压缩包做失败时的清理：同样在崩溃/导出路径上，删的是我们刚建的暂存目录（几十 MB），不是用户数据'
  },
  {
    file: 'async-exec.ts',
    needle: 'spawnSync(cmd, args',
    why: 'runSync 的**实现本身**（同步运行器）。它只被上面几条"退出/崩溃/冷兜底"路径使用；交互路径一律走异步 run'
  },
  {
    file: 'async-exec.ts',
    needle: 'export function runSync',
    why: '同上：这是那个同步运行器的函数签名，不是调用点'
  },
  {
    file: 'workdir.ts',
    needle: 'rmSync(dir',
    why: 'removeDirAsync 的**同步孪生**（清理暂存/工作目录用）。调用方按需选择；大目录一律用 removeDirAsync。保留同步版是因为它还被"进程即将退出"的路径使用'
  },
  {
    file: 'workdir.ts',
    needle: 'rmSync(p',
    why: '同上：workdir 的同步清理分支（个别调用点在同步上下文里，改成异步要连带改签名）'
  },
  {
    file: 'updater.ts',
    needle: 'rmSync(stage',
    why: 'updater.ts 整个模块**在生产里已无人调用**（被 instance:setRuntime 取代，见 ipc.ts 顶部注释）。留着它只为历史参考，实际不会执行 —— 待清理项'
  }
]

/** 递归收集 src/main 下的 .ts */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const BANNED = /(?:ipcRenderer\.sendSync\s*\(|child_process\.execSync|(?<![.\w])execSync\s*\()/
const HEAVY =
  /(?:spawnSync\s*\(|runSync\s*\(|cpSync\s*\([^)]*recursive|rmSync\s*\([^)]*recursive|readFileSync\s*\([^)]*\.(?:exe|zip|tar\.gz|7z|whl|dll)|writeFileSync\s*\([^)]*\.(?:exe|zip|7z))/
const LIGHT = /(?:readFileSync\s*\(|writeFileSync\s*\(|existsSync\s*\(|mkdirSync\s*\(|statSync\s*\()/

const banned = []
const heavy = []
let lightCount = 0

for (const f of walk(SRC)) {
  const rel = path.relative(SRC, f).replace(/\\/g, '/')
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    // 跳过注释行（本项目注释密度极高，注释里提到这些 API 是正常的）
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
    if (BANNED.test(line)) banned.push(`${rel}:${i + 1}: ${trimmed}`)
    if (HEAVY.test(line)) {
      const base = path.basename(rel)
      const allowed = ALLOWED.find((a) => a.file === base && line.includes(a.needle))
      heavy.push({ at: `${rel}:${i + 1}`, line: trimmed, allowed })
    }
    if (LIGHT.test(line)) lightCount++
  })
}

console.log('=== 同步调用审计（指导书自检 3）===\n')
console.log(`BANNED（sendSync / execSync）：${banned.length} 处`)
for (const b of banned) console.log('  ✘ ' + b)

const unallowed = heavy.filter((h) => !h.allowed)
console.log(`\nHEAVY（子进程/递归目录同步调用）：${heavy.length} 处，其中例外 ${heavy.length - unallowed.length} 处`)
for (const h of heavy) {
  if (h.allowed) console.log(`  · [已论证例外] ${h.at} —— ${h.allowed.why.slice(0, 60)}…`)
}
for (const h of unallowed) console.log(`  ✘ [未论证] ${h.at}: ${h.line}`)

console.log(`\nLIGHT（小文件读写/existsSync 等）：${lightCount} 处（微秒级，不拦，仅统计）`)

const fail = banned.length + unallowed.length
console.log(
  fail === 0
    ? '\n[OK] 没有禁用 API；所有同步重调用都有论证过的理由'
    : `\n[FAIL] ${fail} 处需要处理`
)
process.exit(fail === 0 ? 0 : 1)
