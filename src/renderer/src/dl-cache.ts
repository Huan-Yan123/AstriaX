/*
 * 下载页 stale-while-revalidate 内存缓存（指导书第二章的落地）
 *
 * ## 目标（主人原话）
 *
 *   「每次点进去都需要重新加载…哪些镜像源可用、py 装没装、
 *     文件包安装了哪些 —— 每次都要等全部加载完才能继续点」
 *
 * → 进页面**毫秒级**先画上一轮的数据（哪怕可能过期），
 *   后台去拉新数据，回来平滑覆盖。体感=点进去立即能用。
 *
 * ## 键位设计
 *
 * 单键 `dl:v1` 存整个下载页快照（三类 IPC 的数据 + 探测结果），
 * 而不是每条数据一个键 —— 它们本来就该原子地一起变（写操作后整页重拉），
 * 拆开键反而会出现"体积/状态"半新半旧的错位画面。
 *
 * 生命周期：**模块级**，跨挂载/切页存活（指导书 2.2 所说的"渲染进程内存
 * 缓存：切页即时读，进程退出丢"）；持久层不做 —— 下载页数据轻且主进程
 * 本来就有 version-cache 这类磁盘缓存，跨启动重建的成本可忽略。
 */

export interface DlSnapshotData {
  state: unknown
  rows: Array<{ type: 'a' | 'n'; tag: string; sizeMB?: number }>
  py: { ready?: boolean; version?: string } | null
  /** 探测结果的 plain 形式（identity 变 transport-safe） */
  health: Array<{ base: string; status: string; ms: number | null; reason?: string }>
}

export interface DlSnapshot extends DlSnapshotData {
  /** 写入时刻（ms epoch）；SWR 的 stale 判据 */
  ts: number
  /** 最近一次镜像探测成功时刻（探测试行节流的判据） */
  probeAt: number
}

const KEY = 'dl:v1'
/** 指导书 2.3：TTL 默认 5 分钟；做成常量便于调 */
export const SWR_TTL_MS = 5 * 60_000
/** 镜像探测的节流：60s 内不重复打服务器/上游 */
export const PROBE_TTL_MS = 60_000

let snap: DlSnapshot | null = null
/** 防止两份数据并存时新旧翻转 */
let loadId = 0

export function dlNextLoadId(): number {
  return ++loadId
}

export function dlIsCurrentLoad(id: number): boolean {
  return id === loadId
}

/** 命中缓存就返回（可能过期 —— SWR 允许，只是要在 UI 上表明） */
export function dlHydrate(): DlSnapshot | null {
  return snap
}

export function dlHydrateFresh(): DlSnapshot | null {
  if (!snap) return null
  return Date.now() - snap.ts <= SWR_TTL_MS ? snap : null
}

export function dlProbeBlocked(): boolean {
  if (!snap) return false
  return Date.now() - snap.probeAt < PROBE_TTL_MS
}

/** 后台拉取成功后写回（整体替换，永远比上次"更新"或时间更迟才算数） */
export function dlSave(next: DlSnapshotData, opts: { probeAt?: number } = {}): void {
  snap = {
    ...next,
    probeAt: opts.probeAt ?? snap?.probeAt ?? 0,
    ts: Date.now()
  }
}

/** 只记录"探测完成过"这一点（探测与数据刷新不同频） */
export function dlMarkProbed(): void {
  if (snap) snap.probeAt = Date.now()
}

/**
 * 把探测结果写回快照。
 *
 * ## 为什么必须有这个（四厂商审计抓出的真问题）
 *
 * 第一版里 probeMirrors 只调了 `dlMarkProbed()` —— 只记了"刚测过"的时刻，
 * **却没把测出来的可用性存进快照**。而 reload 总是跑在探测之前，
 * 于是第一轮写进快照的 health 永远是空数组。
 *
 * 结果：用户第一次进页面看到"120ms / 可用"，切走再回来（60s 节流生效、
 * 不重新探测）→ 水合拿到的是空 health → **可用性标签与"N 个源不可用"
 * 那一整块消失**，直到手点「重新检测」或节流过期。看上去像"功能时有时无"。
 */
export function dlSaveHealth(
  health: Array<{ base: string; status: string; ms: number | null; reason?: string }>
): void {
  if (!snap) return
  snap = { ...snap, health }
}

/**
 * 写操作后的失效。
 *
 * ## 两种失效强度（区分开很重要）
 *
 *   · `dlInvalidate()` —— **整份清空**。用于"数据根变了"这种
 *     全局性变化（搬家）：那时连"哪些镜像源可用"都可能不同，
 *     必须全部重来。
 *   · `dlInvalidate({ keepProbe: true })` —— **保留探测结果与节流时刻**，
 *     只把数据标记为过期（ts=0）。用于删除版本、装 Python 这类
 *     局部写操作：它们不改变"哪些源可用"，把探测结果一起丢掉只会让
 *     下一次进页面**重新全量探测所有源** —— 那正是主人抱怨的
 *     "每次点进去都要等"。
 *
 * 第一版只有整份清空这一种，于是"删完版本回来看效果"（高频动作）
 * 每次都打穿了 60s 节流。审计把它指了出来。
 */
export function dlInvalidate(opts: { keepProbe?: boolean } = {}): void {
  if (opts.keepProbe && snap) {
    // ts 归零 = 不再新鲜 → 下次进页面照样会后台刷新，但不会重打所有镜像源
    snap = { ...snap, ts: 0 }
    return
  }
  snap = null
}

/**
 * 本轮拉取失败：把快照标记为过期，**不要**续期。
 *
 * 第一版 reload 里是 `Promise.allSettled` 之后无条件 `dlSave` —— 三路全失败时
 * 组件里留着的还是**水合来的旧数据**，却拿到了 `ts = Date.now()`，
 * 于是这份旧数据在 5 分钟内被当成"新鲜"：连"展示的是上次的数据哦"
 * 这句提示都不会出现（判据是 dlHydrateFresh）。错误只活在当次挂载，
 * 重进页面就消失 —— 用户看到的是"过期的数据 + 没有任何提示"。
 */
export function dlNoteLoadFailed(): void {
  if (snap) snap = { ...snap, ts: 0 }
}
