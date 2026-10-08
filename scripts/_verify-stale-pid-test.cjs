#!/usr/bin/env node
/**
 * 验证「绝不误杀」那组测试**真的能抓到那个 bug**。
 *
 * ## 为什么必须做这一步
 *
 * 我刚修了一个严重问题：`killTreeSync` 对**已退出进程的陈旧 PID**
 * 也会执行 taskkill，而 PID 会被系统回收复用 → 可能杀掉用户自己的
 * QQ / NapCat / 别的软件（管理员权限下）。
 *
 * 我同时加了 4 条测试断言"已退出的 PID 不许杀"。但这里有个必须排除的
 * 自欺可能：**这组断言会不会在旧代码下也通过？**
 *
 * 如果会（比如 killImpl 注入点没生效、或断言写反了），
 * 那这组测试就是"永远绿"的装饰品 —— bug 回来它也不响。
 *
 * ## 做法
 *
 * 把修复**临时撤掉**（恢复成"只看 pid 真值"的老写法），
 * 跑那组测试，预期**必须失败**：
 *   · 失败 → 说明测试有效（bug 在就会红）
 *   · 通过 → 说明测试无效，得重写
 *
 * 用副本 + finally 保证原文件还原。
 *
 * 用法：node scripts/_verify-stale-pid-test.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const PM = path.join(ROOT, 'src', 'main', 'proc', 'process-manager.ts')
const original = fs.readFileSync(PM, 'utf8')

/**
 * 把修复撤掉：让 isLiveForKill 恢复成"只看 pid 有没有"。
 *
 * 老代码的实质是 `if (!p || !p.child.pid) return` ——
 * 也就是只判 pid 真值。这里把函数体换成等价的宽松版。
 *
 * ## 锚点要用正则，且要处理 CRLF
 *
 * 第一版用字面量 `'function isLiveForKill(p: {'` 去找，
 * 结果报"没能定位" —— 因为这个项目里的 .ts 是 **CRLF** 换行，
 * 而我的锚点里带了 `\n`（在下一行）。这类"锚点不匹配"很容易被误读成
 * "探针跑不动"，所以统一用 `\r?\n` 的正则来定位。
 */
function breakIt(src) {
  /*
   * 匹配整个函数：从 `function isLiveForKill(` 到它自己的结束大括号。
   * 用"遇到行首两个空格 + } 就收"的方式界定（函数体只有一层）。
   */
  const re =
    /function isLiveForKill\(p: \{[\s\S]*?\r?\n  \}\r?\n/
  const m = re.exec(src)
  if (!m) return null

  const loose =
    'function isLiveForKill(p: {\r\n' +
    '    child: ChildProcess\r\n' +
    '    status: ProcStatus\r\n' +
    '  }): boolean {\r\n' +
    '    /* 【探针注入：老写法】只判 pid 真值，不判状态/退出码 */\r\n' +
    '    return !!p.child.pid\r\n' +
    '  }\r\n'
  return src.slice(0, m.index) + loose + src.slice(m.index + m[0].length)
}

let bad = 0
const broken = breakIt(original)
if (!broken) {
  console.error('✘ 没能定位 isLiveForKill —— 探针失效，请更新脚本')
  process.exit(1)
}
if (broken === original) {
  console.error('✘ 注入没有产生变化')
  process.exit(1)
}

try {
  fs.writeFileSync(PM, broken, 'utf8')
  console.log('已把 isLiveForKill 换回"只看 pid"的老写法，跑那组测试……\n')

  let out = ''
  try {
    out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--no-file-parallelism', 'tests/unit/process-manager.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: process.platform === 'win32' }
    )
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }

  // 老写法下应该**有失败**
  const failed = /(\d+) failed/.exec(out)
  const n = failed ? Number(failed[1]) : 0

  if (n >= 3) {
    console.log(`  ✔ 老写法下有 ${n} 条失败 —— 说明这组测试确实能抓到"陈旧 PID 被误杀"`)
    for (const line of out.split('\n')) {
      if (line.includes('★绝不误杀') || line.includes('×')) console.log('     ' + line.trim())
    }
  } else {
    bad++
    console.log(`  ✘ 老写法下只有 ${n} 条失败 —— 测试不足以抓住这个 bug`)
    console.log(out.split('\n').slice(-25).join('\n'))
  }
} finally {
  fs.writeFileSync(PM, original, 'utf8')
  console.log('\nprocess-manager.ts 已还原（含 isLiveForKill 修复）。')
}

process.exit(bad)
