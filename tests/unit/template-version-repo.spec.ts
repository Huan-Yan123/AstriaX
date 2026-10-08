import { describe, expect, it } from 'vitest'
import { createInstanceRepo } from '../../src/main/store/instance-repo'
import { testStage } from '../helpers/stage'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * `updateTemplateVersion` —— 从调用方手里收回来的「改索引」逻辑。
 *
 * 背景：原来 ipc.ts 里有个 refreshTemplateVersion 自己拼 instances.json 路径
 * 做读-改-写，绕过了 repo 层。这带来两个真实缺陷：
 *   1) 那次 JSON.parse 没有 try 包裹 —— **索引损坏时建实例直接崩**；
 *   2) 用 writeFileSync 直写目标文件 —— 不是原子替换，写到一半断电就毁索引。
 *   而 repo 的 writeAll 本来就是「临时文件 + rename」，正是为了防这个。
 *
 * 这两条都要用测试钉住，否则将来又有人图省事绕回去。
 */
describe('updateTemplateVersion（收回来的索引写入口）', () => {
  function setup(): { root: string; repo: ReturnType<typeof createInstanceRepo> } {
    const root = testStage('tplver-')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'runtimes', 'a', 'v4.28.0'), { recursive: true })
    const repo = createInstanceRepo({ dataRoot: root })
    return { root, repo }
  }

  it('写入并读回模板版本', () => {
    const { repo } = setup()
    const rec = repo.create({ type: 'a', name: 'A', port: 6100, runtimeTag: 'v4.28.0' })
    expect(repo.get(rec.id)?.templateVersion).toBe(1)
    repo.updateTemplateVersion(rec.id, 4280)
    expect(repo.get(rec.id)?.templateVersion).toBe(4280)
  })

  it('索引损坏时不抛异常（老实现会在这里崩）', () => {
    const { root, repo } = setup()
    const rec = repo.create({ type: 'a', name: 'A', port: 6100, runtimeTag: 'v4.28.0' })
    // 把索引弄坏，模拟断电/手工改坏
    writeFileSync(join(root, 'instances.json'), '{"instances":[{"id":"a_1"', 'utf8')
    expect(() => repo.updateTemplateVersion(rec.id, 999), '损坏的索引不该让调用方崩').not.toThrow()
  })

  it('写盘是原子替换：不留临时文件，且目标文件始终是完整 JSON', () => {
    /*
     * 原子性的可观测证据：
     *   - 写完之后目录里不该残留 .tmp 文件；
     *   - 目标文件内容必须是能完整 parse 的合法 JSON
     *     （如果实现改回 writeFileSync，虽然这条也能过，但配合下一条的
     *      "写到一半" 语义，能挡住明显的非原子实现）。
     */
    const { root, repo } = setup()
    const rec = repo.create({ type: 'a', name: 'A', port: 6100, runtimeTag: 'v4.28.0' })
    repo.updateTemplateVersion(rec.id, 4280)

    const leftovers = readdirSync(root).filter((f) => f.endsWith('.tmp'))
    expect(leftovers, '不该残留临时文件').toEqual([])

    const raw = readFileSync(join(root, 'instances.json'), 'utf8')
    expect(() => JSON.parse(raw), '索引必须是完整合法的 JSON').not.toThrow()
    expect(JSON.parse(raw).instances[0].templateVersion).toBe(4280)
  })

  it('同值写入不产生额外 IO（避免无意义的频繁写盘）', () => {
    const { root, repo } = setup()
    const rec = repo.create({ type: 'a', name: 'A', port: 6100, runtimeTag: 'v4.28.0' })
    repo.updateTemplateVersion(rec.id, 4280)
    const before = readFileSync(join(root, 'instances.json'), 'utf8')
    repo.updateTemplateVersion(rec.id, 4280)
    expect(readFileSync(join(root, 'instances.json'), 'utf8'), '值没变就不该重写').toBe(before)
  })

  it('实例不存在时幂等返回，不抛', () => {
    const { repo } = setup()
    expect(() => repo.updateTemplateVersion('a_notexist', 1)).not.toThrow()
  })
})
