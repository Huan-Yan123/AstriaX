/*
 * ★★ 「同版本也报更新」+「点下载没反应」—— 两个现象，同一处根因
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 主人反馈（2026-09-27，0.1.6 上实测）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   当前版本 / 检查更新
 *   AstriaX 0.1.6
 *   发现新版本 0.1.6 呀
 *   [下载更新] [跳过这个版本]
 *
 *   然后：「点下载怎么没反应」。
 *
 * ## 根因：`app:checkUpdate` 有**两个真相来源**在打架
 *
 * 原来的手动检查路径：
 *     const via = await viaLibrary()            // electron-updater
 *     if (via?.hasUpdate) {
 *       const detail = await safeCheck(current) // 我们自己的 latest.json
 *       const merged = detail.hasUpdate ? detail : { ...via, url: undefined }
 *       return merged
 *     }
 *
 * 于是：
 *   · electron-updater 说"有新版"（它读 app-update.yml，比较逻辑与我们的
 *     清单无关）→ 但 latest.json 说没有 → 合成出 `hasUpdate: true, url: undefined`
 *     → 界面显示"发现新版本 0.1.6"，而**点下载时渲染层第一行就是
 *       `if (!info?.url) return`（静默返回）** → "点了没反应"
 *   · 同版本报更新的那一半，就是 electron-updater 的 hasUpdate 恒被采信
 *
 * ## 修法
 *
 * **只有一个真相来源：latest.json**（`safeCheck`）。
 * 它一次给出 hasUpdate / url / sha256 / sizeMB / notes —— 正好是
 * 渲染层"下载"需要的全部字段，不会再出现"有更新但没直链"的组合。
 *
 * ## 这条测试守什么
 *
 *   1. 同版本 ⇒ hasUpdate=false（不管是哪个来源）
 *   2. **hasUpdate=true 时，url 必须同时存在**（这是"点了没反应"的根治）
 *   3. electron-updater 那条路径不能参与"有没有新版"的判定
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { checkAppUpdate } from '../../src/main/update/app-update'

/** 去掉注释，避免把说明文字当代码（项目里踩过这个坑） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')
}

describe('★同版本不报更新 / 报更新就必须能下载', () => {
  it('同版本 ⇒ hasUpdate=false（清单也是同版本）', async () => {
    const r = await checkAppUpdate({
      currentVersion: '0.1.6',
      manifestUrl: 'https://example.com/mxbot/latest.json',
      fetchJson: async () =>
        JSON.stringify({
          version: '0.1.6',
          url: 'AstriaX-Setup-0.1.6.exe',
          size: 84_834_189,
          sha256: 'ff00'
        })
    })
    expect(r.hasUpdate, '同版本不该报更新').toBe(false)
  })

  it('★有更新时 url 必须存在（否则界面"点了没反应"）', async () => {
    const r = await checkAppUpdate({
      currentVersion: '0.1.6',
      manifestUrl: 'https://example.com/mxbot/latest.json',
      fetchJson: async () =>
        JSON.stringify({
          version: '0.1.7',
          url: 'AstriaX-Setup-0.1.7.exe',
          size: 84_900_000,
          sha256: 'AA11bb22',
          notes: '修了点东西'
        })
    })
    expect(r.hasUpdate).toBe(true)
    /*
     * 这一条是"点了没反应"的**根治断言**：
     * 只要 hasUpdate 为真，url 就必须能拿到（相对路径也要拼成绝对地址）。
     */
    expect(r.url, 'hasUpdate=true 却没有 url ⇒ 界面点下载会静默无反应').toBeTruthy()
    expect(r.url, '相对路径要拼成绝对地址').toMatch(/^https:\/\/example\.com\/mxbot\//)
    expect(r.sha256, 'sha256 也要带上（下载校验用）').toBe('aa11bb22')
    expect(r.sizeMB, '大小要给（界面显示用）').toBeGreaterThan(0)
  })

  it('★源码守卫：`app:checkUpdate` 不许再造"有更新但没直链"的组合', () => {
    /*
     * 这条是源码级守卫（和 ipc-app-import-guard 同一个思路）——
     * 因为那个 bug 的表现是"两个来源拼出来的对象缺字段"，
     * 单测很难覆盖每一种组合，而源码形状能直接钉住。
     */
    const src = stripComments(readFileSync(join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8'))

    expect(
      src.includes('url: undefined'),
      'ipc.ts 里又出现了 `url: undefined` —— 那正是"显示有更新但点下载没反应"的写法。\n' +
        '正确做法：只信 latest.json（safeCheck），它永远同时给出 hasUpdate 与 url。'
    ).toBe(false)

    expect(
      /const\s+viaLibrary\s*=/.test(src),
      'viaLibrary 又回来了 —— electron-updater 不能参与"有没有新版"的判定' +
        '（它读 app-update.yml，与 latest.json 语义不一致，会造出同版本报更新）。\n' +
        '它只该用在增量下载（app:downloadUpdate）。'
    ).toBe(false)
  })

  it('★渲染层守卫：doUpdate 缺 url 时不许静默返回', () => {
    const src = stripComments(
      readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'SettingsPanel.vue'), 'utf8')
    )
    const i = src.indexOf('async function doUpdate')
    expect(i, '找不到 doUpdate').toBeGreaterThan(0)
    const body = src.slice(i, i + 1600)
    /*
     * 光秃秃的 `if (!info?.url || !info.version) return` 就是原来那句 ——
     * 它让"点了没反应"成为可能。现在必须在 return 之前给用户一句提示。
     */
    expect(
      /if\s*\(!info\?\.url\s*\|\|\s*!info\.version\)\s*\{/.test(body),
      'doUpdate 里那句缺字段的检查必须**带提示体**（不能是裸 return）——\n' +
        '否则用户会遇到"点了下载毫无反应、也没有报错"。'
    ).toBe(true)
    expect(
      /updMsg\.value\s*=/.test(body),
      '缺字段时要给出一句可读的提示'
    ).toBe(true)
  })
})
