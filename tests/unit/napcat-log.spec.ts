import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNapcatLogCollector, decodeSmart } from '../../src/main/proc/napcat-log'
import { testStage } from '../helpers/stage'

/**
 * NapCat 日志收集器（用假 fetch，不连真 WebUI）。
 *
 * 背景（实机证据）：我们收到的实例日志只有
 *   [02:05:01.836][out] Administrator mode detected.
 *   [02:06:19.657][err] ^C
 * 就断了 —— 因为 NapCat 注入进 QQ 后日志不走我们的管道。
 * 所以改从它的 WebUI 日志接口拉。
 */
describe('NapCat 日志收集', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('mxbot-nclog-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('把 WebUI 的日志增量写进实例日志文件（带 [napcat] 标记）', async () => {
    const logFile = join(root, 'n_1.log')
    let body = 'line-1\nline-2\n'
    const c = createNapcatLogCollector({
      port: 6200,
      token: '114514',
      logFile,
      // 不启用定时器，手工 flush
      setInterval: () => 0,
      clearInterval: () => undefined,
      fetchBytes: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ data: body }), 'utf8') })
    })

    expect(await c.flush()).toBeGreaterThan(0)
    let text = readFileSync(logFile, 'utf8')
    expect(text).toContain('line-1')
    expect(text).toContain('[napcat]')

    // 第二轮：只追加新增的部分，不能把旧内容再写一遍
    body += 'line-3\n'
    await c.flush()
    text = readFileSync(logFile, 'utf8')
    expect(text.match(/line-1/g)).toHaveLength(1)
    expect(text).toContain('line-3')
    c.stop()
  })

  it('WebUI 还没起来时不报错、不写脏数据（启动早期很常见）', async () => {
    const logFile = join(root, 'n_2.log')
    const c = createNapcatLogCollector({
      port: 6200,
      token: '114514',
      logFile,
      setInterval: () => 0,
      clearInterval: () => undefined,
      fetchBytes: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    expect(await c.flush()).toBe(0)
    // 没有文件或空文件都行，但不能抛
    c.stop()
  })

  it('日志轮转（新内容和旧的没有前缀关系）时整段写入，宁可重复也不丢', async () => {
    const logFile = join(root, 'n_3.log')
    let body = 'aaa\n'
    const c = createNapcatLogCollector({
      port: 6200,
      token: '114514',
      logFile,
      setInterval: () => 0,
      clearInterval: () => undefined,
      fetchBytes: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ data: body }), 'utf8') })
    })
    await c.flush()
    // 轮转：内容完全换了，不再以 aaa 开头
    body = 'zzz\n'
    await c.flush()
    const text = readFileSync(logFile, 'utf8')
    expect(text).toContain('zzz')
    c.stop()
  })

  it('stop() 之后不再写', async () => {
    const logFile = join(root, 'n_4.log')
    const c = createNapcatLogCollector({
      port: 6200,
      token: '114514',
      logFile,
      setInterval: () => 0,
      clearInterval: () => undefined,
      fetchBytes: async () => ({ status: 200, body: Buffer.from('{"data":"x"}', 'utf8') })
    })
    c.stop()
    expect(await c.flush()).toBe(0)
  })

  it('GBK 输出要能正确解码（实机出现过「锟斤拷」乱码）', () => {
    // 「停止运行」的 GBK 字节（中文 Windows 代码页 936 的典型输出）
    const gbk = Buffer.from([0xcd, 0xa3, 0xd6, 0xb9, 0xd4, 0xcb, 0xd0, 0xd0])
    const decoded = decodeSmart(gbk)
    // 不能再出现替换字符（那正是「锟斤拷」的来源）
    expect(decoded).not.toContain('\uFFFD')
    // 正常 UTF-8 输入保持原样
    expect(decodeSmart(Buffer.from('你好', 'utf8'))).toBe('你好')
  })
})
