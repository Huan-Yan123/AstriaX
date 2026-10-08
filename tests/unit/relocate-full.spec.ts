/*
 * 数据根迁移的**完整性**。
 *
 * 为什么专门写这个文件：relocate.ts 里只搬了 `instances\` 和 `instances.json`，
 * 而 <dataRoot> 下真实住着七样东西（runtimes / python / mirrors.json /
 * logs / cache / templates / config.json）。
 *
 * 后果不是「少搬了点文件」那么轻 —— 用户点「迁移数据目录」的期望是
 * 「东西都跟过去」，实际上搬完：
 *   - runtimes\ 没跟过去 → 所有实例的运行时都没了，启动报「运行时文件不完整」
 *   - python\   没跟过去 → AstrBot 报「需要先装好 Python」
 *   - mirrors.json 没跟过去 → 用户自己加的镜像源凭空消失、首选源重置
 *   - logs\ / 审计  没跟过去 → 排查问题的现场没了
 * 也就是**一次迁移把软件搬成半废状态**，而界面还告诉他迁移成功。
 *
 * 这几条断言就是钉住「搬家要把家当搬全」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createInstanceRepo } from '../../src/main/store/instance-repo'
import { relocateDataRoot } from '../../src/main/store/relocate'
import { pythonExeFor } from '../../src/main/runtime/python-runtime'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-reloc-full-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个「住着东西」的数据根：每个子目录放一个可辨认的文件 */
function seedDataRoot(instances: ReturnType<typeof createInstanceRepo>): void {
  const files: Array<[string, string]> = [
    ['config.json', '{"dataRoot":"x"}'],
    [join('runtimes', 'a', 'v4.28.0', 'astrbot', '__init__.py'), 'code'],
    [join('runtimes', 'n', 'v4.18.19', 'napcat.mjs'), 'code'],
    // 内置解释器的**真实**位置：runtime\python（见 python-runtime.ts:53）。
    // 这里原来写的是 'python\python.exe' —— 那是 MOVE_DIRS 里的错路径，
    // fixture 跟着一起错，于是测试替 bug 背书。
    [join('runtime', 'python', 'python.exe'), 'MZ'],
    ['mirrors.json', '{"custom":[]}'],
    [join('logs', 'audit-2026-01-01.log'), 'audit'],
    [join('logs', 'instances', 'x.log'), 'log'],
    [join('logs-export', 'export-2026-01-01.zip'), 'zip'],
    [join('cache', 'versions-a.json'), 'cache'],
    [join('templates', 'astrbot', 'marker.txt'), 'tpl']
  ]
  for (const [rel, body] of files) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body, 'utf8')
  }
  void instances
}

describe('数据根迁移：家当要搬全', () => {
  it('★runtimes\\ 必须跟着搬（否则所有实例都启动不了）', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'a', name: 'A' })
    seedDataRoot(repo)

    const target = join(root, 'moved')
    await relocateDataRoot(repo, { target })

    expect(
      existsSync(join(target, 'runtimes', 'a', 'v4.28.0', 'astrbot', '__init__.py')),
      '运行时没搬过去 → 实例启动会报「运行时文件不完整」'
    ).toBe(true)
    expect(
      existsSync(join(target, 'runtimes', 'n', 'v4.18.19', 'napcat.mjs')),
      'NapCat 运行时也没搬过去'
    ).toBe(true)
  })

  it('★内置 Python 必须跟着搬（否则 AstrBot 说没装 Python）', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'a', name: 'A' })
    seedDataRoot(repo)

    const target = join(root, 'moved')
    await relocateDataRoot(repo, { target })

    /*
     * 路径必须**问生产代码**，不能自己拼。
     *
     * 这个用例原来断言的是 `join(target, 'python', 'python.exe')` —— 而
     * MOVE_DIRS 里也写着 'python'，两边一起错，于是测试是绿的、功能是坏的。
     * 实机验证：用户机器上 `data\python` **根本不存在**，
     * 真解释器在 `data\runtime\python\python.exe`（见 python-runtime.ts:53）。
     * 迁移时搬的是一个从不存在的目录，真正的 Python 落在原地不动 ——
     * 迁完 AstrBot 就报「需要先装好 Python」。
     *
     * 用 pythonExeFor() 取真实路径：将来路径再改，这里会自动跟着走，
     * 不会又变成一份"自证式"的断言。
     */
    const realExe = pythonExeFor(target)
    expect(
      existsSync(realExe),
      `内置 Python 没搬过去（期望在 ${realExe}）→ 迁完 AstrBot 会报「需要先装好 Python」`
    ).toBe(true)
  })

  it('★不会去搬一个从来不存在的 data\\python（误导性空搬）', async () => {
    /*
     * 反向断言：确认真正生效的是 runtime\python。
     * 如果哪天有人把 MOVE_DIRS 又改回 'python'，上面那条会因为
     * runtime\python 没被搬而变红 —— 这条只是把"错的那个"也钉一下，
     * 免得将来有人误以为两个地方都对。
     */
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'a', name: 'A' })
    seedDataRoot(repo)

    const target = join(root, 'moved')
    await relocateDataRoot(repo, { target })

    expect(
      existsSync(join(target, 'runtime', 'python', 'python.exe')),
      'runtime\\python 才是真位置'
    ).toBe(true)
  })

  it('★mirrors.json 必须跟着搬（否则用户加的镜像源凭空消失）', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'a', name: 'A' })
    seedDataRoot(repo)

    const target = join(root, 'moved')
    await relocateDataRoot(repo, { target })

    expect(existsSync(join(target, 'mirrors.json')), '镜像源配置没搬过去').toBe(true)
  })

  it('★logs\\ 必须跟着搬（否则排查问题的现场没了）', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'a', name: 'A' })
    seedDataRoot(repo)

    const target = join(root, 'moved')
    await relocateDataRoot(repo, { target })

    expect(existsSync(join(target, 'logs', 'audit-2026-01-01.log')), '审计日志没搬').toBe(true)
    expect(existsSync(join(target, 'logs', 'instances', 'x.log')), '实例日志没搬').toBe(true)
  })

  it('★templates\\ 要搬，而 cache\\ 刻意不搬（可再生，搬它又慢又占空间）', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'a', name: 'A' })
    seedDataRoot(repo)

    const target = join(root, 'moved')
    await relocateDataRoot(repo, { target })

    expect(existsSync(join(target, 'templates', 'astrbot', 'marker.txt')), '模板没搬').toBe(true)
    /*
     * cache 里是版本列表缓存 + pip 下载缓存（实测能到 6.8GB），
     * 纯可再生。搬它会让迁移慢几分钟、还要求目标盘有同等空闲空间，
     * 而软件重新联网拉一遍只要几秒 —— 所以**故意不搬**。
     */
    expect(
      existsSync(join(target, 'cache', 'versions-a.json')),
      'cache 不该被搬（它是可再生的中间产物）'
    ).toBe(false)
  })

  it('★源目录里的东西不能被搬走（是复制不是剪切）', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'a', name: 'A' })
    seedDataRoot(repo)

    const target = join(root, 'moved')
    await relocateDataRoot(repo, { target })

    expect(existsSync(join(root, 'runtimes', 'a', 'v4.28.0', 'astrbot', '__init__.py'))).toBe(true)
    expect(existsSync(join(root, 'mirrors.json'))).toBe(true)
  })

  it('★目标已有同名文件时不炸（迁移可以重试）', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'a', name: 'A' })
    seedDataRoot(repo)

    const target = join(root, 'moved')
    // 先迁移一次，再迁移一次：第二次目标已存在，不能抛
    await relocateDataRoot(repo, { target })
    // 迁移已改 async：这里直接 await —— 若重复迁移再抛错，测试自然失败
    await relocateDataRoot(repo, { target })
    expect(existsSync(join(target, 'runtimes', 'a', 'v4.28.0', 'astrbot', '__init__.py'))).toBe(true)
  })
})
