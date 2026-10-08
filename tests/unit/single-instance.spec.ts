/*
 * 单实例锁的启动顺序。
 *
 * 用户报告：「为什么可以同时启动一堆 MX 机器人启动器」——
 * 原来完全没有单实例锁。加锁本身很简单，但**和提权自重启撞在一起**
 * 有个非常隐蔽的陷阱，差点把软件改成完全打不开，所以用测试钉死。
 *
 * 陷阱是这样的：
 *   提权流程 = 普通权限进程用 runas 拉起管理员副本，然后自己退出。
 *   两个进程的 verdict 分别是：
 *     原进程：     'relaunched'（它负责拉起，然后退出）
 *     管理员副本： 'already'   （它本身就是管理员）
 *
 *   如果按 verdict 判断「谁跳过抢锁」，会正好搞反：
 *   让马上要退出的原进程跳过（它反正要退），让真正要活下来的副本去抢 ——
 *   而副本启动时原进程还没退干净、锁还在它手上，副本抢不到就自杀，
 *   原进程也退了。**软件完全起不来，双击图标毫无反应。**
 *
 * 所以正确的判定是「我是不是被提权拉起来的那一个」（argv 里有没有标记），
 * 而不是 verdict。下面第一条就是守住这一点。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { alreadyRelaunched, argsForRelaunch } from '../../src/main/elevate'

const SRC = readFileSync('src/main/index.ts', 'utf8')

describe('单实例锁（防止同时开一堆启动器）', () => {
  it('确实申请了单实例锁', () => {
    // 必须**真的调用**，不是只定义了函数（定义了不调等于没加锁）
    expect(SRC, '没有 requestSingleInstanceLock 就能同时开无数个').toContain(
      'requestSingleInstanceLock'
    )
    expect(
      /const\s+gotTheLock\s*=\s*acquireLockWithRetry\(\)/.test(SRC),
      '必须真的调用抢锁函数并把结果用于判定，不能写死成 true'
    ).toBe(true)
    // 抢锁函数内部必须真的调用 Electron API（而不是自己返回 true）
    const i = SRC.indexOf('function acquireLockWithRetry')
    const body = SRC.slice(i, i + 900)
    expect(
      /app\.requestSingleInstanceLock\(\)/.test(body),
      '抢锁函数里必须真的调 Electron 的 requestSingleInstanceLock'
    ).toBe(true)
  })

  it('拿不到锁就退出（否则第二个实例还是会把界面开出来）', () => {
    // 找 gotTheLock 之后那段，必须有 app.exit / app.quit
    const i = SRC.indexOf('const gotTheLock')
    expect(i, '应当有 gotTheLock 判定').toBeGreaterThan(0)
    const after = SRC.slice(i, i + 900)
    expect(
      /app\.(exit|quit)\(/.test(after),
      '拿不到锁必须退出进程，不能继续建窗口'
    ).toBe(true)
  })

  it('★按「是否被提权拉起」判断跳过抢锁，而不是按 verdict', () => {
    /*
     * 这是整个改动里最容易写错的一处。
     * 提权副本的 verdict 是 'already'，原进程才是 'relaunched'。
     * 用 verdict 判断会正好搞反，导致软件完全起不来。
     */
    expect(
      SRC.includes('alreadyRelaunched(process.argv)'),
      '必须用 argv 标记判断「我是被提权拉起的那一个」'
    ).toBe(true)

    // 反面：不许出现「按 verdict === 'relaunched' 决定跳过抢锁」这种写法
    expect(
      /const\s+isElevateRelaunch\s*=\s*elevateVerdict\s*===\s*'relaunched'/.test(SRC),
      "这是错的：管理员副本的 verdict 是 'already'，不是 'relaunched'"
    ).toBe(false)
  })

  it('被提权拉起的副本会等原进程释放锁（否则自己先死）', () => {
    /*
     * 原进程退出要几十到几百毫秒，而副本几乎立刻就来抢锁。
     * 必须有重试等待，否则副本抢不到 → app.exit(0) → 软件起不来。
     */
    const i = SRC.indexOf('function acquireLockWithRetry')
    expect(i, '应当有带重试的抢锁函数').toBeGreaterThan(0)
    const body = SRC.slice(i, i + 900)
    expect(/deadline|Date\.now\(\)/.test(body), '要有超时窗口').toBe(true)
    expect(/for\s*\(/.test(body), '要有重试循环').toBe(true)
  })

  it('第二个实例会把已有窗口叫到前面（用户双击时才是「有反应」）', () => {
    /*
     * 注意锚点要带 `, () =>`：文件里注释也提到过 `app.on('second-instance')`，
     * 只按事件名 indexOf 会命中注释、切到一段没有代码的片段，测试假红。
     */
    const anchor = "app.on('second-instance', () =>"
    expect(SRC).toContain(anchor)
    const i = SRC.indexOf(anchor)
    const body = SRC.slice(i, i + 600)
    expect(/\.show\(\)/.test(body), '窗口藏在托盘时要 show 出来').toBe(true)
    expect(/\.focus\(\)/.test(body), '要把窗口聚焦到最前').toBe(true)
    expect(/isMinimized|restore/.test(body), '最小化时要 restore').toBe(true)
  })
})

describe('提权标记本身（alreadyRelaunched）', () => {
  it('带标记的 argv 判定为「已被提权拉起」', () => {
    // 用真实的 argsForRelaunch 生成，保证和生产路径一致
    const argv = argsForRelaunch(['--some-arg'])
    expect(alreadyRelaunched(argv)).toBe(true)
  })

  it('不带标记的普通启动判定为「不是提权副本」', () => {
    expect(alreadyRelaunched(['--some-arg'])).toBe(false)
    expect(alreadyRelaunched([])).toBe(false)
  })

  it('重复 relaunch 不会堆叠标记（否则会无限重启）', () => {
    const once = argsForRelaunch([])
    const twice = argsForRelaunch(once)
    expect(twice.filter((a) => once.includes(a)).length).toBe(once.length)
  })
})
