import { describe, expect, it } from 'vitest'
import { BACKUP_KEEP_DEFAULT, PORT_RANGE_A, PORT_RANGE_N } from '../../src/main/constants'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'

/**
 * 默认配置必须**引用**常量，不能各写一份字面量。
 *
 * 背景：`ipc.ts` 里曾经硬写 `portMin: 6100, portMax: 6199, backupKeep: 5`，
 * 而 `constants.ts` 里另有 `PORT_RANGE_A = {6100, 6199}` 和 `BACKUP_KEEP_DEFAULT = 5`。
 * 同一个数字存在两份「真相」：改一处、忘一处时不会报任何错，
 * 但端口段和备份保留份数就会静默跑偏，而且几乎不可能被发现 ——
 * 顺带 `BACKUP_KEEP_DEFAULT` 也成了没人引用的死常量。
 *
 * 这条测试从**实际生效的默认配置**倒推，钉住两边一致。
 */
describe('默认配置与 constants 保持单一真相源', () => {
  it('端口范围与 PORT_RANGE_A 一致', async () => {
    const h = buildHandlers({
      probe: async () => true,
      processManager: createProcessManager()
    })
    // 未配置时返回的就是 DEFAULTS
    const cfg = (await h['config:get']()) as { portMin?: number; portMax?: number } | undefined
    // config 还没 set 过时可能为空对象，用 paths:defaults 之外的途径拿 DEFAULTS 不可靠，
    // 所以这里显式 set 一个空 patch 触发 DEFAULTS 兜底
    void cfg
    const after = (await h['config:set']({ dataRoot: testStage('truth-') }), await h['config:get']()) as {
      portMin: number
      portMax: number
      backupKeep: number
    }
    expect(after.portMin, 'portMin 必须等于 PORT_RANGE_A.min').toBe(PORT_RANGE_A.min)
    expect(after.portMax, 'portMax 必须等于 PORT_RANGE_A.max').toBe(PORT_RANGE_A.max)
    expect(after.backupKeep, 'backupKeep 必须等于 BACKUP_KEEP_DEFAULT').toBe(BACKUP_KEEP_DEFAULT)
  })

  it('portMin/portMax 不能被写成 A 段以外的值（回归护栏）', () => {
    // 这两个常量是端口分配的唯一边界来源
    expect(PORT_RANGE_A).toEqual({ min: 6100, max: 6199 })
    expect(PORT_RANGE_N).toEqual({ min: 6200, max: 6299 })
    // 两段不能重叠 —— 重叠会让 A/N 实例抢同一个端口
    expect(PORT_RANGE_A.max).toBeLessThan(PORT_RANGE_N.min)
  })
})
