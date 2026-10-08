import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MX_OFFICIAL_BASE } from '../../src/main/update/publish-urls'
import { rmSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { downloadRuntime } from '../../src/main/update/runtime-download'
import { addCustomMirror, setMirrorPref, loadMirrors, BUILTIN_MIRRORS } from '../../src/main/update/mirror-store'
import { createHash } from 'crypto'
import { testStage } from '../helpers/stage'

let root: string
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

beforeEach(() => {
  root = testStage('mx-dl-')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const RELEASE = {
  tag: 'v4.28.0',
  assetName: 'AstrBot-v4.28.0-dashboard.zip',
  assetUrl: 'https://github.com/AstrBotDevs/AstrBot/releases/download/v4.28.0/AstrBot-v4.28.0-dashboard.zip'
}

/*
 * 加速源从内置列表里**按位置推导**，别写死域名。
 * 内置列表会跟着实测结果变（不可用的会被剔除），
 * 断言绑死某个域名就会在列表调整时假红。
 */
const PROXIES = BUILTIN_MIRRORS.filter((m) => m.mode === 'proxy' && m.base)
const SECOND_PROXY = PROXIES[0]
const THIRD_PROXY = PROXIES[1]

describe('运行时下载（按镜像顺序回退）', () => {
  /*
   * 回退链是**动态**的（来自内置源 + 用户自定义源），
   * 所以这些用例不该把「第几个是哪个源」写死 ——
   * 之前写死 ghproxy.net，后来实测发现它 API 返回 403（列不出可用版本）
   * 从内置列表里移除了，测试就红了。红的不是代码，是断言绑死了具体某个源。
   */

  it('前面的源失败 → 自动换下一个并最终成功，记录实际使用的源', async () => {
    const tried: string[] = []
    const r = await downloadRuntime({
      dataRoot: root,
      type: 'a',
      release: RELEASE,
      destFile: join(root, 'a.zip'),
      fetchBuf: async (url) => {
        tried.push(url)
        // 直连和第一个加速都挂，落到第二个加速
        if (url === RELEASE.assetUrl || url.startsWith(SECOND_PROXY.base)) throw new Error('HTTP 502')
        return Buffer.from('astrbot-bytes')
      }
    })
    expect(r.ok).toBe(true)
    expect(r.usedBase).toBe(THIRD_PROXY.base)
    expect(tried[0]).toBe(RELEASE.assetUrl)
    expect(tried[1]).toContain(SECOND_PROXY.base)
    expect(tried[2]).toContain(THIRD_PROXY.base)
    expect(readFileSync(join(root, 'a.zip'), 'utf8')).toBe('astrbot-bytes')
  })

  it('官方 sha256 校验不过 → 换下一个源，不留下坏文件', async () => {
    const r = await downloadRuntime({
      dataRoot: root,
      type: 'a',
      release: { ...RELEASE, sha256: sha('correct') },
      destFile: join(root, 'a.zip'),
      fetchBuf: async (url) =>
        url === RELEASE.assetUrl || url.startsWith(SECOND_PROXY.base)
          ? Buffer.from('tampered')
          : Buffer.from('correct')
    })
    expect(r.ok).toBe(true)
    expect(r.usedBase).toBe(THIRD_PROXY.base)
    expect(r.sha256).toBe(sha('correct'))
    expect(readFileSync(join(root, 'a.zip'), 'utf8')).toBe('correct')
  })

  it('所有源都不通 → 报错里带上试过的源数量与最后错误', async () => {
    await expect(
      downloadRuntime({
        dataRoot: root,
        type: 'a',
        release: RELEASE,
        destFile: join(root, 'a.zip'),
        fetchBuf: async () => {
          throw new Error('ECONNREFUSED')
        }
      })
    ).rejects.toThrow(/下载失败.*ECONNREFUSED/s)
  })

  it('文件型镜像：读 index.json，优先 index 里的直链与 sha256', async () => {
    const payload = Buffer.from('real-astrbot')
    const seen: string[] = []
    const r = await downloadRuntime({
      dataRoot: root,
      type: 'a',
      release: RELEASE,
      destFile: join(root, 'a.zip'),
      onlyBase: `${MX_OFFICIAL_BASE}files/`,
      fetchJson: async (url) => {
        expect(url).toBe(`${MX_OFFICIAL_BASE}files/index.json`)
        return JSON.stringify({
          assets: [{ name: RELEASE.assetName, url: 'http://cdn.example/a.zip', sha256: sha('real-astrbot') }]
        })
      },
      fetchBuf: async (url) => {
        seen.push(url)
        return payload
      }
    })
    expect(r.ok).toBe(true)
    expect(seen).toEqual(['http://cdn.example/a.zip'])
  })

  it('文件型镜像没有 index → 退回按文件名拼接', async () => {
    const seen: string[] = []
    await downloadRuntime({
      dataRoot: root,
      type: 'n',
      release: { tag: 'v4.18.19', assetName: 'NapCat.Shell.Windows.Node.zip', assetUrl: 'https://github.com/x/y.zip' },
      destFile: join(root, 'n.zip'),
      onlyBase: `${MX_OFFICIAL_BASE}files/`,
      fetchJson: async () => {
        throw new Error('404')
      },
      fetchBuf: async (url) => {
        seen.push(url)
        return Buffer.from('napcat')
      }
    })
    expect(seen[0]).toBe(`${MX_OFFICIAL_BASE}files/NapCat.Shell.Windows.Node.zip`)
  })

  it('用户指定的首选源排在最前（可自定义镜像源的落地）', async () => {
    addCustomMirror(root, { label: '我的源', base: 'https://mine.example/', mode: 'proxy' })
    setMirrorPref(root, { a: 'https://mine.example/' })
    const st = loadMirrors(root)
    expect(st.pref.a).toBe('https://mine.example/')

    const first: string[] = []
    await downloadRuntime({
      dataRoot: root,
      type: 'a',
      release: RELEASE,
      destFile: join(root, 'a.zip'),
      fetchBuf: async (url) => {
        first.push(url)
        return Buffer.from('x')
      }
    })
    expect(first[0]).toBe('https://mine.example/https://github.com/AstrBotDevs/AstrBot/releases/download/v4.28.0/AstrBot-v4.28.0-dashboard.zip')
  })

  it('下载完成后落盘且目录自动创建', async () => {
    const dest = join(root, 'deep', 'nested', 'a.zip')
    await downloadRuntime({
      dataRoot: root,
      type: 'a',
      release: RELEASE,
      destFile: dest,
      fetchBuf: async () => Buffer.from('ok')
    })
    expect(existsSync(dest)).toBe(true)
  })

  it('进度回调按已收字节上报', async () => {
    const seen: number[] = []
    await downloadRuntime({
      dataRoot: root,
      type: 'a',
      release: RELEASE,
      destFile: join(root, 'a.zip'),
      fetchBuf: async (_url, onProgress) => {
        onProgress?.(50, 100)
        onProgress?.(100, 100)
        return Buffer.from('abcd')
      },
      onProgress: (got) => seen.push(got)
    })
    expect(seen).toEqual([50, 100])
  })

  it('取消信号：已请求中止时抛「已取消」', async () => {
    await expect(
      downloadRuntime({
        dataRoot: root,
        type: 'a',
        release: RELEASE,
        destFile: join(root, 'a.zip'),
        fetchBuf: async () => {
          throw new Error('aborted')
        },
        isCancelled: () => true
      })
    ).rejects.toThrow(/已取消/)
  })

  it('源顺序里跳过文件型源之外的脏数据（base 为空的直连仍可用）', async () => {
    const urls: string[] = []
    await downloadRuntime({
      dataRoot: root,
      type: 'a',
      release: RELEASE,
      destFile: join(root, 'a.zip'),
      fetchBuf: async (url) => {
        urls.push(url)
        if (url.startsWith('https://gh-proxy.com/')) throw new Error('bad')
        if (url.startsWith('https://ghproxy.net/')) throw new Error('bad')
        if (url.startsWith('https://gh-proxy.net/')) throw new Error('bad')
        /*
         * 官方源也让它失败（模拟"官方源临时不可达"），验证仍能回落到直链。
         * 用常量而不是写死 IP：换服务器时这条模拟自动跟着走，
         * 否则它会静默失效 —— 模拟的坏源变成了"没人请求的地址"，
         * 用例看起来还在跑，其实已经没在验任何东西。
         */
        if (url.startsWith(MX_OFFICIAL_BASE)) throw new Error('bad')
        return Buffer.from('direct-ok')
      }
    })
    expect(urls[urls.length - 1]).toBe(RELEASE.assetUrl)
  })
})

describe('镜像测速（仅代理型可拼 GitHub API）', () => {
  it('测速返回每源延迟，文件型源走自身 versions.json', async () => {
    const { testMirrors } = await import('../../src/main/update/mirror-store-test')
    const calls: string[] = []
    /*
     * 注意注入的是 fetchText（不是旧的 fetchHead）：
     * 光测「能不能连上」不够 —— 一个源可能活着但上面根本没有版本清单，
     * 那种源对用户等于没有。所以测速要真把清单拉下来看有没有内容。
     */
    const res = await testMirrors({
      dataRoot: root,
      fetchText: async (url) => {
        calls.push(url)
        // 让第一个加速源挂掉，验证「连不上 → unreachable」
        if (url.startsWith(SECOND_PROXY.base)) throw new Error('timeout')
        // 代理型源返回 GitHub release 的 JSON；文件型源返回我们自己的清单
        return { status: 200, body: JSON.stringify({ tag_name: 'v4.18.19', files: [{ name: 'x' }] }) }
      },
      now: (() => {
        let t = 0
        return () => (t += 30)
      })()
    })
    // 连不上的源：不可用
    const dead = res.find((r) => r.base === SECOND_PROXY.base)
    expect(dead?.status, `${SECOND_PROXY.base} 应该被判 unreachable`).toBe('unreachable')
    // 通的且有内容：可用，带延迟
    const ok = res.find((r) => r.base === '')
    expect(ok?.status).toBe('ok')
    expect(typeof ok?.ms).toBe('number')
    // 文件型源要真的去拉自己的 versions.json
    expect(calls.some((u) => u.includes(`${MX_OFFICIAL_BASE}files/versions.json`))).toBe(true)
    vi.restoreAllMocks()
  })

  it('连得上但源上没有文件 → 判「不可用」（可用≠连得上）', async () => {
    const { testMirrors } = await import('../../src/main/update/mirror-store-test')
    const res = await testMirrors({
      dataRoot: root,
      fetchText: async (url) => {
        // 全都连得上，但返回空内容 / 空清单
        if (url.includes('ghproxy.net')) return { status: 200, body: '[]' }
        return { status: 200, body: '' }
      }
    })
    for (const r of res) {
      // 空的也算不可用 —— 用户从这儿下不到东西
      expect(r.status).toBe('empty')
    }
  })
})

/*
 * 写盘失败**不能让整个启动器崩**。
 *
 * 这条是真实事故的回归测试：流式下载那段代码里 `createWriteStream` 没有挂
 * 'error' 监听。Node 里写流出错是以 EventEmitter 的 'error' 事件抛的，
 * 没有监听者时会被 rethrow 成 uncaughtException —— 它**不会**被 try/catch
 * 接住，也不会让 out.end(cb) 的回调拿到（这两点我都实测复刻确认过）。
 *
 * 而本应用对 uncaughtException 的处理是弹崩溃框 + app.exit(1)。
 * 于是磁盘满（下 NapCat 要 117MB）、权限被拒、路径过长、杀软锁文件时，
 * 用户得到的不是「下载失败：磁盘空间不足」，而是**整个启动器崩掉**。
 *
 * 为什么要直接测 defaultFetchToFile 而不是 downloadRuntime：
 * 我第一版就是走 downloadRuntime 的，结果那条测试**是假的** ——
 * 因为 downloadRuntime 在写流之前先对目标做了 `rmSync`（第 215/231 行），
 * 「目标是个目录」会在那一步就抛 ERR_FS_EISDIR，
 * 压根没走到写流。反向验证（去掉 error 监听）仍然全绿，才发现的。
 * 所以要单独把这个函数拿出来测。
 */
describe('写盘失败要报错，不能崩进程', () => {
  it('写流出错时以 rejected promise 的形式抛出来（不是 uncaughtException）', async () => {
    const { defaultFetchToFile } = await import('../../src/main/update/runtime-download')

    /*
     * 制造一个**只在写入阶段**才会失败的目标。
     *
     * 原来用的是「流创建之后把父目录删掉」，写错误取自实测经验，但那条经验
     * 来自 Linux/CI。在 Windows 上这个手法**根本不产生错误**：删掉含打开句柄
     * 的目录之后，句柄继续往那个"已无名"的文件里写，写入全程成功，promise
     * 正常 resolve —— 于是这条测试在 Windows 上一直红着，测的其实是成功路径。
     * （实测确认：rmSync 成功、父目录消失，但 end 回调到达时写错误次数为 0。）
     *
     * 改用一个两个平台都真的会失败、且 Windows 上实测得到 EISDIR 的手法：
     * 让 dest 指向一个**已存在的目录**。createWriteStream 打开它时直接报错，
     * 正是我们要覆盖的「写入阶段失败」。
     */
    const parent = join(root, 'vanish')
    mkdirSync(parent, { recursive: true })
    const dest = join(parent, 'x.bin')
    // dest 本身建造成目录 —— 写这个路径必然 EISDIR
    mkdirSync(dest, { recursive: true })

    let uncaught: unknown = null
    const onUncaught = (e: unknown): void => {
      uncaught = e
    }
    process.on('uncaughtException', onUncaught)

    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      // 每次给一个全新的 stream（复用会 locked）
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < 200; i++) {
            c.enqueue(new Uint8Array(64 * 1024))
          }
          c.close()
        }
      })
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(200 * 64 * 1024) }),
        body
      } as unknown as Response
    }) as typeof fetch

    try {
      // 必须是 reject（调用方能换源重试），而不是把进程带走
      await expect(defaultFetchToFile('https://example.com/x.bin', dest)).rejects.toBeTruthy()

      await new Promise((r) => setTimeout(r, 300))
      expect(
        uncaught,
        `写盘失败不能变成 uncaughtException（那会崩掉整个启动器）：${String(uncaught)}`
      ).toBe(null)
    } finally {
      process.off('uncaughtException', onUncaught)
      globalThis.fetch = realFetch
    }
  }, 30000)

  it('正常写盘要能落对内容（别把正常路径也判死）', async () => {
    const { defaultFetchToFile } = await import('../../src/main/update/runtime-download')
    const dest = join(root, 'good.bin')

    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '5' }),
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('hello'))
            c.close()
          }
        })
      }) as unknown as Response) as typeof fetch

    try {
      const r = await defaultFetchToFile('https://example.com/good.bin', dest)
      expect(readFileSync(dest, 'utf8')).toBe('hello')
      expect(r.bytes).toBe(5)
      // 哈希要跟内容对得上（增量哈希没算错）
      expect(r.sha256).toBe(createHash('sha256').update('hello').digest('hex'))
    } finally {
      globalThis.fetch = realFetch
    }
  }, 30000)
})
