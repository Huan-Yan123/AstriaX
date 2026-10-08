import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectInstanceVersion } from '../../src/main/runtime/instance-version'
import { testStage } from '../helpers/stage'

/**
 * 实例版本：卡片上要显示的那个「这个实例现在跑的是哪个版本」。
 *
 * 用户的原话是「卡片会显示当前实例版本，软件或者实例启动的时候会读一次并更新」。
 * 所以它是一个**缓存的、会被刷新的**值，而不是每次渲染都去翻磁盘。
 *
 * 读的顺序（重要的取舍）：
 *   1. 运行时包自己带的版本（最权威 —— 用户手动换过包时只有它是对的）
 *   2. 我们创建的标记 instance.json 里的 runtimeTag（自己下载的，通常对）
 *   3. 目录名 vX.Y.Z（最后的兜底）
 * 三层都拿不到就返回 undefined，界面显示「未知」而不是编一个。
 */
describe('实例版本识别', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('mxbot-insver-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('优先用运行时包自己带的版本（用户换过包时只有它准）', () => {
    // 目录名写 v4.18.19，但包里其实是 4.20.1 —— 必须以包内为准
    const inst = join(root, 'n_1')
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    mkdirSync(inst, { recursive: true })
    mkdirSync(rt, { recursive: true })
    writeFileSync(join(rt, 'napcat.mjs'), 'const a = {}, Vu = typeof a < "u" && "4.20.1" || "1.0.0-dev";\n', 'utf8')
    writeFileSync(join(inst, 'instance.json'), JSON.stringify({ runtimeTag: 'v4.18.19' }), 'utf8')

    expect(
      detectInstanceVersion({ type: 'n', instanceDir: inst, runtimeDir: rt })
    ).toBe('4.20.1')
  })

  it('包内读不到时退回 instance.json 的 runtimeTag', () => {
    const inst = join(root, 'n_2')
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    mkdirSync(inst, { recursive: true })
    mkdirSync(rt, { recursive: true })
    writeFileSync(join(rt, 'napcat.mjs'), 'no version', 'utf8')
    writeFileSync(join(inst, 'instance.json'), JSON.stringify({ runtimeTag: 'v4.18.19' }), 'utf8')

    expect(detectInstanceVersion({ type: 'n', instanceDir: inst, runtimeDir: rt })).toBe('4.18.19')
  })

  it('前面都读不到时退回运行时目录名', () => {
    const inst = join(root, 'a_3')
    const rt = join(root, 'runtimes', 'a', 'v4.28.0')
    mkdirSync(inst, { recursive: true })
    mkdirSync(rt, { recursive: true })
    expect(detectInstanceVersion({ type: 'a', instanceDir: inst, runtimeDir: rt })).toBe('4.28.0')
  })

  it('AstrBot 从 dist-info 读（真实 wheel 里就是这个形态）', () => {
    const inst = join(root, 'a_4')
    const rt = join(root, 'runtimes', 'a', 'v9.9.9')
    mkdirSync(join(rt, 'astrbot-4.28.0.dist-info'), { recursive: true })
    mkdirSync(inst, { recursive: true })
    writeFileSync(
      join(rt, 'astrbot-4.28.0.dist-info', 'METADATA'),
      'Name: AstrBot\nVersion: 4.28.0\n',
      'utf8'
    )
    expect(detectInstanceVersion({ type: 'a', instanceDir: inst, runtimeDir: rt })).toBe('4.28.0')
  })

  it('三层都拿不到返回 undefined —— 不编假的', () => {
    const inst = join(root, 'a_5')
    const rt = join(root, 'runtimes', 'a', 'weird-name')
    mkdirSync(inst, { recursive: true })
    mkdirSync(rt, { recursive: true })
    expect(detectInstanceVersion({ type: 'a', instanceDir: inst, runtimeDir: rt })).toBeUndefined()
  })

  it('runtimeDir 不存在也不炸', () => {
    const inst = join(root, 'a_6')
    mkdirSync(inst, { recursive: true })
    expect(
      detectInstanceVersion({ type: 'a', instanceDir: inst, runtimeDir: join(root, 'nope') })
    ).toBeUndefined()
  })
})
