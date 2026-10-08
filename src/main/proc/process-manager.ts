import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { appendFileSync, writeFileSync } from 'fs'

export type ProcStatus = 'starting' | 'running' | 'stopped' | 'error'

export interface StartSpec {
  id: string
  cmd: string
  args: string[]
  port: number // 仅记录；健康探测归 health.ts
  cwd?: string
  detached?: boolean
  logFile?: string
  /** 额外环境变量（AstrBot 要用 MXBOT_SITE 指定包目录；embed Python 忽略 PYTHONPATH） */
  env?: Record<string, string>
}

export interface ProcHandle {
  status: ProcStatus
  pid: () => number | undefined
  eventually: (target: ProcStatus, timeoutMs: number) => Promise<void>
  /** 进程退出码（还没退出时为 undefined） */
  exitCode?: () => number | null | undefined
  /** 子进程最后几行输出：启动失败时用它告诉用户真实原因 */
  tail?: () => string
  /**
   * 最后一次收到子进程输出的时刻（毫秒时间戳）。
   * 启动守卫用它区分「还在推进」和「真的卡死」—— 见 process-manager 里的注释。
   */
  lastOutputAt?: () => number
}

export interface ProcessManager {
  start: (spec: StartSpec) => Promise<ProcHandle>
  /** 树杀：Windows=taskkill /T /F；Unix=process.kill(-pid)（同一进程组，前提 detached 自成组长） */
  killTreeSync: (id: string) => void
  killAllSync: () => void
  statusOf: (id: string) => ProcStatus | undefined
  /** id→pid 快照：给资源统计用（stopped 后消失） */
  pidsOf: () => Map<string, number>
  onStatus: (cb: (id: string, status: ProcStatus) => void) => () => void
  /** 子进程最后几行输出（排查启动失败用） */
  tailOf: (id: string) => string
}

export class DuplicateInstance extends Error {}

/**
 * 可注入的依赖。
 *
 * `spawnImpl` 存在的唯一理由是**让测试能观察"到底对哪些 PID 下了杀令"**
 * 而不必真的执行 taskkill —— 因为要测的恰恰是"不该杀的时候有没有杀"，
 * 真跑 taskkill 会去动宿主机上的真实进程（测试里只该用假实现）。
 *
 * `killImpl` 同理：Windows 下默认走 taskkill，测试里换成记录器。
 */
export interface ProcManagerDeps {
  spawnImpl?: typeof spawn
  /** 收到要杀的 PID 时调用（默认实现：Windows=taskkill /T /F，其它=负 pid 组杀） */
  killImpl?: (pid: number) => void
}

export function createProcessManager(deps: ProcManagerDeps = {}): ProcessManager {
  const spawnFn = deps.spawnImpl ?? spawn
  const procs = new Map<
    string,
    { child: ChildProcess; status: ProcStatus; handle: ProcHandle }
  >()
  const bus = new EventEmitter()
  const listeners = new Set<(id: string, s: ProcStatus) => void>()
  /** 退出信息（退出码 + 输出尾部）：启动失败时给用户看真实原因 */
  const exitInfo = new Map<string, { code: number | null; tail: string }>()
  /** 主动 kill 的 id：它们的退出码当然非 0，不能当成启动失败 */
  const killing = new Set<string>()

  function setStatus(id: string, s: ProcStatus) {
    const p = procs.get(id)
    if (!p) return
    p.status = s
    p.handle.status = s
    bus.emit('status', id, s)
    for (const cb of listeners) cb(id, s)
  }

  /**
   * 这个记录现在还"活着"吗？
   *
   * ## 为什么必须单独判（这是本轮最严重的一个修复）
   *
   * 项目的设计文档立过一条硬规矩：
   *   「清理是白名单式 —— 只杀管理器自己 spawn 并持有 pid 的进程树，
   *     绝不按进程名扫描系统（用户另跑的 napcat/astrbot/QQ 一概不碰）」
   *
   * 但原来 killTreeSync 只判 `p.child.pid` 真值、**不判状态**，
   * 而 exit 回调又**故意保留** procs 记录（为了让 statusOf 能返回终态，
   * 见下面 exit 处理里的说明）。两件事凑在一起就是：
   *
   *   实例崩溃过（记录留在 error 态）→ 用户点「退出（停止全部实例）」
   *   → killAllSync 遍历**全部** key（含 stopped/error）
   *   → 对一个早就死掉的 PID 执行 taskkill /T /F
   *
   * 而 **PID 会被系统回收复用**（审计实测：约 6.5~7.7 秒的窗口，
   * 60 个释放的 PID 里 5 个被复用）。旧 PID 很可能已经属于一个
   * **完全无关的活进程** —— 用户的 QQ、他的 NapCat、甚至别的软件。
   * taskkill 对活着的 PID 返回 0，于是**无辜进程被打死**，
   * 而且是在管理员权限下。
   *
   * 这比"杀不掉"严重得多：杀不掉只是不好用，杀错了是毁用户的东西。
   *
   * ## 判据为什么用三重
   *
   * 1. **状态**：stopped / error 一律不动（业务语义上的终态）
   * 2. **exitCode / signalCode**：Node 明确告知已退出 —— 这是最硬的证据，
   *    哪怕状态因为某种原因没更新到，也不会误杀
   * 3. pid 真值：连 pid 都没有就没法杀
   *
   * 第 2 条是关键：它不依赖我们自己的状态机是否正确，
   * 而是直接问 Node "这个子进程退了没"。状态机可能因为竞态落后，
   * 但 exitCode 不会骗人。
   */
  function isLiveForKill(p: {
    child: ChildProcess
    status: ProcStatus
  }): boolean {
    // 业务终态：一定不杀
    if (p.status !== 'running' && p.status !== 'starting') return false
    // Node 说退了就退了（比状态机更可信）
    if (p.child.exitCode !== null && p.child.exitCode !== undefined) return false
    if (p.child.signalCode !== null && p.child.signalCode !== undefined) return false
    // 没 pid 也无从下手
    if (!p.child.pid) return false
    return true
  }

  function start(spec: StartSpec): Promise<ProcHandle> {
    const old = procs.get(spec.id)
    // error 也允许重试：上次启动失败后进程已经没了，
    // 若把 error 当成「还在运行」，用户就永远点不动了（日志里反复出现「实例已在运行」）。
    if (old && old.status !== 'stopped' && old.status !== 'error') {
      return Promise.reject(new DuplicateInstance(`实例已在运行: ${spec.id}`))
    }
    if (old) {
      // 清掉上次的记录，避免旧 handle 的监听继续干扰新进程
      procs.delete(spec.id)
      exitInfo.delete(spec.id)
      killing.delete(spec.id)
    }

    return new Promise((resolve, reject) => {
      // 有没有 logFile 都要收输出：程序秒退时得知道它为什么退
      const stdio = ['ignore', 'pipe', 'pipe'] as const
      /*
       * 控制台窗口的坑（真机踩过，证据是窗口标题）：
       *   Select "E:\...\NapCatWinBootMain.exe" "E:\QQ\QQ.exe" "E:\...\NapCatWinBootHook.dll"
       * 开头那个 Select 是 Windows 控制台「标记模式」的标题 —— 说明冒出来的黑框是
       * **NapCatWinBootMain.exe 自己的控制台**，不是我们 spawn 的 cmd。
       *
       * 机制（MSDN，CREATE_NO_WINDOW）：
       *   "This flag is ignored if ... used with either CREATE_NEW_CONSOLE or DETACHED_PROCESS."
       * Node 的 detached:true 在 Windows 上就是 DETACHED_PROCESS，于是 windowsHide 被忽略：
       *   spawn(cmd, {detached:true, windowsHide:true})
       *   → cmd 自己没有控制台
       *   → cmd 再同步启动 CUI 子进程（NapCatWinBootMain.exe 的 PE Subsystem = 3）
       *   → 孩子没控制台可继承，Windows 就**新建一个可见的控制台** = 黑框怼到用户脸上
       *
       * 所以 Windows 上必须 detached:false，让 windowsHide 真正生效，
       * 整条链（我们 → cmd → NapCatWinBootMain → 注入进 QQ）都继承那个隐藏的控制台。
       *
       * 树杀的代价：taskkill /T 原本靠 detached 自成进程组。但 Windows 上
       * taskkill /T 是按**父子关系**递归杀的，不需要进程组，所以 detached:false 也能杀干净。
       * （POSIX 侧才依赖负 pid 的进程组，那种情况下仍用 detached。）
       */
      const useDetached = spec.detached ?? process.platform !== 'win32'
      let child: ChildProcess
      try {
        child = spawnFn(spec.cmd, spec.args, {
          cwd: spec.cwd,
          detached: useDetached,
          stdio,
          // 让整条进程链都不冒控制台窗口（用户只看我们自己的界面）
          windowsHide: true,
          // 没传就继承当前环境
          env: spec.env ? { ...process.env, ...spec.env } : process.env
        })
      } catch (e) {
        return reject(e)
      }

      // 最后 N 行输出：启动失败时拿它给用户看真实原因
      const tailLines: string[] = []
      /*
       * 最后一次有输出的时刻。
       *
       * 为什么需要它：AstrBot 冷启动实测要 20~35 秒（Python + 依赖 + 数据库
       * 迁移 + 插件加载），而启动守卫原来是固定 30 秒超时 —— 用户日志里
       * 就出现过「进程一直在正常输出、33 秒时打印 AstrBot v4.28.0，
       * 但我们 30 秒就判超时把它杀了」。
       *
       * 一个**还在持续说话**的进程不该被当成卡死。有了这个时间戳，
       * 启动守卫就能在「最近还有输出」时放宽预算，只对真正沉默的进程收手。
       */
      let lastOutputAt = Date.now()
      /** 是否已经 resolve/reject 过：避免 ENOENT 时重复结算 */
      let settled = false
      const keepTail = (s: Buffer): void => {
        lastOutputAt = Date.now()
        for (const row of s.toString('utf8').split(/\r?\n/)) {
          if (!row.trim()) continue
          tailLines.push(row)
          if (tailLines.length > 20) tailLines.shift()
        }
      }

      const p = {
        child,
        status: 'starting' as ProcStatus,
        handle: undefined as unknown as ProcHandle
      }

      const evt = () =>
        ({
          status: p.status,
          pid: () => (child.pid ?? undefined),
          exitCode: () => child.exitCode,
          tail: () => tailLines.join('\n'),
          lastOutputAt: () => lastOutputAt,
          eventually: (target: ProcStatus, timeoutMs: number) =>
            new Promise<void>((ok, bad) => {
              if (p.status === target) return ok()
              // 进程已经没了却还等 running：立刻失败，别干等到超时
              if (p.status === 'error' || p.status === 'stopped') {
                return bad(new Error(`进程没能起来（当前 ${p.status}）: ${spec.id}`))
              }
              /*
               * 无论走哪条路（等到 / 超时 / 中途改判），都必须把监听器摘掉。
               *
               * 踩过的坑：原来只在「等到目标状态」那条路径上 removeListener，
               * 定时器超时那条只调 bad() 就完事 —— 于是每超时一次就在 bus 上
               * 永久留一个监听器。攒到第 11 个就触发
               *   MaxListenersExceededWarning: 11 status listeners added to [EventEmitter]
               * （实测就是这个数），而且这些死监听器还会被后续每次状态变更回调，
               * 闭包抓着 handle/timer，是实打实的泄漏。
               * 所以统一收敛到一个 cleanup，三条出口都过它。
               */
              let done = false
              const cleanup = (): void => {
                if (done) return
                done = true
                clearTimeout(timer)
                bus.removeListener('status', limbo)
              }
              const timer = setTimeout(() => {
                cleanup()
                bad(new Error(`等待 ${target} 超时（当前 ${p.status}）: ${spec.id}`))
              }, timeoutMs)
              const limbo = (_id: string, s: ProcStatus) => {
                if (s === target) {
                  cleanup()
                  ok()
                }
              }
              bus.on('status', limbo)
            })
        }) as ProcHandle
      p.handle = evt()

      /*
       * 顺序很关键：**先把记录放进 procs，再挂事件处理器**。
       * 否则进程极快退出时，exit 回调里的 setStatus 找不到记录会静默 return，
       * 状态更新整个丢掉。
       */
      procs.set(spec.id, p)

      /*
       * resolve 必须发生在 **spawn 事件**，而不是 spawn() 调用返回之后。
       *
       * 踩过的坑：原来在函数末尾直接 `settled = true; resolve(p.handle)`，
       * 那时 spawn 事件还没派发，`p.status` 还是 'starting'。
       * 于是调用方拿到 handle 的瞬间状态是 starting —— 想判断"起来了没"
       * 只能自己轮询，而且中间存在一个**状态窗口**：
       * 进程其实已经就绪，管理器却说 starting。
       * （实测：start() 返回后立刻 statusOf() 得到 'starting'。）
       *
       * 改成等 spawn 或 error 二者之一来结算，语义就干净了：
       *   resolve  → 进程确实起来了（此时状态已是 running）
       *   reject   → 压根没起来（ENOENT / EACCES 等）
       */
      child.on('spawn', () => {
        setStatus(spec.id, 'running')
        if (settled) return
        settled = true
        resolve(p.handle)
      })

      child.on('exit', (code) => {
        exitInfo.set(spec.id, { code, tail: tailLines.join('\n') })
        // 判据：非 0 退出且不是我们主动杀的 → 失败。
        // 不能用 status==='starting' 判断：spawn 事件会先把状态置成 running，
        // 而 AstrBot 那种秒退（ModuleNotFoundError）退出时状态已经是 running。
        if (!killing.has(spec.id) && code !== 0) {
          setStatus(spec.id, 'error')
        } else {
          setStatus(spec.id, 'stopped')
        }
        killing.delete(spec.id)
        /*
         * 这里**不能**把 procs 里的记录删掉。
         *
         * 我一度删过，结果打破了对外契约：process-manager.spec.ts 要求
         * 「启动即失败 → statusOf 返回 'error'」「正常退出 → statusOf 返回 'stopped'」，
         * 删掉记录后 statusOf 变成 undefined，调用方拿不到终态。
         * 所以终态必须留着。
         *
         * 那内存怎么控？—— 在 start() 入口按 id 覆盖（见函数开头 `if (old) procs.delete`），
         * 所以**同一个实例反复启停不会累积**；只有"实例被删掉"这种情况会留下残余，
         * 那份残余也只是一条小对象，且随实例数封顶，不构成增长问题。
         */
      })
      child.on('error', (e) => {
        exitInfo.set(spec.id, { code: null, tail: String(e) })
        // 已经 resolve 过了（进程起过又崩）就只标状态；
        // 还在等待中（例如 ENOENT，压根没起来）才 reject
        if (settled) {
          setStatus(spec.id, 'error')
          return
        }
        settled = true
        procs.delete(spec.id)
        reject(e)
      })

      // 实例日志落盘：stdout/stderr → logFile（时间戳前缀，逐行追加）
      // 没有 logFile 时也收进 tail，供启动失败诊断用
      const line = (s: Buffer, stream: 'out' | 'err'): void => {
        keepTail(s)
        if (!spec.logFile) return
        /*
         * ★★ 日志时间戳必须用**本机时间**（主人 2026-09-27：
         *    「实例日志的时间怎么和本机时间不一致」）
         *
         * ## 原来的错
         *
         *     const stamp = new Date().toISOString().slice(11, 23)
         *                                       ^^^^^^^^^^^^^^^^
         * `toISOString()` 返回的是 **UTC**，所以日志里写的是 UTC 时刻。
         * 用户在东八区看到的就是**比实际早 8 小时**：
         *
         *     日志里：[05:54:17][out] ...        ← UTC
         *     真实时间：13:54:17                  ← 本机
         *（他贴的日志里，AstrBot 自己打的 `[13:54:24]` 与我们的
         *  `[05:54:17]` 正好差 8 小时 —— 一眼可见的错位。）
         *
         * 后果不只是"看着别扭"：
         *   · 用户按时间对不上故障现象（"我 14 点操作的，日志里没有"）
         *   · 排查时会把**两段不同时间**的运行混起来看
         *   · 我们自己的「只看本次运行」如果按这个时间比较也会错
         *
         * ## 现在：手工拼本机时间
         *
         * 不用 `toLocaleString()` —— 它的格式随系统区域变（可能是
         * `2026/9/27 下午1:54:17`），而日志需要**稳定的定长格式**。
         * 所以取本机时区下的各字段自己拼 `HH:MM:SS.mmm`。
         */
        const d = new Date()
        const p2 = (n: number): string => String(n).padStart(2, '0')
        const p3 = (n: number): string => String(n).padStart(3, '0')
        const stamp = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
        /*
         * ★ 先把所有行拼成**一段**，再一次性 append（性能修复）
         *
         * 审计抓出的问题：原来在循环里逐行 `appendFileSync`。
         * 每次 appendFileSync 都是一次完整的 open → write → close
         * （同步系统调用），而一个 data chunk 常被切出**几十到几百行**
         *（上面 137-147 行自己就在处理多行的情况）。
         *
         * 后果：实例输出密集的时期（启动刷日志、NapCat 打印消息流水）
         * 每个输出事件要做 N 次同步磁盘写，全在主进程上 ——
         * 直接把"界面点不动 / 所有 IPC 排队"放大。
         *
         * 同项目的 proc/napcat-log.ts:167-175 早就把 delta 合并成
         * 一次 append 了 —— 正确写法项目里已有先例，这里对齐它。
         *
         * 行为不变：写进文件的每一行内容和顺序都一样，只是合成一次写入。
         */
        const rows = s.toString('utf8').split(/\r?\n/).filter((r) => r.length > 0)
        if (!rows.length) return
        const chunk = rows.map((row) => `[${stamp}][${stream}] ${row}\n`).join('')
        try {
          appendFileSync(spec.logFile, chunk, 'utf8')
        } catch {
          /* 追加失败忽略 */
        }
      }
      if (spec.logFile) {
        try {
          writeFileSync(spec.logFile, '', { flag: 'a' })
        } catch {
          /* 只读盘时跳过，不影响启动 */
        }
      }
      child.stdout?.on('data', (c: Buffer) => line(c, 'out'))
      child.stderr?.on('data', (c: Buffer) => line(c, 'err'))
    })
  }

  function killTreeSync(id: string) {
    const p = procs.get(id)
    /*
     * ★ 这里必须用 isLiveForKill，不能只判 pid 真值。
     *
     * 原因见 isLiveForKill 的注释：已退出进程的 PID 会被系统回收复用，
     * 对陈旧 PID 执行 taskkill 会杀掉一个无辜的活进程。
     * 这一条是"绝不误杀用户进程"那条设计承诺的实际落点。
     */
    if (!p || !isLiveForKill(p)) return
    const pid = p.child.pid
    if (!pid) return

    // 标记成主动杀：退出码会是非 0，但这不是「启动失败」
    killing.add(id)

    if (deps.killImpl) {
      deps.killImpl(pid)
      return
    }

    if (process.platform === 'win32') {
      /*
       * /F 强杀 /T 连子进程。
       *
       * ★ 必须挂 error 监听（审计抓出的"停止反而把启动器打崩"）
       *
       * spawn 本身失败（taskkill 不存在、被安全软件拦、路径异常）会发
       * 'error' 事件。**没有监听者时 Node 会把它抛成 uncaughtException** ——
       * 而 index.ts 的 uncaughtException 处理是弹崩溃框 + `app.exit(1)`，
       * 于是用户的观感是「点了停止，启动器自己没了，实例还在跑」。
       *
       * 对照 logger.ts 里同类 spawn 是有 error 防护的 —— 同一类写法，
       * 一处补了一处漏了。这里补上：失败只记一行，不升级成崩溃。
       */
      const child = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      child.on?.('error', () => {
        /* taskkill 起不来时无法树杀；上层还有按端口补杀兜底（stopInstanceHard） */
      })
    } else {
      try {
        process.kill(-pid, 'SIGKILL') // detached → 负 pid = 整组
      } catch {
        /* 已退出，忽略 */
      }
    }
  }

  return {
    start,
    killTreeSync,
    killAllSync: () => {
      /*
       * 只遍历**还活着**的记录。
       *
       * killTreeSync 内部已经会拦一次，这里再过滤一次是有意为之：
       * killAllSync 是"退出前把实例都停掉"的最后一道闸，它遍历的集合
       * 本身就应该是"活着的进程"，而不是"历史上出现过的进程"。
       * 两道各自独立，任意一道生效都不会误杀。
       */
      for (const [id, p] of procs) {
        if (isLiveForKill(p)) killTreeSync(id)
      }
    },
    statusOf: (id) => procs.get(id)?.status,
    /** 子进程最后几行输出 + 退出码（诊断启动失败用） */
    tailOf: (id) => {
      const i = exitInfo.get(id)
      const live = procs.get(id)?.handle.tail?.() ?? ''
      const t = i?.tail || live
      const code = i?.code
      const head = code === undefined || code === null ? '' : `退出码 ${code}\n`
      return (head + t).trim()
    },
    pidsOf: () => {
      const out = new Map<string, number>()
      for (const [id, p] of procs) {
        if (p.child.pid && p.status === 'running') out.set(id, p.child.pid)
      }
      return out
    },
    onStatus: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
