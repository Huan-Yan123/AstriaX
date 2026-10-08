#!/usr/bin/env node
/*
 * 从头检查 —— 一条命令跑完整条验证链。
 *
 * ============================================================================
 * 为什么要有这个脚本
 * ============================================================================
 *
 * 主人的原话：「你每次说好了都是一堆bug，你再多检查检查，每改一个地方，
 * 都要从头开始检查」。
 *
 * 这个批评是对的。之前的毛病是：改完只跑**那个新写的**测试，
 * 它绿了就说"好了"。可那个测试是我自己写的、按我的理解写的，
 * 它绿只能证明"我改的地方符合我的预期"，证明不了：
 *   - 别的地方被我改坏了（回归）
 *   - 打包/安装器那一层还编得过吗
 *   - 真正跑一遍安装流程还对不对
 *
 * 所以现在立一条规矩：**每次改动之后，跑这个脚本，全绿才算改完。**
 * 它按顺序跑四关，任何一关失败就立刻停（不继续跑后面的，因为
 * 后面的结果已经没有意义了）：
 *
 *   1. 构建        npx electron-vite build
 *   2. 静态自检    node scripts/self-check.cjs（含**真** makensis 两遍编译）
 *   3. 全量单测    npx vitest run --no-file-parallelism
 *   4. 安装器真机  node scripts/test-installer-e2e.cjs
 *
 * ============================================================================
 * 为什么用 node 写而不是 PowerShell
 * ============================================================================
 *
 * 刚踩过的血坑：用 PowerShell 的 Get-Content/Set-Content 往返一个含中文的
 * 源文件，PS 5.1 按 GBK 解码 UTF-8 → 536 个字符变 U+FFFD、换行被吞、
 * 把代码行并进注释里 → 整个宏被静默删掉。所以：**任何涉及中文文本的
 * 处理一律用 node**，包括这个脚本本身。
 *
 * 用法：
 *   node scripts/full-check.cjs              # 四关全跑（约 12-15 分钟）
 *   node scripts/full-check.cjs --skip-e2e   # 跳过安装器真机（约 10-12 分钟）
 *   node scripts/full-check.cjs --only=build,selfcheck   # 只跑前两关
 *
 * 退出码：0 = 全绿；非 0 = 有失败（并告诉你失败在哪一关）
 */
const { spawnSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const LOGDIR = path.join(ROOT, 'data', 'cache', 'tmp', `full-check-${STAMP}`)

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2)
const skipE2E = argv.includes('--skip-e2e')
const onlyArg = argv.find((a) => a.startsWith('--only='))
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null

const want = (name) => !only || only.has(name)

/* ------------------------------------------------------------------ *
 * 输出小工具。GBK 控制台会把 ✔ 打成乱码，但那只是显示问题，
 * 所以只在**文件日志**里用符号，控制台上用纯 ASCII 标记。
 * ------------------------------------------------------------------ */
let failedStep = null
function say(msg) {
  process.stdout.write(msg + '\n')
}

function hr(title) {
  say('')
  say('  ' + title)
  say('  ' + '-'.repeat(Math.max(20, 70 - title.length)))
}

/* ------------------------------------------------------------------ *
 * 跑一条命令，把完整输出存文件、只把摘要打到控制台。
 * ------------------------------------------------------------------ */
function run(name, cmd, args, opts = {}) {
  const timeout = opts.timeout ?? 45 * 60 * 1000
  const t0 = Date.now()
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    shell: opts.shell ?? true, // npx / python 在 Windows 上要 shell
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' }
  })
  const ms = Date.now() - t0
  const out = (r.stdout || '') + (r.stderr || '')
  try {
    fs.writeFileSync(path.join(LOGDIR, `${name}.log`), out, 'utf8')
  } catch {
    /* 日志写不了不影响判断 */
  }
  const timedOut = Boolean(r.error) && r.error.code === 'ETIMEDOUT'
  return { name, code: r.status, signal: r.signal, ms, out, timedOut }
}

/** 失败时把最能说明问题的那几行挑出来 */
function failLines(out, max = 18) {
  const lines = out.split(/\r?\n/).filter((l) => l.trim())
  // 优先挑"像错误"的行
  const errish = lines.filter((l) =>
    /error|Error|✘|×|failed|FAIL|未通过|不配平|缺少|缺失|异常/.test(l)
  )
  const pick = (errish.length ? errish : lines).slice(0, max)
  return pick.map((l) => '      ' + l.trim().slice(0, 200))
}

/* ------------------------------------------------------------------ *
 * 步骤定义
 * ------------------------------------------------------------------ */
const steps = []

if (want('build')) {
  steps.push({
    name: 'build',
    label: '构建（electron-vite build）',
    run: () => run('build', 'npx', ['electron-vite', 'build']),
    check: (r) => {
      if (r.code !== 0) return `构建失败（退出码 ${r.code}）`
      return null
    }
  })
}

if (want('selfcheck')) {
  steps.push({
    name: 'selfcheck',
    label: '静态自检 + 真 makensis 编译（self-check.cjs）',
    run: () => run('selfcheck', 'node', ['scripts/self-check.cjs']),
    check: (r) => {
      if (r.code !== 0) return `自检不通过（退出码 ${r.code}）`
      // 自检脚本自己会用"未发现问题。"作为全绿信号，双重确认
      if (!/未发现问题/.test(r.out)) return '自检没有输出「未发现问题。」—— 判据本身可能坏了'
      return null
    }
  })
}

if (want('tests')) {
  steps.push({
    name: 'tests',
    label: '全量单元/界面测试（vitest --no-file-parallelism）',
    run: () => run('tests', 'npx', ['vitest', 'run', '--no-file-parallelism']),
    check: (r) => {
      if (r.timedOut) return '测试超时'
      /*
       * 不能只看退出码：vitest 在"测试文件挂了但没报 failed"这类情况下
       * 退出码可能仍为 0。所以既看退出码，也**解析计数** ——
       * 要求至少跑到了测试（有 Tests 行）、且 failed 为 0。
       */
      const m = r.out.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/)
      const failedM = r.out.match(/Tests\s+(\d+)\s+failed/)
      const nFailed = failedM ? Number(failedM[1]) : 0
      if (nFailed > 0) return `${nFailed} 个测试失败`
      if (!m) return '没解析到测试计数 —— 测试可能根本没跑起来（这本身就是问题）'
      if (r.code !== 0) return `vitest 退出码 ${r.code}（计数却是 0 失败，需人工看日志）`
      return null
    }
  })
}

if (want('e2e') && !skipE2E) {
  steps.push({
    name: 'e2e',
    label: '安装器真机验证（覆盖更新数据保全，6 个场景）',
    run: () => run('e2e', 'node', ['scripts/test-installer-e2e.cjs'], { timeout: 30 * 60 * 1000 }),
    check: (r) => {
      if (r.code !== 0) return `安装器真机验证失败（退出码 ${r.code}）`
      if (!/数据保全逻辑全部通过/.test(r.out)) return '没看到「全部通过」的结论行'
      return null
    }
  })
}

/* ------------------------------------------------------------------ *
 * 跑
 * ------------------------------------------------------------------ */
fs.mkdirSync(LOGDIR, { recursive: true })

say('')
say('  MXBot 从头检查')
say('  ' + '='.repeat(60))
say(`  时间   ${new Date().toLocaleString('zh-CN')}`)
say(`  日志   ${LOGDIR}`)

/*
 * 记录"这次检查的是哪份代码"。
 * 没有这个指纹，一轮跑完再说"我检查过了"是没有说服力的 ——
 * 说不定中间文件已经变了。
 */
const FINGERPRINT = [
  'src/main/ipc.ts',
  'src/main/index.ts',
  'src/main/creds/creds.ts',
  'src/main/update/backup.ts',
  'src/main/update/app-update.ts',
  'src/main/update/import-archive.ts',
  'src/main/util/workdir.ts',
  'src/main/util/atomic-write.ts',
  'build/installer.nsh',
  'package.json'
]
say('')
say('  代码指纹（SHA256 前 12 位）:')
for (const f of FINGERPRINT) {
  try {
    const h = createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex')
    say(`    ${h.slice(0, 12)}  ${f}`)
  } catch {
    say(`    (缺失)        ${f}`)
  }
}

const results = []
const tAll = Date.now()

for (const s of steps) {
  hr(s.label)
  const r = s.run()
  const reason = s.check(r)
  const secs = (r.ms / 1000).toFixed(1)
  results.push({ label: s.label, ok: !reason, reason, secs })

  if (reason) {
    say(`  [失败] ${reason}  (${secs}s)`)
    say('')
    say('  关键输出:')
    for (const l of failLines(r.out)) say(l)
    say('')
    say(`  完整日志: ${path.join(LOGDIR, r.name + '.log')}`)
    failedStep = s.name
    break // 前面挂了，后面的结果没意义
  }
  say(`  [通过] ${secs}s`)
}

const total = ((Date.now() - tAll) / 1000).toFixed(1)

say('')
say('  ' + '='.repeat(60))
if (failedStep) {
  say(`  [不通过] 卡在「${steps.find((s) => s.name === failedStep)?.label}」`)
  for (const r of results) {
    if (!r.ok) say(`     失败：${r.reason}`)
  }
} else {
  say(`  [全绿] ${results.length} 关全部通过，用时 ${total}s`)
}
say('  ' + '='.repeat(60))
say('')

process.exit(failedStep ? 1 : 0)
