/*
 * pip 进度映射的单测（P1 安装进度反馈的验收）
 *
 * 主人的抱怨（指导书 7.1 原文）：进度条显示 "package:..." 之类文本，
 * 看起来在装但不走，无速度 —— 以为卡死。根因之一就是**进度没有被映射**：
 * 一堆 pip 输出进来，界面上的百分比一直不动。
 *
 * 这里用**真实的 pip 输出样本**（从实际安装日志里抄的形态）验证映射：
 *   · 阶段推进（deps → install → config）
 *   · 百分比单调不回退、不会跳变
 *   · 不编造"总数"（pip 非 TTY 不打印总数，硬编就是假进度）
 */
import { describe, it, expect } from 'vitest'
import { createPipProgress } from '../../src/main/update/pip-progress'

/** pip 非 TTY 下的典型输出（形态取自真实安装日志） */
const SAMPLE = [
  'Looking in indexes: https://pypi.tuna.tsinghua.edu.cn/simple',
  'Collecting astrbot==4.28.0',
  '  Downloading astrbot-4.28.0-py3-none-any.whl (7.4 MB)',
  '     ---------------------------------------- 7.4/7.4 MB 2.1 MB/s eta 0:00:00',
  'Collecting aiohttp>=3.11.18',
  'Collecting aiosqlite>=0.21.0',
  'Collecting bs4',
  '  Using cached beautifulsoup4-4.12.3-py3-none-any.whl (1.2 MB)',
  'Collecting pandas>=2.2.0',
  'Installing collected packages: astrbot, aiohttp, aiosqlite, beautifulsoup4, pandas',
  'Successfully installed astrbot-4.28.0 aiohttp-3.11.18 pandas-2.2.0'
].join('\r\n')

describe('pip 进度映射', () => {
  it('★阶段按 deps → install → config 推进，且百分比单调', () => {
    const p = createPipProgress()
    const seen: Array<{ percent: number; stage: string }> = []

    // 逐行喂（真实场景就是一个 data chunk 里有若干行）
    for (const line of SAMPLE.split('\r\n')) {
      const t = p.feed(line + '\n')
      seen.push({ percent: t.percent, stage: t.stage })
    }

    // 阶段顺序：先从 deps 起，中途进 install，最后进 config
    expect(seen[0].stage, '一开始是依赖收集阶段').toBe('deps')
    expect(seen.some((x) => x.stage === 'install'), '应当经过"安装包"阶段').toBe(true)
    expect(seen[seen.length - 1].stage, '最后进入收尾/配置阶段').toBe('config')

    // 单调不回退（进度条回退会让用户以为出错）
    for (let i = 1; i < seen.length; i++) {
      expect(
        seen[i].percent,
        `第 ${i} 步百分比回退了：${seen[i - 1].percent} → ${seen[i].percent}`
      ).toBeGreaterThanOrEqual(seen[i - 1].percent)
    }

    // 结束时应到 90（100 由调用方在真正收尾后发）
    expect(seen[seen.length - 1].percent).toBe(90)
  })

  it('★区间符合指导书：收集阶段不出 60，装完=90', () => {
    const p = createPipProgress()
    // 只喂收集类输出：不该越过 60（60 以上是"安装包"阶段的地盘）
    for (let i = 0; i < 40; i++) p.feed(`Collecting pkg${i}\n`)
    expect(p.now().percent, '收集阶段不得越过 60').toBeLessThanOrEqual(60)
    expect(p.now().percent, '收集了很多包也该有明显进展').toBeGreaterThan(10)

    // 见到 Installing → 62（进阶段 3 的下界之上）
    p.feed('Installing collected packages: pkg0, pkg1\n')
    expect(p.now().percent).toBeGreaterThanOrEqual(62)
    expect(p.now().stage).toBe('install')

    // 见到 Successfully installed → 90
    p.feed('Successfully installed pkg0-1.0\n')
    expect(p.now().percent).toBe(90)
    expect(p.now().stage).toBe('config')
  })

  it('解析不出包名时也不炸、不倒退（pip 输出形态会变）', () => {
    const p = createPipProgress()
    const before = p.now().percent
    for (const junk of ['', '   ', 'WARNING: something', '\x1b[32mcolored\x1b[0m line', '...']) {
      const t = p.feed(junk)
      expect(t.percent).toBeGreaterThanOrEqual(before)
    }
    expect(p.now().percent).toBe(before)
  })

  it('finishInstall 把进度推到 90（pip 退出 0 之后的收尾）', () => {
    const p = createPipProgress()
    p.feed('Collecting astrbot==4.28.0\n')
    const t = p.finishInstall()
    expect(t.percent).toBe(90)
    expect(t.stage).toBe('config')
  })

  it('★不编造"总数"：进度只由真实信号驱动（没有假进度）', () => {
    const p = createPipProgress()
    // 只喂一行无关输出：进度**不该**自己往上爬
    p.feed('Looking in indexes: https://pypi.org/simple\n')
    expect(p.now().percent, '没有真实信号就不该动（假进度比慢进度更伤信任）').toBe(5)
  })
})
