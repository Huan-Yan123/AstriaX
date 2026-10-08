/*
 * pip 输出 → 进度百分比 / 阶段 / 当前包名 的映射（指导书 7.3 的落地）
 *
 * ## 为什么抽成独立模块（而不是写在 ipc.ts 的 onData 里）
 *
 * 指导书 7.3(3) 要求"分阶段 + 包计数映射到进度条"。这属于**纯计算**：
 *  输入：pip 的一行输出（或一整块，按行喂）
 *  输出：当前应显示的 percent / 阶段 / 包名
 *
 * 写在 handler 里就没法验证 —— 而"进度条到底会不会走、会不会跳变"
 * 恰恰是主人抱怨过的（7.1「看起来在装但不走，用户以为卡死」）。
 * 抽出来之后可以拿**真实的 pip 输出样本**做单测。
 *
 * ## 阶段区间（照指导书原表）
 *
 *   阶段1 依赖检查/收集   → 0% - 10%
 *   阶段2 下载依赖包      → 10% - 60%（按已见包数推进）
 *   阶段3 安装包          → 60% - 90%
 *   阶段4 配置/收尾       → 90% - 100%
 *
 * ## 为什么按"已见包数"而不是"已完成/总数"
 *
 * pip 在非 TTY 下**不打印总包数**（它关掉 rich 进度条），所以"X/Y"里的
 * 总数拿不到。硬编一个总数就是**假进度**（比慢进度更伤信任 —— 见
 * decisions.log D10）。所以：
 *   · 见过多少个 Collecting → 在 10~60 区间里按个数推进（有上限封顶）
 *   · 见到 "Installing collected packages" → 跳到 62（进入阶段3）
 *   · 见到 "Successfully installed" → 90（进入阶段4）
 *   · 真正装完（调用方 finish()）→ 100
 * 任何情况下**单调不回退**，避免进度条来回抖。
 */

export type PipStage = 'deps' | 'install' | 'config'

export interface PipTick {
  /** 0-100（单调不回退） */
  percent: number
  stage: PipStage
  /** 当前正在处理的包名（解析不到就是 undefined） */
  package?: string
  /** 已观察到的依赖条目数；pip 不提供可靠总数，因此只展示已发现数量。 */
  packages: number
}

export interface PipProgress {
  /** 喂一段输出（多行也行），返回当前进度；无变化时也返回当前值 */
  feed(chunk: string): PipTick
  /** 安装流程收尾（pip 退出 0 之后）→ 90；再往后由调用方发 100 */
  finishInstall(): PipTick
  /** 当前快照 */
  now(): PipTick
}

export function createPipProgress(): PipProgress {
  let percent = 5 // 一开始就离开 0：让进度条立刻有存在感（阶段1 依赖检查）
  let stage: PipStage = 'deps'
  let packages = 0
  let pkg: string | undefined

  const bump = (to: number): void => {
    // 单调：只前进不回退（进度条回退会让用户以为出错了）
    if (to > percent) percent = to
  }

  return {
    feed(chunk: string): PipTick {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue

        /*
         * 「Installing collected packages」= pip 开始往目标目录放文件。
         * 这是阶段 2 → 阶段 3 的转折点，**必须先判它**：
         * 它和 Collecting 可能出现在同一块输出里，顺序判断错了阶段就错。
         */
        if (/Installing collected packages/i.test(line)) {
          stage = 'install'
          bump(62)
          continue
        }
        /* 「Successfully installed」= 装完了，进入收尾/配置阶段 */
        if (/Successfully installed/i.test(line)) {
          stage = 'config'
          bump(90)
          continue
        }
        /* Collecting/Downloading：数包 + 记包名（阶段 2 的主要信号） */
        const m = /(?:Collecting|Downloading|Saved|Using cached)\s+([^\s(]+)/i.exec(line)
        if (m) {
          if (/Collecting/i.test(line)) {
            packages++
            /*
             * ★ 10 → 60 用**渐近曲线**而不是线性（审计抓出的"60% 钉死"）
             *
             * 第一版是 `min(60, 10 + packages * 2)` —— 第 25 个包就到 60，
             * 而阶段 2 要等 pip 打印 "Installing collected packages"
             *（所有依赖都下完之后）才结束。AstrBot 的依赖远超 25 个，
             * 于是**整个最长的下载期进度条钉死在 60%** ——
             * 主人抱怨的"看起来在装但不走"只是从 0% 挪到了 60%。
             *
             * 曲线：10 + 50 * (1 - 1/(1 + packages/8))
             *   · 前几个包涨得快（用户立刻看到"在动"）
             *   · 之后越来越慢但**永不封顶**（60 只是极限，需要无穷多包）
             *   · 仍然是**真实信号**驱动（包数），不是凭空爬的假进度
             * 到第 8 个包约 35%、第 25 个约 49%、第 50 个约 55%，
             * 后面还有很多包时仍能一点点动，不会"死"在某个数字上。
             */
            bump(10 + 50 * (1 - 1 / (1 + packages / 8)))
          }
          pkg = m[1]
        }
      }
      return { percent, stage, package: pkg, packages }
    },

    finishInstall(): PipTick {
      stage = 'config'
      bump(90)
      return { percent, stage, package: pkg, packages }
    },

    now(): PipTick {
      return { percent, stage, package: pkg, packages }
    }
  }
}
