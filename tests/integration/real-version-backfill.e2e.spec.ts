import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHandlers, defaultCommandFor } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'

/**
 * 真机验证：**老实例启动后能不能补上版本号**。
 *
 * 这是「卡片会显示当前实例版本，软件或者实例启动的时候会读一次并更新」
 * 这句话里最有价值的部分 —— 用户升级软件后，他那些**已经存在的实例**
 * 卡片上原本是「版本未知」，启动一次就该显示出真实版本。
 *
 * 用 NapCat 验（启动快、不依赖内置 Python），且挑一个 runtimeVersion 为空的实例，
 * 这样才测得到"从无到有"。
 */
const REAL_DATA = join(process.cwd(), 'data')
const NAPCAT_RT = join(REAL_DATA, 'runtimes', 'n', 'v4.18.19')
const QQ = 'E:\\QQ\\QQ.exe'

const ready = existsSync(join(NAPCAT_RT, 'napcat.mjs')) && existsSync(QQ)

describe.skipIf(!ready)('真机：老实例启动后补上版本号', () => {
  let pm: ReturnType<typeof createProcessManager>
  let id = ''

  beforeEach(() => {
    pm = createProcessManager()
  })

  afterEach(() => {
    /*
     * ★ 这里原来写的是 `taskkill /IM QQ.exe /F` —— 已删掉。
     *
     * 那是**按进程名扫描系统**，会把用户机器上**所有** QQ 进程全部杀掉：
     * 他自己登着的号、别的软件依赖的 QQ、甚至另一个项目在跑的 QQ。
     *
     * 而项目设计文档白纸黑字立过规矩
     * （docs/.../2026-09-12-napcat-astrbot-launcher-design.md:121）：
     *   「清理是白名单式 —— 只杀管理器自己 spawn 并持有 pid 的进程树，
     *     绝不按进程名扫描系统（用户另跑的 napcat/astrbot/QQ 一概不碰）」
     *
     * 测试代码也是代码：这条 e2e 一旦被真跑（它对 data/ 和 E:\QQ 有前置
     * 条件，在开发机上就是满足的），就会真杀用户的 QQ。
     * 「只是测试」不能成为违反这条规矩的理由。
     *
     * 正确做法：只收我们自己**持有 pid** 的那棵树（下面那句）。NapCat
     * 是注入进 QQ 跑的，QQ 会脱离父子链，所以单纯 /T 可能带不走 ——
     * 但那属于"我们没能回收干净"，不该用"杀光所有 QQ"来掩盖。
     * 真要兜底，应该按**端口**定位（stopInstanceHard 已经有这套：
     * waitPortGone → findListenerPid → 按 PID 补杀），而不是按名字。
     */
    if (id) {
      try {
        pm.killTreeSync(id)
      } catch {
        /* 已经没了 */
      }
    }
  })

  it('NapCat 实例：启动后 runtimeVersion 从空变成真实版本', async () => {
    const h = buildHandlers({
      probe: async () => true,
      processManager: pm,
      commandFor: defaultCommandFor
    })
    await h['config:set']({ dataRoot: REAL_DATA })

    const list = (await h['instance:list']()) as Array<{
      id: string
      type: string
      port: number
      dir: string
      status: string
      runtimeVersion?: string
    }>

    // 挑一个目录完整、且版本还是空的 NapCat 实例 —— 才能验证"补上"
    const cand = list.find(
      (x) => x.type === 'n' && existsSync(join(x.dir, 'instance.json')) && !x.runtimeVersion
    )
    if (!cand) {
      console.log('没有"版本为空"的 NapCat 实例可验，跳过（这是正常情况）')
      return
    }
    id = cand.id
    console.log('验证对象:', id, '端口', cand.port, '启动前版本:', cand.runtimeVersion ?? '(空)')

    await h['instance:start'](id)

    const after = (await h['instance:list']()) as Array<{
      id: string
      status: string
      runtimeVersion?: string
    }>
    const me = after.find((x) => x.id === id)
    console.log('启动后状态:', me?.status, '版本:', me?.runtimeVersion ?? '(空)')

    expect(me?.status).toBe('running')
    // 关键：从无到有
    expect(me?.runtimeVersion, '老实例启动后应被补上真实版本号').toBeTruthy()
    expect(me?.runtimeVersion).toMatch(/^\d+\.\d+\.\d+/)
    // NapCat 的版本是 4.18.x
    expect(me?.runtimeVersion).toMatch(/^4\./)
  }, 180000)
})
