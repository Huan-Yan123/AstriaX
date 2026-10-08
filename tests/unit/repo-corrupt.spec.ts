import { describe, expect, it } from 'vitest'
import { createInstanceRepo } from '../../src/main/store/instance-repo'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * `instances.json` 损坏时能不能扛住 —— 这是实例索引的**唯一真相来源**。
 *
 * 为什么要专门测：这个文件是 `JSON.parse` 直读的，而它可能被各种现实情况弄坏 ——
 * 写入过程中断电、磁盘写满、用户手工编辑、杀软隔离、同步盘回滚。
 * 一旦 parse 抛异常，`instance:list` 就整个挂掉，界面上**一个实例都看不到**，
 * 用户会以为实例全丢了 —— 这比"少一个实例"严重得多。
 *
 * 期望行为：**坏文件降级成空列表，而不是让整条链路崩掉**，
 * 同时不能顺手把坏文件覆盖掉（那是用户唯一的现场证据）。
 */
describe('instances.json 损坏时的降级', () => {
  function seed(content: string): string {
    const root = testStage('repo-corrupt-')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'instances.json'), content, 'utf8')
    return root
  }

  const cases: Array<[string, string]> = [
    ['被截断的 JSON', '{"instances":[{"id":"a_1"'],
    ['空文件', ''],
    ['内容是数组不是对象', '[1,2,3]'],
    ['instances 是 null', '{"instances":null}'],
    ['整个对象是 null', 'null'],
    ['完全不是 JSON', 'this is not json at all'],
    ['只有空白字符', '   \n  ']
  ]

  for (const [name, content] of cases) {
    it(`${name} → list() 返回空数组而不是抛异常`, () => {
      const root = seed(content)
      const repo = createInstanceRepo({ dataRoot: root })
      expect(() => repo.list(), `${name} 不该让 list 抛异常`).not.toThrow()
      expect(repo.list()).toEqual([])
    })
  }

  /*
   * 「保留用户现场」的正确含义 —— 这条测试原来断言错了东西
   * ========================================================================
   *
   * 原来写的是：
   *     repo.list()                                   // 只读一次
   *     expect(readFileSync(root/instances.json)).toBe(content)   // 原文件没变
   *
   * 意思是"**读**不该改写文件"。这个要求在**只读**时是对的，但它
   * 把"保留现场"误解成了"原文件名、原位置不能动"，于是**挡住了真正的修复**：
   *
   * 原实现确实做到了"读不改写"，可下一次 `create()` 就会
   * `writeFileSync(tmp) + renameSync(tmp, file)` —— 原子替换，
   * **把坏文件彻底盖掉**。也就是说"读的时候没覆盖"根本保证不了什么：
   * 用户点一次「新建实例」，那份唯一证据就没了
   * （详见 instance-repo.ts 里 quarantineCorrupt 的注释）。
   *
   * 现在改成断言**真正的意图**：坏内容被完整留证、可读、不复存在被覆盖的风险。
   * 留证方式是改名成 `instances.json.corrupt-<时间戳>` ——
   * 位置和文件名变了，但"用户还能把数据救回来"这件事更强了：
   *   - 内容完整（下面断言能读到原文）
   *   - 后续写入（create）不会碰它
   */
  it('损坏文件被完整留证（内容可读，且后续写入覆盖不到它）', () => {
    const content = '{"instances":[{"id":"a_1"'
    const root = seed(content)
    const repo = createInstanceRepo({ dataRoot: root })
    repo.list()

    const files = readdirSync(root)
    const saved = files.filter((f) => f.startsWith('instances.json.corrupt-'))
    expect(saved, '坏文件必须被留证（改名），否则下次写盘就永久盖掉了').toHaveLength(1)

    // 留证的内容必须和原文**一字不差** —— 这才是"保留现场"
    const { readFileSync } = require('fs') as typeof import('fs')
    expect(readFileSync(join(root, saved[0]), 'utf8')).toBe(content)

    /*
     * 再确认一层：触发一次写入之后，留证文件仍在。
     * 这是原测试真正想防的事（"别把用户现场弄丢"），
     * 只是原来用"原文件不变"表达，反而写不死这个性质。
     */
    repo.create({ type: 'n', name: '新实例' })
    expect(readdirSync(root).filter((f) => f.startsWith('instances.json.corrupt-'))).toHaveLength(1)
    expect(readFileSync(join(root, saved[0]), 'utf8')).toBe(content)
  })

  it('正常文件照常工作（别把好文件也当成坏的处理了）', () => {
    const root = testStage('repo-ok-')
    mkdirSync(root, { recursive: true })
    const repo = createInstanceRepo({ dataRoot: root })
    // 造一个实例再读回来
    mkdirSync(join(root, 'runtimes', 'a', 'v4.28.0'), { recursive: true })
    const rec = repo.create({ type: 'a', name: '正常实例', port: 6100, runtimeTag: 'v4.28.0' })
    expect(repo.list()).toHaveLength(1)
    expect(repo.get(rec.id)?.name).toBe('正常实例')
  })
})
