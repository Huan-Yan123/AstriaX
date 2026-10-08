import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'
import { listVersions } from '../../src/main/update/version-catalog'
import { addCustomMirror, setMirrorPref, BUILTIN_MIRRORS } from '../../src/main/update/mirror-store'
import { MX_OFFICIAL_BASE } from '../../src/main/update/publish-urls'
import { testStage } from '../helpers/stage'

let root: string

beforeEach(() => {
  root = testStage('mx-ver-')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const ghReleases = [
  {
    tag_name: 'v4.28.0',
    name: 'AstrBot v4.28.0',
    prerelease: false,
    published_at: '2026-08-20T10:00:00Z',
    assets: [
      {
        name: 'AstrBot-v4.28.0-dashboard.zip',
        browser_download_url: 'https://github.com/AstrBotDevs/AstrBot/releases/download/v4.28.0/AstrBot-v4.28.0-dashboard.zip',
        digest: 'sha256:aa11',
        size: 6000000
      }
    ]
  },
  {
    tag_name: 'v4.27.2',
    name: 'AstrBot v4.27.2',
    prerelease: false,
    published_at: '2026-07-30T10:00:00Z',
    assets: [
      {
        name: 'AstrBot-v4.27.2-dashboard.zip',
        browser_download_url: 'https://github.com/AstrBotDevs/AstrBot/releases/download/v4.27.2/AstrBot-v4.27.2-dashboard.zip',
        digest: 'sha256:bb22',
        size: 5900000
      }
    ]
  },
  {
    tag_name: 'v4.29.0-beta.1',
    name: 'AstrBot beta',
    prerelease: true,
    published_at: '2026-08-25T10:00:00Z',
    assets: [
      {
        name: 'AstrBot-v4.29.0-beta.1-dashboard.zip',
        browser_download_url: 'https://github.com/x/y.zip',
        digest: 'sha256:cc33',
        size: 6100000
      }
    ]
  }
]

describe('版本探测：从镜像源读有哪些版本', () => {
  /*
   * 这两条原本断言「代理源能列出 AstrBot 的 dashboard.zip 版本」。
   *
   * 那个期望在**旧世界里是对的**，但旧世界本身是错的：
   * dashboard.zip 只有前端 dist/，不含后端，装上跑不起来。
   * 实测官方六个 release 全只发这个包，AstrBot 后端只在 PyPI。
   *
   * 所以现在代理源对 AstrBot **列不出**任何可安装版本是正确的 ——
   * 能装的那些由 PyPI 那条来源提供（见下面「PyPI 是唯一渠道」那组测试）。
   */
  it('GitHub 直连源：AstrBot 的 dashboard.zip 不能被列成可装版本', async () => {
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      onlyBase: '',
      fetchJson: async (url) => {
        // PyPI 也堵上，单纯看代理源会产出什么
        if (url.includes('pypi.org')) throw new Error('PyPI 不通')
        return JSON.stringify(ghReleases)
      }
    })
    expect(
      list,
      'dashboard.zip 被列成 AstrBot 可装版本了 —— 它只有前端 dist/，装上起不来。'
        + 'AstrBot 必须走 PyPI。'
    ).toEqual([])
  })

  it('只有源码包（source.tar.gz）时也不会误列', async () => {
    const payload = [
      { tag_name: 'v9.9.9', prerelease: false, assets: [{ name: 'source.tar.gz', browser_download_url: 'https://x/y' }] },
      ...ghReleases.slice(0, 1)
    ]
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      onlyBase: '',
      fetchJson: async (url) => {
        if (url.includes('pypi.org')) throw new Error('PyPI 不通')
        return JSON.stringify(payload)
      }
    })
    expect(list).toEqual([])
  })

  it('直连不通 → 自动用加速镜像前缀重试（前缀会被探到）', async () => {
    const seen: string[] = []
    const list = await listVersions({
      dataRoot: root,
      type: 'n',
      onlyBase: 'https://gh-proxy.com/',
      fetchJson: async (url) => {
        seen.push(url)
        return JSON.stringify([
          {
            tag_name: 'v4.18.19',
            prerelease: false,
            assets: [
              {
                name: 'NapCat.Shell.zip',
                browser_download_url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.19/NapCat.Shell.zip',
                digest: 'sha256:dd44',
                size: 29460000
              }
            ]
          }
        ])
      }
    })
    expect(list[0].tag).toBe('v4.18.19')
    expect(seen[0]).toContain('gh-proxy.com/https://api.github.com')
    // Shell 版约 28 MB（Node 版 112 MB 是塞了整份 node.exe，已弃用）
    expect(list[0].sizeMB).toBeGreaterThan(20)
    expect(list[0].sizeMB).toBeLessThan(60)
    // 下载时要能带着这条前缀还原直链
    expect(list[0].assetUrl).toContain('github.com/NapNeko/NapCatQQ/releases/download/v4.18.19/')
  })

  it('探测全部镜像源并按 tag 去重合并：NapCat 多源合并（这条合并逻辑仍要有效）', async () => {
    /*
     * 原来这条是拿 AstrBot 的 dashboard.zip 验合并的，那个来源已经没有可装版本了。
     * 改用 NapCat —— 它是真正多源分发（GitHub release + 文件型源都能发 Shell 包），
     * 合并去重逻辑在它身上依然必须成立。
     */
    const list = await listVersions({
      dataRoot: root,
      type: 'n',
      fetchJson: async (url) => {
        if (url.includes('api.github.com')) {
          return JSON.stringify([
            {
              tag_name: 'v4.18.19',
              prerelease: false,
              assets: [
                {
                  name: 'NapCat.Shell.zip',
                  browser_download_url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.19/NapCat.Shell.zip',
                  size: 29482717
                }
              ]
            },
            {
              tag_name: 'v4.18.10',
              prerelease: false,
              assets: [
                {
                  name: 'NapCat.Shell.zip',
                  browser_download_url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.10/NapCat.Shell.zip',
                  size: 29000000
                }
              ]
            }
          ])
        }
        if (url.endsWith('versions.json')) {
          return JSON.stringify({
            napcat: [
              { tag: 'v4.18.19', asset: 'napcat/NapCat.Shell.zip', sha256: 'zz99', size: 29482717 },
              { tag: 'v4.18.5', asset: 'napcat/NapCat.Shell.zip', sha256: 'yy88', size: 28000000 }
            ]
          })
        }
        throw new Error('404')
      }
    })
    // v4.18.19 两处都有 → 只留一条（先命中的来源优先）
    expect(
      list.filter((v) => v.tag === 'v4.18.19'),
      '同 tag 在多源出现时应去重，只留一条'
    ).toHaveLength(1)
    // 两边各自的独有版本都要在
    expect(list.map((v) => v.tag)).toContain('v4.18.10')
    expect(list.map((v) => v.tag)).toContain('v4.18.5')
  })
})

describe('版本探测：探测「AstriaX官方源」上架了什么（服务器不做探测，由启动器读）', () => {
  /*
   * AstrBot 的现实（实测 2026-09-13，服务器侧查证）：
   *   官方 GitHub release 六个版本全只发 AstrBot-<ver>-dashboard.zip
   *   （5.75MB，只有前端 dist/，不含后端）
   *   后端只在 PyPI：astrbot-4.28.0-py3-none-any.whl（7.396MB）
   *
   * 所以 PyPI 是 AstrBot **唯一**的分发渠道，不是"额外补充源"。
   * 用户点某个镜像源去看 AstrBot 时，列表里必须仍有 PyPI 的版本 ——
   * 否则界面空白，而用户要的东西其实是有的。
   */
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★ 契约变更（主人 2026-09-27）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 旧契约：**指定任何源**都要带上 PyPI 的全量版本
   *   —— 理由是"PyPI 是 AstrBot 唯一渠道，不带就空白"。
   *
   * 但主人实测发现这造成了两个问题：
   *   · 「官方源也是高达几十个版本，你真的塞了这么多版本在我的服务器上吗」
   *     —— 官方源上其实只有 1 条 `pypi:astrbot` 指路记录，
   *        而界面列了 PyPI 的 168 个，**界面在无中生有**
   *   · 「github 源打开还是有 astrbot」
   *     —— 那些代理上根本没有 AstrBot 后端，列出来的全是 PyPI 那条路
   *
   * 新契约：**只在"不指定源"时才列 PyPI 全量**（那才是"我要装 AstrBot"的正路）。
   * 指定了某个源 → 只列那个源上真有的条目。
   *
   * 注意"指定源时可能空白"这个担心仍然成立，但**答案变了**：
   * 不是"偷偷塞一堆别的源的版本"，而是**如实显示这个源上有什么**——
   * 用户点的是这个源，就该看到这个源的真实情况。
   * 想装 AstrBot 请去「AstrBot 下载」里点 Python 源（那条路会列全量）。
   */
  it('★AstrBot：指定某个源时**只列该源真有的**（不再无中生有塞 PyPI 全量）', async () => {
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      onlyBase: 'https://gh-proxy.com/',
      fetchJson: async (url) => {
        if (url.includes('pypi.org')) {
          return JSON.stringify({
            releases: {
              '4.28.0': [
                {
                  filename: 'astrbot-4.28.0-py3-none-any.whl',
                  url: 'https://files.pythonhosted.org/x/astrbot-4.28.0-py3-none-any.whl',
                  size: 7756000,
                  digests: { sha256: 'aa11' }
                }
              ]
            }
          })
        }
        // 代理源：GitHub release 只有 dashboard.zip，不该被选中
        return JSON.stringify([
          {
            tag_name: 'v4.28.0',
            prerelease: false,
            assets: [
              {
                name: 'AstrBot-v4.28.0-dashboard.zip',
                browser_download_url: 'https://github.com/x/dashboard.zip',
                size: 6025513
              }
            ]
          }
        ])
      }
    })
    /*
     * 这个源上**没有**可用的 AstrBot 后端（只有 dashboard.zip，被过滤掉），
     * 所以列表就该是空的 —— 如实反映这个源的情况。
     */
    expect(
      list.length,
      '指定了源就只列那个源上真有的 —— GitHub 代理上没有 AstrBot 后端，' +
        '所以这里应当为空（原来会偷偷塞 PyPI 的 168 个版本，那是"无中生有"）'
    ).toBe(0)
  })

  it('★AstrBot：不指定源时列 PyPI 全量（那才是"我要装 AstrBot"的正路）', async () => {
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      /* 不传 onlyBase —— 对应下载页点「AstrBot 下载」里的 Python 源 */
      fetchJson: async (url) => {
        if (url.includes('pypi.org')) {
          return JSON.stringify({
            releases: {
              '4.28.0': [
                {
                  filename: 'astrbot-4.28.0-py3-none-any.whl',
                  url: 'https://files.pythonhosted.org/x/astrbot-4.28.0-py3-none-any.whl',
                  size: 7756000,
                  digests: { sha256: 'aa11' }
                }
              ]
            }
          })
        }
        return '[]'
      }
    })
    expect(list.length, '不指定源时必须列出 PyPI 的版本（否则装不了 AstrBot）').toBeGreaterThan(0)
    expect(list[0].kind, '这条来自 PyPI').toBe('pypi')
    expect(list[0].assetName).toContain('.whl')
  })

  it('AstrBot：dashboard.zip 永远不会被当成可安装的版本', async () => {
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      onlyBase: 'https://gh-proxy.com/',
      fetchJson: async (url) => {
        if (url.includes('pypi.org')) throw new Error('PyPI 不通')
        return JSON.stringify([
          {
            tag_name: 'v4.28.0',
            prerelease: false,
            assets: [
              {
                name: 'AstrBot-v4.28.0-dashboard.zip',
                browser_download_url: 'https://github.com/x/dashboard.zip',
                size: 6025513
              }
            ]
          }
        ])
      }
    })
    expect(
      list.filter((v) => v.assetName.includes('dashboard')),
      'dashboard.zip 被列成可装版本了 —— 它是只有前端的资源包，装了跑不起来'
    ).toEqual([])
  })

  it('NapCat：指定代理源时不该混入 PyPI（它不从 PyPI 装）', async () => {
    const list = await listVersions({
      dataRoot: root,
      type: 'n',
      onlyBase: 'https://gh-proxy.com/',
      fetchJson: async () =>
        JSON.stringify([
          {
            tag_name: 'v4.18.19',
            prerelease: false,
            assets: [
              {
                name: 'NapCat.Shell.zip',
                browser_download_url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.19/NapCat.Shell.zip',
                size: 29482717
              }
            ]
          }
        ])
    })
    expect(list[0].tag).toBe('v4.18.19')
    expect(list[0].kind, 'NapCat 是 zip 分发').toBeUndefined()
    expect(list[0].assetName).toBe('NapCat.Shell.zip')
  })

  it('读官方源自己的 versions.json（用源常量，不写死 IP）', async () => {
    /*
     * ★ 这条原来把老服务器 IP 写死在断言里 —— 主人把主源换成新服务器后
     * 它就红了（老源现在是"备用"，label 变成「AstriaX官方源·备用」）。
     *
     * 教训：**测试不该写死基础设施地址**，否则换个服务器就要改测试，
     * 而"改测试让它变绿"恰恰是我们最不该养成的习惯。
     * 现在从 publish-urls 取常量：源换了测试自动跟着走，
     * 而且还能顺带验证"新源确实是列表里的第一个（排第一）"。
     */
    const primaryBase = `${MX_OFFICIAL_BASE}files/`
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      onlyBase: primaryBase,
      fetchJson: async (url) => {
        expect(url).toBe(`${primaryBase}versions.json`)
        return JSON.stringify({
          astrbot: [
            { tag: 'v4.28.0', asset: 'astrbot/AstrBot-v4.28.0-dashboard.zip', sha256: 'aa11', size: 6000000 },
            { tag: 'v4.27.2', asset: 'astrbot/AstrBot-v4.27.2-dashboard.zip', sha256: 'bb22', size: 5900000 }
          ]
        })
      }
    })
    expect(list.map((v) => v.tag)).toEqual(['v4.28.0', 'v4.27.2'])
    expect(list[0].assetName).toBe('astrbot/AstrBot-v4.28.0-dashboard.zip')
    expect(list[0].sha256).toBe('aa11')
    expect(list[0].from).toBe('AstriaX官方源')
    // 文件型源的下载地址 = 源基址 + 上架文件名
    expect(list[0].assetUrl).toBe(`${primaryBase}astrbot/AstrBot-v4.28.0-dashboard.zip`)
  })

  it('★官方源只有一个，地址来自 publish-urls.ts（换服务器只改一处）', () => {
    /*
     * 2026-09-15 主人把服务器换成唯一的 8.216.54.25（老两台都已下线）。
     * 之前这里断言过"主源 + ·备用"两个 files 源 —— 那条随双源设计一起
     * 撤掉了：把已退役的机器留作"备用"，只会让每次失败多等一轮必然超时，
     * 还会让人误以为那条路是活的。
     *
     * 这条守两件事：
     *   ① 内置的 files 官方源**有且只有一个**
     *   ② 它的 base 来自 publish-urls.ts 的常量（不是测试里写死的 IP）——
     *      换服务器只改常量，测试自动跟着走
     */
    const filesMirrors = BUILTIN_MIRRORS.filter((m) => m.mode === 'files')
    expect(filesMirrors.length, '官方文件源应当只有一个').toBe(1)
    expect(filesMirrors[0].base).toBe(`${MX_OFFICIAL_BASE}files/`)
    expect(filesMirrors[0].label).toBe('AstriaX官方源')
    expect(filesMirrors[0].hideBase, 'UI 不暴露服务器地址').toBe(true)
  })

  it('唯一官方源上架的文件能列出、能拼出下载直链', async () => {
    const base = `${MX_OFFICIAL_BASE}files/`
    const list = await listVersions({
      dataRoot: root,
      type: 'n',
      onlyBase: base,
      fetchJson: async (url) => {
        expect(url).toBe(`${base}versions.json`)
        return JSON.stringify({
          napcat: [{ tag: 'v4.18.19', asset: 'napcat/NapCat.Shell.zip', sha256: 'cc33', size: 28000000 }]
        })
      }
    })
    expect(list.map((v) => v.tag)).toEqual(['v4.18.19'])
    expect(list[0].from).toBe('AstriaX官方源')
    expect(list[0].assetUrl).toBe(`${base}napcat/NapCat.Shell.zip`)
  })

  it('官方源还没上架（versions.json 404）→ 空列表，不报错', async () => {
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      onlyBase: `${MX_OFFICIAL_BASE}files/`,
      fetchJson: async () => {
        throw new Error('404')
      }
    })
    expect(list).toEqual([])
  })

  it('★官方源里 asset=pypi:astrbot 的条目 → **展开成 PyPI 的真实版本**', async () => {
    /*
     * 服务器清单里 AstrBot 那条写的是 `"tag": "pypi", "asset": "pypi:astrbot"` ——
     * 这是发布脚本（scripts/publish-runtime.py 的 PYPI_HINT）定下的约定：
     * 「AstrBot 由内置 Python 从 PyPI 直接装，不经本服务器分发」。
     *
     * ══════════════════════════════════════════════════════════════════════════
     * ★ 契约变更（主人 2026-09-27 踩到的真报错）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 旧行为：把这条**原样**当版本条目，`tag` 就是 `"pypi"`。
     * 于是用户点它的「下载」时执行：
     *     pip install astrbot==pypi
     *     → ERROR: Invalid requirement: 'astrbot==pypi'
     *（主人实测报错原文就是这句）
     *
     * 新行为：把这条**展开成 PyPI 上的可用版本**（真实版本号），
     * 点哪个装哪个 —— 这才是"从 PyPI 装"的正确表达。
     */
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      onlyBase: `${MX_OFFICIAL_BASE}files/`,
      fetchJson: async (url) => {
        /* 展开时要读 PyPI 的元数据 */
        if (url.includes('pypi.org')) {
          return JSON.stringify({
            releases: {
              '4.28.0': [
                {
                  filename: 'astrbot-4.28.0-py3-none-any.whl',
                  url: 'https://files.pythonhosted.org/x/astrbot-4.28.0-py3-none-any.whl',
                  size: 7756000,
                  digests: { sha256: 'aa11' },
                  upload_time_iso_8601: '2026-09-07T00:00:00Z'
                }
              ]
            }
          })
        }
        return JSON.stringify({
          astrbot: [
            {
              tag: 'pypi',
              asset: 'pypi:astrbot',
              sha256: '',
              size: 0,
              note: 'AstrBot 由内置 Python 从 PyPI 直接安装，不经本服务器分发'
            }
          ]
        })
      }
    })

    expect(list.length, '要展开出 PyPI 上的版本').toBeGreaterThan(0)
    /*
     * ★ 关键断言：`tag` 必须是**真实版本号**，绝不能是 "pypi"。
     * 它会被拿去拼 `pip install astrbot==<tag>` —— 拼错就必然报错。
     */
    expect(
      list[0].tag,
      '★tag 必须是真实版本号。原来是 "pypi"，导致 pip install astrbot==pypi 直接报错'
    ).not.toBe('pypi')
    expect(list[0].tag).toBe('v4.28.0')
    // 标成 pypi → 安装时走 pip 而不是下载 zip
    expect(list[0].kind, 'asset 以 pypi: 开头时必须标 kind=pypi').toBe('pypi')
    /*
     * ★ 展开后拿到的是**真的 PyPI wheel** —— 所以它**有**下载地址。
     *
     * （第一版断言写的是 `assetUrl === ''`，那是"还留着指路条目"时的行为。
     *   现在指路条目已被同 tag 的真实条目**顶替**，自然带上了 wheel 地址 ——
     *   而这才对：用户点它能真的装上。）
     */
    expect(list[0].assetName, '要是真的 wheel，不是 pypi:astrbot 指路标记').toContain('.whl')
    expect(list[0].assetUrl, 'wheel 必须有可下载地址（否则点了装不上）').toContain('.whl')
    expect(
      list.filter((v) => v.assetName === 'pypi:astrbot'),
      '不该留下只有指路标记、没有包体的条目 —— 那会让用户点了装不上（pip install astrbot==pypi）'
    ).toEqual([])
  })

  it('★官方源里 pypi: 条目展开后，与真实文件条目能共存', async () => {
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      onlyBase: `${MX_OFFICIAL_BASE}files/`,
      fetchJson: async (url) => {
        if (url.includes('pypi.org')) {
          return JSON.stringify({
            releases: {
              '4.28.0': [
                {
                  filename: 'astrbot-4.28.0-py3-none-any.whl',
                  url: 'https://files.pythonhosted.org/x/astrbot-4.28.0-py3-none-any.whl',
                  size: 7756000,
                  digests: { sha256: 'aa11' }
                }
              ]
            }
          })
        }
        return JSON.stringify({
          astrbot: [
            { tag: 'pypi', asset: 'pypi:astrbot', sha256: '', size: 0 },
            { tag: 'v4.20.0', asset: 'astrbot/old.zip', sha256: 'cc33', size: 1000000 }
          ]
        })
      }
    })
    /* pypi 那条展开成了 v4.28.0（真实版本号），文件条目原样保留 */
    const pypi = list.find((v) => v.tag === 'v4.28.0')!
    const zip = list.find((v) => v.tag === 'v4.20.0')!
    expect(pypi, 'pypi 指路记录要展开成 PyPI 的真实版本').toBeTruthy()
    expect(pypi.kind).toBe('pypi')
    expect(zip.kind, '普通文件条目不该被误标成 pypi').toBeUndefined()
    expect(zip.assetUrl).toBe(`${MX_OFFICIAL_BASE}files/astrbot/old.zip`)
  })

  it('NapCat 段独立列出', async () => {
    const list = await listVersions({
      dataRoot: root,
      type: 'n',
      onlyBase: `${MX_OFFICIAL_BASE}files/`,
      fetchJson: async () =>
        JSON.stringify({
          napcat: [{ tag: 'v4.18.19', asset: 'napcat/NapCat.Shell.zip', sha256: 'dd44', size: 29460000 }]
        })
    })
    expect(list[0].tag).toBe('v4.18.19')
    expect(list[0].sizeMB).toBeGreaterThan(20)
    expect(list[0].sizeMB).toBeLessThan(60)
  })

  it('用户自建文件源同样能被探测', async () => {
    addCustomMirror(root, { label: '我的文件源', base: 'https://files.example/', mode: 'files' })
    setMirrorPref(root, { a: 'https://files.example/' })
    const list = await listVersions({
      dataRoot: root,
      type: 'a',
      onlyBase: 'https://files.example/',
      fetchJson: async (url) => {
        expect(url).toBe('https://files.example/versions.json')
        return JSON.stringify({ astrbot: [{ tag: 'v1.2.3', asset: 'a.zip', sha256: 'ff', size: 1000 }] })
      }
    })
    expect(list[0].tag).toBe('v1.2.3')
    expect(list[0].from).toBe('我的文件源')
  })
})

describe('按需下载指定版本', () => {
  it('downloadRuntime 能直接下旧版本（不经 latest）', async () => {
    const { downloadRuntime } = await import('../../src/main/update/runtime-download')
    const { readFileSync } = await import('fs')
    const r = await downloadRuntime({
      dataRoot: root,
      type: 'a',
      release: {
        tag: 'v4.27.2',
        assetName: 'AstrBot-v4.27.2-dashboard.zip',
        assetUrl: 'https://github.com/AstrBotDevs/AstrBot/releases/download/v4.27.2/AstrBot-v4.27.2-dashboard.zip'
      },
      destFile: join(root, 'old.zip'),
      onlyBase: '',
      fetchBuf: async () => Buffer.from('old-version')
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(root, 'old.zip'), 'utf8')).toBe('old-version')
  })

  it('官方文件源：按 asset 相对路径下载并校验 sha256', async () => {
    const { downloadRuntime } = await import('../../src/main/update/runtime-download')
    const { createHash } = await import('crypto')
    const payload = Buffer.from('official-astrbot-428')
    const sha = createHash('sha256').update(payload).digest('hex')
    const seen: string[] = []
    const r = await downloadRuntime({
      dataRoot: root,
      type: 'a',
      release: {
        tag: 'v4.28.0',
        assetName: 'astrbot/AstrBot-v4.28.0-dashboard.zip',
        assetUrl: 'https://github.com/AstrBotDevs/AstrBot/releases/download/v4.28.0/AstrBot-v4.28.0-dashboard.zip',
        sha256: sha
      },
      destFile: join(root, 'off.zip'),
      onlyBase: `${MX_OFFICIAL_BASE}files/`,
      fetchJson: async () => {
        throw new Error('404')
      },
      fetchBuf: async (url) => {
        seen.push(url)
        return payload
      }
    })
    expect(r.ok).toBe(true)
    expect(seen[0]).toBe(`${MX_OFFICIAL_BASE}files/astrbot/AstrBot-v4.28.0-dashboard.zip`)
  })
})
