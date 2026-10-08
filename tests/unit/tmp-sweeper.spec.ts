/*
 * Bug I：`cache\tmp` 的残留必须真的有人清
 * ========================================================================
 *
 * ## 坏在哪
 *
 * 下载中转、解压暂存都放 `data\cache\tmp`，每处用完都会自己 cleanStage。
 * 但"用完就删"只在**正常跑完**时成立 —— 下载到一半被杀、断电、
 * 文件被杀软占住（rmSync 当场失败）时，暂存目录就留下了。
 *
 * 而代码里好几处注释写着「删不掉就算了，**下次启动可清理**」，
 * `workdir.ts` 的 cleanStage 也写着「下次启动可清理」——
 * **但根本没有任何"下次启动清理"的代码**。那句话是空头支票。
 *
 * 实测这台机器上 `data\cache\tmp` 已经堆了 **916** 个条目。
 * 单看每个都不大，但 `rt-*`（运行时包）和解压产物能到 GB 级，
 * 而且**永不回收** —— 用户会觉得"版本我都删了，磁盘怎么还占着"。
 *
 * ## 判据：必须"按时间"清，不能整个端掉
 *
 * `cache\tmp` 也是跑着的实例的 TMP/TEMP（pipEnvFor 会把 TMP/TEMP/TMPDIR
 * 都指到这里）。无条件 `RMDir /r` 整个目录会**干掉正在进行的下载/解压** ——
 * 那是把一个"占空间"的小毛病换成一个"装到一半失败"的大毛病。
 *
 * 所以只清"确实没人再用"的（mtime 很旧）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { sweepStaleTmp, tempDirFor } from '../../src/main/util/workdir'

let root: string
beforeEach(() => {
  root = testStage('acb-bugI-')
  mkdirSync(tempDirFor(root), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 建一个暂存目录，内容随便，可指定"多久没动过" */
function staleDir(name: string, ageMs: number): string {
  const d = join(tempDirFor(root), name)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'payload.bin'), 'x'.repeat(64), 'utf8')
  const t = (Date.now() - ageMs) / 1000
  utimesSync(d, t, t)
  utimesSync(join(d, 'payload.bin'), t, t)
  return d
}

describe('Bug I：cache\\tmp 陈旧残留必须被清理', () => {
  it('★很旧的残留要被删掉（否则永不回收，越堆越多）', async () => {
    const old = staleDir('rt-old', 3 * 24 * 60 * 60 * 1000) // 3 天没动

    const n = await sweepStaleTmp(root)

    expect(
      existsSync(old),
      '3 天前的暂存目录还在 —— 这就是 cache\\tmp 无限堆积的原因。\n' +
        '代码注释里写的"下次启动可清理"必须真的有人执行。'
    ).toBe(false)
    expect(n, '应该报告清理了 1 项').toBe(1)
  })

  it('★正在用的（刚建的）绝对不能删 —— 那是活跃的下载/解压', async () => {
    const fresh = staleDir('rt-fresh', 0) // 刚刚
    const recent = staleDir('rt-recent', 10 * 60 * 1000) // 10 分钟前

    const n = await sweepStaleTmp(root)

    expect(
      existsSync(fresh),
      '把刚建的暂存目录删了 —— 那可能是**正在进行的下载/解压**，\n' +
        '(pipEnvFor 会把 TMP/TEMP/TMPDIR 都指到这里)，\n' +
        '删掉等于把"装到一半"直接搞坏。清理必须按时间筛。'
    ).toBe(true)
    expect(existsSync(recent), '10 分钟前的也可能还在用，不该删').toBe(true)
    expect(n, '不该删任何东西').toBe(0)
  })

  it('混合场景：只删旧的，新的原样留着', async () => {
    const old1 = staleDir('a-old', 8 * 60 * 60 * 1000) // 8 小时（超 6 小时阈值）
    const old2 = staleDir('b-old', 24 * 60 * 60 * 1000)
    const fresh = staleDir('c-fresh', 60 * 1000)

    const n = await sweepStaleTmp(root)

    expect(n).toBe(2)
    expect(existsSync(old1)).toBe(false)
    expect(existsSync(old2)).toBe(false)
    expect(existsSync(fresh), '新的被误删了').toBe(true)
  })

  it('目录不存在时不抛错（首启、或用户手工删过）', async () => {
    const empty = testStage('acb-bugI-empty-')
    try {
      /*
       * sweepStaleTmp 已改 async（性能审计实测：同步版每次启动冻结约 14 秒），
       * 所以断言必须 resolves 而不是直接比较 —— 直接比会拿 Promise 对象比数字。
       */
      await expect(sweepStaleTmp(empty)).resolves.toBe(0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('单个目录删不掉不能中断整体清理（本机真有 ACL 坏掉的目录）', async () => {
    /*
     * 模拟"某一项删不掉"：用一个无法删除的路径很难在单测里造，
     * 所以这里验证**行为的另一面** —— 清理必须遍历完所有项，
     * 而不是遇到第一个问题就退出。
     */
    staleDir('d1', 12 * 60 * 60 * 1000)
    staleDir('d2', 12 * 60 * 60 * 1000)
    staleDir('d3', 12 * 60 * 60 * 1000)

    const n = await sweepStaleTmp(root)

    expect(n, '三个旧目录应该全被清掉（不能只处理第一个）').toBe(3)
    const left = readdirSync(tempDirFor(root))
    expect(left, `还有残留：${left.join(', ')}`).toEqual([])
  })
})
