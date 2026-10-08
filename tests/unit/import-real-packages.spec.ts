/*
 * 用**主人真实的两个包**验证手动导入链路（探测阶段）。
 *
 * 背景 —— 用户报告（问题报告v2 第 10 条）：
 *   「astrbot-4.28.0-py3-none-any.whl 选择到入astrbot怎么就这样了，不下载」
 *
 * 意思是：选了那个 whl 之后，界面没有进入「下载/安装」流程，
 * 就停在原地看着「AstrBot 0 还没下载」。
 *
 * 探测阶段（probeArchive）必须能正确认出 whl 是 AstrBot 包并读出 4.28.0，
 * 否则后续环节全都会走偏。这个测试直接吃成品目录里的真实文件 ——
 * 真实包才是最可信的样本（它里面有 820 个条目、各种噪音版本号）。
 *
 * 如果成品目录里的包不在（换了机器/清理过），测试跳过而不是失败。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { probeArchive } from '../../src/main/update/import-archive'

const WHL = 'E:\\MX机器人启动器成品\\astrbot-4.28.0-py3-none-any.whl'
const NAPCAT = 'E:\\MX机器人启动器成品\\NapCat.Shell.zip'

describe('手动导入 · 真实包探测', () => {
  it('★AstrBot whl 要被认成 AstrBot 且版本 4.28.0', async () => {
    if (!existsSync(WHL)) {
      console.log('  跳过：成品目录里没有那个 whl')
      return
    }
    const p = await probeArchive(WHL)
    expect(p.kind, '没认出是 AstrBot 包 —— 界面就会卡在「还没下载」').toBe('a')
    expect(p.version, '版本没读出来，装完卡片又会显示未知').toBe('4.28.0')
    expect(p.sizeBytes).toBeGreaterThan(1_000_000)
    expect(p.sha256, 'sha256 应当有值').toMatch(/^[0-9a-f]{64}$/)
  })

  it('★NapCat zip 要被认成 NapCat 且版本 4.18.19（不能抓到包里的噪音版本号）', async () => {
    if (!existsSync(NAPCAT)) {
      console.log('  跳过：成品目录里没有那个 zip')
      return
    }
    const p = await probeArchive(NAPCAT)
    expect(p.kind).toBe('n')
    /*
     * napcat.mjs 里有 1.0.0 / 3.2.12 / 6.9.53 / 9.9.15 / 9.9.22 等一堆版本串，
     * package.json 里还是个占位 0.0.1 —— 必须精确抓到 4.18.19。
     */
    expect(p.version, '抓到了包里的噪音版本号').toBe('4.18.19')
  })
})
