import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../../src/main/logs/logger'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-log-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('createLogger（独立于 Electron 的兜底日志）', () => {
  it('log 落盘到按日期滚动的文件，行含时间/级别/来源/消息', () => {
    const logger = createLogger({ dataRoot: root, dateFor: () => '2026-09-12' })
    logger.log('INFO', 'proc', '实例 a_x 启动成功')
    logger.log('ERROR', 'proc', '实例 n_y 启动失败', 'ECONNREFUSED')
    const f = join(root, 'logs', 'app-2026-09-12.log')
    expect(existsSync(f)).toBe(true)
    const text = readFileSync(f, 'utf8')
    expect(text).toContain('[INFO] [proc] 实例 a_x 启动成功')
    expect(text).toContain('[ERROR] [proc] 实例 n_y 启动失败 :: ECONNREFUSED')
  })

  it('crash：同步写 ERROR 行（软件崩溃前最后几毫秒也要留下来）', () => {
    const logger = createLogger({ dataRoot: root, dateFor: () => '2026-09-12' })
    logger.crash('uncaughtException', 'TypeError: boom')
    const f = join(root, 'logs', 'app-2026-09-12.log')
    expect(readFileSync(f, 'utf8')).toContain('[CRASH] [uncaughtException] TypeError: boom')
  })

  it('不同日期自动换文件', () => {
    let fake = '2026-09-12'
    const logger = createLogger({ dataRoot: root, dateFor: () => fake })
    logger.log('INFO', 'app', 'day1')
    fake = '2026-09-13'
    logger.log('INFO', 'app', 'day2')
    const files = readdirSync(join(root, 'logs')).sort()
    expect(files).toEqual(['app-2026-09-12.log', 'app-2026-09-13.log'])
    expect(readFileSync(join(root, 'logs', files[0]), 'utf8')).toContain('day1')
    expect(readFileSync(join(root, 'logs', files[1]), 'utf8')).toContain('day2')
  })

  it('exportZip 调 runner 打包 logs+config+实例清单，产出带时间戳的 zip 路径', async () => {
    const logger = createLogger({
      dataRoot: root,
      dateFor: () => '2026-09-12',
      zipRunner: async (cmd, args) => {
        /*
         * ★ 压缩命令已从 `powershell Compress-Archive` 改成 `tar`
         *（主人 2026-09-27：「日志导出也要卡半天」）
         *
         * 实测同一份日志：Compress-Archive 896ms vs tar 20ms（快 45 倍），
         * 而导出的东西只有 0.1MB —— 慢的全是 PowerShell 冷启动。
         *
         * 注意 tar 的第一条候选；若它失败会回落到 powershell（见下一条测试）。
         */
        expect(cmd, '首选 tar（无 PowerShell 冷启动开销）').toBe('tar')
        expect(args, '要用 -a 让它按 .zip 扩展名产出真 zip').toContain('-a')
        expect(args).toContain('-f')
        return 0
      }
    })
    logger.log('INFO', 'app', 'some operation')
    const zip = await logger.exportZip()
    expect(zip).toMatch(/logs-export[\\/].+\.zip$/)
    expect(zip).toContain('2026')
  })

  it('exportZip 失败时抛出明确错误', async () => {
    const logger = createLogger({
      dataRoot: root,
      zipRunner: async () => 1
    })
    await expect(logger.exportZip()).rejects.toThrow('导出日志失败')
  })

  it('默认 dateFor/zipRunner 用真实时间与 PowerShell', () => {
    const logger = createLogger({ dataRoot: root })
    logger.log('INFO', 'app', 'ok')
    expect(readdirSync(join(root, 'logs'))[0]).toMatch(/app-\d{4}-\d{2}-\d{2}\.log/)
    expect(typeof logger.exportZip).toBe('function')
  })

  /*
   * ==========================================================================
   * Bug D：Compress-Archive 的路径必须转义；暂存目录不能在检查退出码前删
   * ==========================================================================
   *
   * ## D-1 路径注入 / 引号炸裂
   *
   * 原实现是裸插值：
   *
   *     `Compress-Archive -Force -Path '${staging}\\*' -DestinationPath '${zipPath}'`
   *
   * PowerShell 单引号串里**唯一的转义是「单引号写两遍」**。
   * 而数据根路径是用户可以自己选的（设置里能迁移到任意目录），
   * Windows 路径合法字符里就包含 `'`。路径里有一个单引号：
   *
   *     E:\my logs'\out
   *
   * 拼出来就是 `'E:\my logs'\out\*'` —— PowerShell 读到第二个引号就
   * 认为字符串结束了，报 `The string is missing the terminator: '`。
   * 表现是**只有这部分用户会遇到**的导出失败，而且报错完全指不到真因。
   *
   * 更糟的是它同时是注入面：路径里塞 `'; Remove-Item -Recurse ...`
   * 就会被当成命令执行。虽然路径来自本机用户自己，但日志导出这个动作
   * 是"把出问题的机器状态打包送出去"的场景，不该在这里开这种口子。
   *
   * 项目里已经有正确的 `psQuote()`（见 util/async-exec.ts），
   * 它把 `'` 变成 `''`，并明确说过就是为了这个坑。这里漏用了。
   *
   * ## D-2 暂存目录删得太早
   *
   *     const code = await compress(...)
   *     rmSync(staging, { recursive: true, force: true })   // ← 先删
   *     if (code !== 0) throw ...                            // ← 后判
   *
   * 顺序反了。压缩失败时暂存目录已经没了，**没法重试也没法人工翻看**——
   * 而这正是导出日志最需要的东西（压缩本身失败时，里面那份 staging
   * 就是唯一的原始素材）。
   *
   * 另一个问题：`rmSync` 在 `await` 之后无条件执行，如果 `compress`
   * 抛异常（runner 抛错而不是返回非 0），暂存目录**永远留在磁盘上**，
   * 累积成垃圾。所以清理要放在 finally 里，且失败时不能删。
   */
  describe('Bug D：PowerShell 转义与暂存目录清理', () => {
    /** 取出发给 powershell 的那段 -Command 脚本文本 */
    function scriptOf(args: string[]): string {
      const i = args.indexOf('-Command')
      return i >= 0 ? args[i + 1] : args.join(' ')
    }

    /*
     * 从脚本里推出暂存目录。
     *
     * 不能用「简单切引号」的办法：这正是被测的 bug —— 路径里如果有
     * 单引号，引号就不成对，切法失效。但**本测试用的 root 不含单引号**，
     * 所以这里的宽松提取是安全的（D-1 单独负责验证含引号的场景）。
     *
     * 脚本形状（走 psQuote 之后）：
     *   Compress-Archive -Force -Path 'E:\...\staging\*' -DestinationPath 'E:\...\x.zip'
     *
     * 所以取 `-Path ` 到 ` -DestinationPath` 之间的整段，去掉外层引号和结尾的 `\*`。
     *
     * 第一版正则写成 `(.+?)\\\*\s+-DestinationPath` —— 漏掉了路径与
     * `-DestinationPath` 之间的**闭合引号**，于是永远匹配不到。
     * 表现是"推不出暂存目录"，看着像实现坏了，其实是测试正则的错。
     */
    function stagingOf(script: string): string {
      const m = script.match(/-Path\s+([\s\S]+?)\s+-DestinationPath/)
      if (!m) return ''
      let p = m[1].trim()
      if (p.startsWith("'")) p = p.slice(1)
      if (p.endsWith("'")) p = p.slice(0, -1)
      return p.replace(/[\\/]\*$/, '')
    }

    it('★D-1 路径含单引号时必须能正常导出（tar 用参数数组，不拼命令行）', async () => {
      /*
       * ★ 这条测试的**契约变了**，值得说明为什么。
       *
       * 原来它验的是"PowerShell 单引号转义正确"—— 因为那时压缩命令是
       * 拼成一段 `-Command` 脚本文本的，路径里的 `'` 会破坏语法（还有注入面）。
       *
       * 现在首选命令是 `tar`，**参数以数组形式传给 spawn**
       *（`['-a','-c','-f',zipPath,'-C',staging,'.']`），
       * 根本不经过任何 shell —— 于是"引号转义"这类 bug **从结构上消失了**。
       *
       * 但契约不能丢：**含单引号的路径照样要能导出成功**。
       * 所以这条测试保留，只是断言从"转义对"改成"能跑通 + 参数是数组不是脚本"。
       */
      const nasty = join(root, "logs'export")
      mkdirSync(nasty, { recursive: true })
      let seenCmd = ''
      let seenArgs: string[] = []
      const logger = createLogger({
        dataRoot: nasty,
        dateFor: () => '2026-09-12',
        zipRunner: async (cmd, args) => {
          seenCmd = cmd
          seenArgs = args
          return 0
        }
      })
      logger.log('INFO', 'app', 'x')
      const zip = await logger.exportZip()

      expect(seenCmd, '首选 tar').toBe('tar')
      /*
       * 关键：**参数数组里原样保留那个单引号**（不需要转义，因为没有 shell）。
       * 若哪天有人改回"拼一段脚本"，这条会立刻红。
       */
      expect(
        seenArgs.some((a) => a.includes("logs'export")),
        `路径（含单引号）应当**原样**作为参数传递，而不是拼进脚本文本：${JSON.stringify(seenArgs)}`
      ).toBe(true)
      expect(zip).toMatch(/logs-export[\\/].+\.zip$/)
    })

    it('★D-2 压缩失败时暂存目录必须保留（那是唯一原始素材，不能先删）', async () => {
      let stagingDir = ''
      const logger = createLogger({
        dataRoot: root,
        dateFor: () => '2026-09-12',
        zipRunner: async (_cmd, args) => {
          /*
           * 注意：现在会**依次试两条候选**（tar → powershell），
           * 而 staging 路径只在 tar 的参数里（`-C <staging>`）。
           * 所以只取第一次出现的那个（后面那条是 PowerShell 脚本，没有 -C）。
           */
          const i = args.indexOf('-C')
          if (i >= 0 && !stagingDir) stagingDir = args[i + 1]
          return 1 // 所有候选都失败
        }
      })
      logger.log('INFO', 'app', 'x')
      await expect(logger.exportZip()).rejects.toThrow('导出日志失败')

      expect(stagingDir, '没能从参数里推出暂存目录').toBeTruthy()
      expect(
        existsSync(stagingDir),
        '压缩失败却把暂存目录删了 —— 用户失去唯一原始素材，也没法重试'
      ).toBe(true)
    })

    it('★tar 失败时自动回落到 Compress-Archive（老系统不能因此导不出日志）', async () => {
      /*
       * ★ 这条守的是"优化不能变成退化"。
       *
       * `tar.exe` 是 Windows 10 1803+ 才自带的。万一用户机器上没有
       *（或 PATH 被别的东西占了），**导不出日志**是最糟的结果 ——
       * 而用户往往正是遇到问题才来导出。
       *
       * 所以：tar 返回非 0 → 自动试 powershell Compress-Archive → 成功即成功。
       */
      const tried: string[] = []
      const logger = createLogger({
        dataRoot: root,
        dateFor: () => '2026-09-12',
        zipRunner: async (cmd) => {
          tried.push(cmd)
          // tar 失败、powershell 成功
          return cmd === 'tar' ? 1 : 0
        }
      })
      logger.log('INFO', 'app', 'x')
      const zip = await logger.exportZip()
      expect(tried, '两条候选都要试过，且按顺序').toEqual(['tar', 'powershell'])
      expect(zip).toMatch(/logs-export[\\/].+\.zip$/)
    })

    it('★D-3 压缩成功后才清掉暂存目录（否则磁盘一路涨）', async () => {
      let stagingDir = ''
      const logger = createLogger({
        dataRoot: root,
        dateFor: () => '2026-09-12',
        zipRunner: async (_cmd, args) => {
          // tar 的参数形状：['-a','-c','-f',zipPath,'-C',staging,'.']
          const i = args.indexOf('-C')
          stagingDir = i >= 0 ? args[i + 1] : ''
          return 0
        }
      })
      logger.log('INFO', 'app', 'x')
      await logger.exportZip()
      expect(stagingDir, '没能从参数里推出暂存目录').toBeTruthy()
      expect(existsSync(stagingDir), '成功了却不清理，暂存目录会无限累积').toBe(false)
    })

    /*
     * ★D-5 同步版（崩溃现场）的路径也必须转义
     *
     * ====================================================================
     * 这条是**反向测试逼出来的**，不是我先想到的
     * ====================================================================
     *
     * 跑反向验证时，我把 `psQuote(...)` 改回裸插值 `'${...}'`，
     * 期望 D-1 变红 —— 结果**全绿**。
     *
     * 查下去才发现：命令字符串原本在**两个地方各写了一遍**：
     *   - exportZip  → compressAndClean 内部
     *   - exportZipSync → 自己又拼了一次
     * 而我的反向替换命中的是后面那处（前面那处正则没匹配上），
     * 异步用例检查的却是前面那处 —— **改了没人管的那一处，测试当然不红**。
     *
     * 也就是说：sync 路径的引号修复当时**完全没有测试保护**。
     * 这比"少写一条测试"更危险 —— 它给人的印象是"这个 bug 已经修好并有覆盖"，
     * 实际上崩溃现场那条路径仍然会炸（而崩溃现场恰恰最需要能导出成功）。
     *
     * 修法是两手：
     *   1. 把命令拼装收成一个 `compress()`，两条路径共用（结构上消灭重复）
     *   2. 补这条测试，直接钉住 sync 路径的转义
     */
    it('★D-5 同步导出（崩溃现场）也走同一条命令，含引号的路径照样能打', () => {
      /*
       * ★ 契约随实现一起变了（说明见 D-1）。
       *
       * 这条测试原本是**反向测试逼出来的**：sync 路径的命令拼装曾经
       * 和 async 各写一份，改了异步那份、同步那份没人管 ——
       * 于是崩溃现场（最需要导出成功的时候）仍然会因引号炸掉。
       * 修法是收成一个 `compress()` 两条共用。
       *
       * 现在两条路径共用 `compressCandidates()`（tar → powershell），
       * 所以这里改为钉住"**同步版也用 tar、且参数是数组**"——
       * 若哪天有人只改异步那份，这条会立刻红（正是原来漏掉的那种情况）。
       */
      const nasty = join(root, "logs'export")
      mkdirSync(nasty, { recursive: true })
      let seenCmd = ''
      let seenArgs: string[] = []
      const logger = createLogger({
        dataRoot: nasty,
        dateFor: () => '2026-09-12',
        zipRunnerSync: (cmd, args) => {
          seenCmd = cmd
          seenArgs = args
          return 0
        }
      })
      logger.log('INFO', 'app', 'x')
      logger.exportZipSync()

      expect(seenCmd, '同步版（崩溃路径）也必须用 tar，不能各写一份').toBe('tar')
      expect(
        seenArgs.some((a) => a.includes("logs'export")),
        '含单引号的路径要原样作为参数传递（无 shell，不需转义）'
      ).toBe(true)
    })

    /*
     * ★D-4 runner 抛异常时：**也要保留**暂存目录（和 D-2 同一个道理）
     *
     * ====================================================================
     * 这条测试我写错过一次，记下来免得以后再错
     * ====================================================================
     *
     * 第一版写的是"runner 抛异常时也要**清掉**暂存目录"，理由是
     * 「原代码 `rmSync` 在 await 后面，抛异常就跳过它 → 每次失败漏一个目录」。
     *
     * 这个理由是**错的**，而且和我自己上面 D-2 的断言**直接矛盾**：
     *   - D-2 说：压缩失败要**保留** staging，因为那是唯一原始素材
     *   - D-4 却说：runner 抛异常要**删掉** staging
     * 两者都是"压缩没成功"，凭什么一个留一个删？
     *
     * 错在哪：我把"原代码在抛异常路径上意外漏掉清理"当成了要修的行为，
     * 于是顺手写了条断言把它钉住 —— 典型的**照着代码写测试**，
     * 而不是先想清楚应该是什么行为。
     *
     * 正确的是"失败一律保留"，理由和 D-2 相同：
     *   - 压缩失败（不管表现为退出码非 0 还是抛异常）**正是**用户要看
     *     staging 内容的时候
     *   - 删掉只是省一点磁盘，代价是丢掉唯一可诊断的东西
     *   - "目录会越积越多"是真问题，但**该用清理策略解决**（保留 N 天/
     *     只留最近几个），不该靠"把证据删掉"来省事
     *     —— 注意 logs-export 里的 zip 也是只增不减的，同一个问题
     *
     * 所以这条断言的是：抛异常时 staging 留着，且报错里要写明它在哪。
     */
    it('★D-4 runner 抛异常时也要保留暂存目录，并在报错里说明位置', async () => {
      let stagingDir = ''
      const logger = createLogger({
        dataRoot: root,
        dateFor: () => '2026-09-12',
        zipRunner: async (_cmd, args) => {
          stagingDir = stagingOf(scriptOf(args))
          throw new Error('powershell 起不来')
        }
      })
      logger.log('INFO', 'app', 'x')

      let msg = ''
      try {
        await logger.exportZip()
        throw new Error('本该抛错')
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e)
      }

      expect(stagingDir, '没能从脚本里推出暂存目录').toBeTruthy()
      expect(msg, '要把原始报错带出来（别吞掉）').toContain('powershell 起不来')
      expect(
        existsSync(stagingDir),
        'runner 抛异常时暂存目录被删了 —— 和压缩失败一样，这时才最需要它'
      ).toBe(true)
      expect(msg, '报错里要告诉用户素材在哪，否则他不知道去哪找').toContain(stagingDir)
    })
  })
})
