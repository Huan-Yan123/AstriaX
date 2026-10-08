/*
 * 「正在进行的可取消任务」注册表。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么需要它（主人 2026-09-27 的两个要求）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   「安装和导入没有互锁正在进行的同版本」
 *   「安装/下载一个加入取消，防止卡住了只能重启软件来换更快的
 *     安装/下载源」
 *
 * ## 这一份同时解决两件事
 *
 * 两件事都需要同一个东西：**主进程要有一份"现在正在装什么"的权威表**。
 *
 *   · **互锁** —— 同一个 `<type>:<tag>` 已经有任务在跑时，第二个请求
 *     直接拒绝（而不是两个流程同时写同一个目录）
 *   · **取消** —— 按 `<type>:<tag>` 找到那个任务的 `AbortController`，
 *     触发它 → 下载的 HTTP 请求和 pip 子进程**一起**被中断
 *
 * ## 为什么不用内存 Set（`pendingInstalls` 那样）
 *
 * 原来的 `pendingInstalls` 只是个 `Set<string>`（只有键、没有句柄），
 * 所以它**只能防重入、不能取消**。这里换成 Map<
 * key, {controller, startedAt, kind} > —— 一个结构同时支撑两个功能。
 *
 * ## 关于"内存状态会不会又搞出永久卡死"
 *
 * 我在 `markInstalling` 上刚踩过这个坑（true/false 没配对 → 那个版本
 * 永久不可见、无法自愈），所以这里**刻意做了两条防线**：
 *
 *   ① 所有登记都必须在 `try/finally` 里配对释放 —— 而且 release 用
 *      `key + controller` 双重校验：**只释放自己那一个**。
 *      这样即使两个任务曾经并存（理论上被互锁挡住，但防御一下），
 *      先结束的那个也不会把后一个的登记误删。
 *
 *   ② 这份表**只影响"能不能再开一个"和"能不能取消"**，
 *      **不参与任何"显示/不显示"的判断** —— 与 markInstalling 的关键
 *      区别就在这里。就算它脏了，用户也只是"看到提示说正在装"
 *      而实际没装，不会出现"版本永久消失"那种无法自愈的状态。
 */

/** 一个正在进行的任务（安装 / 导入 / 单独下载） */
export interface RunningTask {
  /** `<type>:<tag>` —— 互锁与取消都用它当键 */
  key: string
  /**
   * 任务种类。
   *
   * `install` = 从源安装（downloadRuntime + pip）
   * `import`  = 手动导入压缩包（解压 + 可选 pip）
   *
   * 分开记是为了让报错说清"是**安装**在跑还是**导入**在跑" ——
   * 用户看到"这个版本已经在装了"时，得知道去哪儿找那个进度条。
   */
  kind: 'install' | 'import'
  /** 用来中断它（下载的 fetch 与 pip 子进程共用同一个 signal） */
  controller: AbortController
  /** 开始时刻（诊断用；也让"取消"能报告它跑了多久） */
  startedAt: number
  /** 给人看的名字（如 `AstrBot v4.28.1`），报错文案里用 */
  label: string
}

const running = new Map<string, RunningTask>()

export function taskKey(type: 'a' | 'n', tag: string): string {
  return `${type}:${tag}`
}

/**
 * 试着登记一个任务。**已经有同键任务时返回 null**（= 该拒绝这次请求）。
 *
 * 互锁粒度就是 `key` —— 同一个 `<type>:<tag>` 互斥，
 * 而"装 AstrBot 的同时装 NapCat"、"装 v4.28.0 的同时装 v4.28.1"
 * 都**允许**（它们互不影响：写的是不同目录）。
 */
export function beginTask(t: Omit<RunningTask, 'startedAt'>): RunningTask | null {
  if (running.has(t.key)) return null
  const task: RunningTask = { ...t, startedAt: Date.now() }
  running.set(t.key, task)
  return task
}

/**
 * 释放登记。
 *
 * **必须传 controller** —— 只释放"确实是自己那一个"。
 * 这样即便因为某种意外出现了同键覆盖，先结束的任务也不会把
 * 后一个的登记误删（那会让后者"变成不可取消"）。
 *
 * ## 为什么参数类型写死 `AbortController` 而不是 `AbortSignal`
 *
 * 调用方很容易顺手传 `task.controller.signal`（我第一版就是），
 * 而两者**不是同一个对象** → 那句 `===` 永远 false → **永远不释放**
 * → 那个版本永远"正在安装中"、再也开不了新任务。
 *
 * 把类型写死成 `AbortController` 能让 `tsc` 在传错时报错
 *（`AbortSignal` 不能赋给 `AbortController`）—— 用类型挡住，
 * 比靠注释提醒可靠。
 */
export function endTask(key: string, controller: AbortController): void {
  const cur = running.get(key)
  if (cur && cur.controller === controller) running.delete(key)
}

/** 同键任务在跑吗（返回它，调用方可以据此写报错文案） */
export function findTask(key: string): RunningTask | undefined {
  return running.get(key)
}

/**
 * 取消一个任务。返回是否**确实发出了取消**。
 *
 * 取消是**异步生效**的：`abort()` 只是发信号，
 * 真正停下来要等 pip/fetch 那边响应（通常很快）。
 * 所以界面上的表现应该是"取消中…"而不是"已取消"。
 */
export function cancelTask(key: string): { ok: boolean; task?: RunningTask } {
  const t = running.get(key)
  if (!t) return { ok: false }
  try {
    t.controller.abort()
  } catch {
    /* 已经取消过了 */
  }
  return { ok: true, task: t }
}

/** 现在有哪些任务在跑（诊断 / 界面恢复状态用） */
export function listTasks(): RunningTask[] {
  return [...running.values()]
}
