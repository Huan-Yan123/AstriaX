import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createInstanceRepo } from '../../src/main/store/instance-repo'
import { relocateDataRoot } from '../../src/main/store/relocate'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-reloc-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const stubProbe = () => Promise.resolve(true)

describe('数据根迁移 relocateDataRoot', () => {
  it('复制实例目录到新根、更新记录 dir、旧根保留', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    const rec = repo.create({ type: 'a', name: '要搬的' })
    mkdirSync(join(rec.dir, 'data'), { recursive: true })
    writeFileSync(join(rec.dir, 'data', 'db.sqlite'), 'payload', 'utf8')

    const target = join(root, 'moved-root')
    await relocateDataRoot(repo, { target })

    // 新根有实例数据（按类型分流到 instances\AstrBot\）
    expect(existsSync(join(target, 'instances', 'AstrBot', rec.id, 'data', 'db.sqlite'))).toBe(true)
    // 新根有仓库索引
    const disk = JSON.parse(readFileSync(join(target, 'instances.json'), 'utf8'))
    expect(disk.instances.map((x: { id: string }) => x.id)).toContain(rec.id)
    // 记录 dir 已更新
    expect(repo.get(rec.id)!.dir).toBe(join(target, 'instances', 'AstrBot', rec.id))
    // 旧目录保留（copy 而非 move）
    expect(existsSync(join(root, 'instances', 'AstrBot', rec.id, 'data', 'db.sqlite'))).toBe(true)
  })

  it('新根的仓库可直接重建并读回数据', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    const rec = repo.create({ type: 'n', name: '持久' })
    const target = join(root, 'reloc2')
    await relocateDataRoot(repo, { target })
    const repo2 = createInstanceRepo({ dataRoot: target })
    expect(repo2.get(rec.id)!.name).toBe('持久')
  })

  it('★runtimes.json 也要搬过去（它不在任何被搬目录里）', async () => {
    /*
     * ## 这个测试防的是什么（审计抓出的遗漏）
     *
     * `MOVE_DIRS` 里有 `runtimes`（**目录**），但 `runtimes.json` 是
     * **数据根根目录下的一个单文件**
     *（update/runtime-store.ts:94 `join(opts.dataRoot, FILE)`，
     *  `FILE = 'runtimes.json'`）—— 它不在任何被搬的目录里面。
     *
     * 所以只搬目录的话，新根有 `runtimes/` 却没有清单。
     * 好在 scanDisk 会自愈（版本仍可用、**运行时不会丢**），
     * 但 `from`（装来源）与 `installedAt`（装的时间）会静默降级成
     * 目录 mtime —— 不报错、不丢功能，只是用户再也看不到装上时间。
     *
     * 属于"没人会去查、查了也说不清"的丢失，所以单独钉一条。
     */
    const repo = createInstanceRepo({ dataRoot: root })
    // 造一份"装了版本"的现场：目录 + 根下的清单
    mkdirSync(join(root, 'runtimes', 'a', 'v4.28.0'), { recursive: true })
    const manifest = {
      items: [
        {
          type: 'a',
          tag: 'v4.28.0',
          from: '官方源',
          installedAt: '2026-09-01T10:00:00.000Z'
        }
      ]
    }
    writeFileSync(join(root, 'runtimes.json'), JSON.stringify(manifest, null, 2), 'utf8')

    const target = join(root, 'reloc3')
    await relocateDataRoot(repo, { target })

    const moved = join(target, 'runtimes.json')
    expect(existsSync(moved), 'runtimes.json 没被搬过去（它不在 runtimes\\ 目录里）').toBe(true)

    const got = JSON.parse(readFileSync(moved, 'utf8')) as typeof manifest
    // 关键是 from / installedAt 不能丢 —— 那正是这份清单存在的意义
    expect(got.items[0].from, 'from（来源标签）必须保住').toBe('官方源')
    expect(got.items[0].installedAt, 'installedAt（装上时间）必须保住').toBe(
      '2026-09-01T10:00:00.000Z'
    )
  })
})
