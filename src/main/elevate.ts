/**
 * 启动器自我提权。
 *
 * 为什么是「整个启动器提权」而不是「只把 NapCat 提起来」：
 *
 * NapCat 是注入 QQ.exe 运行的（它的 launcher.bat 里
 * NapCatWinBootMain.exe <QQ.exe> NapCatWinBootHook.dll），注入需要管理员权限。
 * 而 spawn 本身没有提权能力，唯一的路是 ShellExecute 的 runas 动词。
 *
 * 如果让官方 bat 自己提权：它 runas 出的是**另一个进程**，我们 spawn 的那个
 * 立刻就退出了 —— 子进程句柄、stdout/stderr、taskkill /T 的进程树全都失效，
 * 用户点「停止」也停不掉真正在跑的那个。这正是「官方自己提权会丢控制」。
 *
 * 如果我们在外部用 Start-Process -Verb RunAs 把 bat 拉起来，同样拿不到句柄。
 *
 * 所以：让**启动器自己**以管理员身份运行。这样 NapCat 就是我们普通 spawn 出来的
 * 子进程，控制权完整；而 bat 里的 net session 自检会因为已经是管理员而直接通过，
 * 不会再 runas 重开，也就不会丢控制。
 */

/** 标记：本次进程已经是被提权重开的，别再提一次（防死循环） */
export const ELEVATED_FLAG = '--elevated'

export type ElevateVerdict =
  /** 已经是管理员（或被提权重开过），正常继续 */
  | 'already'
  /** 成功拉起了提权实例，当前这个该退了 */
  | 'relaunched'
  /** 用户拒绝了 UAC 或提权失败 —— 继续以普通权限跑（AstrBot 仍可用） */
  | 'declined'

/**
 * 判断当前进程是否是管理员。
 *
 * 用 whoami 的组 SID 而不是 net session：
 * net session 在「Server 服务被停掉」时对管理员也会失败，会造成误判并反复重启；
 * S-1-16-12288 = 高完整性（管理员），S-1-16-16384 = System，这两个才是权威标志。
 */
export function isElevatedFromWhoami(run: () => { status: number | null; stdout: string }): boolean {
  const r = run()
  if (r.status !== 0) return false
  return /S-1-16-(12288|16384)/.test(r.stdout)
}

/** 是否已经是被提权重开的那一次（防无限重启） */
export function alreadyRelaunched(argv: string[]): boolean {
  return argv.includes(ELEVATED_FLAG)
}

/** 拼 Start-Process 提权命令（PowerShell 单引号转义：内部单引号翻倍） */
export function buildStartProcessCommand(exe: string, args: string[]): string {
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const argList = args.length ? ` -ArgumentList ${args.map(q).join(',')}` : ''
  return `Start-Process -FilePath ${q(exe)}${argList} -Verb RunAs`
}

/** 重开时要带的参数：去掉旧的标记，再补一个新的 */
export function argsForRelaunch(argv: string[]): string[] {
  return [...argv.filter((a) => a !== ELEVATED_FLAG), ELEVATED_FLAG]
}

/**
 * 决定要不要提权重开。
 * 纯决策逻辑，副作用（查权限/拉起新进程/退出）全部注入，方便单测覆盖每条分支。
 */
export function decideElevate(deps: {
  isElevated: boolean
  argv: string[]
  /** 尝试以管理员身份重开；返回 true 表示成功拉起 */
  relaunch: () => boolean
}): ElevateVerdict {
  if (deps.isElevated) return 'already'
  // 已经被提权重开过还是没权限：可能是用户第二次也拒了，别再纠缠
  if (alreadyRelaunched(deps.argv)) return 'declined'
  return deps.relaunch() ? 'relaunched' : 'declined'
}
