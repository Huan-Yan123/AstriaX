#!/usr/bin/env node
/*
 * 造一个"所有者是 Administrators"的顽固目录，并验证 `removeDirAsync` 能删掉它。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个脚本
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人机器上真实出现过"删实例后留下删不掉的空目录"：
 *     ...\instances\AstrBot\a_28fe6f37cc\data\temp\updates
 *
 * 实测到的现象链（都是硬证据）：
 *     fs.rm(recursive,force)  → EPERM scandir
 *     Get-Acl                 → 尝试执行未经授权的操作
 *     icacls /grant           → Access is denied
 *     takeown /F              → ERROR: Access is denied
 *     dir /q                  → 所有者 = BUILTIN\Administrators
 *     dir                     → File Not Found（**目录其实是空的**）
 *     管理员删除              → ✔ 成功
 *
 * 结论：不是"被占用"，是**所有者是 Administrators 而当前进程是普通权限**。
 * 成因是"以管理员身份运行的 pip"建的目录（data\temp\updates 就是 pip 的 TEMP）。
 *
 * 单测里造不出这种目录（改 ACL 需要管理员，而 CI/vitest 是普通权限），
 * 所以**只能靠这个脚本做真机验证** —— 它会弹一次 UAC 来构造现场。
 *
 * 用法：
 *     node scripts/test-stubborn-dir-delete.cjs
 *
 * 退出码 0 = 修复有效（提权兜底真的删掉了）；1 = 失败。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SANDBOX = path.join(ROOT, 'data', 'cache', 'tmp', `stubborn-${Date.now()}`)

function log(msg) {
  console.log(msg)
}

/** 用提权进程把目录的所有者改成 Administrators，并去掉普通用户权限 */
function makeStubborn(dir) {
  const inner = path.join(dir, 'sub', 'updates')
  fs.mkdirSync(inner, { recursive: true })
  fs.writeFileSync(path.join(inner, 'leftover.txt'), 'pip 残留', 'utf8')

  const ps =
    `icacls '${dir}' /setowner '*S-1-5-32-544' /T /C /Q | Out-Null; ` +
    `icacls '${dir}' /inheritance:r /grant '*S-1-5-32-544:(OI)(CI)F' /T /C /Q | Out-Null; ` +
    `exit 0`
  log('  （会弹一次 UAC：需要管理员才能把所有者改成 Administrators）')
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden ` +
        `-ArgumentList '-NoProfile','-Command',"${ps.replace(/"/g, '\\"')}"`
    ],
    { stdio: 'inherit', timeout: 120000 }
  )
}

/** 复现：普通权限下原生 rm 必须失败 */
function assertNativeRmFails(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    return false // 居然成功了 → 没复现出来
  } catch (e) {
    return e.code === 'EPERM' || e.code === 'EACCES'
  }
}

async function main() {
  log('=== 顽固目录删除验证 ===')
  log(`沙箱: ${SANDBOX}`)

  // ① 造现场
  log('\n[1] 造一个"所有者=Administrators"的目录（复现主人机器的现场）')
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  makeStubborn(SANDBOX)
  log('    构造完成')

  // ② 确认普通权限删不掉（否则这个测试没有意义）
  log('\n[2] 确认普通权限下删不掉（复现问题）')
  const reproduced = assertNativeRmFails(SANDBOX)
  if (!reproduced) {
    log('    ✘ 没复现出来（原生 rm 成功了）—— 可能是权限模型不同，本脚本无效')
    fs.rmSync(SANDBOX, { recursive: true, force: true })
    process.exit(1)
  }
  log('    ✔ 复现成功：原生 rm 抛 EPERM（这正是主人看到"删不掉"的原因）')

  // ③ 走生产代码
  log('\n[3] 走生产代码 removeDirAsync（含提权兜底）')
  const t0 = Date.now()
  let err
  try {
    // 直接加载编译产物里的工具函数不方便（入口是 Electron），
    // 所以用 tsx 之外的等价方式：调用我们导出它的那个路径。
    const mod = require(path.join(ROOT, 'out', 'main', 'index.js'))
    if (typeof mod.removeDirAsync !== 'function') throw new Error('产物里没导出 removeDirAsync')
    await mod.removeDirAsync(SANDBOX)
  } catch (e) {
    err = e
  }
  const ms = Date.now() - t0
  const gone = !fs.existsSync(SANDBOX)

  log(`    耗时 ${ms} ms`)
  if (err) log(`    抛错: ${err.message}`)
  log(`    目录已删: ${gone ? '✔ 是' : '✘ 否'}`)

  // ④ 清理
  if (!gone) {
    log('\n[4] 兜底清理（提权）')
    try {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden ` +
            `-ArgumentList '-NoProfile','-Command',"Remove-Item -LiteralPath '${SANDBOX}' -Recurse -Force -ErrorAction SilentlyContinue"`
        ],
        { stdio: 'inherit', timeout: 120000 }
      )
    } catch {
      /* 忽略 */
    }
  }

  log(`\n${gone ? '✔ 通过：提权兜底真的删掉了顽固目录' : '✘ 失败：仍留在磁盘上'}`)
  process.exit(gone ? 0 : 1)
}

main().catch((e) => {
  console.error('脚本出错:', e)
  process.exit(2)
})
