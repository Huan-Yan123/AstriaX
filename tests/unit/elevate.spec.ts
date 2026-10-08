import { describe, expect, it, vi } from 'vitest'
import {
  alreadyRelaunched,
  argsForRelaunch,
  buildStartProcessCommand,
  decideElevate,
  ELEVATED_FLAG,
  isElevatedFromWhoami
} from '../../src/main/elevate'

/**
 * 启动器自我提权。
 *
 * 为什么不是让 NapCat 的 bat 自己提权：bat 被 runas 拉起的是另一个进程，
 * 我们 spawn 的那个立刻退出 —— 句柄/stdout/进程树全失效，用户点「停止」停不掉真的那个。
 * 让启动器整体是管理员，NapCat 才是我们的子进程，控制权才完整。
 */
describe('启动器自我提权', () => {
  describe('管理员判定', () => {
    it('whoami 输出里有高完整性 SID（S-1-16-12288）→ 是管理员', () => {
      const out = [
        'Mandatory Label\\High Mandatory Level  Label  S-1-16-12288',
        'BUILTIN\\Administrators  Alias  S-1-5-32-544'
      ].join('\n')
      expect(isElevatedFromWhoami(() => ({ status: 0, stdout: out }))).toBe(true)
    })

    it('System 完整性（S-1-16-16384）也算够权限', () => {
      expect(isElevatedFromWhoami(() => ({ status: 0, stdout: 'S-1-16-16384' }))).toBe(true)
    })

    it('中等完整性（S-1-16-8192）→ 是普通用户，需要提权', () => {
      const out = 'Mandatory Label\\Medium Mandatory Level  Label  S-1-16-8192'
      expect(isElevatedFromWhoami(() => ({ status: 0, stdout: out }))).toBe(false)
    })

    it('命令本身失败 → 保守当作没权限（但不会因此崩）', () => {
      expect(isElevatedFromWhoami(() => ({ status: 1, stdout: '' }))).toBe(false)
    })
  })

  describe('防死循环', () => {
    it('带 --elevated 标记的参数算「已经重开过」', () => {
      expect(alreadyRelaunched(['app.exe', '--elevated'])).toBe(true)
      expect(alreadyRelaunched(['app.exe'])).toBe(false)
    })

    it('重开参数不会把旧标记带上两遍', () => {
      const next = argsForRelaunch(['app.exe', '--elevated', '--hidden'])
      expect(next.filter((a) => a === ELEVATED_FLAG)).toHaveLength(1)
      expect(next).toContain('--hidden')
    })
  })

  describe('PowerShell 命令拼接', () => {
    it('路径含空格会被正确引起来', () => {
      const c = buildStartProcessCommand('C:\\Program Files\\MXBot\\mxbot.exe', ['--elevated'])
      expect(c).toBe("Start-Process -FilePath 'C:\\Program Files\\MXBot\\mxbot.exe' -ArgumentList '--elevated' -Verb RunAs")
    })

    it('参数里的单引号按 PowerShell 规则翻倍转义（防止注入）', () => {
      const c = buildStartProcessCommand('C:\\a.exe', ["it's"])
      expect(c).toContain("'it''s'")
    })

    it('没有参数时不留空 -ArgumentList', () => {
      expect(buildStartProcessCommand('C:\\a.exe', [])).toBe("Start-Process -FilePath 'C:\\a.exe' -Verb RunAs")
    })
  })

  describe('决策', () => {
    it('已经是管理员 → 直接继续，不重开', () => {
      const relaunch = vi.fn(() => true)
      expect(decideElevate({ isElevated: true, argv: [], relaunch })).toBe('already')
      expect(relaunch).not.toHaveBeenCalled()
    })

    it('不是管理员且没重开过 → 尝试提权重开', () => {
      const relaunch = vi.fn(() => true)
      expect(decideElevate({ isElevated: false, argv: [], relaunch })).toBe('relaunched')
      expect(relaunch).toHaveBeenCalledOnce()
    })

    it('用户拒绝 UAC → 不重开、继续以普通权限跑（AstrBot 还能用）', () => {
      const relaunch = vi.fn(() => false)
      expect(decideElevate({ isElevated: false, argv: [], relaunch })).toBe('declined')
    })

    it('已经重开过还不是管理员 → 不再纠缠，避免无限重启', () => {
      const relaunch = vi.fn(() => true)
      const v = decideElevate({ isElevated: false, argv: ['--elevated'], relaunch })
      expect(v).toBe('declined')
      expect(relaunch).not.toHaveBeenCalled()
    })
  })
})
