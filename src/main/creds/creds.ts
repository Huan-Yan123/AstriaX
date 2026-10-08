import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  openSync,
  readSync,
  closeSync
} from 'fs'
import { createHash, pbkdf2, pbkdf2Sync, randomBytes } from 'crypto'
import { join } from 'path'
import { ASTRBOT_DEFAULT_PASSWORD, ASTRBOT_DEFAULT_USER, NAPCAT_DEFAULT_TOKEN } from '../constants'
import type { InstanceType } from '../constants'
import { readJsonFile } from '../util/json-file'
import { writeJsonAtomic } from '../util/atomic-write'

/**
 * 把损坏的配置文件改名留证。
 *
 * ## 为什么不能直接覆盖
 *
 * 这类配置（`cmd_config.json`）是用户的**主配置**，不只是账密 ——
 * 里面有模型服务商、API key、插件开关、人格设定。文件损坏时，
 * 里面**还能读出来的部分**对用户可能价值很高（尤其 API key，
 * 那往往是他唯一的副本）。
 *
 * 直接覆盖 = 把这些永久冲掉。改名则：
 *   - 新配置正常写出来（重置功能不瘸）
 *   - 原始内容一字不动地留着，用户能手工抢救
 *
 * ## 命名和 instances.json 的留证保持一致
 *
 * `xxx.corrupt-<ISO时间>`，这样一看就知道是什么、什么时候坏的。
 * 时间戳里的 `:` 和 `.` 在 Windows 文件名里非法，替换成 `-`。
 *
 * 改名失败时退而求其次**不动文件**（而不是删它）：
 * 后续的 writeFileSync 会覆盖它，但那至少是在我们尽力留证之后；
 * 绝不能因为"留证失败"就把原始内容主动删掉。
 */
function quarantineConfig(cfgFile: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(cfgFile, `${cfgFile}.corrupt-${stamp}`)
  } catch {
    /*
     * 改名失败（被占用/权限）：什么都不做。
     * 下面的 writeFileSync 会覆盖它 —— 但那不是我们主动删的，
     * 而且此刻也没有更好的选择（总不能因为留不了证就拒绝重置）。
     */
  }
}

export interface Credential {
  label: string
  value: string
}

/*
 * AstrBot 的密码哈希格式（照抄 astrbot/core/utils/auth_password.py，别自己发明）：
 *
 *   _PBKDF2_ITERATIONS = 600_000
 *   _PBKDF2_SALT_BYTES = 16
 *   _PBKDF2_FORMAT    = "pbkdf2_sha256$"
 *   hash = f"{_PBKDF2_FORMAT}{iterations}${salt_hex}${digest_hex}"
 *        = "pbkdf2_sha256$600000$<salt_hex>$<digest_hex>"
 *
 * 校验侧（verify_dashboard_password）会 split('$') 成 4 段，
 * 所以格式必须严格一致 —— 少一段就直接判定密码错误。
 */
const ASTRBOT_PBKDF2_ITERATIONS = 600_000
const ASTRBOT_PBKDF2_SALT_BYTES = 16

/** 生成 AstrBot 认的 PBKDF2 哈希串 */
export function astrbotHashPassword(raw: string): string {
  const salt = randomBytes(ASTRBOT_PBKDF2_SALT_BYTES).toString('hex')
  const digest = pbkdf2Sync(raw, Buffer.from(salt, 'hex'), ASTRBOT_PBKDF2_ITERATIONS, 32, 'sha256').toString('hex')
  return `pbkdf2_sha256$${ASTRBOT_PBKDF2_ITERATIONS}$${salt}$${digest}`
}

/** 生成 AstrBot 兼容的 MD5 哈希（它在 dashboard.password 里保留一份做向后兼容） */
export function astrbotHashMd5(raw: string): string {
  return createHash('md5').update(raw, 'utf8').digest('hex')
}

/**
 * 按 AstrBot 的规则重置账密：写 `data/cmd_config.json` 的 dashboard.* 字段。
 *
 * 字段与官方 CLI 的 `_set_dashboard_password` 完全对齐：
 *   dashboard.username                  → 用户名
 *   dashboard.pbkdf2_password           → PBKDF2 哈希（当前校验用的就是它）
 *   dashboard.password                  → MD5 哈希（旧版兼容）
 *   dashboard.password_storage_upgraded → true（标记已升级到 PBKDF2）
 *   dashboard.password_change_required  → false（明确告知「不需要改密码」，
 *                                          否则登录后会被强制跳转改密页）
 *
 * AstrBot 的 root 是**进程 cwd**，且要求存在 `.astrbot` 标记文件；
 * 缺了它 CLI 会拒绝工作（登录逻辑同样依赖这个标记），所以顺手补上。
 */
function resetAstrBotConfig(dir: string): Credential[] {
  const cfgFile = join(dir, 'data', 'cmd_config.json')
  let obj: Record<string, unknown> = {}
  if (existsSync(cfgFile)) {
    try {
      const parsed = readJsonFile(cfgFile) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>
      } else {
        /*
         * 解析出来了但不是对象（比如内容是 `[]` 或 `"x"`）—— 同样属于损坏。
         * 不处理的话下面会往一个数组/字符串上挂属性，写出去仍然是垃圾。
         */
        quarantineConfig(cfgFile)
      }
    } catch {
      /*
       * ## 损坏时必须**留证**，不能静默用空配置重建
       *
       * 原来这里只有一句注释「损坏 → 用空配置重建（总比写不进去强）」，
       * 然后 obj 保持 `{}` 继续往下走。那个理由**是错的**：
       *
       * `cmd_config.json` 不只是账密仓库，它是 AstrBot 的**主配置**：
       * 模型服务商、API key、插件开关、人格设定、消息适配器…
       * 用户可能配了很久。
       *
       * 而下面 `writeFileSync(cfgFile, JSON.stringify(obj, null, 2))` 是
       * **整文件覆盖**。于是点一次"重置账密"，那份损坏文件里**还能读出来的
       * 部分**（以及用户手工修复的机会）被彻底冲掉，换成一个只有
       * dashboard 字段的空壳。界面还回报"重置成功"，
       * 用户要等下次拿 AstrBot 聊天才发现配置全没了 —— 不可逆。
       *
       * 「总比写不进去强」不成立：写不进去只是**这次重置失败**
       * （用户再点一次就行），抹掉配置是**永久数据损失**。
       *
       * 所以：先改名留证（内容一字不改地保住），再写新配置。
       * 这样功能没瘸（重置照样成功），数据也没毁（原文件还在，
       * 用户能把 api_key 之类手工捞出来）。
       */
      quarantineConfig(cfgFile)
    }
  }

  const dash =
    obj.dashboard && typeof obj.dashboard === 'object' && !Array.isArray(obj.dashboard)
      ? (obj.dashboard as Record<string, unknown>)
      : ((obj.dashboard = {}) as Record<string, unknown>)

  dash.username = ASTRBOT_DEFAULT_USER
  dash.pbkdf2_password = astrbotHashPassword(ASTRBOT_DEFAULT_PASSWORD)
  dash.password = astrbotHashMd5(ASTRBOT_DEFAULT_PASSWORD)
  dash.password_storage_upgraded = true
  dash.password_change_required = false

  mkdirSync(join(dir, 'data'), { recursive: true })
  /*
   * ★ 必须原子写（审计抓出的真问题）
   *
   * 这里原来是裸的 `writeFileSync(cfgFile, JSON.stringify(obj, null, 2))`。
   * 而 `writeFileSync` 打开目标文件时会**先截断成 0 字节**再写
   *（见 util/atomic-write.ts:10-15 的说明）—— 写到一半被杀 / 磁盘满，
   * 用户拿到的是一个**残缺的 JSON**。
   *
   * 这个文件是 `cmd_config.json`：AstrBot 的**主配置**，
   * 里面有账密、模型 API key、插件开关、人格设定 —— 丢了就找不回来。
   * 而且 AstrBot 下次启动读到坏 JSON 会直接报错或回落默认值，
   * 用户看到的是"我配的东西全没了"。
   *
   * 讽刺的是这个文件下面的注释（105-130 行）专门讲了
   * 「cmd_config.json 是主配置，含 API key」，并为它加了
   * quarantineConfig 留证 —— 但那保的只是**读**的一侧，
   * 写的一侧仍然是裸 writeFileSync。
   *
   * 同仓库 util/atomic-write.ts 的 writeJsonAtomic 早就写好、
   * 且 mirror-store 等处已在用。这里改用它：tmp + rename，
   * 任何时刻读到的要么是完整旧内容、要么是完整新内容。
   */
  writeJsonAtomic(cfgFile, obj)

  // AstrBot 认定 root 的标志文件；没有它 CLI/登录会报 not a valid root
  const marker = join(dir, '.astrbot')
  if (!existsSync(marker)) writeFileSync(marker, '', 'utf8')

  return [
    { label: '用户名', value: ASTRBOT_DEFAULT_USER },
    { label: '密码', value: ASTRBOT_DEFAULT_PASSWORD }
  ]
}

function walkJson(dir: string, depth: number): string[] {
  if (depth > 4 || !existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    if (name.isDirectory()) out.push(...walkJson(p, depth + 1))
    else if (name.name.endsWith('.json')) out.push(p)
  }
  return out
}

/**
 * 从实例日志里把 AstrBot **自己打印出来的初始密码**捞回来。
 *
 * ## 为什么需要这个
 *
 * 用户原话：「日志里明明有个随机生成的 astrbot 密码，
 * 『看账密』却告诉我（加密存储，无法查看），那要这个功能干什么？」
 *
 * 他说得对。事实是：AstrBot 首次运行时**自己生成**一个 24 位强密码，
 * 打完哈希存进 `cmd_config.json` 的 `pbkdf2_password`，
 * 然后把**明文**在启动日志里打印一次：
 *
 *     ➜  Initial username: astrbot
 *     ➜  Initial password: OJx5hx6Ql9mEdekljXrzxJLb
 *     ➜  Change it after logging in
 *
 * 之后就把它从内存里抹掉（`object.__setattr__(self.config,
 * "_generated_dashboard_password", None)`），磁盘上只剩哈希 —— 这是**故意**的，
 * 密码本就不该能反推。
 *
 * ## 那为什么我们不去读日志
 *
 * 因为那句明文**确实是我们唯一的、也是合法的线索**：它是 AstrBot 主动告诉
 * 使用者的东西，本来就写在用户自己的日志文件里（用户自己也能翻到）。
 * 我们只是替他把这一行读出来摆在界面上，没有做任何破解。
 *
 * ## 为什么密码必须校验过才敢显示
 *
 * 光按 `Initial password: xxx` 抓一行是**不安全**的：那个密码可能早就被改过，
 * 也可能属于上一次运行（例如用户刚用「重置账密」写入了新哈希，
 * 而日志里还留着旧的那一行）。把过期密码当当前密码显示，
 * 用户照着输登不进去，比什么都不显示更糟。
 *
 * 所以这里**必须**拿 `pbkdf2_password` 里的 salt/iterations 现算一遍哈希，
 * 对上了才认。对不上就说明这条日志已经过期，宁可不显示。
 *
 * （实测：主人这台机器上日志里的 `OJx5hx6Ql9mEdekljXrzxJLb` 与当前
 *  `cmd_config.json` 里的哈希**对不上** —— 配置在日志之后被重写过。
 *  这正是需要校验的原因：不校验就会显示一个错的密码。）
 */
async function astrbotPasswordFromLog(
  logText: string,
  storedHash: string
): Promise<string | undefined> {
  const parts = String(storedHash ?? '').split('$')
  // 必须是 AstrBot 认的 4 段格式，否则没法验
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return undefined
  const iterations = Number(parts[1])
  if (!Number.isFinite(iterations) || iterations <= 0) return undefined
  let salt: Buffer
  try {
    salt = Buffer.from(parts[2], 'hex')
  } catch {
    return undefined
  }
  if (!salt.length) return undefined

  /*
   * 把所有出现过的候选都收集起来逐个验（而不是只取最后一条）。
   * 用户可能重启过多次，日志里会有多行；真正有效的那个不一定是最后一行
   * （比如最后一次启动没能生成新密码，只是复用了旧哈希）。
   *
   * ★ 加上**我们的默认密码**作为候选（主人 2026-09-27 的 bug：
   *   「我重置密码之后这里应该显示 astrbot」）
   *
   * 原因：重置（resetAstrBotConfig）会把密码设成 `astrbot`（常量），
   * 而日志里**只有首次启动的随机密码**（重置不会往日志里写）。
   * 于是重置之后来查看：日志候选全都对不上新哈希 → 落到"无法反推" ——
   * 用户刚重置完，界面却说不知道密码，这是明显不对的。
   *
   * 把默认密码也当候选验一次就够了：如果当前哈希确实是"重置后的那个"，
   * 就一定能验出 `astrbot`；如果不是（用户自己改过），验不过也不会误报。
   *
   * 顺带也覆盖"用户没改过、AstrBot 恰好用了默认值"的情况。
   */
  const candidates = [...logText.matchAll(/Initial password:\s*([A-Za-z0-9_-]+)/g)].map(
    (m) => m[1]
  )
  if (!candidates.includes(ASTRBOT_DEFAULT_PASSWORD)) candidates.push(ASTRBOT_DEFAULT_PASSWORD)
  /*
   * ★ 候选**最多验 3 个**（性能：每次 60 万轮，单次实测 256ms）。
   *
   * 用户重启很多次时，日志里会攒下几十行 Initial password ——
   * 全验一遍 = 主进程线程池被占满十几秒，界面「卡半天才弹窗」。
   *
   * 而真正有效的那个候选只可能是：
   *   · 最近一次生成的那个（历史越多越可能是最后几个）
   *   · 或我们重置时写入的默认密码
   * 所以取「最后 2 个 + 默认密码」就足够，且把默认密码放最前面 ——
   * 重置后用它的概率最高，命中即返回，省掉后面的计算。
   */
  const recent = candidates.slice(-3)
  const ordered = recent.includes(ASTRBOT_DEFAULT_PASSWORD)
    ? [ASTRBOT_DEFAULT_PASSWORD, ...recent.filter((c) => c !== ASTRBOT_DEFAULT_PASSWORD)]
    : [...recent]
  for (const cand of ordered) {
    let digest: string
    try {
      /*
       * ★ 用**异步** pbkdf2（性能审计实测：同步版 256ms/次）
       *
       * 原来是 `pbkdf2Sync(cand, salt, iterations, 32, 'sha256')` ——
       * AstrBot 默认 iterations = **600,000 轮**，实测单次 **256ms**。
       * 而这里在**候选循环**里逐个验（用户重启多次就有多个候选）——
       * 点一次「查看账密」能把主进程冻住几百毫秒到几秒，界面整个僵死。
       *
       * pbkdf2 是**纯 CPU 计算**（不涉及 IO），所有审计脚本的词表里都没有它，
       * 所以它一直是隐形的。改用 callback 版之后，计算被放到 libuv
       * 线程池，主进程照常响应；结果与同步版逐字节一致。
       */
      digest = await new Promise<string>((resolve, reject) => {
        pbkdf2(cand, salt, iterations, 32, 'sha256', (err, out) =>
          err ? reject(err) : resolve(out.toString('hex'))
        )
      })
    } catch {
      continue
    }
    if (digest === parts[3]) return cand
  }
  return undefined
}

/**
 * 读实例日志的尾部。
 *
 * 路径是 `<dataRoot>\logs\instances\<id>.log`（与 instance:start 里写日志的
 * 那一处必须一致）。日志可能很大（长跑几个月的实例能到几十 MB），
 * 而我们要找的 `Initial password` 只可能在**开头几次启动**里 ——
 * 但最新的那行可能在任何位置，所以只读尾部 256 KB 足够覆盖常见情况：
 * 密码只在首次生成时打印，那时的内容早就被后续输出顶到很后面了……
 *
 * 等等，这里有个反直觉的点：首次启动的日志在**文件开头**，不是尾部。
 * 长跑之后开头的行会被顶到很远，只读尾部就可能漏掉。
 *
 * 所以策略是：小文件（<2MB）整个读；大文件读开头 512KB + 尾部 256KB。
 * 开头的 512KB 覆盖首次启动那段（Initial password 就在里面），
 * 尾部 256KB 覆盖「刚刚重启过、又重新生成密码」的情况。
 * 两头都读，两种场景都不会漏。
 */
function readInstanceLog(dataRoot: string, id: string): string {
  try {
    const p = join(dataRoot, 'logs', 'instances', `${id}.log`)
    if (!existsSync(p)) return ''
    /*
     * ★ 用静态导入而不是 require —— 消除"测试环境与生产环境语义分叉"
     *
     * 原来这里是：
     *     const { statSync, openSync, readSync, closeSync } = require('fs')
     *
     * 关于它为什么在**测试里**炸，第一版我写的理由是错的，这里更正
     *（第二轮复审实测纠正，值得留档免得后人拿错前提去改别处）：
     *
     *   · 打包后主进程是 **CJS**（electron-vite 产物 `out/main/index.js`
     *     里就是 `require("fs")`），所以 `require` 在**生产环境是存在的** ——
     *     本文件其它地方（以及 `index.ts:49`、`ports/allocator.ts:61`、
     *     `ipc.ts` 的延迟 require）都是靠这一点正常工作的。
     *   · 只有 **vitest 直接加载 .ts 源码（ESM）** 时才没有 `require`。
     *
     * 也就是说：这段代码在打包态**大概率能跑**，只在测试里抛
     * `ReferenceError`，然后被外层的 catch **静默吞掉**、返回空串 ——
     * 表现是「查看账密」在测试里永远验不出密码（3 条用例红）。
     *
     * 那么为什么还要改？因为"测试环境与生产环境语义分叉"本身就是隐患：
     * 同一段代码在两边行为不同，测试就不再能证明生产行为。
     * 改成静态导入之后两边**完全一致**，测试的绿灯才重新有意义。
     *
     * 教训：**不要**因为这条注释就去"修" `allocator.ts` / `ipc.ts` 里
     * 那些同样写法的延迟 require —— 它们在 CJS 下是合法且能跑的。
     */
    const size = statSync(p).size
    const HEAD = 512 * 1024
    const TAIL = 256 * 1024
    if (size <= HEAD + TAIL) return readFileSync(p, 'utf8')

    const fd = openSync(p, 'r')
    try {
      const head = Buffer.alloc(HEAD)
      const tail = Buffer.alloc(TAIL)
      const nHead = readSync(fd, head, 0, HEAD, 0)
      const nTail = readSync(fd, tail, 0, TAIL, size - TAIL)
      return head.subarray(0, nHead).toString('utf8') + tail.subarray(0, nTail).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    /* 读不到就当没有：凭据扫描不该因为日志读失败而整个报错 */
    return ''
  }
}

function pickString(obj: unknown, keys: string[]): string | undefined {
  if (obj === null || typeof obj !== 'object') return undefined
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k.toLowerCase()) && typeof v === 'string' && v) return v
  }
  return undefined
}

function deepFindString(obj: unknown, keys: string[]): string | undefined {
  if (obj === null || typeof obj !== 'object') return undefined
  const direct = pickString(obj, keys)
  if (direct !== undefined) return direct
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = deepFindString(v, keys)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 重置凭据为固定内容（用户点「重置密码/Token」后的行为）。
 *
 * ## AstrBot（type 'a'）
 *
 * 走**官方 CLI**：`python -m astrbot.cli conf dashboard.password <pw> --username <u>`。
 *
 * 这里踩过一个大坑，记录一下免得再犯：
 *   原来的实现是往 `data/config/astrbot_config.json` 写 `{admin:{username,password}}`，
 *   看着挺合理，实际**路径错、字段错、格式也错**：
 *     - AstrBot 的凭据在 `data/cmd_config.json` 的 `dashboard.*` 下（不是 config/ 目录）；
 *     - 密码**不是明文**，是 PBKDF2-HMAC-SHA256 + MD5 双写（见
 *       astrbot/core/utils/auth_password.py，PBKDF2 600000 轮）；
 *     - 直接写明文进去，登录时会拿明文去当哈希比对，**永远登不上**，
 *       而且把我们写的垃圾数据留在配置里。
 *   所以必须交给 AstrBot 自己算哈希 —— 自己实现一份哈希逻辑迟早跟上游对不上。
 *
 * 注意 AstrBot 的 CLI 要求 root 目录（cwd）下有 `.astrbot` 标记文件，
 * 没有就报 "is not a valid AstrBot root directory"，所以重置前先确保它存在。
 *
 * ## NapCat（type 'n'）
 *
 * 只**就地**改 token 字段，绝不整个覆盖配置文件（见下方详细说明）。
 */
export function resetCredentials(deps: { dir: string; type: InstanceType }): Credential[] {
  const { dir, type } = deps
  if (type === 'a') {
    return resetAstrBotConfig(dir)
  }

  const fixedToken = NAPCAT_DEFAULT_TOKEN
  const cfgDir = join(dir, 'config')
  /*
   * NapCat 的 WebUI 配置**只能就地改 token 字段，绝不能整个覆盖**。
   *
   * 原来这里是 `writeFileSync(webui.json, {token})`，把 NapCat 自己生成的
   * port / host / prefix / loginRate / theme / disableWebUI 全抹掉了，
   * 结果 WebUI 起不来或端口跑回默认 6099。
   *
   * 而且 NapCat 自己会读 NAPCAT_WEBUI_SECRET_KEY 环境变量写 token
   * （napcat.mjs 的 Nge 函数里 UpdateWebUIConfig），所以：
   * - 已经有配置文件 → 只改 token
   * - 还没有配置文件 → 什么都不写，留给 NapCat 启动后自己生成
   */
  if (existsSync(cfgDir)) {
    for (const f of walkJson(cfgDir, 0)) {
      const name = f.split(/[\\/]/).pop() ?? ''
      if (!/^(onebot11_.*\.json|webui\.json)$/.test(name)) continue
      try {
        const obj = readJsonFile<Record<string, unknown>>(f)
        if ('token' in obj || name.startsWith('onebot11_')) {
          obj.token = fixedToken
          /*
           * 同样必须原子写（理由见上面 AstrBot 主配置那处）。
           * 这里是 NapCat 的 webui.json / onebot11_*.json：
           * 里面除了 token 还有端口、host、主题等用户设置 ——
           * 一次写入失败会把它们一起抹掉。
           */
          writeJsonAtomic(f, obj)
        }
      } catch {
        /* 损坏跳过：下次 NapCat 启动会重写 */
      }
    }
  }
  return [{ label: 'WebUI Token', value: fixedToken }]
}

/**
 * 凭据扫描（M2 任务5）：把 AstrBot 账密 / NapCat token 从实例运行时配置里找出来告知用户。
 * AstrBot：运行时=data\config\*.json；NapCat：config\onebot11_*.json（token 字段）。
 */
export async function scanCredentials(deps: {
  dir: string
  type: InstanceType
  /** 实例 id 与数据根：用来定位实例日志（AstrBot 的初始密码打印在那里） */
  id?: string
  dataRoot?: string
}): Promise<Credential[]> {
  const { dir, type, id, dataRoot } = deps
  const results: Credential[] = []
  if (type === 'a') {
    /*
     * AstrBot 的账密在 data/cmd_config.json 的 dashboard.* 下。
     *
     * 密码**存的是哈希**，不是明文 —— 所以这里**不能**把哈希当密码告诉用户
     * （用户照着哈希输是登不进去的）。
     *
     * 但「看不到密码」并不等于「只能重置」。AstrBot 首次生成密码时会把**明文**
     * 在启动日志里打印一次（`➜ Initial password: xxx`），之后才只留哈希。
     * 那句明文就在用户自己的日志文件里，替他读出来完全正当 ——
     * 唯一的要求是**必须拿当前哈希验过**再用，否则可能显示一个早就失效的旧密码。
     * 见 astrbotPasswordFromLog 的说明。
     */
    const cfgFile = join(dir, 'data', 'cmd_config.json')
    if (existsSync(cfgFile)) {
      try {
        const obj = readJsonFile<{
          dashboard?: { username?: unknown; pbkdf2_password?: unknown; password?: unknown }
        }>(cfgFile)
        const u = obj.dashboard?.username
        if (typeof u === 'string' && u) results.push({ label: '用户名', value: u })
        const storedHash =
          typeof obj.dashboard?.pbkdf2_password === 'string' ? obj.dashboard.pbkdf2_password : ''

        // 先试日志里那句初始密码（有就用真的，这是用户最想要的）
        /*
         * ★ 必须 await（我把它改成 async 时差点留下一个静默错误）
         *
         * `astrobotPasswordFromLog` 用异步 pbkdf2（60 万轮同步会冻主进程 256ms）。
         * 改 async 之后，如果这里不 await，`logged` 拿到的是 **Promise 对象** ——
         * 而 Promise 永远 truthy，于是：
         *     results.push({ label: '密码', value: logged })   ← 显示 "[object Promise]"
         * 更糟的是它会走"有密码"那条分支，把**真正能用的回退路径**（提示去重置）
         * 挡住。这是"改签名忘了改调用方"的典型，必须靠测试钉住。
         */
        const logged =
          storedHash && id && dataRoot
            ? await astrbotPasswordFromLog(readInstanceLog(dataRoot, id), storedHash)
            : undefined
        if (logged) {
          results.push({ label: '密码', value: logged })
          /*
           * ★ 说明只留一句（主人 2026-09-27：「这里怎么还有废话文案」）
           *
           * 原文：「这是 AstrBot 首次运行自动生成的密码，记在实例日志里。
           *        改过密码后这里会自动失效。」
           *
           * 两句都是**用户用不着知道的**：
           *   · "首次运行自动生成的" —— 他只需要拿到密码，不关心它是怎么来的
           *   · "改过密码后这里会自动失效" —— 那是**实现细节**
           *     （靠哈希校验判断有效性），而且容易让人担心"是不是快失效了"，
           *     制造无谓的焦虑。
           *
           * 只留"从哪来的"这一条**可验证**的信息：
           * 用户能自己去日志里核对，出问题时也知道去哪找。
           */
        } else if (storedHash || typeof obj.dashboard?.password === 'string') {
          /*
           * 日志里没有（或那句已经过期）→ 老实说清"看不到，但可以重置"。
           *
           * ★ 精简（主人 2026-09-27：「这个也是废话」「这里也有废话」）
           *
           * 原来两条：
           *   密码: （只存了哈希，无法反推——请用你改过的密码，
           *          或点「重置账密」重设为 astrbot）
           *   说明: 如果这是第一次运行，AstrBot 生成的初始密码会打印在实例日志里
           *         （搜索「Initial password」）。日志被清过或密码已改，就只能重置了。
           *
           * 问题：
           *   · 「只存了哈希，无法反推」—— **技术细节**，用户不关心哈希是什么
           *   · 「搜索「Initial password」」—— 教用户去翻日志，而界面就有日志入口，
           *     而且我们**已经自动找过了**（找不到才走这里）
           *   · 两条说的是同一件事（看不到 → 去重置），重复
           *
           * 现在压成一条，且**直接给可操作的动作**：点「重置账密」。
           * 那正是用户此刻唯一能做的事。
           */
          results.push({ label: '密码', value: '（看不到，点上面的「重置账密」可以重设）' })
        }
      } catch {
        /* 配置损坏或还没生成 → 没有任何可报的凭据 */
      }
    }
  } else {
    /*
     * NapCat 有**两个不同的 token**，别搞混（这里踩过）：
     *
     *   config\webui.json        → WebUI 登录 token，就是用户在浏览器里
     *                              打开 NapCat 面板时输入的那个
     *   config\onebot11_<QQ>.json → OneBot 连接 token，给其他程序连机器人用的
     *
     * 原来这里只读 onebot11_*.json，于是用户点「看 Token」看不到
     * 自己想登面板用的那个 token（反馈「napcat 的 token 没办法查看」），
     * 而且 onebot11 配置文件在没配过连接时根本不存在，什么也读不到。
     *
     * 现在两个都读，并且**分开标注**，用户才知道哪个该填到哪。
     * WebUI 的排前面（那是最常要的）。
     */
    let webuiToken = ''
    let onebotToken = ''
    for (const f of walkJson(join(dir, 'config'), 0)) {
      const name = f.split(/[\\/]/).pop() ?? ''
      try {
        const obj: unknown = readJsonFile(f)
        if (name === 'webui.json') {
          const t = deepFindString(obj, ['token'])
          if (t) webuiToken = t
        } else if (/^onebot11_.*\.json$/.test(name)) {
          const t = deepFindString(obj, ['token'])
          if (t) onebotToken = t
        }
      } catch {
        /* 损坏跳过 */
      }
    }
    /*
     * 标签只留名字（主人 2026-09-27：「去掉看 token 里的（登录面板用）文案」）。
     *
     * 原来写的是 `WebUI Token（登录面板用）` / `OneBot Token（连接机器人用）`——
     * 括号里那句是**解释性废话**：看账密的人已经知道自己在找什么，
     * 而两个 Token 的区别在名字里就说清了（WebUI 是面板、OneBot 是连机器人）。
     */
    if (webuiToken) results.push({ label: 'WebUI Token', value: webuiToken })
    if (onebotToken) results.push({ label: 'OneBot Token', value: onebotToken })
    /*
     * 一个都没有时给一句解释，而不是空手而归。
     * webui.json 要等 NapCat 首次启动后才会生成 —— 用户没启动过实例就来点，
     * 什么都不显示会让人以为功能坏了。
     */
    if (!results.length) {
      results.push({
        label: 'WebUI Token',
        value: '（还没生成——先启动一次实例，NapCat 会自动创建配置）'
      })
    }
  }
  return results
}
