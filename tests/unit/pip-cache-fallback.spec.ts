/*
 * ★ pip 失败时绕过缓存重试（主人 2026-09-27 的 jieba 失败）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 真实失败
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 日志（audit-2026-09-27，14:53:23）：
 *     装 AstrBot 失败：.1-py3-none-any.whl' ->
 *     '...\pip-cache\wheels\08\a1\a3\...\jieba-0.42.1-py3-none-any.whl'
 *     error: failed-wheel-build-for-install
 *     Failed to build installable wheels for some pyproject.toml based projects jieba
 *
 * 查缓存目录看出的根因：那里躺着的 **whl** 与它 `origin.json` 记的
 * **sdist（tar.gz）对不上** —— pip 把构建好的 wheel 复制进缓存那一步失败了
 *（搬家数据目录后更容易撞上），于是报"构建失败"，而 wheel 其实已建好。
 *
 * 单独对同一个 jieba 跑 pip 是**成功**的 → jieba 与编译器都没问题。
 */
import { describe, it, expect } from 'vitest'
import { looksCacheRelated, withNoCacheDir, runPipWithCacheFallback } from '../../src/main/util/pip-run'

describe('★pip 缓存坏了要能自愈', () => {
  it('识别"像是缓存问题"的报错', () => {
    /* 真实那条 */
    expect(
      looksCacheRelated(
        "ERROR: failed-wheel-build-for-install\nFailed to build installable wheels for some pyproject.toml based projects jieba"
      ),
      '主人实测的那条必须被认出来'
    ).toBe(true)
    /* 权限/占用类（搬家后常见） */
    expect(looksCacheRelated('ERROR: [Errno 13] Permission denied')).toBe(true)
    expect(looksCacheRelated('EBUSY: resource busy or locked')).toBe(true)
    expect(looksCacheRelated('Access is denied')).toBe(true)
    /* 缓存里那份 hash 不对 */
    expect(looksCacheRelated('THESE PACKAGES DO NOT MATCH THE HASHES')).toBe(true)
  })

  it('★源上真没这个包 → **不**重试（重试也白搭，别浪费用户几分钟）', () => {
    expect(
      looksCacheRelated(
        'ERROR: Could not find a version that satisfies the requirement astrbot==4.27.5 (from versions: none)\nERROR: No matching distribution found'
      ),
      '源上没有的包不该触发重试'
    ).toBe(false)
  })

  it('网络断开 → 不重试', () => {
    expect(looksCacheRelated('Could not fetch URL https://pypi.org: connection refused')).toBe(false)
  })

  it('withNoCacheDir 插在 install 之后（并保持幂等）', () => {
    const a = withNoCacheDir(['-m', 'pip', 'install', '--target', '/x', 'jieba'])
    expect(a[0]).toBe('-m')
    expect(a[1]).toBe('pip')
    expect(a[2]).toBe('install')
    expect(a[3], '--no-cache-dir 要紧跟 install').toBe('--no-cache-dir')
    expect(a).toContain('jieba')
    /* 幂等：已经有就不再加 */
    expect(withNoCacheDir(a).filter((x) => x === '--no-cache-dir')).toHaveLength(1)
  })

  it('★★首次成功 → 不重试（不该白跑第二遍）', async () => {
    let calls = 0
    const r = await runPipWithCacheFallback(
      async () => {
        calls++
        return { status: 0, stdout: 'ok', stderr: '' }
      },
      'python.exe',
      ['-m', 'pip', 'install', 'x'],
      {}
    )
    expect(calls, '成功了就不该有第二次').toBe(1)
    expect(r.result.status).toBe(0)
    expect(r.retriedNoCache).toBe(false)
  })

  it('★★缓存类失败 → 自动绕过缓存重试一次，并以第二次结果为准', async () => {
    const seen: string[][] = []
    const r = await runPipWithCacheFallback(
      async (_cmd, args) => {
        seen.push(args)
        /* 第一次失败（报缓存错），第二次成功 */
        return seen.length === 1
          ? {
              status: 1,
              stdout: '',
              stderr: 'ERROR: failed-wheel-build-for-install\nFailed to build installable wheels for jieba'
            }
          : { status: 0, stdout: 'Successfully installed', stderr: '' }
      },
      'python.exe',
      ['-m', 'pip', 'install', '--target', '/x', 'jieba'],
      {}
    )
    expect(seen, '应当跑了两次').toHaveLength(2)
    expect(seen[1], '★第二次必须带 --no-cache-dir').toContain('--no-cache-dir')
    expect(seen[0], '第一次不带（先按正常路径试）').not.toContain('--no-cache-dir')
    expect(r.result.status, '以第二次结果为准').toBe(0)
    expect(r.retriedNoCache).toBe(true)
  })

  it('★非缓存类失败 → **不**重试（不让用户白等）', async () => {
    let calls = 0
    const r = await runPipWithCacheFallback(
      async () => {
        calls++
        return {
          status: 1,
          stdout: '',
          stderr: 'ERROR: Could not find a version that satisfies the requirement x (from versions: none)'
        }
      },
      'python.exe',
      ['-m', 'pip', 'install', 'x'],
      {}
    )
    expect(calls, '源上没有就别重试').toBe(1)
    expect(r.result.status).toBe(1)
    expect(r.retriedNoCache).toBe(false)
  })
})
