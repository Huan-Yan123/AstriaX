import { describe, expect, it } from 'vitest'
import { dirname } from 'path'
import { checkQQ, readQQVersion } from '../../src/main/runtime/qq-check'
import { run } from '../../src/main/util/async-exec'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'

/**
 * 真机验证（不 mock 注册表、不 mock 文件系统）。
 * 本机 QQ 装在 E:\QQ，版本 9.9.31-49738，构建号 49738 > 40768 应通过。
 *
 * 这些用例依赖「这台机器上装没装 QQ」，所以在没装 QQ 的机器上会跳过而不是报红 ——
 * 但它们的存在本身有价值：一旦解析逻辑被改坏，在有 QQ 的机器上立刻会暴露。
 */
async function registrQQDir(): Promise<string | undefined> {
  const r = await run('reg.exe', [
    'query',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    '/v',
    'UninstallString'
  ], { timeoutMs: 8000 })
  if (r.status !== 0) return undefined
  const m = /UninstallString\s+REG_SZ\s+(.+)/i.exec(r.stdout)
  return m ? dirname(m[1].trim().replace(/^"|"$/g, '')) : undefined
}

describe('QQ 检测真机验证', () => {
  it('注册表能定位到 QQ 安装目录并读出构建号', async () => {
    const dir = await registrQQDir()
    if (!dir) {
      console.log('本机没装 QQ（注册表没有卸载项），跳过真机验证')
      return
    }
    console.log('解析出的安装目录:', dir)
    const ver = readQQVersion(dir)
    console.log('读到的版本:', JSON.stringify(ver))
    expect(ver).toBeDefined()
    expect(ver!.build).toBeGreaterThan(0)
  })

  it('本机 QQ 版本满足 NapCat 的 40768 门槛', async () => {
    const dir = await registrQQDir()
    if (!dir) {
      console.log('本机没装 QQ，跳过')
      return
    }
    const info = checkQQ({ candidates: [dir, 'E:\\QQ', 'D:\\QQ'] })
    console.log('检测结果:', JSON.stringify(info, null, 2))
    expect(info.installed).toBe(true)
    expect(info.ok).toBe(true)
    expect(info.build).toBeGreaterThanOrEqual(40768)
  })

  it('qq:status handler 在真机返回可用', async () => {
    const dir = await registrQQDir()
    if (!dir) {
      console.log('本机没装 QQ，跳过')
      return
    }
    const h = buildHandlers({
      probe: () => Promise.resolve(true),
      processManager: createProcessManager(),
      qqChecker: () => checkQQ({ candidates: [dir, 'E:\\QQ'] })
    })
    const st = (await h['qq:status']()) as { ok?: boolean; version?: string; build?: number }
    console.log('qq:status →', JSON.stringify(st))
    expect(st.ok).toBe(true)
    expect(st.build).toBeGreaterThanOrEqual(40768)
  })
})
