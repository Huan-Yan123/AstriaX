/*
 * electron-updater 接进 IPC 后的行为契约。
 *
 * ## 这条测试要守的核心
 *
 * 「**不打破现有可用流程**」。更新下载是用户点下去就必须成功的事，
 * 而 electron-updater 依赖打包态 + app-update.yml + 服务器配置，
 * 任何一环出问题都可能失败。所以接法是：
 *
 *   注入了 appUpdater → 先试它（增量下载，省流量）
 *   它失败 / 没注入   → **安静回落到手写整包下载**（原路径，有 sha256 校验）
 *
 * 这里就把这两半都钉住 —— 尤其是"失败必须回落"，
 * 因为那正是"接了新库之后用户反而更常失败"的典型翻车方式。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { buildHandlers } from '../../src/main/ipc'
import type { AppUpdater } from '../../src/main/update/app-updater'
import { testStage } from '../helpers/stage'

let root: string
let downloads: string

beforeEach(() => {
  root = testStage('ipc-updater-')
  downloads = join(root, 'Downloads')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 假 appUpdater：可选择成功返回路径，或抛错 */
function fakeUpdater(mode: { ok: true; file: string } | { ok: false; msg: string }): AppUpdater {
  return {
    async check() {
      return mode.ok ? { hasUpdate: true, version: '0.1.9' } : { hasUpdate: false, reason: 'boom' }
    },
    async download() {
      if (!mode.ok) throw new Error(mode.msg)
      return { file: mode.file }
    }
  }
}

function make(mode: { ok: true; file: string } | { ok: false; msg: string } | null) {
  const fetched: string[] = []
  const h = buildHandlers({
    probe: () => Promise.resolve(true),
    downloadsDir: () => downloads,
    appVersion: () => '0.1.3',
    appUpdater: mode ? fakeUpdater(mode) : undefined,
    fetchUpdateToFile: async (_url, outPath) => {
      fetched.push(outPath)
      writeFileSync(outPath, 'PK-fake-full-installer')
      return 20
    }
  })
  return { h, fetched }
}

describe('★app:downloadUpdate：优先增量，失败回落整包', () => {
  it('注入了 appUpdater → 用它下载，返回它给的路径', async () => {
    const incFile = join(downloads, 'AstriaX-Setup-0.1.9.exe')
    const { h, fetched } = make({ ok: true, file: incFile })

    const saved = (await h['app:downloadUpdate']({
      url: 'http://x/mxbot/AstriaX-Setup-0.1.9.exe',
      version: '0.1.9'
    })) as string

    expect(saved, '应当返回增量下载给出的路径').toBe(incFile)
    expect(fetched, '走增量就不该再走手写整包下载').toEqual([])
  })

  it('★appUpdater 抛错 → 回落到手写整包下载（用户点下载不能失败）', async () => {
    const { h, fetched } = make({ ok: false, msg: '增量失败（blockmap 缺失）' })

    const saved = (await h['app:downloadUpdate']({
      url: 'http://x/mxbot/AstriaX-Setup-0.1.9.exe',
      version: '0.1.9'
    })) as string

    expect(fetched.length, '应当回落到手写下载').toBe(1)
    expect(existsSync(saved), '回落路径也要真的落盘').toBe(true)
    expect(readFileSync(saved, 'utf8')).toContain('fake-full-installer')
    // 文件名带版本号（新旧安装包不互相覆盖）—— 这是原来的契约，不能被改掉
    expect(saved).toContain('0.1.9')
  })

  it('没注入 appUpdater（开发态/依赖缺失）→ 直接走手写下载', async () => {
    const { h, fetched } = make(null)
    const saved = (await h['app:downloadUpdate']({
      url: 'http://x/mxbot/AstriaX-Setup-0.1.9.exe',
      version: '0.1.9'
    })) as string
    expect(fetched.length).toBe(1)
    expect(existsSync(saved)).toBe(true)
  })
})

describe('★app:checkUpdate：库与手写两条路都要能出结论', () => {
  it('注入的库说"没有新版" → 返回 hasUpdate:false（不再打扰服务器）', async () => {
    const { h } = make({ ok: false, msg: 'x' }) // 这个假对象 check() 返回 reason → 会回落
    const r = (await h['app:checkUpdate']({ force: true })) as { hasUpdate: boolean }
    // 回落之后没有 fetchUpdateManifest 注入 → 手写检查也说没有新版
    expect(r.hasUpdate).toBe(false)
  })

  it('没注入库 → 依然返回结构完整的结论（不抛）', async () => {
    const { h } = make(null)
    const r = (await h['app:checkUpdate']({ force: true })) as { currentVersion?: string }
    expect(r.currentVersion).toBe('0.1.3')
  })
})
