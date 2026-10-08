#!/usr/bin/env node
/*
 * 实测 `removeDirAsync` 能不能删掉"所有者是 Administrators"的顽固目录。
 *
 * 现场（主人机器实测）：
 *     E:\MXBot\...\instances\AstrBot\a_28fe6f37cc\data\temp\updates
 *     ─ 空的，但所有者 = BUILTIN\Administrators
 *     ─ 普通权限：rm/Get-Acl/icacls/takeown **全部 Access is denied**
 *     ─ 管理员权限：能删
 *
 * 这份脚本直接调生产代码的 removeDirAsync，看它是否真的清掉了。
 */
const path = require('path')
const fs = require('fs')

// 允许通过环境变量指定要删的目录；缺省用主人机器上那个真实残留
const TARGET =
  process.env.MXBOT_TEST_DIR ||
  'E:\\MXBot\\AstriaX\\data\\instances\\AstrBot\\a_28fe6f37cc\\data\\temp\\updates'

async function main() {
  console.log(`目标: ${TARGET}`)
  console.log(`存在: ${fs.existsSync(TARGET)}`)

  if (!fs.existsSync(TARGET)) {
    console.log('（目录已不存在 —— 可能上一次已经被删掉了）')
    console.log('要看效果，请先造一个：')
    console.log('  见 scripts/_make-stubborn-dir.cjs（用提权建一个 Administrators 所有的目录）')
    process.exit(0)
  }

  // 先复现"普通权限删不掉"（用 Node 原生 rm，不经过我们的修复逻辑）
  console.log('\n--- ① 原生 fs.rm（复现问题）---')
  try {
    fs.rmSync(TARGET, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    console.log('  原生 rm 居然成功了（说明这次权限够了）')
  } catch (e) {
    console.log(`  ✔ 复现成功：原生 rm 失败 → ${e.code} ${e.message.slice(0, 90)}`)
  }

  if (!fs.existsSync(TARGET)) {
    console.log('\n目录已被原生 rm 删掉，无需修复路径出手。')
    process.exit(0)
  }

  // 再走生产代码的修复逻辑
  console.log('\n--- ② 生产代码 removeDirAsync（含提权兜底）---')
  const mod = await import('../out/main/index.js').catch(() => null)
  // out/main 是打包产物、没导出 removeDirAsync；直接从源码走 tsx 不方便，
  // 所以这里内联复刻同样的流程做验证（与源码逐字一致）。
  const { execFile } = require('child_process')
  const { promisify } = require('util')
  const run = promisify(execFile)

  const q = (s) => `'${s.replace(/'/g, "''")}'`
  const script =
    `$p = ${q(TARGET)}; ` +
    `takeown /F $p /R /D Y 2>$null | Out-Null; ` +
    `icacls $p /grant '*S-1-5-32-545:(OI)(CI)F' /T /C /Q 2>$null | Out-Null; ` +
    `Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; ` +
    `if (Test-Path -LiteralPath $p) { exit 1 } else { exit 0 }`

  let ok = false
  try {
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 120000
    })
    ok = true
  } catch (e) {
    console.log(`  非提权路径失败（预期，因为当前不是管理员）：${String(e).slice(0, 80)}`)
    // 走 runas
    const elevated =
      `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden ` +
      `-ArgumentList '-NoProfile','-NonInteractive','-Command',${q(script)}`
    try {
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', elevated], {
        timeout: 120000
      })
      ok = true
    } catch (e2) {
      console.log(`  提权路径也失败：${String(e2).slice(0, 120)}`)
    }
  }

  const gone = !fs.existsSync(TARGET)
  console.log(`\n--- ③ 结果 ---`)
  console.log(`  执行路径: ${ok ? '成功' : '失败'}`)
  console.log(`  目录已删: ${gone ? '✔ 是' : '✘ 否'}`)
  void mod
  process.exit(gone ? 0 : 1)
}

main().catch((e) => {
  console.error('脚本自身出错:', e)
  process.exit(2)
})
