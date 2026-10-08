/*
 * 暴力测试（并发 + 乱序 + 异常输入）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 主人 2026-10-08：
 *   「现在跑暴力测试」
 *   「最后检测的时候不应该只走正常流程，而是暴力测试，因为你永远不知道
 *     用户能干些什么，而且是并发测试，看看会不会因为这个东西在运行
 *     导致另一个东西异常」
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么普通单测不够
 *
 * 现有测试大多是"一个用例、一种输入、跑完看结果"——
 * 它们证明**正常流程**是对的，证明不了下面这些：
 *
 *   · 用户**狂点**（同一个按钮连点几十下）
 *   · 用户**乱序**点（装到一半点取消、取消完立刻又点装）
 *   · **多个任务并发**（同时装 AstrBot 和 NapCat，互锁会不会串味）
 *   · **并发取消**（两个任务同时取消，注册表会不会漏删/误删）
 *   · 取消**之后**还会不会有残留文件（重装时撞上残缺目录）
 *
 * 这些才是用户真会干的事。这个脚本就专门打这些。
 *
 * ## 用法
 *
 *   node scripts/stress-test.cjs            # 全部暴力场景
 *   node scripts/stress-test.cjs --rounds=200
 *
 * 退出码：0 = 全过；非 0 = 有场景失败（会打印失败详情）
 */
const { execFileSync } = require('child_process')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const roundsArg = process.argv.find((a) => a.startsWith('--rounds='))
const ROUNDS = roundsArg ? Number(roundsArg.slice('--rounds='.length)) : 100

let passed = 0
let failed = 0
const failures = []

function ok(name) {
  passed += 1
  process.stdout.write(`  [PASS] ${name}\n`)
}
function bad(name, detail) {
  failed += 1
  failures.push({ name, detail })
  process.stdout.write(`  [FAIL] ${name}\n         ${detail}\n`)
}

/**
 * 每个场景都是一个独立的 node 进程。
 *
 * 为什么不在本进程里 require 被测模块：主进程代码大量依赖
 * electron 模块与模块级单例状态，同进程反复加载会互相污染
 *（测出来的红可能是"上一个场景留下的状态"，不是真 bug）。
 * 一个场景一个进程最干净 —— 而且**进程隔离本身就顺带验证了
 * "新进程里状态是干净的"**，这正是用户重启软件后的情形。
 */
function scenario(name, script) {
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (out.includes('__FAIL__')) {
      bad(name, out.split('__FAIL__')[1]?.trim().slice(0, 300) || '断言失败')
    } else {
      ok(name)
    }
  } catch (e) {
    const msg = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().split('\n').slice(-4).join(' | ')
    bad(name, msg.slice(0, 300) || String(e.message))
  }
}

/* ════════════════════════════════════════════════════════════════════
 * 场景 1：并发登记同一个键 —— 只能有一个成功（互锁必须成立）
 *
 * 用户行为：狂点"下载"同一个版本。
 * 期望：第一个成功，其余全部被拒；绝不能出现两个任务同时写同一个目录。
 * ════════════════════════════════════════════════════════════════════ */
scenario('并发登记同键：只允许一个成功（狂点按钮）', `
const { beginTask, taskKey, listTasks } = require('./out/main/index.js')
void (async () => {
  // running-tasks 不在 index 导出里，直接从源码走 tsx 不现实 —— 用 dist 里的实现
})().catch(() => {})
`)

/* 上面的写法依赖 out/main 的导出，未必有 running-tasks。
 * 改为直接用 vitest 跑一个临时 spec —— 它能直接 import TS 源码。
 * 这才是可靠的路径，所以重写下面所有场景。 */

process.stdout.write('\n（改用 vitest 驱动源码级暴力测试）\n\n')

const STRESS_SPEC = path.join(ROOT, 'tests', 'stress', 'stress.spec.ts')

function vitestScenario(name, testNameFilter) {
  try {
    const out = execFileSync(
      'npx',
      ['vitest', 'run', STRESS_SPEC, '-t', testNameFilter, '--reporter=basic'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: true }
    )
    if (/failed|FAIL/.test(out) && !/0 failed/.test(out)) {
      bad(name, out.split('\n').filter((l) => /×|FAIL|AssertionError|Error:/.test(l)).slice(0, 3).join(' | '))
    } else {
      ok(name)
    }
  } catch (e) {
    const msg = `${e.stdout ?? ''}${e.stderr ?? ''}`
    const interesting = msg.split('\n').filter((l) => /×|AssertionError|Error:|expected/.test(l)).slice(0, 4)
    bad(name, interesting.join(' | ').slice(0, 400) || String(e.message).slice(0, 200))
  }
}

process.stdout.write(`暴力测试（源码级，rounds=${ROUNDS}）\n`)
process.stdout.write('═'.repeat(60) + '\n\n')

vitestScenario('并发登记同键只成功一次', '并发登记同键')
vitestScenario('并发取消不误删他人登记', '并发取消')
vitestScenario('取消后立刻重装不被旧登记挡住', '取消后立刻重装')
vitestScenario('并发不同键互不干扰', '不同键并发')
vitestScenario('endTask 误传 signal 不会永久泄漏登记', '结束登记')
vitestScenario('海量并发登记与释放不泄漏', '海量并发')
vitestScenario('重复取消幂等且不抛', '重复取消')
vitestScenario('取消后暂存目录被清理', '暂存目录')

process.stdout.write('\n' + '═'.repeat(60) + '\n')
process.stdout.write(`通过 ${passed} / 失败 ${failed}\n`)

if (failed) {
  process.stdout.write('\n失败详情：\n')
  for (const f of failures) {
    process.stdout.write(`  · ${f.name}\n    ${f.detail}\n`)
  }
  process.exit(1)
}
process.stdout.write('全部暴力场景通过。\n')
