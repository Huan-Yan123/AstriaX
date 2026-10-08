import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHandlers, defaultCommandFor } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'

/**
 * 真机验证：**启动一个真 AstrBot 实例**，走完整的启动流程。
 *
 * 用真实的 data 目录（不是临时目录）、真实的运行时、真实的内置 Python，
 * 把「点启动按钮」背后会发生的事情完整跑一遍。
 *
 * 这个测试回答的是用户的原话：
 *   「实例需要验证是否真的进入启动流程」
 * 也就是：跑完之后，实例是不是真的起来了（进程活 + 端口通 + 版本被读到）。
 *
 * 注意：它比较慢（AstrBot 首启要初始化数据库，约 12 秒），
 * 而且需要本机已经装好 Python + AstrBot。没装就自动跳过。
 */
const REAL_DATA = join(process.cwd(), 'data')
const REAL_PY = join(REAL_DATA, 'runtime', 'python', 'python.exe')
const REAL_RT = join(REAL_DATA, 'runtimes', 'a', 'v4.28.0')

const ready =
  existsSync(REAL_PY) && existsSync(join(REAL_RT, 'astrbot', '__init__.py'))

describe.skipIf(!ready)('真机：启动真 AstrBot 实例', () => {
  let pm: ReturnType<typeof createProcessManager>
  let id = ''

  beforeEach(() => {
    pm = createProcessManager()
  })

  afterEach(() => {
    // 无论成败都要把进程收干净，别留后台
    if (id) {
      try {
        pm.killTreeSync(id)
      } catch {
        /* 已经没了 */
      }
    }
  })

  it('启动 → 进程活 + 端口通 + 版本写进 instance.json', async () => {
    // 用**生产同一条**命令生成路径，才能测到入口/环境变量这些真会出问题的地方
    const h = buildHandlers({
      probe: async () => true,
      processManager: pm,
      commandFor: defaultCommandFor
    })
    await h['config:set']({ dataRoot: REAL_DATA })

    // 挑一个**目录完整**的 AstrBot 实例（本地有几个遗留实例目录不完整，
    // instance.json 都没有，拿它们测不出东西）
    const list = (await h['instance:list']()) as Array<{
      id: string
      type: string
      port: number
      dir: string
      status: string
    }>
    const usable = list.filter((x) => x.type === 'a' && existsSync(join(x.dir, 'instance.json')))
    expect(
      usable.length,
      `本地没有目录完整的 AstrBot 实例（共 ${list.filter((x) => x.type === 'a').length} 个 AstrBot 实例，`
        + `其中 ${list.filter((x) => x.type === 'a').length - usable.length} 个缺 instance.json）`
    ).toBeGreaterThan(0)
    const target = usable[0]
    id = target.id

    // 记录启动前的版本（老实例可能是空的）
    const before = (list.find((x) => x.id === id) ?? {}) as { runtimeVersion?: string }

    await h['instance:start'](id)

    // 1) 状态真的变成 running（进程活 + 端口通才算）
    const after = (await h['instance:list']()) as Array<{
      id: string
      status: string
      runtimeVersion?: string
    }>
    const me = after.find((x) => x.id === id)
    expect(me?.status, '启动后状态应为 running（进程活 + 端口通才算）').toBe('running')

    /*
     * 2) 版本被读出来并落库 —— 这就是「启动时读一次并更新」。
     *
     * 注意数据位置：版本存在**中央 instances.json**（由 instance-repo 管理），
     * 不是实例目录里的 instance.json。后者是创建时写的一次性快照（记 runtimeTag），
     * 前端卡片读的是 instance:list，也就是中央那份。
     * （我一开始断言错了地方，误以为功能没生效 —— 其实这里早就写对了。）
     */
    console.log('runtimeVersion 启动前:', before.runtimeVersion ?? '(空)', '→ 启动后:', me?.runtimeVersion)
    expect(me?.runtimeVersion, '启动后应能读到真实版本号（从运行时包里读的，不是目录名）').toBeTruthy()
    expect(me?.runtimeVersion).toMatch(/^\d+\.\d+\.\d+/)

    // 3) 实例目录里应该出现了 AstrBot 自己的数据（证明它真的跑起来了）
    expect(existsSync(join(target.dir, 'data')), 'AstrBot 应已建出 data 目录').toBe(true)

    // 4) 日志文件里应有 AstrBot 的真实输出
    const logFile = join(REAL_DATA, 'logs', 'instances', `${id}.log`)
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    console.log('实例日志长度:', log.length)
    expect(log.length, '实例日志不该是空的（说明进程真的在输出）').toBeGreaterThan(0)
  }, 120000)
})
