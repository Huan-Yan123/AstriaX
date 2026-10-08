/*
 * 从 netstat 输出解析"谁在监听这个端口"（指导书 P0-4 收口的可测部分）
 *
 * ## 为什么要单独测这个纯函数
 *
 * `findListenerPid` 原来是 `spawnSync('netstat') + 内联解析`：
 *   · 同步 spawn 会冻主进程（最坏 8 秒）→ 已加异步版给交互路径
 *   · 但**解析逻辑本身**也很容易错，而它混在 spawn 里就没法测
 *
 * 抽成纯函数之后，两种调用（同步退出路径 / 异步交互路径）共用它，
 * 也不会出现"改了异步版忘了同步版"的漂移。
 *
 * 真实 netstat 输出的形态（Windows 10/11 中文与英文都一样，只列 LISTENING）：
 *     TCP    127.0.0.1:6200    0.0.0.0:0    LISTENING    28704
 *     TCP    [::]:6200         [::]:0       LISTENING    28704
 *     TCP    0.0.0.0:135       0.0.0.0:0    LISTENING    1064
 */
import { describe, it, expect } from 'vitest'
import { parseListenerPid } from '../../src/main/ipc'

const SAMPLE = [
  '',
  '活动连接',
  '',
  '  协议  本地地址          外部地址        状态           PID',
  '  TCP    0.0.0.0:135       0.0.0.0:0      LISTENING       1064',
  '  TCP    127.0.0.1:6200    0.0.0.0:0      LISTENING       28704',
  '  TCP    [::]:6200         [::]:0         LISTENING       28704',
  '  TCP    127.0.0.1:6201    127.0.0.1:51234 ESTABLISHED     9999',
  '  TCP    0.0.0.0:6100      0.0.0.0:0      LISTENING       456',
  ''
].join('\r\n')

describe('parseListenerPid：从 netstat 里找监听某端口的 pid', () => {
  it('IPv4 监听行能解析出 pid', () => {
    expect(parseListenerPid(SAMPLE, 6200)).toBe(28704)
  })

  it('IPv6 监听行也能解析（[::]:6200）', () => {
    // 这一行与 IPv4 那行同 pid；单独验证含方括号的地址不被正则漏掉
    const only6 = '  TCP    [::]:6300         [::]:0         LISTENING       777'
    expect(parseListenerPid(only6, 6300)).toBe(777)
  })

  it('★ESTABLISHED 的行不算监听（否则会杀掉一个只是连上来的进程）', () => {
    // 6201 只有 ESTABLISHED、没有 LISTENING → 必须返回 undefined
    expect(parseListenerPid(SAMPLE, 6201)).toBeUndefined()
  })

  it('端口不存在 → undefined（不能随便返回别的 pid）', () => {
    expect(parseListenerPid(SAMPLE, 6399)).toBeUndefined()
  })

  it('空输入/垃圾输入不炸', () => {
    expect(parseListenerPid('', 6200)).toBeUndefined()
    expect(parseListenerPid('乱七八糟的输出', 6200)).toBeUndefined()
    expect(parseListenerPid(undefined as unknown as string, 6200)).toBeUndefined()
  })

  it('★端口要精确匹配，不能前缀命中（6200 ≠ 62001）', () => {
    /*
     * 正则里 `:(\d+)` 捕获的是完整数字段，`Number(m[1]) === port` 是
     * 精确比较 —— 这条钉住它：万一以后有人改成 startsWith，
     * 6200 的查询会命中 62001 的监听者，于是**杀错进程**。
     */
    const other = '  TCP    127.0.0.1:62001   0.0.0.0:0    LISTENING    12345'
    expect(parseListenerPid(other, 6200)).toBeUndefined()
    expect(parseListenerPid(other, 62001)).toBe(12345)
  })

  it('有多个匹配行时取第一个（同一端口通常只有一个 pid）', () => {
    const dup = [
      '  TCP    127.0.0.1:6200    0.0.0.0:0      LISTENING       111',
      '  TCP    [::]:6200         [::]:0         LISTENING       111'
    ].join('\n')
    expect(parseListenerPid(dup, 6200)).toBe(111)
  })
})
