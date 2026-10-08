/*
 * 「每次启动都弹数据目录向导」到底为什么。
 *
 * 向导显示条件：`firstRun = !cfg.dataRoot`（App.vue:323）。
 * 所以「每次都弹」= 启动时 `config:get` 拿不到 dataRoot。
 *
 * 启动恢复链路（registerIpcHandlersReal 末尾）：
 *     const saved = readAppConfig(await defaultDataRoot())
 *     if (saved) handlers['config:set'](saved)
 *
 * config.json 正常存在时 saved 有值，config 会被填上 —— 不该弹。
 * 所以问题一定出在「config:set(saved) 抛异常」或「根本没走到」。
 *
 * ## 真凶：这句恢复调用没有容错，一抛就面瘫
 *
 * `saved` 是磁盘上的旧配置。若它的 dataRoot 指向一个已经不可写的
 * 位置（用户删了目录、换了盘符、U 盘拔了、被安全软件锁了），
 * 紧接着 `mkdirSync(config.dataRoot, {recursive:true})` 就会抛。
 *
 * 而 `if (saved) handlers['config:set'](saved)` **没有 try/catch**，
 * 一抛就中断整个 `registerIpcHandlersReal`，后面的
 * `ipcMain.handle(...)` 注册循环**全部不执行**。
 *
 * 结果：ipcMain 上一个通道都没注册。渲染层调 config:get 报
 * "No handler registered for 'config:get'"，界面半死不活。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildHandlers, readAppConfig } from '../../src/main/ipc'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

let root: string
beforeEach(() => {
  root = testStage('acb-wizroot-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('数据目录向导不该每次启动都弹', () => {
  it('★磁盘上已有 config.json → 恢复后 config:get 必须带出 dataRoot', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ dataRoot: root, portMin: 6100, portMax: 6199, backupKeep: 5 }, null, 2),
      'utf8'
    )

    const h = buildHandlers({ probe: () => true, audit: undefined })
    const saved = readAppConfig(root)
    expect(saved, 'config.json 就在那儿，却读不出来').toBeTruthy()
    h['config:set'](saved!)

    const cfg = h['config:get']() as { dataRoot?: string }
    expect(cfg.dataRoot, 'config:get 没带出 dataRoot → 向导会再弹一次').toBe(root)
  })

  it('★配置里的目录不可写时，config:set 要抛得清楚，不能静默吞掉', () => {
    const h = buildHandlers({ probe: () => true, audit: undefined })
    const blocker = join(root, 'not-a-dir')
    mkdirSync(root, { recursive: true })
    writeFileSync(blocker, 'x', 'utf8')

    expect(
      () => h['config:set']({ dataRoot: join(blocker, 'sub') }),
      '配置保存失败应当抛出，而不是静默吞掉'
    ).toThrow()

    expect(typeof h['config:get']).toBe('function')
    expect(typeof h['instance:list']).toBe('function')
  })

  it('★读不出 config.json 时 readAppConfig 返回 undefined（不抛）', () => {
    mkdirSync(root, { recursive: true })
    expect(readAppConfig(root)).toBeUndefined()
  })
})
