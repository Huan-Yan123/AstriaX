/*
 * ★★ 按端口补杀前的身份校验（深度审查报告 C-1）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 问题
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 停实例时如果端口还占着，程序会**按端口精确补杀**
 *（`taskkill /PID <pid> /T /F`）。而程序**自我提权到管理员**，
 * 所以这是一条"管理员权限的强杀"原语。原来的唯一判据是
 * "谁在 LISTENING 这个端口" —— 端口段只是我们**优先选**的区间，
 * 用户完全可能在 6200 上跑别的服务。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 判据的两版试错（都是实测否掉的）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ① **命令行里找实例目录/id** —— 实测本机 QQ 主进程：
 *        "E:\QQ\QQ.exe"       ← 命令行里什么都没有！
 *    因为实例目录是 `NAPCAT_WORKDIR` **环境变量**传的，
 *    而环境变量不出现在 CommandLine 里。→ 永远不命中。
 * ② **映像路径在运行时目录下** —— NapCat 注入的是**用户自己的 QQ**
 *    （`E:\QQ\QQ.exe`），不在我们目录里。→ 同样不命中。
 *
 * 两版都等于"**永远不杀**"，功能被废掉（端口永远占着）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 现在：**回环监听 + 启动时间**（两条都要满足）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   · 端口只绑**回环** —— NapCat 的 WebUI 是本机服务；
 *     要给别人用的服务会绑 `0.0.0.0`
 *   · 进程启动时间**晚于**实例开始启动的时刻 —— 它必然是我们刚 spawn 的
 *
 * 真实场景（脱链的 QQ）两条都满足 → **认得出、能杀**；
 * 用户自己开的服务（绑对外 / 开得更早）→ **不杀**。
 */
import { describe, it, expect } from 'vitest'
import {
  shouldKillByPort,
  isLoopbackOnly,
  type ProcInfo
} from '../../src/main/proc/proc-identity'

/* netstat 输出的真实形状（实测抓的） */
const NETSTAT_LOOPBACK = [
  '  TCP    127.0.0.1:6200         0.0.0.0:0              LISTENING       28704',
  '  TCP    127.0.0.1:6201         0.0.0.0:0              LISTENING       11111'
].join('\r\n')

const NETSTAT_ANY = [
  '  TCP    0.0.0.0:6200           0.0.0.0:0              LISTENING       28704'
].join('\r\n')

describe('★★按端口补杀的身份校验', () => {
  describe('① 端口是不是只绑回环', () => {
    it('127.0.0.1 → 是回环', () => {
      expect(isLoopbackOnly(NETSTAT_LOOPBACK, 6200)).toBe(true)
    })

    it('★0.0.0.0 → **不是**回环（那是给别人用的服务）', () => {
      expect(
        isLoopbackOnly(NETSTAT_ANY, 6200),
        '★绑 0.0.0.0 说明它在对外提供服务 —— 极可能不是我们的实例'
      ).toBe(false)
    })

    it('★网卡具体 IP（192.168.x.x）→ 也不是回环', () => {
      const t = '  TCP    192.168.1.8:6200       0.0.0.0:0              LISTENING       28704'
      expect(isLoopbackOnly(t, 6200)).toBe(false)
    })

    it('★端口根本没在监听 → 保守返回 false（调用方据此不杀）', () => {
      expect(isLoopbackOnly(NETSTAT_LOOPBACK, 6999)).toBe(false)
    })
  })

  describe('② 启动时间判据', () => {
    const startedAt = 1_700_000_000_000

    it('★★刚启动的进程 + 回环 → **可以杀**（真实场景：脱链的 QQ）', () => {
      const info: ProcInfo = {
        pid: 28704,
        exePath: 'E:\\QQ\\QQ.exe', // ← 实测：注入的就是用户自己的 QQ
        commandLine: '"E:\\QQ\\QQ.exe"', // ← 实测：命令行里没有实例痕迹
        createdAt: startedAt + 500
      }
      expect(
        shouldKillByPort(info, { sinceMs: startedAt, loopbackOnly: true }),
        '★这才是要杀掉的那个：NapCat 注入的 QQ，命令行里什么都没有，\n' +
          '但它是我们刚 spawn 的、且只绑回环'
      ).toBe(true)
    })

    it('★★早就开着的进程 → **不杀**（用户自己的服务）', () => {
      const info: ProcInfo = {
        pid: 9999,
        exePath: 'C:\\MyServer\\server.exe',
        commandLine: '"C:\\MyServer\\server.exe"',
        /* 一小时前就开了 —— 比我们启动实例早得多 */
        createdAt: startedAt - 3600_000
      }
      expect(
        shouldKillByPort(info, { sinceMs: startedAt, loopbackOnly: true }),
        '★这条是防误杀的核心：比实例还早就在跑的进程，绝对不是我们起的'
      ).toBe(false)
    })

    it('★★绑对外端口 + 是 QQ → **可以杀**（OneBot 端口本来就对外）', () => {
      /*
       * ══════════════════════════════════════════════════════════════════
       * 主人 2026-10-08 实测暴露：这条原先断言"对外就不杀"，是错的
       * ══════════════════════════════════════════════════════════════════
       *
       * 现场（日志实据）：
       *   删除实例：端口 6200 被 pid 26324 占用，但**证据不足**
       *            （不是回环监听 ✘）—— 这次不动它。它是 E:\QQ\QQ.exe
       *
       * netstat 实测：`0.0.0.0:6200 LISTENING` —— NapCat 在实例端口上
       * 开的是 **OneBot 端口**，**本来就该对外**（机器人框架要连它）。
       * 旧判据要求"必须回环"，于是对最常见的 NapCat 场景**恒为假**，
       * 结果实例永远停不掉、删不掉。
       *
       * 现在：对外监听时用**进程名**补鉴别力 —— 是 QQ 就认。
       */
      const info: ProcInfo = {
        pid: 26324,
        exePath: 'E:\\QQ\\QQ.exe',
        createdAt: startedAt + 500
      }
      expect(
        shouldKillByPort(info, { sinceMs: startedAt, loopbackOnly: false }),
        '★NapCat 注入的 QQ 在 OneBot 端口上是对外监听的，必须认得出 ——\n' +
          '否则这个实例永远删不掉、停不掉（主人实测就是这个现象）'
      ).toBe(true)
    })

    it('★★绑对外端口 + **不是** QQ → 不杀（别人的服务）', () => {
      /*
       * 这是上一条的对照，也是"补鉴别力"的那一刀：
       * 用户完全可能在 6200 上跑别的对外服务，那不是我们的，绝不能杀。
       */
      const info: ProcInfo = {
        pid: 9999,
        exePath: 'C:\\MyServer\\server.exe',
        createdAt: startedAt + 500
      }
      expect(
        shouldKillByPort(info, { sinceMs: startedAt, loopbackOnly: false }),
        '对外监听 + 不是 QQ → 不杀。用户自己的服务不能被误杀'
      ).toBe(false)
    })

    it('★绑对外 + 查不到 exePath → 不杀（保守）', () => {
      const info: ProcInfo = { pid: 28704, createdAt: startedAt + 500 }
      expect(
        shouldKillByPort(info, { sinceMs: startedAt, loopbackOnly: false }),
        '拿不到进程路径就无法确认是 QQ —— 不杀'
      ).toBe(false)
    })

    it('★★读不到启动时间 → **不杀**（保守）', () => {
      const info: ProcInfo = { pid: 28704, exePath: 'E:\\QQ\\QQ.exe' }
      expect(
        shouldKillByPort(info, { sinceMs: startedAt, loopbackOnly: true }),
        '★拿不到证据就不能杀 —— 漏杀只是"没停干净"，误杀是不可逆的'
      ).toBe(false)
    })

    it('★完全查不到进程信息 → 不杀', () => {
      expect(shouldKillByPort(undefined, { sinceMs: startedAt, loopbackOnly: true })).toBe(false)
    })

    it('★留了 2 秒余量（记录时刻与进程创建之间的小误差）', () => {
      /* 进程比"记录的开始时刻"早 1.5 秒 —— 仍在余量内，算我们的 */
      const info: ProcInfo = { pid: 1, createdAt: startedAt - 1500 }
      expect(shouldKillByPort(info, { sinceMs: startedAt, loopbackOnly: true })).toBe(true)
      /* 早 30 秒 —— 超出余量，不认 */
      const old: ProcInfo = { pid: 1, createdAt: startedAt - 30_000 }
      expect(shouldKillByPort(old, { sinceMs: startedAt, loopbackOnly: true })).toBe(false)
    })
  })
})
