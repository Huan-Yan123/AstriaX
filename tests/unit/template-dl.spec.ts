/*
 * downloadTemplate 的测试 —— 这个函数原来**零覆盖**。
 *
 * 为什么必须补：它在「安装运行时」的关键路径上（ipc.ts 的 templates:download
 * 直接调它），而它的收尾清理原来是 `rmSync(stage, {recursive:true, force:true})`
 * —— 同步删一个装着刚下完的整包（NapCat 29MB）的目录，会把主进程独占住，
 * 表现就是「装完了但界面点不动」。项目里明明有 removeDirAsync 并写明了
 * 「大目录必须用这个，别用 rmSync」，这处漏改了。
 *
 * 反向验证过：把 removeDirAsync 改回 rmSync，下面的用例会红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('mx-tpl-')
  /*
   * 必须清掉上一个用例留下的 doMock。
   *
   * 踩过：某个用例把 removeDirAsync mock 成「总是抛错」（模拟文件被占用），
   * 下一个用例以为自己在用真实实现，结果暂存目录没被删掉而假红。
   * vi.resetModules() **不会**清 doMock 注册表，得显式 doUnmock。
   */
  vi.resetModules()
  vi.doUnmock('../../src/main/util/workdir')
  vi.doUnmock('../../src/main/update/runtime-download')
  vi.doUnmock('../../src/main/util/async-exec')
  vi.doUnmock('../../src/main/update/template-source')
  vi.doUnmock('../../src/main/update/templates')
  vi.doUnmock('../../src/main/update/mirror-store')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/**
 * 因为 downloadTemplate 内部 import 了 downloadRuntime / expandArchive，
 * 这里用 vi.mock 把它们替换掉，只验证 downloadTemplate 自己的编排逻辑：
 * 暂存位置、清理方式、版本换算、返回值结构。
 */
function mockDeps(opts: { sha?: string; expandStatus?: number } = {}) {
  vi.doMock('../../src/main/update/runtime-download', () => ({
    downloadRuntime: async (d: { destFile: string; release: { assetName: string } }) => {
      mkdirSync(join(d.destFile, '..'), { recursive: true })
      writeFileSync(d.destFile, 'fake-package-bytes', 'utf8')
      return { ok: true, sha256: opts.sha ?? 'abc123', usedLabel: '测试源', usedBase: '' }
    }
  }))
  vi.doMock('../../src/main/util/async-exec', () => ({
    expandArchive: async () => ({ status: opts.expandStatus ?? 0, stdout: '', stderr: '' })
  }))
  vi.doMock('../../src/main/update/template-source', () => ({
    TEMPLATE_SOURCES: {
      a: { repo: 'x/y' },
      n: { repo: 'x/z' }
    },
    resolveLatest: async () => ({
      tag: 'v4.18.19',
      assetName: 'NapCat.Shell.zip',
      assetUrl: 'https://example.com/x.zip',
      sha256: 'deadbeef'
    })
  }))
  vi.doMock('../../src/main/update/templates', () => ({
    ensureTemplate: () => undefined
  }))
  vi.doMock('../../src/main/update/mirror-store', () => ({
    mirrorOrderFor: () => [{ base: '', mode: 'proxy' }]
  }))
}

describe('downloadTemplate（原来零覆盖的安装路径）', () => {
  it('暂存目录必须落在 data\\cache\\tmp 下，绝不用系统临时目录（别占 C 盘）', async () => {
    mockDeps()
    let stageSeen = ''
    vi.doMock('../../src/main/util/workdir', async () => {
      const real = await vi.importActual<typeof import('../../src/main/util/workdir')>(
        '../../src/main/util/workdir'
      )
      return {
        ...real,
        makeStage: (dataRoot: string, tag: string) => {
          const d = real.makeStage(dataRoot, tag)
          stageSeen = d
          return d
        }
      }
    })

    const { downloadTemplate } = await import('../../src/main/update/template-dl')
    await downloadTemplate({
      type: 'n',
      dataRoot: root,
      destDir: join(root, 'templates', 'napcat')
    })

    expect(stageSeen, '应该用了 makeStage').toBeTruthy()
    // 关键：必须在 data 下，而不是 C:\Users\...\AppData\Local\Temp
    expect(stageSeen.toLowerCase()).toContain(root.toLowerCase())
    expect(stageSeen).toContain(join('cache', 'tmp'))
  })

  it('返回值结构完整：版本数字、资产名、sha256、来源', async () => {
    mockDeps({ sha: 'sha-from-mirror' })
    const { downloadTemplate } = await import('../../src/main/update/template-dl')
    const r = await downloadTemplate({
      type: 'n',
      dataRoot: root,
      destDir: join(root, 'templates', 'napcat')
    })

    expect(r.version, 'v4.18.19 → 41819').toBe(41819)
    expect(r.asset).toBe('NapCat.Shell.zip')
    expect(r.sha256).toBe('sha-from-mirror')
    expect(r.from).toBe('测试源')
  })

  it('解压失败要抛出并带上 stderr（不能静默当成功）', async () => {
    mockDeps({ expandStatus: 1 })
    const { downloadTemplate } = await import('../../src/main/update/template-dl')
    await expect(
      downloadTemplate({ type: 'n', dataRoot: root, destDir: join(root, 'templates', 'napcat') })
    ).rejects.toThrow(/解压失败/)
  })

  it('收尾清理**不能阻塞主进程**（本轮修的 bug：原来是同步 rmSync）', async () => {
    /*
     * 这条是核心回归测试。
     *
     * 判定方式：hook 掉 removeDirAsync，看它有没有被调用。
     * 原来的实现走的是 fs.rmSync，从不调用 removeDirAsync ——
     * 于是这个断言会红。（反向验证：改回 rmSync → 红。）
     *
     * 光看「最终目录被删了」是不够的：同步删和异步删的最终效果一样，
     * 区别只在**删的时候主进程卡不卡**。所以必须验证「用了异步那个函数」。
     */
    mockDeps()
    let asyncRemoveCalled = false
    vi.doMock('../../src/main/util/workdir', async () => {
      const real = await vi.importActual<typeof import('../../src/main/util/workdir')>(
        '../../src/main/util/workdir'
      )
      return {
        ...real,
        removeDirAsync: async (d: string) => {
          asyncRemoveCalled = true
          return real.removeDirAsync(d)
        }
      }
    })

    const { downloadTemplate } = await import('../../src/main/update/template-dl')
    await downloadTemplate({
      type: 'n',
      dataRoot: root,
      destDir: join(root, 'templates', 'napcat')
    })

    // 清理是 fire-and-forget，给它一拍时间落地
    await new Promise((r) => setTimeout(r, 300))
    expect(
      asyncRemoveCalled,
      '暂存清理必须走 removeDirAsync（同步 rmSync 会卡住主进程）'
    ).toBe(true)
  })

  it('清理失败不能把成功的安装变成失败（finally 里不能抛）', async () => {
    /*
     * 场景：文件被占用导致删不掉。
     * 这时安装其实已经成功了，用户该看到「装好了」，
     * 而不是一个跟安装毫无关系的删除报错。
     */
    mockDeps()
    vi.doMock('../../src/main/util/workdir', async () => {
      const real = await vi.importActual<typeof import('../../src/main/util/workdir')>(
        '../../src/main/util/workdir'
      )
      return {
        ...real,
        removeDirAsync: async () => {
          throw new Error('EBUSY: 文件被占用')
        }
      }
    })

    const { downloadTemplate } = await import('../../src/main/update/template-dl')
    const r = await downloadTemplate({
      type: 'n',
      dataRoot: root,
      destDir: join(root, 'templates', 'napcat')
    })
    expect(r.version).toBe(41819)
  })

  it('安装目标目录会被创建出来', async () => {
    mockDeps()
    const dest = join(root, 'templates', 'napcat')
    const { downloadTemplate } = await import('../../src/main/update/template-dl')
    await downloadTemplate({ type: 'n', dataRoot: root, destDir: dest })
    expect(existsSync(dest)).toBe(true)
  })

  it('暂存目录用完会消失（不留下垃圾累积在 cache/tmp）', async () => {
    mockDeps()
    const { downloadTemplate } = await import('../../src/main/update/template-dl')
    await downloadTemplate({
      type: 'n',
      dataRoot: root,
      destDir: join(root, 'templates', 'napcat')
    })
    // 等异步清理完成
    await new Promise((r) => setTimeout(r, 500))
    const tmp = join(root, 'cache', 'tmp')
    const left = existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith('tpl-')) : []
    expect(left, `暂存该清干净，实际剩：${left.join(',')}`).toEqual([])
  })
})
