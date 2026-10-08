import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { PORT_RANGE_A, PORT_RANGE_N, INSTANCE_DIR_PREFIX, type InstanceType } from '../constants'
import { PortRangeExhausted } from '../ports/allocator'
import { readJsonFile } from '../util/json-file'

/** 分段端口：AstrBot 6100-6199，NapCat 6200-6299（用户决策 2026-09-12） */
export const TYPE_PORT_RANGE: Record<InstanceType, { min: number; max: number }> = {
  a: { min: PORT_RANGE_A.min, max: PORT_RANGE_A.max },
  n: { min: PORT_RANGE_N.min, max: PORT_RANGE_N.max }
}

export interface InstanceRecord {
  id: string
  type: InstanceType
  name: string
  templateVersion: number
  port: number
  dir: string
  status: 'stopped' | 'running' | 'starting' | 'error'
  /**
   * 可选：这个实例绑定的 QQ 号（NapCat 用）。
   *
   * 它是 NapCat 快速登录的账号，也是**多开隔离的关键** —— NapCat 按 QQ 号
   * 命名数据文件（onebot11_<QQ号>.json、napcat_<QQ号>.json），
   * 所以不同实例配不同 QQ 号就天然隔离；不填则走扫码登录。
   */
  qqAccount?: string
  /**
   * 这个实例当前跑的运行时版本（如 "4.18.19"），卡片上直接显示。
   *
   * 是**缓存**：创建和每次启动时读一次运行时包里的权威标识再写回
   * （见 runtime/instance-version.ts 的三层兜底）。
   * 缓存而不是每次渲染去读盘，是因为卡片列表会频繁刷新，
   * 而读 3MB 的 napcat.mjs 或扫 dist-info 不该出现在渲染路径上。
   * 读不到就是 undefined，界面显示「未知」——不编假的。
   */
  runtimeVersion?: string
  /**
   * 最近一次**启动的时刻**（UTC ISO 字符串，如 `2026-09-27T07:13:04.089Z`）。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ★ 为什么需要它（主人 2026-09-27 的思路，比我原来的做法对）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 要做「翻翻日志只显示本次运行的日志」，我第一版是**去日志文本里找标记**：
   *   ① 先找自己写的分隔线 `========== 启动于 … ==========`
   *   ② 后来改成找 AstrBot 自己打印的 `Welcome to AstrBot CLI!`
   *
   * 主人问了一句：
   *   「为啥不是通过实例启动来判定」
   *
   * 他说得对 —— 我在**猜文本**，而"实例是什么时候启动的"这件事
   * **我们自己最清楚**（启动本来就是我们发起的）。
   *
   * ## 为什么这个方案更好
   *
   *   · **不用猜**：不依赖任何程序的输出格式 ——
   *     换了程序、改了横幅文案、用户手动改过日志，都不会失效
   *   · **零侵入**：不用往用户日志里塞我们的分隔线
   *   · **精确**：日志行自带我们写的时间戳前缀（process-manager 里加的），
   *     直接按时间比较即可
   *
   * 写入时机：`instance:start` 里进程真的起来（拿到 pid）那一刻。
   */
  lastStartedAt?: string
  /**
   * 最近一次启动时，实例日志文件已经有多少字节。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ★ 这是「只看本次运行日志」的**真正判据**（比时间戳更稳）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 主人 2026-09-27：「为啥不是通过实例启动来判定」
   * —— 对，启动是我们发起的，位置我们最清楚。
   *
   * ## 为什么用**字节偏移**而不是时间
   *
   * 一开始想按时间过滤（日志行自带 `[13:54:17.469]` 前缀），但有三个坑：
   *   ① **前缀只有时间、没有日期** —— 实例跑过午夜就没法比较了
   *   ② 历史日志里混着**旧格式**（`toISOString` 的 UTC 时刻），
   *      同一个文件里两种口径，比较必然错
   *   ③ 还要解析每一行，慢且脆
   *
   * 字节偏移没有这些问题：启动那一刻文件有多长，之后的就都是本次的。
   * 不解析、不受时区影响、不受格式变更影响。
   *
   * ## 失效保护
   *
   * 用户可能删掉/清空日志文件 —— 那时偏移会**大于**当前文件大小。
   * 读取侧遇到这种情况一律"从头读"（宁可多给历史，也不能给空）。
   */
  lastLogOffset?: number
  createdAt: string
  updatedAt: string
}

interface RepoFile {
  instances: InstanceRecord[]
}

interface CreateParams {
  type: InstanceType
  /** 留空则自动命名：AstrBot 实例 / NapCat 实例 / NapCat 实例2 … */
  name?: string
  /** NapCat 专用：绑定的 QQ 号（快速登录 + 多开数据隔离），不填走扫码 */
  qqAccount?: string
  /** 端口由注入的分配函数决定（任务 3 引入真实分配器前用默认占位实现） */
  allocatePort?: (taken: number[]) => number
}

/**
 * 没起名时的默认名：「AstrBot 实例」「NapCat 实例」，第二个起加序号。
 * 序号从 2 开始——「NapCat 实例」本身就算第一个，加个 1 反而别扭。
 */
export function defaultName(recs: Array<{ name: string }>, type: 'a' | 'n'): string {
  const base = `${type === 'a' ? 'AstrBot' : 'NapCat'} 实例`
  const used = new Set(recs.map((x) => x.name))
  if (!used.has(base)) return base
  for (let i = 2; i < 10000; i++) {
    const cand = `${base}${i}`
    if (!used.has(cand)) return cand
  }
  return `${base}${Date.now()}`
}

export interface InstanceRepo {
  create: (p: CreateParams) => InstanceRecord
  list: () => InstanceRecord[]
  get: (id: string) => InstanceRecord | undefined
  updateStatus: (id: string, status: InstanceRecord['status']) => void
  /**
   * 更新实例端口。
   *
   * 为什么需要它：readAll 会把越界端口"修"成 0（见上面那段注释），
   * 而那个 0 会随 writeAll 落盘。0 是**我们自己写进去**的坏值，
   * 而 allocate 只在 create 时跑过 —— 于是端口被归零的实例永远修不好，
   * 每次启动白等满 90 秒。
   *
   * 有了这个方法，instance:start 就能在发现端口无效时重新分配并**写回**，
   * 让记录真正恢复健康（否则下次启动还是 0，等于没修）。
   */
  updatePort: (id: string, port: number) => void
  /** 更新实例记录的运行时版本（创建/启动时读一次写回，卡片显示用） */
  updateRuntimeVersion: (id: string, version: string | undefined) => void
  /**
   * 记下"最近一次启动"：时刻 + 那时日志文件有多长。
   *
   * `logOffset` 就是「只看本次运行日志」的判据（见 record 上 lastLogOffset 的说明）——
   * 启动时文件有多长，之后的就都是本次的。两个参数都可选：
   * 拿不到就只记时刻，读取侧退回"显示全部"。
   */
  markStarted: (id: string, at?: string, logOffset?: number) => void
  /** 更新实例绑定的模板版本（换运行时后调用；写盘走原子替换） */
  updateTemplateVersion: (id: string, version: number) => void
  remove: (id: string) => void
  /** 数据根迁移用：更新记录的 dir 字段并落盘 */
  setRecordDir: (id: string, dir: string) => void
  /** 仓库所在数据根 */
  readonly dataRoot: string
}

const FILE = 'instances.json'
/** 无注入时的兜底分配：同类从「同类上一个端口+1」顺延找空位（占用探测由 handler 层完成） */
const defaultAllocate = (recs: InstanceRecord[], type: InstanceType['type'] | InstanceType): number => {
  const range = TYPE_PORT_RANGE[type]
  const same = recs.filter((x) => x.type === type).map((x) => x.port)
  const taken = new Set(recs.map((x) => x.port))
  const start = same.length ? Math.max(...same) + 1 : range.min
  for (let p = start; p <= range.max; p++) {
    if (!taken.has(p)) return p
  }
  for (let p = range.min; p <= range.max; p++) {
    if (!taken.has(p)) return p
  }
  throw new PortRangeExhausted(type === 'a' ? 'AstrBot' : 'NapCat')
}

export function createInstanceRepo(opts: { dataRoot: string }): InstanceRepo {
  const file = join(opts.dataRoot, FILE)
  mkdirSync(opts.dataRoot, { recursive: true })

  /**
   * 把损坏的索引文件**留证**（改名成 `instances.json.corrupt-<时间戳>`）。
   *
   * ## 为什么必须做，而且必须在"检测到的那一刻"做
   *
   * readAll 上面的注释承诺了「不覆盖坏文件 —— 那是用户唯一的现场证据」，
   * 但**原来没有任何代码实现它**。readAll 只保证"这次不写"，
   * 而 writeAll 是 `writeFileSync(tmp) + renameSync(tmp, file)`，
   * 直接原子替换掉原文件。
   *
   * 于是最普通的用户路径就会毁掉证据：
   *   1. 用户手改 instances.json 弄坏一个引号（或写盘断电、同步盘回滚）
   *   2. 打开软件 → 列表降级成空 → 界面**一个实例都没有**
   *   3. 用户以为软件坏了，点「新建实例」试一下
   *   4. create 内部 readAll 拿到空列表 → 写回 → **坏文件被永久覆盖**
   *   5. 本来还能照着原文手工恢复的那些记录，全没了
   *
   * 第 4 步只需要一次再普通不过的操作。
   *
   * ## 为什么放在 readAll 里而不是 writeAll 之前
   *
   * 因为 readAll 是**所有**写路径的共同前哨（create/update/remove/setRecordDir
   * 全都先 readAll）。放在这里，新增写路径自动受保护；
   * 放在 writeAll 之前则要保证每个调用点都记得先调它。
   *
   * ## 只做一次
   *
   * 用 `quarantined` 标志记住本次进程内已经处理过。否则界面每次轮询
   * `instance:list` 都会 readAll 一次，每次都改名的话会堆出上百个
   * `.corrupt-*` 文件，把目录搞乱，用户更找不到哪个是原始证据。
   * 第一次改名之后原文件就不存在了（existsSync 为 false），
   * 后续 readAll 走的是「文件不存在」的早退分支，本来也不会重复。
   * 但显式加标志更清楚，也防止"用户看完又把坏文件拷回来"这种边界。
   */
  const quarantineCorrupt = (why: string): void => {
    try {
      if (!existsSync(file)) return
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dest = `${file}.corrupt-${stamp}`
      renameSync(file, dest)
      // 记进控制台/审计能看到的层：用户报「实例全没了」时，
      // 我们要能立刻说清"索引坏了，原文留在 xxx"
      console.warn(`[instance-repo] 索引损坏（${why}），原文已留证：${dest}`)
    } catch {
      // 留证失败（磁盘满/权限）不能连累"读到空列表"这个降级行为 ——
      // 那会让用户从"看不到实例"恶化成"软件打不开"
    }
  }

  /**
   * 读实例索引。
   *
   * **必须对坏文件免疫**：这个文件是实例列表的唯一真相来源，而它会因为各种
   * 现实原因损坏 —— 写入时断电、磁盘写满、用户手工编辑、杀软隔离、同步盘回滚。
   * 老实现直接 `JSON.parse`，一旦抛异常 `instance:list` 整条挂掉，
   * 界面上**一个实例都看不到**，用户会以为实例全没了（实测 7 种坏法全都崩）。
   *
   * 所以这里降级成空列表：宁可"暂时看不到"，也不能让整个功能不可用。
   * 并且**把坏文件改名留证**（见 quarantineCorrupt 的注释）——
   * 光"不主动写"是不够的，下一次 create 就会把它覆盖掉。
   */
  const readAll = (): RepoFile => {
    if (!existsSync(file)) return { instances: [] }
    try {
      const parsed = readJsonFile(file) as unknown
      // 结构校验：parsed 必须是对象且 instances 是数组，否则按损坏处理
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        quarantineCorrupt('顶层不是对象')
        return { instances: [] }
      }
      const list = (parsed as { instances?: unknown }).instances
      if (!Array.isArray(list)) {
        quarantineCorrupt('instances 不是数组')
        return { instances: [] }
      }
      // 逐条过滤掉明显不是实例记录的元素（手工改坏时容易混进 null / 字符串）
      const ok = list.filter(
        (x): x is InstanceRecord =>
          !!x && typeof x === 'object' && typeof (x as InstanceRecord).id === 'string'
      )
      /*
       * 端口兜底修正。
       *
       * 校验只到「id 是字符串」为止是不够的：用户会用记事本改 instances.json，
       * 把 port 改成 99999 / 0 / -1 / 留空 都是很自然的手滑。
       * 而一个越界端口会让 `net.connect` 同步抛 RangeError，
       * 顺着 `Promise.all` 把**整份实例列表**打成空（用户以为实例全丢了）。
       *
       * probePort 那边已经加了守卫（第一道）；这里是第二道 ——
       * 把坏值**就地修成一个不可能被占用的端口**，让记录本身变成良性的。
       *
       * 为什么修而不丢：这条记录的其他字段（名字、目录、运行时常量）
       * 可能都是好的，只是端口被改坏了。丢掉它 = 用户的实例凭空消失
       * （而且写回时会把这条彻底抹掉，比"显示异常"严重得多）。
       * 保留下来 + 端口归零，界面上会显示成「已停止」，
       * 用户点启动时 start 会走 allocate 重新分配一个合法端口。
       *
       * 用 0 而不是随便挑一个合法端口：0 明确表示"没有端口"，
       * 不会被误认为在监听（probePort(0) 恒为 false），
       * 也不会和真正在用的端口撞上。
       */
      const fixed = ok.map((x) => {
        const p = Number((x as { port?: unknown }).port)
        if (Number.isInteger(p) && p >= 1 && p <= 65535) return x
        return { ...x, port: 0 }
      })
      return { instances: fixed }
    } catch (e) {
      // JSON 解析失败 / 读文件失败 —— 同样要留证再降级
      quarantineCorrupt(e instanceof Error ? e.message : String(e))
      return { instances: [] }
    }
  }

  const writeAll = (data: RepoFile): void => {
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file) // 原子替换，避免写一半崩溃损坏索引
  }

  return {
    dataRoot: opts.dataRoot,
    create(p) {
      const all = readAll()
      const typed = (p.name ?? '').trim()
      // 用户自己起的名字：撞了就报错，让他换
      if (typed && all.instances.some((x) => x.name === typed)) {
        throw new Error(`实例名「${typed}」已存在，换个名字`)
      }
      // 没起名就自动给：AstrBot 实例 / NapCat 实例 / NapCat 实例2 / NapCat 实例3 …
      const want = typed || defaultName(all.instances, p.type)
      const taken = all.instances.map((x) => x.port)
      void taken
      const port = p.allocatePort ? p.allocatePort(taken) : defaultAllocate(all.instances, p.type)
      const now = new Date().toISOString()
      const id = `${INSTANCE_DIR_PREFIX[p.type]}${randomBytes(5).toString('hex')}`
      // 按类型分成两个文件夹：AstrBot 实例与 NapCat 实例各居其位
      const rec: InstanceRecord = {
        id,
        type: p.type,
        name: want,
        templateVersion: 1,
        port,
        dir: join(opts.dataRoot, 'instances', p.type === 'a' ? 'AstrBot' : 'NapCat', id),
        status: 'stopped',
        // NapCat 绑定的 QQ 号：只有填了才写进记录（空字符串别落盘，免得读出来是「有值但是空」）
        ...(p.qqAccount && p.qqAccount.trim() ? { qqAccount: p.qqAccount.trim() } : {}),
        createdAt: now,
        updatedAt: now
      }
      all.instances.push(rec)
      writeAll(all)
      mkdirSync(rec.dir, { recursive: true })
      return rec
    },
    list() {
      return readAll().instances
    },
    get(id) {
      return readAll().instances.find((x) => x.id === id)
    },
    updateStatus(id, status) {
      const all = readAll()
      const rec = all.instances.find((x) => x.id === id)
      if (!rec) throw new Error(`实例不存在: ${id}`)
      rec.status = status
      rec.updatedAt = new Date().toISOString()
      writeAll(all)
    },
    updatePort(id, port) {
      /*
       * 用途见接口上的注释：把 readAll 归零过的坏端口**真正修好**。
       *
       * 沿用 updateRuntimeVersion 的两个约定：
       *   · 实例可能刚被删 → 幂等返回，不抛（启动流程里抛错很难处理）
       *   · 值没变就不写盘 → 启动很频繁，省掉无意义的 IO
       */
      if (!Number.isInteger(port) || port < 1 || port > 65535) return
      const all = readAll()
      const rec = all.instances.find((x) => x.id === id)
      if (!rec) return
      if (rec.port === port) return
      rec.port = port
      rec.updatedAt = new Date().toISOString()
      writeAll(all)
    },
    updateRuntimeVersion(id, version) {
      const all = readAll()
      const rec = all.instances.find((x) => x.id === id)
      if (!rec) return // 实例可能刚被删，幂等返回，别抛
      // 值没变就不写盘：启动很频繁，省掉无意义的 IO
      if (rec.runtimeVersion === version) return
      rec.runtimeVersion = version
      rec.updatedAt = new Date().toISOString()
      writeAll(all)
    },
    markStarted(id, at, logOffset) {
      /*
       * 记下"这个实例最近一次启动的时刻 + 那时日志有多长" ——
       * 「只看本次运行日志」的判据（见 InstanceRecord.lastLogOffset 的说明）。
       *
       * 沿用上面两个方法的约定：
       *   · 实例可能刚被删 → 幂等返回，不抛（启动流程里抛错很难处理）
       *   · 值没变就不写盘（启动频繁，省无意义的 IO）
       */
      const all = readAll()
      const rec = all.instances.find((x) => x.id === id)
      if (!rec) return
      const iso = at ?? new Date().toISOString()
      const off = Number.isFinite(logOffset) ? Math.max(0, Number(logOffset)) : undefined
      if (rec.lastStartedAt === iso && rec.lastLogOffset === off) return
      rec.lastStartedAt = iso
      if (off !== undefined) rec.lastLogOffset = off
      rec.updatedAt = iso
      writeAll(all)
    },
    updateTemplateVersion(id, version) {
      /*
       * 为什么要有这个方法：
       * 之前调用方嫌麻烦，自己 join 出 instances.json 路径做「读-改-写」，
       * 结果两处踩坑 ——
       *   1) 那次 JSON.parse 没有 try 包裹，索引一旦损坏，**建实例就直接崩**；
       *   2) 用的 writeFileSync 不是原子替换，写到一半断电就把索引写坏了
       *      （而 repo 里的 writeAll 用临时文件 + rename 正是为了避免这个）。
       * 收敛到这里之后，防御和原子性都只有一份实现。
       */
      const all = readAll()
      const rec = all.instances.find((x) => x.id === id)
      if (!rec) return // 幂等，别抛
      if (rec.templateVersion === version) return
      rec.templateVersion = version
      rec.updatedAt = new Date().toISOString()
      writeAll(all)
    },
    /**
     * 只摘记录，**不删目录**。
     *
     * 目录删除交给调用方用异步方式做（见 ipc.ts 的 instance:remove 与
     * util/workdir.ts 的 removeDirAsync）—— 原因：
     *   - 实例目录动辄几万文件，`rmSync` 会独占主进程，界面整个卡住；
     *   - 删文件可能因占用/权限失败，不该因此让「删除实例」整体失败，
     *     否则记录留着、下次列表里又冒出来，用户以为没删掉。
     */
    remove(id) {
      const all = readAll()
      const rec = all.instances.find((x) => x.id === id)
      if (!rec) return // 幂等
      writeAll({ instances: all.instances.filter((x) => x.id !== id) })
    },
    setRecordDir(id, dir) {
      const all = readAll()
      const rec = all.instances.find((x) => x.id === id)
      if (!rec) throw new Error(`实例不存在: ${id}`)
      rec.dir = dir
      rec.updatedAt = new Date().toISOString()
      writeAll(all)
    }
  }
}
