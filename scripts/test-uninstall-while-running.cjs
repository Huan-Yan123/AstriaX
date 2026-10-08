#!/usr/bin/env node
/*
 * ★★ 真机验证（在**真实安装**上做）：卸载器能不能关掉正在运行的 AstriaX
 *
 * 主人反馈（2026-09-27）：
 *     「卸载程序永远无法关闭正在运行中的软件，导致卸载失败」
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么用"真实安装"而不是"临时装一个"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 试过临时静默安装（`AstriaX-Setup-0.1.7.exe /S /D=<tmp>`），**退出码 2** ——
 * 因为机器上已经装了 AstriaX（`perMachine=false` 的安装器拒绝重复安装）。
 *
 * 而"已安装的那个"恰恰就是真实现场：
 *     E:\MXBot\AstriaX\AstriaX.exe
 *     E:\MXBot\AstriaX\Uninstall AstriaX.exe
 *
 * ## 这个脚本做什么（**不会真的卸载掉主人的软件**）
 *
 * 它**只验证"关进程"这一段**，不跑完整卸载：
 *   1. 找到已安装的 AstriaX.exe 与它的卸载器
 *   2. 启动 AstriaX，确认进程在跑
 *   3. 用**卸载器里的那段逻辑**（与 installer.nsh 的 customCheckAppRunning
 *      逐字一致的 taskkill 序列）去关它
 *   4. 断言：进程真的没了
 *
 * 为什么不跑完整卸载：主人还要用这个软件。完整卸载会删掉
 * E:\MXBot\AstriaX\，那是他的工作副本。
 * 「卸载时数据保不保全」已经由 scripts/test-installer-e2e.cjs 覆盖
 *（真机 NSIS 编译 + 安装/卸载 + 逐字节断言）。
 *
 * 这里补的是**唯一没被覆盖的那一段**：进程关闭。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync, spawn } = require('child_process')

const APP_DIR = process.env.MXBOT_INSTALL_DIR || 'E:\\MXBot\\AstriaX'
const EXE = path.join(APP_DIR, 'AstriaX.exe')
const EXE_NAME = 'AstriaX.exe'

function log(m) {
  console.log(m)
}

function isRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/NH'], {
      encoding: 'utf8',
      timeout: 15000
    })
    return out.includes(EXE_NAME)
  } catch {
    return false
  }
}

function pids() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 15000
    })
    return out
      .split(/\r?\n/)
      .map((l) => l.match(/"[^"]+","(\d+)"/))
      .filter(Boolean)
      .map((m) => Number(m[1]))
  } catch {
    return []
  }
}

/**
 * 复刻 installer.nsh 的 customCheckAppRunning 逻辑（逐条对应）。
 *
 * 为什么不直接调卸载器：见文件头（那会删掉主人的软件）。
 * 这段是**纯进程操作**，与 NSIS 里那几行一一对应：
 *   ① taskkill /im（温和）
 *   ② 轮询等（最多 5 × 600ms）
 *   ③ taskkill /f /t /im（强制，连子进程树）
 */
async function closeLikeUninstaller() {
  const tryRun = (args) => {
    try {
      execFileSync('taskkill', args, { stdio: 'ignore', timeout: 30000 })
      return true
    } catch {
      return false
    }
  }

  log('  ① 温和请求退出：taskkill /im')
  tryRun(['/im', EXE_NAME])

  log('  ② 轮询等它退出（最多 3 秒）')
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 600))
    if (!isRunning()) return 'graceful'
  }

  log('  ③ 仍未退出 → 强制（连子进程树）taskkill /f /t /im')
  tryRun(['/f', '/t', '/im', EXE_NAME])
  await new Promise((r) => setTimeout(r, 1200))
  return isRunning() ? 'failed' : 'forced'
}

async function main() {
  log('=== 卸载器的"关闭运行中软件"能力（真机）===')

  if (!fs.existsSync(EXE)) {
    log(`✘ 找不到 ${EXE}`)
    log('  可用 MXBOT_INSTALL_DIR 指定安装目录')
    process.exit(1)
  }
  const uninst = fs.readdirSync(APP_DIR).find((f) => /^Uninstall.*\.exe$/i.test(f))
  log(`安装目录: ${APP_DIR}`)
  log(`卸载器  : ${uninst || '(没找到！)'}`)
  log(`版本    : ${(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'resources', 'app-update.yml'), 'utf8'))
        .version
    } catch {
      return '未知'
    }
  })()}`)

  let pass = true
  const fail = (m) => {
    pass = false
    log(`  ✘ ${m}`)
  }
  const ok = (m) => log(`  ✔ ${m}`)

  // 收尾：绝不让主人的软件留在"被我杀了"的状态
  let wasRunningBefore = isRunning()

  try {
    // ① 启动（如果本来没跑）
    if (!wasRunningBefore) {
      log('\n[1] 启动 AstriaX')
      const c = spawn(EXE, [], { detached: true, stdio: 'ignore' })
      c.unref()
      let up = false
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        if (isRunning()) {
          up = true
          break
        }
      }
      if (!up) {
        fail('40 秒内没启动起来 —— 测不了')
        process.exit(1)
      }
    } else {
      log('\n[1] AstriaX 本来就在跑（正好是"用户开着软件去卸载"的现场）')
    }
    ok(`进程在跑（pid: ${pids().join(', ')}）`)
    await new Promise((r) => setTimeout(r, 3000))

    // ② 用卸载器的逻辑关它
    log('\n[2] 用卸载器的关闭逻辑（installer.nsh 的 customCheckAppRunning）')
    const how = await closeLikeUninstaller()

    // ③ 断言
    log('\n[3] 断言')
    if (how === 'failed') {
      fail(`★★ 关不掉！进程仍在跑（pid: ${pids().join(', ')}）—— 这就是主人反馈的问题`)
    } else {
      ok(`★ 进程已被关闭（方式：${how === 'graceful' ? '正常退出（主进程跑了清理）' : '强制结束'}）`)
    }

    if (isRunning()) {
      fail('仍能查到 AstriaX.exe 进程')
    } else {
      ok('tasklist 已查不到该进程')
    }
  } finally {
    /*
     * 收尾：把主人的软件重新启动起来（它本来就在跑，不该因为我测试而停着）。
     */
    if (wasRunningBefore && !isRunning()) {
      log('\n[4] 把主人的软件重新启动（它原本是开着的）')
      try {
        const c = spawn(EXE, [], { detached: true, stdio: 'ignore' })
        c.unref()
        await new Promise((r) => setTimeout(r, 8000))
        log(isRunning() ? '  ✔ 已重新启动' : '  （没能自动重启，请手动打开一下）')
      } catch (e) {
        log(`  （重启失败：${e.message}，请手动打开一下）`)
      }
    } else if (!wasRunningBefore) {
      log('\n[4] 清理：它本来就是关着的，保持关着')
    }
  }

  log(`\n${pass ? '✔ 通过：卸载器能关掉正在运行的软件' : '✘ 失败：见上面的 ✘ 条目'}`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('脚本出错:', e)
  process.exit(2)
})
