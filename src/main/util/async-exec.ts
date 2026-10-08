import { spawn, spawnSync } from 'child_process'

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** 边跑边收输出（给进度用） */
  onData?: (chunk: string, stream: 'out' | 'err') => void
  /*
   * 取消信号 —— 触发时**杀掉整棵进程树**并立刻返回。
   *
   * 主人 2026-09-27：
   *   「安装/下载一个加入取消，防止卡住了只能重启软件来换更快的
   *     安装/下载源」
   *
   * 装 AstrBot 依赖要几分钟，而下错源时（清华源 403、或源慢得离谱）
   * 用户**只能干等或重启软件** —— 重启还会留下半个安装目录。
   *
   * ## 为什么用原生 AbortSignal 而不是自造回调
   *
   * `fetch` 和 `setTimeout` 都认它，而下载层用的正是 `fetch` ——
   * 同一个 signal 一路传下去，**HTTP 请求和子进程会被同一次取消
   * 一起中断**，不用各写一套。
   */
  signal?: AbortSignal
}

/**
 * 异步执行外部命令。
 *
 * 为什么不用 spawnSync：主进程只有一个事件循环，spawnSync 会把它整段堵住。
 * 之前 pip install astrbot（几分钟）、Expand-Archive（117MB 要十几秒）都是同步跑的，
 * 结果就是「装一个东西时整个界面点不动、别的按钮也全变灰」。
 * 换成 spawn 之后这些工作跑在独立子进程里，主进程照常响应 IPC，
 * 多个安装任务也能真正并行推进。
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    /* 已经取消了就别起进程 —— 否则"取消之后又冒出一个 pip" */
    if (opts.signal?.aborted) {
      resolve({ status: -1, stdout: '', stderr: '已取消' })
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true
      })
    } catch (e) {
      resolve({ status: -1, stdout: '', stderr: String(e) })
      return
    }

    let out = ''
    let err = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const done = (status: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      /* 取消监听要摘掉，否则长会话里会越挂越多 */
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ status, stdout: out, stderr: err })
    }

    /*
     * 取消：**杀整棵进程树**再返回。
     *
     * ## 为什么不是 `child.kill()`
     *
     * Windows 上它只杀直接子进程，而 pip / tar 这类**会派生子进程**
     *（pip 装源码包时要调编译器）。留一个孤儿 pip 在后面写文件，
     * 比不取消还糟 —— 那正是"取消了目录反而更乱"的来源。
     *
     * `taskkill /T /F` 按进程树递归，是这里唯一可靠的做法。
     *
     * ## 为什么用 `spawnSync`
     *
     * 取消路径**本身不能被取消**，而且它必须**同步发出** ——
     * 否则 `done()` 会先返回，调用方以为进程没了，实际它还活着。
     */
    const onAbort = (): void => {
      if (settled) return
      try {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            timeout: 5000,
            windowsHide: true,
            stdio: 'ignore'
          })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        /* 进程可能已经退了 */
      }
      err += '\n已取消'
      done(-1)
    }

    opts.signal?.addEventListener('abort', onAbort, { once: true })

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 已经退出了 */
        }
        done(-1)
      }, opts.timeoutMs)
    }

    child.stdout?.on('data', (b: Buffer) => {
      const s = b.toString()
      out += s
      // 输出太多时只留尾部，避免长任务把内存吃光
      if (out.length > 4_000_000) out = out.slice(-2_000_000)
      opts.onData?.(s, 'out')
    })
    child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString()
      err += s
      if (err.length > 4_000_000) err = err.slice(-2_000_000)
      opts.onData?.(s, 'err')
    })
    child.on('error', (e) => {
      err += String(e)
      done(-1)
    })
    child.on('close', (code) => done(code))
  })
}

/** 跑 PowerShell 脚本（异步；解压之类的活都用它） */
export function runPowerShell(script: string, opts: RunOptions = {}): Promise<RunResult> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], opts)
}

/**
 * 把一段文本编成 PowerShell 的**单引号字符串字面量**。
 *
 * PowerShell 单引号串里唯一的转义规则是「单引号写两遍」，
 * 除此之外里面的一切都是字面量（`$`、反引号都不会被解释），
 * 所以它比双引号安全得多，适合放路径。
 *
 * 为什么必须有这个函数：我们踩过坑 —— 直接把路径塞进 `'${path}'`，
 * 结果用户数据根路径里只要有一个单引号（Windows 合法字符），
 * PowerShell 就报 `The string is missing the terminator: '`，
 * 解压直接失败，而且是**只有那部分用户会遇到**的偶发故障，极难排查。
 */
export function psQuote(text: string): string {
  return `'${String(text).replace(/'/g, "''")}'`
}

/**
 * 解压 zip —— 统一入口，内部负责正确转义。
 *
 * 别在调用处自己拼 `Expand-Archive -LiteralPath '${p}'`：那样迟早会踩引号坑，
 * 而且踩了之后报错信息（PowerShell 语法错误）完全指不到真正的原因。
 */
export function expandArchive(zip: string, dest: string, opts: RunOptions = {}): Promise<RunResult> {
  const script = `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(dest)} -Force`
  return runPowerShell(script, opts)
}

/**
 * 同步执行外部命令 —— **只给毫秒级的短命令用**。
 *
 * 存在的理由：有些查询卡在「必须同步」的位置上。比如每次启动 NapCat 都要拿
 * QQ.exe 的绝对路径，而启动链本身是同步的；把它整条链改成异步得不偿失。
 *
 * 什么时候**不要**用：pip install、解压、下载这类要几秒到几分钟的活，
 * 用 run()，否则界面会整个卡住（这个坑我们踩过，见上面 run() 的注释）。
 * 所以这里加了超时上限兜底，防止误用成长任务时把主进程锁死。
 */
export function runSync(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): RunResult {
  const r = spawnSync(cmd, args, {
    timeout: opts.timeoutMs ?? 5000,
    windowsHide: true,
    encoding: 'utf8'
  })
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? String(r.error ?? '')
  }
}
