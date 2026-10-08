import { resolve, sep, isAbsolute } from 'path'

/**
 * 把「来自渲染层的一小段名字」收敛成安全的**单个路径段**。
 *
 * ============================================================================
 * 为什么需要它
 * ============================================================================
 *
 * 主进程里凡是拿渲染层传的字符串去 `join(某个根, 名字)` 的地方，
 * 都是在把「拼路径」的权力交给界面层。而 `join`/`resolve` 会**老老实实**
 * 处理 `..` 和绝对路径：
 *
 *     join('E:\\data\\runtimes\\a', '..\\..\\..\\Windows\\System32')
 *     // → 'E:\\Windows\\System32'
 *
 * 后续如果跟着 `renameSync` + `rmSync(recursive)`，恶意或 bug 造出的名字
 * 就能删掉任意目录。这个进程还是**管理员权限**的
 * （NapCat 注入 QQ 需要提权），所以后果比普通进程严重一档。
 *
 * ipc.ts 里已有的 `assertInsideInstances()` 是同一类保护，但它针对的是
 * 「整条路径」（备份归档的增删改查），做的是**事后**的目录边界断言。
 * 运行时那两个入口（`runtimes:remove` 的 tag、`runtimes:importFile` 的
 * version）传的却是**版本号**，当时没走那道闸 —— 那是遗漏，不是设计。
 *
 * 这里换个思路，做**事前**的形状校验：既然语义上就是"一个目录名"，
 * 那就要求它真的长得像一个目录名。
 *
 * ============================================================================
 * 为什么不用"事后 resolve 边界断言"
 * ============================================================================
 *
 * 那种写法（`const t = resolve(root, name); if (!t.startsWith(root + sep)) throw`）
 * 也能挡住穿越，但有两个缺点：
 *
 *   1. `remove()` 会先算 `dir` 再 `existsSync(dir)`，最后还可能 `renameSync`。
 *      事后断言必须**每一条**用到该路径的分支都记得写一次，
 *      漏掉任何一条就是一个洞。而现在有 dirFor / remove / register /
 *      isInstalled 好几个入口。
 *   2. 边界断言是"允许一切落在根内的形状"，`v1/../v2` 这种虽然没逃出去，
 *      却仍是**非法版本号**，应该报错而不是被规范化掉 ——
 *      否则用户看到的行为难以解释（写 `a/../b` 竟等于 `b`）。
 *
 * 形状校验放在**唯一的路径构造函数** `dirFor()` 里，
 * 所有入口自动收口，新增入口也不会漏。
 *
 * ============================================================================
 * 允许的字符
 * ============================================================================
 *
 * 版本号的真实形态：`v4.28.0`、`v4.18.19`、`v1.0.0-beta.1`、
 * `v4.27.0_rc1`、`v1.0.0+build5`（语义化版本）。
 * 所以白名单是：字母、数字、点、连字符、下划线、加号。
 * 这些字符里没有任何一个能在 Windows 上表达路径分隔（`/` `\` `:`）
 * 或相对跳转（需要 `.` 单独成段，而白名单不允许以纯点号构成段 ——
 * 见下面的额外检查）。
 *
 * **不接受**：空串、纯空白、含分隔符、含盘符、含 `:`、
 * 以 `.` 开头（隐藏目录 / `.` / `..`）、含 `*?<>|"` 这些 Windows 保留字符、
 * 以及任何控制字符。
 */

/** 单个路径段允许的字符集（不含 `_` 的连字符等已在其中） */
const SAFE_SEGMENT = /^[A-Za-z0-9._+-]+$/

/** 运行时类型的合法取值（与 RuntimeType 一致，在这里独立列一份做运行时校验） */
const RUNTIME_TYPES = new Set(['a', 'n'])

export interface SafeSegmentOptions {
  /** 出错的提示里用的名字，比如「版本号」「实例 ID」 */
  what?: string
  /** 允许点号在前（默认不允许，避免 `.` / `..` / 隐藏目录） */
  allowLeadingDot?: boolean
  /** 最大长度（Windows 单段上限 255） */
  maxLength?: number
}

/**
 * 校验并返回一个安全的单个路径段。
 *
 * @throws 当名字不符合"单个目录名"的形状时
 */
export function safeSegment(raw: unknown, opts: SafeSegmentOptions = {}): string {
  const what = opts.what ?? '名称'
  const maxLength = opts.maxLength ?? 200

  const s = typeof raw === 'string' ? raw : ''
  const t = s.trim()

  if (!t) throw new Error(`${what}不能为空`)
  if (t.length > maxLength) {
    throw new Error(`${what}过长（最多 ${maxLength} 个字符）`)
  }

  // 分隔符与盘符：必须在字符集检查**之前**单独判，因为报错要说得明白
  if (t.includes('/') || t.includes('\\')) {
    throw new Error(`${what}不能包含路径分隔符：${t}`)
  }
  if (t.includes(':')) {
    throw new Error(`${what}不能包含冒号：${t}`)
  }
  if (isAbsolute(t)) {
    throw new Error(`${what}不能是绝对路径：${t}`)
  }

  if (!SAFE_SEGMENT.test(t)) {
    throw new Error(`非法字符：${what}「${t}」只能包含字母、数字、点、连字符、下划线、加号`)
  }

  // 纯点号（`.` / `..`）以及点号开头（`.hidden`）一律拒绝
  if (/^\.+$/.test(t) && !opts.allowLeadingDot) {
    throw new Error(`${what}不能是「${t}」`)
  }
  if (t.startsWith('.') && !opts.allowLeadingDot) {
    throw new Error(`${what}不能以点号开头：${t}`)
  }

  return t
}

/**
 * 校验运行时类型（只允许 'a' / 'n'）。
 *
 * 单独写一个是因为 `SUB[type]` 查表在 type 非法时会得到 `undefined`，
 * `join(root, undefined, tag)` 会抛一个**难懂的** TypeError；
 * 这里给出明确的信息，也顺便把 type 纳入同一套防护。
 */
export function safeRuntimeType(raw: unknown): 'a' | 'n' {
  const t = typeof raw === 'string' ? raw.trim() : ''
  if (!RUNTIME_TYPES.has(t)) {
    throw new Error(`运行时类型不对：${String(raw)}（只允许 a 或 n）`)
  }
  return t as 'a' | 'n'
}

/**
 * 在给定根目录下安全地解析一个路径段，返回绝对路径。
 *
 * 即使 `safeSegment()` 已经挡掉了分隔符，这里仍然**再加一道**
 * resolve 边界断言 —— 成本是一行字符串比较，收益是"将来有人
 * 放宽了字符白名单（比如允许 `\`）也不会立刻变成漏洞"。
 * 两道独立的检查比一道检查更抗修改，这叫纵深防御，不是冗余。
 */
export function safeJoin(root: string, segment: unknown, opts: SafeSegmentOptions = {}): string {
  const seg = safeSegment(segment, opts)
  const base = resolve(root)
  const full = resolve(base, seg)
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`${opts.what ?? '名称'}越出了允许的目录：${seg}`)
  }
  return full
}
