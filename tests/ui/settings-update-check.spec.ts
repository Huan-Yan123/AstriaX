// 设置页更新状态回归测试，使用桌面 API 替身。
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

  it('检查失败时显示可重试提示，不误报最新版或泄漏原始异常', async () => {
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
    expect(t).toContain('检查更新失败，请稍后重试')
    expect(t).not.toContain('已是最新版本')
    expect(t, '不该把 ReferenceError 这种原始报错贴给用户').not.toContain('ReferenceError')
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
