/*
 * ★「换个版本」的选项来自**源**，而不是只看本机已装
 *   （主人 2026-09-26：「astrbot 的换个版本应该是从 astrbot 的 py 源里用户自己选」）
 *
 * ## 为什么单独写这一条（第二轮复审抓出的覆盖空白）
 *
 * `version-updown.spec.ts` 只验证了**后端**的指针切换与数据保留 ——
 * 它调的是 `instance:setRuntime` / `runtimes:list`，**从未触及**
 * 「选项从哪来」这件事。而用户要的恰恰是"从 PyPI 源里自己选"。
 *
 * 这条测试直接打 `versions:list`（渲染层 pickVersion 就是靠它拿选项），
 * 钉住三件事：
 *   1. AstrBot 的版本**来自 PyPI**（即使本机一个都没装，也能列出来）
 *   2. 列表**同时包含**比当前新的与比当前旧的（用户才能自己选方向）
 *   3. NapCat 走它自己的分发源，不混入 PyPI
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('pickver-')
  mkdirSync(root, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一份 PyPI 的 JSON 应答（listAstrbotPypiVersions 要的形状） */
function pypiPayload(tags: string[]): string {
  const releases: Record<string, unknown[]> = {}
  for (const t of tags) {
    releases[t] = [
      {
        filename: `astrbot-${t}-py3-none-any.whl`,
        url: `https://files.pythonhosted.org/packages/aa/astrbot-${t}-py3-none-any.whl`,
        size: 7_000_000,
        digests: { sha256: 'aa' }
      }
    ]
  }
  return JSON.stringify({ info: { version: tags[0] }, releases })
}

describe('★「换个版本」的选项来自源（不只看本机已装）', () => {
  it('★本机一个 AstrBot 版本都没装，也能从 PyPI 列出可选版本', async () => {
    const { listVersions } = await import('../../src/main/update/version-catalog')
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      noCache: true,
      fetchJson: async (url: string) => {
        if (url.includes('pypi.org')) return pypiPayload(['4.28.1', '4.28.0', '4.27.2', '4.26.0'])
        throw new Error('其它源不通（这也正是要验证的：AstrBot 不依赖它们）')
      }
    })
    const tags = list.map((v) => v.tag)
    /*
     * 关键：本机 runtimes 目录是**空的**，但列表照样有版本 ——
     * 因为 AstrBot 的版本来自 PyPI，而不是"已装的"。
     * 这正是"用户能从源里选"的前提。
     */
    expect(tags, '空机器也要能列出 PyPI 上的版本').toEqual(
      expect.arrayContaining(['v4.28.1', 'v4.28.0'])
    )
    expect(list.find((v) => v.tag === 'v4.28.0')?.kind, '标成 pypi 分发').toBe('pypi')
  })

  it('★列表同时含"更新的"与"更旧的"（用户才能自己决定升还是降）', async () => {
    const { listVersions } = await import('../../src/main/update/version-catalog')
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      noCache: true,
      fetchJson: async (url: string) => {
        if (url.includes('pypi.org')) {
          // 当前用的是中间那个：两侧都该出现
          return pypiPayload(['4.28.1', '4.28.0', '4.27.0', '4.26.0', '4.25.0'])
        }
        throw new Error('404')
      }
    })
    const tags = list.map((v) => v.tag)
    const current = 'v4.27.0'
    const newer = tags.filter((t) => t > current)
    const older = tags.filter((t) => t < current)
    expect(newer.length, '要有比当前新的（能升级）').toBeGreaterThan(0)
    expect(older.length, '也要有比当前旧的（能降级）').toBeGreaterThan(0)
    /*
     * 排序：新在前 —— 渲染层靠这个顺序让最近的版本出现在弹窗最上面
     *（弹窗只列前 N 个，所以顺序直接影响用户看到什么）。
     */
    expect(tags[0], '最新的应当排第一').toBe('v4.28.1')
  })

  it('★NapCat 走自己的分发源，不混入 PyPI', async () => {
    const { listVersions } = await import('../../src/main/update/version-catalog')
    const seen: string[] = []
    const list = await listVersions({
      dataRoot: root,
      type: 'n',
      noCache: true,
      fetchJson: async (url: string) => {
        seen.push(url)
        if (url.includes('pypi.org')) {
          // 如果代码错误地去问 PyPI 要 NapCat，这里会返回一个假版本暴露问题
          return pypiPayload(['9.9.9'])
        }
        throw new Error('404')
      }
    })
    expect(
      seen.some((u) => u.includes('pypi.org')),
      'NapCat 不该去 PyPI 找版本（「github 源只有 napcat」的另一面：' +
        'napcat 也不从 PyPI 来）'
    ).toBe(false)
    expect(list.map((v) => v.tag), '不该出现 PyPI 的假版本').not.toContain('v9.9.9')
  })
})
