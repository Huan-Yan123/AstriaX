/*
 * Bug K：更新包下载**必须真的校验 sha256**
 * ========================================================================
 *
 * ## 坏在哪（链路断在两个地方，少一处都等于没校验）
 *
 *   1. `AppUpdateCheck` 接口里**没有 sha256 字段**
 *   2. `checkAppUpdate()` 解析完清单、返回结果时**只挑了几个字段**
 *      （hasUpdate / latestVersion / url / sizeMB / notes），
 *      唯独把 `m.sha256` 丢了
 *
 * 于是渲染层 `SettingsPanel.checkUpdate` 里写的
 *
 *     sha256: r.sha256      // ← 永远 undefined
 *
 * 拿到的永远是 undefined，一路传到 `app:downloadUpdate` 的
 * `expectSha256` 也是 undefined，而 `downloadAppUpdate` 的校验是
 *
 *     if (deps.expectSha256) { ...比对... }     // 条件不成立 → 整段跳过
 *
 * **所以 sha256 校验功能写好了、却一次都不会执行。**
 *
 * ## 为什么这个 bug 危险
 *
 * 下载安装包是整条更新链路上**唯一**信任远端字节的地方：
 *   - 服务器被换掉/投毒 → 用户装上一个被篡改的安装包
 *   - 下载中途被劫持/截断 → 装一个坏包（甚至更糟：坏包被当成好的运行）
 *
 * `latest.json` 里明明有 sha256（upload-release.py 会算），
 * 代码里也明明有校验实现和「校验失败就删残file并报错」的逻辑，
 * 但**中间那一段字段没传过去**，于是一切都白写。
 *
 * 这类 bug 的共同特征：**每一处单看都对**，只有把链路连起来才发现断了。
 * 所以下面的用例既测单点，也测**端到端连线**。
 */
import { describe, it, expect } from 'vitest'
import { checkAppUpdate } from '../../src/main/update/app-update'
import { downloadAppUpdate } from '../../src/main/update/app-update'
import { testStage } from '../helpers/stage'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

const MANIFEST_URL = 'http://example.com/mxbot/latest.json'

/** 搭一个"服务器"：清单 + 安装包字节，可注入下载实现 */
function makeServer(version: string, body: Buffer, withSha = true) {
  const sha = createHash('sha256').update(body).digest('hex')
  const manifest = {
    version,
    url: 'AstriaX-Setup-' + version + '.exe',
    size: body.length,
    notes: '修了点东西',
    ...(withSha ? { sha256: sha } : {})
  }
  return { manifest, sha, body }
}

describe('Bug K：sha256 必须真的被用上', () => {
  it('★checkAppUpdate 必须把清单里的 sha256 带出来', async () => {
    const { manifest, sha } = makeServer('9.9.9', Buffer.from('x'.repeat(1024)))

    const r = await checkAppUpdate({
      currentVersion: '0.1.0',
      manifestUrl: MANIFEST_URL,
      fetchJson: async () => JSON.stringify(manifest)
    })

    expect(r.hasUpdate, '应该认出有更新').toBe(true)
    expect(r.latestVersion).toBe('9.9.9')

    /*
     * 这是本 bug 的核心断言。
     *
     * 少了这个字段，下游的 `expectSha256` 就是 undefined，
     * downloadAppUpdate 里的校验整段被 `if` 跳过 ——
     * 也就是说"校验"这个功能**从未执行过**。
     */
    expect(
      r.sha256,
      'checkAppUpdate 没把 sha256 带出来 —— latest.json 里明明有，\n' +
        '但返回时被丢掉了，于是下载校验永远拿不到期望值、\n' +
        '`if (expectSha256)` 恒不成立 → 整段校验被静默跳过。\n' +
        '用户会毫无察觉地装上一个未经验证（甚至被篡改）的安装包。'
    ).toBe(sha)
  })

  it('★端到端：清单 → 检查 → 下载，篡改的包必须被拒绝', async () => {
    const dir = testStage('acb-bugk-')
    try {
      const good = Buffer.from('GOOD-INSTALLER-BYTES-'.repeat(64))
      const { manifest } = makeServer('9.9.9', good)

      // 第一步：检查更新（这一步必须给出 sha256）
      const check = await checkAppUpdate({
        currentVersion: '0.1.0',
        manifestUrl: MANIFEST_URL,
        fetchJson: async () => JSON.stringify(manifest)
      })
      expect(check.hasUpdate).toBe(true)

      /*
       * 第二步：用**检查结果里的 sha256** 去下载一个**内容不匹配**的包。
       * 这是链路连线测试 —— 不再单独构造 expectSha256，
       * 而是完全按渲染层的真实做法从 check 结果里取。
       */
      const tampered = Buffer.from('EVIL-INSTALLER-BYTES-'.repeat(64))

      let threw: Error | undefined
      try {
        await downloadAppUpdate({
          dir,
          url: MANIFEST_URL,
          fileName: 'AstriaX-Setup-9.9.9.exe',
          // ↓ 渲染层就是这么传的（SettingsPanel.vue: sha256: r.sha256）
          expectSha256: check.sha256,
          fetchToFile: async (_u, outPath) => {
            writeFileSync(outPath, tampered)
            return tampered.length
          }
        })
      } catch (e) {
        threw = e as Error
      }

      expect(
        threw,
        '被篡改的安装包没有被拒绝！\n' +
          '这就是 sha256 丢失的后果：校验条件不成立、整段跳过，\n' +
          '坏包被当成好包落到用户的下载目录里。'
      ).toBeDefined()
      expect(threw?.message ?? '', '报错要说清是校验不通过').toMatch(/校验|sha256|hash/i)

      // 校验失败时**不能留下残file**（半截包最容易被误点）
      const left = readdirSync(dir).filter((n) => n.endsWith('.exe') || n.endsWith('.part'))
      expect(left, `校验失败后残留了文件：${left.join(', ')}`).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('清单没给 sha256 时不校验（不能因此拒绝正常下载）', async () => {
    const dir = testStage('acb-bugk-nosha-')
    try {
      const body = Buffer.from('BODY'.repeat(256))
      const { manifest } = makeServer('9.9.9', body, false)

      const check = await checkAppUpdate({
        currentVersion: '0.1.0',
        manifestUrl: MANIFEST_URL,
        fetchJson: async () => JSON.stringify(manifest)
      })
      expect(check.sha256, '清单没给就不该凭空造一个').toBeUndefined()

      const out = await downloadAppUpdate({
        dir,
        url: MANIFEST_URL,
        fileName: 'ok.exe',
        expectSha256: check.sha256,
        fetchToFile: async (_u, outPath) => {
          writeFileSync(outPath, body)
          return body.length
        }
      })
      expect(existsSync(out), '没有 sha256 时正常下载必须成功').toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
