import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { createAuditLog } from '../../src/main/logs/audit'
import { testStage } from '../helpers/stage'

/**
 * 审计日志**真的接进 IPC 了**吗 —— 这是集成层的验证。
 *
 * 单独测 createAuditLog 只能证明"它能写"，证明不了"它被调用了"。
 * 而"写了模块但没接线"是个很隐蔽的失败：模块测试全绿，功能却完全没用。
 * （这个项目上真发生过：audit 模块写好了、单元测试过了，但一度没接进 buildHandlers。）
 *
 * 所以这里走真的 handler 链路，断言操作之后磁盘上**真的有审计行**。
 */
describe('审计日志已接进 IPC 链路', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('audit-wired-')
  })
  afterEach(() => {
    /* 保留现场，stage 在 data 下不占 C 盘 */
  })

  /** 读当天审计文件里的全部行 */
  function auditLines(): string[] {
    const dir = join(root, 'logs')
    if (!existsSync(dir)) return []
    const files = readdirSync(dir).filter((f) => f.startsWith('audit-') && f.endsWith('.log'))
    const out: string[] = []
    for (const f of files) {
      out.push(
        ...readFileSync(join(dir, f), 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      )
    }
    return out
  }

  it('改动类操作被记录（用户视角：我做了什么）', async () => {
    // 造一个可用的运行时，才能建实例
    const rt = join(root, 'runtimes', 'a', 'v4.28.0')
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync(join(rt, 'astrbot'), { recursive: true })
    writeFileSync(join(rt, 'astrbot', '__init__.py'), '__version__ = "4.28.0"', 'utf8')
    writeFileSync(join(rt, 'mxbot-runtime.json'), '{"kind":"pypi","tag":"v4.28.0"}', 'utf8')
    mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'python', 'python.exe'), '', 'utf8')

    const audit = createAuditLog({ dataRoot: root })
    const h = buildHandlers({
      probe: async () => true,
      processManager: createProcessManager(),
      audit
    })
    await h['config:set']({ dataRoot: root })

    // 建一个实例 —— 这是"用户操作"，必须留痕
    const rec = (await h['instance:create']({ type: 'a', name: '审计测试' })) as { id: string }

    const lines = auditLines()
    expect(lines.length, `审计日志是空的（模块没接线？）。\n目录：${join(root, 'logs')}`).toBeGreaterThan(0)

    const joined = lines.join('\n')
    // 应该有"创建实例"这条，且带上实例名（用户看得懂的标识，不是裸 id）
    expect(joined).toContain('instance:create')
    expect(joined).toContain('审计测试')
    // 应标明是用户操作
    expect(joined).toContain('用户')

    void rec
  })

  it('查询类操作不记录（否则日志被 get/list 淹没）', async () => {
    /*
     * 判据：只记"改动状态"的操作。
     * 如果连 instance:list / app:ping 都记，日志瞬间被刷屏，
     * 真正要查的那条反而找不到了。
     */
    const audit = createAuditLog({ dataRoot: root })
    const h = buildHandlers({
      probe: async () => true,
      processManager: createProcessManager(),
      audit
    })
    await h['config:set']({ dataRoot: root })
    // 先清掉 config:set 可能产生的行
    const before = auditLines().length

    await h['instance:list']()
    await h['app:ping']()

    expect(auditLines().length, 'list/ping 这类查询不该产生审计记录').toBe(before)
  })
})
