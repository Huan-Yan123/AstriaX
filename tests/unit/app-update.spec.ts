/*
 * 启动器自身更新的契约（用户要求，逐条钉住）：
 *
 *   1. 设置里显示「当前版本」+「检查更新」
 *   2. 不是最新版 → 显示需要更新
 *   3. 点更新 → 从服务器下载最新版**全量包**到**系统默认下载目录**
 *   4. 从服务器获取版本失败 → 显示「最新版」（用户明确这么要求）
 *   5. 每次启动检测一次
 *   6. 一天最多推一次
 *   7. 可「跳过此版本」，等下一个版本再提示
 *
 * 还有一条来自用户的硬约束：
 *   **「更新只能是用户运行更新版本的安装包走安装流程来更新」**
 *   → 所以这里的实现**只下载、不自动运行安装包**，也不自替换 exe。
 *     下面有专门的测试钉死这一点（绝不能把下载完的文件 exec 起来）。
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  isNewerVersion,
  isCheckDue,
  isVersionSkipped,
  checkAppUpdate,
  fileNameFromUrl,
  downloadAppUpdate,
  versionedInstallerName
} from '../../src/main/update/app-update'
import { buildHandlers } from '../../src/main/ipc'
import { testStage } from '../helpers/stage'

describe('版本号比较', () => {
  it('按数字段比，不是按字符串比（1.2.10 > 1.2.9）', () => {
    // 字符串比较会得出 "1.2.10" < "1.2.9" 的错误结论
    expect(isNewerVersion('1.2.10', '1.2.9')).toBe(true)
    expect(isNewerVersion('1.2.9', '1.2.10')).toBe(false)
  })

  it('常规递增', () => {
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
  })

  it('相同版本不算更新', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
  })

  it('低版本不算更新（不能"更新"回旧版）', () => {
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false)
  })

  it('容忍 v 前缀和预发布后缀，且不崩', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true)
    // 后缀段解析不出来当 0，至少顺序稳定
    expect(isNewerVersion('0.2.0-beta', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.2.0-beta')).toBe(false)
  })

  it('段数不同也能比（0.1 与 0.1.0 视为相同）', () => {
    expect(isNewerVersion('0.1', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.1', '0.1')).toBe(true)
  })
})

describe('一天推一次', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('从没检查过 → 该检查（首次启动要能推）', () => {
    expect(isCheckDue(undefined, Date.now())).toBe(true)
    expect(isCheckDue(0, Date.now())).toBe(true)
  })

  it('不满一天 → 不检查', () => {
    const now = 1_700_000_000_000
    expect(isCheckDue(now - 1000, now)).toBe(false)
    expect(isCheckDue(now - DAY + 60_000, now)).toBe(false)
  })

  it('满一天 → 检查', () => {
    const now = 1_700_000_000_000
    expect(isCheckDue(now - DAY, now)).toBe(true)
    expect(isCheckDue(now - DAY - 1, now)).toBe(true)
  })

  it('★按时间间隔算，不是按"今天日期"算', () => {
    /*
     * 用户晚上 23:59 启动过、00:01 再启动（跨天了但只隔 2 分钟）。
     * 如果按日期判断，会认为"新的一天"又推一次 —— 明显不合理。
     */
    const base = new Date('2026-09-13T23:59:00').getTime()
    const twoMinLater = new Date('2026-09-14T00:01:00').getTime()
    expect(isCheckDue(base, twoMinLater), '跨天但只隔 2 分钟，不该再推').toBe(false)
  })

  it('系统时钟被往回调（lastAt 在未来）也要能继续检查', () => {
    const now = 1_700_000_000_000
    expect(isCheckDue(now + DAY * 10, now), '否则会永远不再检查').toBe(true)
  })
})

describe('跳过此版本', () => {
  it('跳过的是"这个版本"，下个版本照样提示', () => {
    expect(isVersionSkipped('0.1.1', '0.1.1'), '当前就是被跳过的版本 → 不提示').toBe(true)
    expect(isVersionSkipped('0.1.2', '0.1.1'), '出了下一个版本 → 要提示').toBe(false)
  })

  it('没跳过过任何版本 → 不跳过', () => {
    expect(isVersionSkipped('0.1.1', undefined)).toBe(false)
  })

  it('拿不到最新版本号时视为跳过（无从提示）', () => {
    expect(isVersionSkipped(undefined, '0.1.1')).toBe(true)
  })
})

describe('检查更新', () => {
  const cur = '0.1.0'
  const url = 'http://47.109.177.13/mxbot/latest.json'

  it('服务器版本更新 → hasUpdate，并带上大小和地址', async () => {
    const r = await checkAppUpdate({
      currentVersion: cur,
      manifestUrl: url,
      fetchJson: async () =>
        JSON.stringify({
          version: '0.1.1',
          url: 'AstriaX-Setup-0.1.1.exe',
          size: 83_550_075,
          sha256: 'abc'
        })
    })
    expect(r.hasUpdate).toBe(true)
    expect(r.latestVersion).toBe('0.1.1')
    // 相对路径要能拼成绝对地址（发布时不用把域名写进清单）
    expect(r.url).toBe('http://47.109.177.13/mxbot/AstriaX-Setup-0.1.1.exe')
    expect(r.sizeMB).toBeCloseTo(79.7, 1)
  })

  it('服务器版本相同 → 没有更新', async () => {
    const r = await checkAppUpdate({
      currentVersion: cur,
      manifestUrl: url,
      fetchJson: async () => JSON.stringify({ version: '0.1.0', url: 'x.exe' })
    })
    expect(r.hasUpdate).toBe(false)
  })

  it('清单结构不对 → 当作没有更新，而不是抛出去让界面报错', async () => {
    const r = await checkAppUpdate({
      currentVersion: cur,
      manifestUrl: url,
      fetchJson: async () => JSON.stringify({ oops: true })
    })
    expect(r.hasUpdate).toBe(false)
  })

  it('网络/服务器失败 → 抛出去，由调用方决定显示"最新版"', async () => {
    // 用户要求：取版本失败就显示最新版。这里保持"能区分失败与没更新"，
    // 由上层决定怎么呈现（上层测试在下面）
    await expect(
      checkAppUpdate({
        currentVersion: cur,
        manifestUrl: url,
        fetchJson: async () => {
          throw new Error('连接超时')
        }
      })
    ).rejects.toThrow('连接超时')
  })
})

describe('文件名与路径安全', () => {
  it('从 URL 取文件名', () => {
    expect(fileNameFromUrl('http://a.com/x/AstriaX-Setup-0.1.1.exe')).toBe('AstriaX-Setup-0.1.1.exe')
    expect(fileNameFromUrl('http://a.com/x/f.exe?token=abc')).toBe('f.exe')
  })

  it('★挡掉路径穿越（不能让下载写到目录外面去）', () => {
    const n = fileNameFromUrl('http://a.com/x/..%2F..%2Fevil.exe')
    expect(n.includes('..'), `不该保留 ..：${n}`).toBe(false)
    expect(n.includes('/'), `不该保留斜杠：${n}`).toBe(false)
    expect(n.includes('\\'), `不该保留反斜杠：${n}`).toBe(false)
  })

  it('URL 不合法时给兜底名', () => {
    expect(fileNameFromUrl('not a url')).toBe('AstriaX-Setup.exe')
  })

  it('安装包名带版本号，新旧不互相覆盖', () => {
    expect(versionedInstallerName('0.1.1')).toBe('AstriaX-Setup-0.1.1.exe')
    // 版本号里的奇怪字符要清掉（防注入到文件名）
    expect(versionedInstallerName('../etc/passwd')).toBe('AstriaX-Setup-..etcpasswd.exe')
  })
})

describe('下载全量包', () => {
  /*
   * 用 testStage 而不是 os.tmpdir()。
   *
   * 项目约定的原因很实在：原来 41 个测试文件都往 C:\...\Temp 扔东西，
   * 有 e2e 会真装 Python（100MB+）/ 真下 NapCat（117MB），
   * 跑几轮就把 C 盘吃掉七十多 GB。testStage 落在项目 data\cache\tmp 下，
   * 满了能一眼看见，不会偷偷撑爆系统盘。
   */
  function tmpDir(): string {
    return testStage('app-upd')
  }

  it('下到指定目录并返回最终路径', async () => {
    const dir = tmpDir()
    try {
      const out = await downloadAppUpdate({
        dir,
        url: 'http://a.com/AstriaX-Setup-0.1.1.exe',
        fetchToFile: async (_u, p) => {
          writeFileSync(p, 'FAKE-INSTALLER')
          return 14
        }
      })
      expect(existsSync(out)).toBe(true)
      expect(readFileSync(out, 'utf8')).toBe('FAKE-INSTALLER')
      expect(out.startsWith(dir), '必须落在指定目录里').toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★先落 .part 再改名：中途失败不留"半截 exe"', async () => {
    const dir = tmpDir()
    try {
      await expect(
        downloadAppUpdate({
          dir,
          url: 'http://a.com/x.exe',
          fetchToFile: async (_u, p) => {
            writeFileSync(p, 'HALF')
            throw new Error('连接中断')
          }
        })
      ).rejects.toThrow('连接中断')
      // 关键：不能留下一个看起来完整、其实半截的 exe（用户会双击装出坏程序）
      expect(existsSync(join(dir, 'x.exe'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sha256 不匹配 → 报错并删掉残file', async () => {
    const dir = tmpDir()
    try {
      await expect(
        downloadAppUpdate({
          dir,
          url: 'http://a.com/x.exe',
          expectSha256: 'deadbeef',
          fetchToFile: async (_u, p) => {
            writeFileSync(p, 'WRONG')
            return 5
          }
        })
      ).rejects.toThrow(/校验失败/)
      expect(existsSync(join(dir, 'x.exe')), '坏文件不能留下').toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sha256 匹配 → 正常完成', async () => {
    const dir = tmpDir()
    try {
      const body = 'GOOD-PAYLOAD'
      const sha = createHash('sha256').update(body).digest('hex')
      const out = await downloadAppUpdate({
        dir,
        url: 'http://a.com/x.exe',
        expectSha256: sha,
        fetchToFile: async (_u, p) => {
          writeFileSync(p, body)
          return body.length
        }
      })
      expect(existsSync(out)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('0 字节当失败（服务器给了个空文件）', async () => {
    const dir = tmpDir()
    try {
      await expect(
        downloadAppUpdate({
          dir,
          url: 'http://a.com/x.exe',
          fetchToFile: async (_u, p) => {
            writeFileSync(p, '')
            return 0
          }
        })
      ).rejects.toThrow(/0 字节/)
      expect(existsSync(join(dir, 'x.exe'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目标目录不存在会自动建（系统下载目录被改过/删过）', async () => {
    const base = tmpDir()
    const dir = join(base, 'nested', 'downloads')
    try {
      const out = await downloadAppUpdate({
        dir,
        url: 'http://a.com/y.exe',
        fetchToFile: async (_u, p) => {
          writeFileSync(p, 'Z')
          return 1
        }
      })
      expect(existsSync(out)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('进度回调会被调用，百分比边界正常', async () => {
    const dir = tmpDir()
    try {
      const seen: number[] = []
      await downloadAppUpdate({
        dir,
        url: 'http://a.com/z.exe',
        onProgress: (p) => seen.push(p.percent),
        fetchToFile: async (_u, p, onProg) => {
          onProg?.(0, 100)
          onProg?.(50, 100)
          onProg?.(100, 100)
          writeFileSync(p, 'X'.repeat(100))
          return 100
        }
      })
      expect(seen).toEqual([0, 50, 100])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('★更新方式：只下载，绝不自动运行安装包', () => {
  /**
   * 用一个**真实存在的**临时目录当「系统下载目录」。
   *
   * 不能用 `C:\Users\x\Downloads` 这种假路径：那样 mkdir 会 EPERM，
   * 测试变成在测"目录建不出来"，而不是在测我们的契约。
   */
  function fakeDownloads(): string {
    return testStage('app-dl')
  }

  it('app-update.ts 里不能出现启动外部进程的调用', () => {
    /*
     * 用户硬约束：「更新只能是用户运行更新版本的安装包走安装流程来更新」。
     *
     * 所以实现里**不能**有 shell.openPath / execFile / spawn /
     * child_process 之类把安装包跑起来的动作，也不能自替换 exe。
     * 一旦有人加了"下完自动装"，这条测试立刻变红。
     */
    const src = readFileSync(join(__dirname, '../../src/main/update/app-update.ts'), 'utf8')
    const banned = ['child_process', 'openPath', 'shell.open', 'execSync', 'spawnSync', 'execFile']
    for (const b of banned) {
      expect(src.includes(b), `不该出现 ${b}（更新只能由用户自己运行安装包）`).toBe(false)
    }
  })

  it('下载目录由主进程注入，落在该目录且文件名带版本号', async () => {
    /*
     * 用户要求「下载到系统默认文件夹」—— 用户要能自己看到并双击它。
     *
     * 这条测试**曾经是假绿的**，记录一下免得再犯：
     * 第一版写成「检查 ipc.ts 里有没有 `getPath('downloads')`」，
     * 结果它命中的是我写在 HandlerOpts 上的**注释**（那里举例说
     * 生产会传 app.getPath('downloads')），真实代码里根本没有这句。
     * 断言恒为真，删掉实现也照样绿。
     *
     * 现在改成跑真实行为：目录由 downloadsDir 注入，落盘路径必须
     * 就在那个目录里、且文件名带版本号。
     */
    const dir = fakeDownloads()
    try {
      const h = buildHandlers({
        probe: () => Promise.resolve(true),
        downloadsDir: () => dir,
        appVersion: () => '0.1.0',
        fetchUpdateToFile: async (_url, outPath) => {
          writeFileSync(outPath, 'PK-fake-installer')
          return 18
        }
      })
      const saved = (await h['app:downloadUpdate']({
        url: 'http://a.com/AstriaX-Setup-0.1.1.exe',
        version: '0.1.1'
      })) as string

      expect(saved.startsWith(dir), '必须落在注入的下载目录里').toBe(true)
      expect(saved).toContain('AstriaX-Setup-0.1.1.exe')
      expect(existsSync(saved), '文件要真的落盘，用户才能去双击').toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★下载完只返回路径，不会去运行这个安装包', async () => {
    /*
     * 用户硬约束：「更新只能是用户运行更新版本的安装包走安装流程来更新」。
     *
     * 跑完整条 handler，断言返回的是**路径字符串**（界面拿去展示给用户），
     * 而不是"已安装成功"之类的结果 —— 安装这件事根本不由我们做。
     */
    const dir = fakeDownloads()
    try {
      let fetchCalls = 0
      const h = buildHandlers({
        probe: () => Promise.resolve(true),
        downloadsDir: () => dir,
        appVersion: () => '0.1.0',
        fetchUpdateToFile: async (_url, outPath) => {
          fetchCalls++
          writeFileSync(outPath, 'X')
          return 1
        }
      })
      const saved = (await h['app:downloadUpdate']({
        url: 'http://a.com/AstriaX-Setup-0.1.1.exe',
        version: '0.1.1'
      })) as string

      expect(fetchCalls).toBe(1)
      expect(typeof saved, '返回路径给用户，由用户自己双击').toBe('string')
      expect(saved).toContain('AstriaX-Setup-0.1.1.exe')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
