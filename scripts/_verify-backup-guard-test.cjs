#!/usr/bin/env node
/**
 * 验证「备份校验不能误放行关键 .json」那组测试**真的能抓到漏洞**。
 *
 * ## 背景
 *
 * 审计发现 `backup:del` 的校验是"在 instances 下 + 以 .json/.tar.gz 结尾"，
 * 而实例目录里的关键文件全都是 .json（instance.json、cmd_config.json、
 * webui.json…）→ 全部通过校验 → 被 unlinkSync 删掉。
 * 这个进程还是管理员权限。
 *
 * 我把它改成三条约束（在 instances 下 + 父目录必须是 backups +
 * 文件名符合备份形状）。现在要确认：**撤回这个修复后，测试会红**。
 *
 * 否则那几条断言就是安慰剂 —— 漏洞还在也不报警。
 *
 * 做法：把 assertBackupFile 换成老的宽松实现，跑测试。
 *
 * 用法：node scripts/_verify-backup-guard-test.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const IPC = path.join(ROOT, 'src', 'main', 'ipc.ts')
const original = fs.readFileSync(IPC, 'utf8')

/**
 * 把 assertBackupFile 换成"老写法"：只做 assertInsideInstances。
 * 这等价于修复前的行为（.json 白名单放行一切关键文件）。
 */
function breakIt(src) {
  const re = /function assertBackupFile\(\r?\n[\s\S]*?\r?\n\}\r?\n/
  const m = re.exec(src)
  if (!m) return null
  const loose =
    'function assertBackupFile(\r\n' +
    '  dataRoot: string,\r\n' +
    '  p: string,\r\n' +
    '  opts: { exts: string[] }\r\n' +
    '): string {\r\n' +
    '  /* 【探针注入：老写法】只做基础校验 —— .json 白名单会放行关键文件 */\r\n' +
    '  return assertInsideInstances(dataRoot, p, { allowExt: opts.exts })\r\n' +
    '}\r\n'
  return src.slice(0, m.index) + loose + src.slice(m.index + m[0].length)
}

let bad = 0
const broken = breakIt(original)
if (!broken || broken === original) {
  console.error('✘ 没能把 assertBackupFile 换成老写法 —— 探针失效')
  process.exit(1)
}

try {
  fs.writeFileSync(IPC, broken, 'utf8')
  console.log('已把 assertBackupFile 换回"只做基础校验"的老写法，跑测试……\n')

  let out = ''
  try {
    out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--no-file-parallelism', 'tests/unit/backup-path-guard.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32' }
    )
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }

  const failed = /(\d+) failed/.exec(out)
  const n = failed ? Number(failed[1]) : 0
  if (n >= 3) {
    console.log(`  ✔ 老写法下有 ${n} 条失败 —— 这组测试确实能抓到"误删关键 .json"`)
    for (const line of out.split('\n')) {
      if (line.includes('×')) console.log('     ' + line.trim())
    }
  } else {
    bad++
    console.log(`  ✘ 老写法下只有 ${n} 条失败 —— 检测力不足`)
    console.log(out.split('\n').slice(-25).join('\n'))
  }
} finally {
  fs.writeFileSync(IPC, original, 'utf8')
  console.log('\nipc.ts 已还原（三条约束版本）。')
}

process.exit(bad)
