/*
 * ★★ 下载更新的地址必须指向 **Releases**，不能是仓库根目录
 *    （主人 2026-10-08 实测：点「下载更新」报 HTTP 404）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 现场与根因
 * ══════════════════════════════════════════════════════════════════════════
 *
 *     Error invoking remote method 'app:downloadUpdate':
 *     Error: 下载失败：HTTP 404
 *
 * 链路是这样的：
 *
 *   1. `latest.json` 里 `url` 写的是**相对路径**（`AstriaX-Setup-1.0.1.exe`）
 *      —— 这是刻意的，为了让加速源能前缀拼接（写死绝对地址就拼不上了）
 *   2. `checkAppUpdate` 会把相对路径按**清单所在目录**解析，得到：
 *        https://raw.githubusercontent.com/<owner>/<repo>/main/AstriaX-Setup-1.0.1.exe
 *                                                          ↑ 仓库根目录
 *   3. 而安装包是 **Release 资产**，不在仓库里 → 404
 *
 * 正确的地址形如：
 *     https://github.com/<owner>/<repo>/releases/latest/download/AstriaX-Setup-1.0.1.exe
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 修法与它暴露的另一个问题
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `app:downloadUpdate` 改成：**从清单 url 里取文件名**，调
 * `installerUrls()` 拼出全部候选（六个加速源 + 直链），
 * 再 `pickFastestSource()` 并发测速选最快的那个下载。
 *
 * 顺带发现：`installerUrls` 之前**写了但没人调用**（死代码）——
 * 那正是本 bug 的成因（安装包下载走的是"清单 url 原样用"那条路）。
 *
 * 另外 `pickFastestSource` 当时**根本不存在**（我在 ipc 里调用了它，
 * 但函数没实现）—— 说明那次改动根本没编译过就提交了。这条测试也盯着它。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { installerUrls, GITHUB_RAW_BASE } from '../../src/main/update/publish-urls'

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8')
const IPC = read('src', 'main', 'ipc.ts')
const APP_UPDATE = read('src', 'main', 'update', 'app-update.ts')

describe('★ 下载更新：地址与测速', () => {
  it('★★ installerUrls 必须指向 releases/latest/download', () => {
    const urls = installerUrls('AstriaX-Setup-1.0.1.exe')
    expect(urls.length, '应当给出全部候选（加速源 + 直链）').toBeGreaterThanOrEqual(2)

    for (const u of urls) {
      expect(
        u.url,
        `${u.label} 的地址不对：${u.url}\n` +
          '安装包在 **Releases** 里，不是仓库根目录 —— 指向 raw.githubusercontent.com ' +
          '必然 404（这正是主人遇到的那个报错）'
      ).toContain('releases/latest/download/')
      expect(u.url).toContain('AstriaX-Setup-1.0.1.exe')
    }

    /* 直链根常量本身也要对 */
    expect(GITHUB_RAW_BASE).toContain('releases/latest/download/')
    expect(
      GITHUB_RAW_BASE.includes('raw.githubusercontent.com'),
      'GITHUB_RAW_BASE 是**下载安装包**用的，不能是 raw 仓库地址'
    ).toBe(false)
  })

  it('★★ app:downloadUpdate 必须用 installerUrls 重拼地址（不能直接用量表里的 url）', () => {
    const start = IPC.indexOf("'app:downloadUpdate': async")
    expect(start, '找不到 app:downloadUpdate').toBeGreaterThan(-1)
    const body = IPC.slice(start, start + 6000)

    expect(
      body.includes('installerUrls('),
      '★没有调用 installerUrls —— 那就会直接用清单里那个相对路径解析出的地址，\n' +
        '它指向仓库根目录而不是 Releases，必然 404。'
    ).toBe(true)

    /*
     * 从清单 url 里取文件名 —— 这是"重拼"的关键动作。
     * 不取文件名而直接用整个 url 的话，就退回了错误的老路。
     */
    expect(
      /split\('\/'\)\.pop\(\)/.test(body),
      '要从清单的 url 里**取出文件名**再重拼（清单给的相对路径只用来传文件名）'
    ).toBe(true)
  })

  it('★ 下载前要测速选源（不是按顺序试）', () => {
    const start = IPC.indexOf("'app:downloadUpdate': async")
    const body = IPC.slice(start, start + 6000)
    expect(
      body.includes('pickFastestSource('),
      '要用 pickFastestSource 并发测速选最快 ——\n' +
        '"按顺序试"的缺陷是：第一个源若能连上但极慢，用户就得用它下完 80MB'
    ).toBe(true)
    /* 测速失败要能回落，不能直接崩 */
    expect(
      /pickFastestSource\([\s\S]{0,120}?\.catch\(/.test(body),
      '测速要 catch —— 全部探测失败时回落到清单地址，而不是让下载直接失败'
    ).toBe(true)
  })

  it('★★ pickFastestSource 必须真的存在（我犯过"调用了但没实现"的错）', () => {
    expect(
      APP_UPDATE.includes('export async function pickFastestSource'),
      'pickFastestSource 没实现 —— 上一次改动就是因为这个**根本编译不过**，\n' +
        '却照样推到 GitHub 了。它必须在 app-update.ts 里真的存在。'
    ).toBe(true)
    /* 而且要和 ipc 里的 import 对得上 */
    expect(
      /import \{[\s\S]{0,400}pickFastestSource[\s\S]{0,200}\} from '\.\/update\/app-update'/.test(
        IPC
      ),
      'ipc.ts 要从 app-update 导入 pickFastestSource'
    ).toBe(true)
  })

  it('★ 测速探针用 GET + Range（不用 HEAD）', () => {
    const start = APP_UPDATE.indexOf('export async function pickFastestSource')
    const body = APP_UPDATE.slice(start, start + 2500)
    /*
     * 为什么不用 HEAD：有些加速源对 HEAD 的响应跟 GET 完全不同
     *（有的直接 405），测出来的耗时没有参考价值。
     */
    expect(body.includes("'bytes=0-0'"), '要用 Range: bytes=0-0 只取首字节，测首字节时间').toBe(true)
    expect(
      !/method:\s*'HEAD'/.test(body),
      '不要用 HEAD 探测 —— 部分加速源对它的响应与 GET 不同'
    ).toBe(true)
    /*
     * 200 与 206 都算通：206 是接受 Range 的理想情况；
     * 200 是服务器忽略 Range 直接发全量（也算能下，我们会立刻中断）。
     */
    expect(
      body.includes('r.status !== 200 && r.status !== 206'),
      '要同时接受 200 与 206 —— 只认 206 会把忽略 Range 的源误判为不通'
    ).toBe(true)
    /* 探完要把 body 丢掉，否则连接被占着 */
    expect(body.includes('.cancel()'), '探测后要 cancel body，别占着连接').toBe(true)
  })
})
