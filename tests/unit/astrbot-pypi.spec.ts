import { describe, it, expect } from 'vitest'
import { listAstrbotPypiVersions, PYPI_ASTRBOT_JSON } from '../../src/main/update/version-catalog'

const pypiPayload = {
  info: { version: '4.28.0' },
  releases: {
    '4.28.0': [
      {
        filename: 'astrbot-4.28.0-py3-none-any.whl',
        url: 'https://files.pythonhosted.org/packages/aa/astrbot-4.28.0-py3-none-any.whl',
        size: 23000000,
        upload_time_iso_8601: '2026-08-20T10:00:00Z',
        digests: { sha256: 'ab12' }
      }
    ],
    '4.27.2': [
      {
        filename: 'astrbot-4.27.2-py3-none-any.whl',
        url: 'https://files.pythonhosted.org/packages/bb/astrbot-4.27.2-py3-none-any.whl',
        size: 22500000,
        upload_time_iso_8601: '2026-07-30T10:00:00Z',
        digests: { sha256: 'cd34' }
      }
    ],
    '4.28.0b1': [
      {
        filename: 'astrbot-4.28.0b1-py3-none-any.whl',
        url: 'https://files.pythonhosted.org/packages/cc/astrbot-4.28.0b1-py3-none-any.whl',
        size: 23100000,
        digests: { sha256: 'ef56' }
      }
    ]
  }
}

describe('AstrBot 走 PyPI 分发（官方推荐 uv tool install astrbot）', () => {
  it('★列版本固定走 PyPI 官方（国内镜像没有 /pypi/{pkg}/json 接口）', () => {
    /*
     * ★ 这条断言的来历（2026-09-26 实测，scripts/test-python-sources.py）
     *
     * 原来这里断言 `PYPI_INDEX_URLS` 里含 tuna 与 aliyun —— 而实测结果是：
     *   · 清华 TUNA  索引 **403 Forbidden**（元数据接口也 403）
     *   · 阿里云     索引 SSL 握手超时；`/pypi/{pkg}/json` **404**
     *   · 腾讯云     索引 200；`/pypi/{pkg}/json` **404**
     *   · PyPI 官方  索引 200；元数据 200（astrbot 最新 4.28.1，168 个版本）
     *
     * 也就是说**国内镜像根本没有元数据接口** —— 那条旧断言钉的是一个
     * 根本用不了的假设，`PYPI_INDEX_URLS` 本身也是零引用的死数据，已删除。
     *
     * 现在钉住真正的契约：
     *   · **列版本**只能问 PyPI 官方（它是唯一有 /pypi/{pkg}/json 的）
     *   · **装** 走用户选的源（见 update/python-source.ts），两者是分开的两件事
     */
    expect(PYPI_ASTRBOT_JSON).toBe('https://pypi.org/pypi/astrbot/json')
  })

  it('列出全部版本（新在前），含预发布', async () => {
    const list = await listAstrbotPypiVersions({ fetchJson: async () => JSON.stringify(pypiPayload) })
    expect(list.map((v) => v.tag)).toEqual(['v4.28.0', 'v4.28.0b1', 'v4.27.2'])
    const stable = list.find((v) => v.tag === 'v4.28.0')!
    expect(stable.kind).toBe('pypi')
    expect(stable.assetName).toBe('astrbot-4.28.0-py3-none-any.whl')
    expect(stable.sha256).toBe('ab12')
    expect(stable.from).toBe('PyPI 官方')
    expect(stable.sizeMB).toBeCloseTo(21.9, 1)
    expect(list.find((v) => v.tag === 'v4.28.0b1')?.prerelease).toBe(true)
  })

  it('PyPI 不通 → 报错由调用方吞掉（不影响其他源）', async () => {
    await expect(
      listAstrbotPypiVersions({
        fetchJson: async () => {
          throw new Error('ECONNREFUSED')
        }
      })
    ).rejects.toThrow()
  })
})
