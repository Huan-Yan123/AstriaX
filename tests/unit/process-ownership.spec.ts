import { execFileSync, spawnSync } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createProcessManager, type ProcessManager } from '../../src/main/proc/process-manager'

/**
 * 真机验证（起真实进程，不是 mock）：实例进程必须是**我们的直接子进程**，
 * 而且我们得能杀掉它。
 *
 * 为什么这两点值得测：用户的原始抱怨是
 *   「napcat 进程死了软件还显示运行中」+「点停止停不掉」
 * 根因就在旧启动路径：
 *   node spawn → cmd.exe /c launcher-win10.bat
 *              → bat 里 `net session` 自检失败 → runas 重开自己（提权）
 *              → 被 runas 拉起的是**另一个进程**，不是我们的子进程
 * 我们的句柄 / stdout / taskkill /T 的进程树全指向那个已经退出的 cmd，
 * 真正的 NapCat 在别处跑，我们既看不到状态也杀不掉。
 *
 * 新路径（直接 spawn NapCatWinBootMain.exe，不 detached）修掉了这一点。
 *
 * 测试用 cmd.exe 当替身：它同样是 CUI 程序（PE Subsystem = 3），
 * 能代表 NapCatWinBootMain.exe 那类"会自己开控制台"的进程，
 * 而且无害、到处都有，不用真的去注入 QQ。
 *
 * 另外验证 detached 的取值：Windows 上必须关掉它 ——
 * MSDN 说 CREATE_NO_WINDOW 与 DETACHED_PROCESS 同用会被忽略，
 * 而 Node 的 detached:true 在 Windows 上正是 DETACHED_PROCESS，
 * 于是 windowsHide 失效、孙子进程会拿到一个新建的可见控制台（= 黑框）。
 */
describe('实例进程的归属与可控性（真机起进程）', () => {
  const pm: ProcessManager = createProcessManager()
  const ids: string[] = []

  afterEach(() => {
    for (const id of ids) {
      try {
        pm.killTreeSync(id)
      } catch {
        /* 已经没了 */
      }
    }
    ids.length = 0
  })

  /** 起一个活 20 秒的 CUI 进程（cmd 里跑 ping） */
  async function startLongLived(id: string): Promise<number> {
    ids.push(id)
    const h = await pm.start({
      id,
      cmd: 'cmd.exe',
      args: ['/c', 'ping -n 21 127.0.0.1 >nul'],
      port: 0
    })
    const pid = h.pid()
    expect(pid).toBeTypeOf('number')
    return pid as number
  }

  it('不 detached 时，进程是我们的直接子进程（能查到父子关系）', async () => {
    const pid = await startLongLived('own-1')
    const parent = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -EA SilentlyContinue).ParentProcessId`
      ],
      { encoding: 'utf8', windowsHide: true }
    ).trim()
    // 父进程就是跑测试的这个 node 进程 —— 说明我们真正拥有它
    expect(parent).toBe(String(process.pid))
  }, 30000)

  it('killTreeSync 能真的杀掉它（这就是「停止」按钮的本质）', async () => {
    const pid = await startLongLived('own-2')
    pm.killTreeSync('own-2')
    // 给内核一点回收时间
    await new Promise((r) => setTimeout(r, 1500))
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true
    }).stdout
    expect(out).not.toContain(String(pid))
  }, 30000)

  it('Windows 上默认不 detached，让 windowsHide 生效（否则会冒黑框）', async () => {
    // 源码级断言：默认值必须是「非 Windows 才 detached」。
    // 这不是风格问题 —— detached:true 会让 windowsHide 被 Windows 忽略，
    // 于是 CUI 子进程（NapCatWinBootMain.exe）会弹出一个可见控制台窗口。
    const src = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-Content -Raw '${process.cwd().replace(/'/g, "''")}\\src\\main\\proc\\process-manager.ts'`
      ],
      { encoding: 'utf8', windowsHide: true }
    )
    expect(src).toContain("process.platform !== 'win32'")
  }, 30000)
})
