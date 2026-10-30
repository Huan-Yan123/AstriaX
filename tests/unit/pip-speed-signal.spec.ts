/*
 * pip 阶段的速度信号（诊断 2026-10-25）。
 *
 * 症状：AstrBot 下载时，版本行只显示包名，速度恒不出现。
 *
 * 根因假设：pip 的 `--progress-bar raw` 只在**单个文件 > 512KB** 时
 * 才输出 `Progress N of M` 行（见 pip/_internal/network/download.py 的
 * `elif total_length > (512 * 1024)`）。绝大多数 wheel 只有几十 KB，
 * 于是 readPipDownloadProgress 一条都匹配不到 → pipBytesPerSec 恒 0。
 *
 * 这条测试钉住替代信号：从 pip 的 "Downloading xxx.whl (207 kB)" /
 * "Using cached xxx.whl (69 kB)" 行算出已下载字节累计与速度。
 */
import { describe, it, expect } from 'vitest'
import { createPipByteSampler } from '../../src/main/update/pip-progress'

describe('pip 下载速度信号', () => {
  it('从 Downloading/Using cached 行累计字节并算出速度（不依赖 Progress 行）', () => {
    let now = 1_000_000
    const s = createPipByteSampler({ now: () => now })

    s.feed('Collecting requests\n')
    expect(s.snapshot().bytes).toBe(0)

    s.feed('Downloading charset_normalizer-3.5.2-cp312-cp312-win_amd64.whl (207 kB)\n')
    now += 1000
    expect(s.snapshot().bytes, '207 kB 要计进累计字节').toBeGreaterThan(200_000)
    expect(s.snapshot().bytesPerSec, '1 秒下 207 kB → 约 200 kB/s').toBeGreaterThan(150_000)

    s.feed('Using cached idna-3.20-py3-none-any.whl (69 kB)\n')
    now += 1000
    expect(s.snapshot().bytes, '缓存命中也算已获取字节').toBeGreaterThan(270_000)
  })

  it('单位要认全：B / kB / MB / GB，以及 pip 的 "1.2 MB" 写法', () => {
    const s = createPipByteSampler({ now: () => 0 })
    s.feed('Downloading a-1.0-py3-none-any.whl (512 B)\n')
    s.feed('Downloading b-1.0-py3-none-any.whl (1.5 MB)\n')
    s.feed('Downloading c-1.0-py3-none-any.whl (2 GB)\n')
    const got = s.snapshot().bytes
    expect(got).toBeGreaterThan(2 * 1024 ** 3)
  })

  it('同一行重复出现（pip 重试打印两次）不能重复累计', () => {
    const s = createPipByteSampler({ now: () => 0 })
    const line = 'Downloading certifi-2026.10.23-py3-none-any.whl (135 kB)\n'
    s.feed(line)
    const once = s.snapshot().bytes
    s.feed(line)
    expect(s.snapshot().bytes, '重试行不能把字节翻倍').toBe(once)
  })

  it('字节停止增长超过 2 秒后速度归零（否则界面一直报旧速度）', () => {
    let now = 1_000_000
    const s = createPipByteSampler({ now: () => now })
    s.feed('Downloading big-1.0-py3-none-any.whl (5 MB)\n')
    now += 1000
    s.feed('Downloading next-1.0-py3-none-any.whl (1 MB)\n')
    now += 1000
    expect(s.snapshot().bytesPerSec, '先有一份非零速度').toBeGreaterThan(0)

    now += 10_000
    expect(s.snapshot().bytesPerSec, '十秒没新字节，速度必须是 0').toBe(0)
  })

  it('一行被 stdout 拆成多段时仍要能拼回来', () => {
    const s = createPipByteSampler({ now: () => 0 })
    s.feed('Downloading split-1.0-py3-none-any.whl (2')
    expect(s.snapshot().bytes, '半行不能当成文件大小').toBe(0)
    s.feed('07 kB)\n')
    expect(s.snapshot().bytes, '拼回完整行后要记到 207 kB').toBeGreaterThan(200_000)
  })
})
