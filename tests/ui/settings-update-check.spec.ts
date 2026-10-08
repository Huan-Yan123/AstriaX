/*
 * 设置面板的「检查更新」。
 *
 * ## 用户报告的三件事（原话）
 *
 *   1. 「当前版本 MXBot 未知」
 *   2. 「（检查更新失败：Error invoking remote method 'app:checkUpdate':
 *       ReferenceError: app is not defined）」
 *   3. 「不是说了检查失败就显示最新版吗，为什么还要显示报错，报错不应该显示出来」
 *
 * ## 三个根因
 *
 * ① **主进程 `app` 未定义**（第 2 条的直接原因）。
 *    ipc.ts 顶层不 import electron（单测跑纯 node），文件里所有用到 app 的
 *    地方都是函数内 `await import('electron')` 懒取。但装配处写了
 *    `appVersion: () => app.getVersion()` —— 这是**对象字面量里的表达式**，
 *    在模块装配阶段求值时 `app` 不在作用域里，于是 ReferenceError。
 *    `app:version` 走同一个箭头函数，所以版本也拿不到 → 第 1 条
 *    「MXBot 未知」是同一个根因的另一个症状，不是两个独立 bug。
 *
 * ② **渲染层读错字段**。主进程返回的是 `latestVersion`，
 *    而 SettingsPanel 读 `r.version` —— 永远 undefined。
 *    就算检查成功了，也只会显示「发现新版本 undefined」。
 *
 * ③ **失败时仍把原始报错贴出来**。`updErr.value = false` 只控制了
 *    样式（不标红），但那句 `（检查更新失败：<原始异常>）` 照样渲染。
 *    用户要的是「失败就当最新版、**不要显示报错**」，
 *    而原始异常对普通用户毫无意义（那句 ReferenceError 更是纯噪音）。
 *
 * ## 注意挂载方式
 * 面板是 `<Teleport to="body">` 渲染的，断言必须读 `document.body.textContent`，
 * 看 `wrapper.text()` 永远是空的。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsPanel from '../../src/renderer/src/SettingsPanel.vue'

interface CheckResult {
  hasUpdate: boolean
  currentVersion?: string
  latestVersion?: string
  url?: string
  sizeMB?: number
}

function install(opts: {
  version?: string
  check?: () => Promise<CheckResult>
  checkThrows?: Error
}): void {
  const w = window as unknown as { launcher: unknown }
  w.launcher = {
    config: { get: async () => ({ dataRoot: 'D:\\data' }) },
    app: {
      version: async () => opts.version ?? '0.1.1',
      checkUpdate: async () => {
        if (opts.checkThrows) throw opts.checkThrows
        return (opts.check as () => Promise<CheckResult>)()
      }
    }
  }
}

/** 面板在 body 里，统一从 body 取文本 */
const bodyText = (): string => document.body.textContent ?? ''

/** 找到面板里的某个按钮（用 body 查询） */
function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(label)
  ) as HTMLButtonElement | undefined
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 40))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('设置面板 · 检查更新', () => {
  it('★检查成功且有新版 → 要显示版本号（不能是 undefined）', async () => {
    install({
      check: async () => ({ hasUpdate: true, latestVersion: '0.2.0', url: 'http://x/a.exe', sizeMB: 80 })
    })
    const w = mount(SettingsPanel, { attachTo: document.body })
    await settle()

    findButton('检查更新')!.click()
    await settle()
    await w.vm.$nextTick()

    const t = bodyText()
    expect(t, '显示成了 undefined —— 渲染层读的字段名和主进程返回的对不上').not.toContain('undefined')
    expect(t, '应该显示出新版本号').toContain('0.2.0')
  })

  it('★检查失败 → 只说「已是最新版本」，不显示原始报错', async () => {
    install({
      checkThrows: new Error(
        "Error invoking remote method 'app:checkUpdate': ReferenceError: app is not defined"
      )
    })
    const w = mount(SettingsPanel, { attachTo: document.body })
    await settle()

    findButton('检查更新')!.click()
    await settle()
    await w.vm.$nextTick()

    const t = bodyText()
    expect(t, '失败时要显示「已是最新版本」').toContain('已是最新版本')
    expect(t, '不该把 ReferenceError 这种原始报错贴给用户').not.toContain('ReferenceError')
    expect(t, '不该出现「检查更新失败」这种措辞').not.toContain('检查更新失败')
    expect(t, '不该出现远程调用报错的原文').not.toContain('Error invoking remote method')
  })

  it('★没有更新时不显示任何版本号（不误报新版）', async () => {
    install({ check: async () => ({ hasUpdate: false, currentVersion: '0.1.1' }) })
    const w = mount(SettingsPanel, { attachTo: document.body })
    await settle()

    findButton('检查更新')!.click()
    await settle()
    await w.vm.$nextTick()

    const t = bodyText()
    expect(t).toContain('已是最新版本')
    expect(t).not.toContain('发现新版本')
    expect(t).not.toContain('undefined')
  })

  it('★当前版本要真的显示出来（不能是「未知」）', async () => {
    install({ version: '0.1.1', check: async () => ({ hasUpdate: false }) })
    const w = mount(SettingsPanel, { attachTo: document.body })
    await settle()
    await w.vm.$nextTick()
    expect(bodyText(), '版本号没显示出来').toContain('0.1.1')
  })
})
