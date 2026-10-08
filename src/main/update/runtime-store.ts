import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import * as fsp from 'fs/promises'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { readJsonFile } from '../util/json-file'
import { safeJoin, safeRuntimeType } from '../util/safe-segment'

export type RuntimeType = 'a' | 'n'

export interface RuntimeVersion {
  type: RuntimeType
  tag: string
  dir: string
  from?: string
  installedAt: string
  sizeMB?: number
}

export interface InstanceRef {
  instanceId: string
  type: RuntimeType
  tag: string
  name: string
}

export interface RuntimeStore {
  dirFor: (type: RuntimeType, tag: string) => string
  list: (type: RuntimeType) => RuntimeVersion[]
  all: () => RuntimeVersion[]
  register: (p: { type: RuntimeType; tag: string; from?: string }) => RuntimeVersion
  remove: (type: RuntimeType, tag: string) => void
  isInstalled: (type: RuntimeType, tag: string) => boolean
  latest: (type: RuntimeType) => RuntimeVersion | undefined
  setInstanceRefs: (refs: InstanceRef[]) => void
  refsFor: (type: RuntimeType, tag: string) => InstanceRef[]
  /** 清掉遗留的 `.deleting-*` 垃圾目录（删版本被占用时留下的残留） */
  sweepTrash: (onNote?: (msg: string) => void) => void
  /**
   * 对清单里没记过 sizeMB 的存量版本**后台**补算（fire-and-forget，
   * walk 走 fs/promises 线程池）。返回本次真正触发的 `type:tag` 列表
   * （给日志/测试对账用）。详情见实现处注释。
   */
  recomputeSizes: (limit?: number) => string[]
}

interface ManifestFile {
  versions: Array<{ type: RuntimeType; tag: string; from?: string; installedAt: string; sizeMB?: number }>
}

const FILE = 'runtimes.json'
const SUB: Record<RuntimeType, string> = { a: 'a', n: 'n' }

/** 版本号倒序（v4.10.0 > v4.9.9） */
function cmpTag(x: string, y: string): number {
  const norm = (s: string): number[] =>
    s.replace(/^v/i, '').split(/[.\-+]/).map((p) => {
      const n = Number.parseInt(p, 10)
      return Number.isFinite(n) ? n : 0
    })
  const a = norm(x)
  const b = norm(y)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/*
 * ★ 同步版 `dirSizeMB` 已**删除**（审查抓出的死代码 + 地雷）
 *
 * 它原来是"逐文件 statSync 的同步递归统计"，量级是**几万次同步 stat**
 * —— 运行时目录实测 4.9 万个文件，跑一次就是主进程冻结几百毫秒。
 *
 * 现在所有调用点都改用异步的 `dirSizeMBAsync`（见下），同步版**只剩定义、
 * 零调用点**。留着它的风险是：下一个要算体积的人会顺手用它（它就在上面、
 * 名字更短），于是把一个已经被清掉的主进程冻结点又请回来。
 * 所以直接删掉 —— 少一个"可以写错的地方"。
 *
 * （确认过：src 与 tests 里都没有任何引用。）
 */

/**
 * ★ dirSizeMB 的**异步**孪生（主进程零阻塞）
 *
 * 走 fs/promises（libuv 线程池）——几万个文件的 realpath/stat 在线程池里
 * 并行排队，事件循环每一跳照常转。给谁用：
 *   · register() 后台补算新装版本的大小
 *   · recomputeSizes() 对**老清单里没有记过大小**的存量版本回填
 *     （legacy 版本目录在磁盘上好好的，就是清单没记过 —— 首次打开软件
 *      就地补算，下一次 GPU…下一次刷新大小就出现了，主进程零卡）
 * 同步版 dirSizeMB 只允许 register 和测试的一次性小目录使用。
 */
async function dirSizeMBAsync(dir: string): Promise<number> {
  let total = 0
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 8) return
    let entries: Array<{ name: string; isDirectory: () => boolean }> = []
    try {
      entries = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      try {
        if (e.isDirectory()) {
          await walk(p, depth + 1)
        } else {
          const s = await fsp.stat(p)
          total += s.size
        }
      } catch {
        /* 跳过读不到的项 */
      }
    }
  }
  await walk(dir, 0)
  return Math.round((total / 1048576) * 10) / 10
}

/**
 * 多版本运行时仓库：runtimes/<a|n>/<tag>/
 * 清单 runtimes.json 只是索引——磁盘目录才是真身，清单丢失/损坏时从目录自愈，
 * 避免用户辛苦下好的运行时因为一个 json 坏了就"消失"。
 */
export function createRuntimeStore(opts: { dataRoot: string }): RuntimeStore {
  const rootDir = join(opts.dataRoot, 'runtimes')
  /**
   * 本进程内"已经尝试补算过体积"的 `${type}:${tag}`。
   *
   * 为什么要它：体积补算是 fire-and-forget 的后台动作，而它要递归扫整棵
   * 运行时目录（几万个文件）。同一个 tag 被反复扫就是纯粹的 IO 浪费 ——
   * 实测日志里同一批 tag 连刷十几次，主进程 IO 被占满。
   * 进程内只试一次，绝不重复。
   */
  const attemptedSizes = new Set<string>()
  const file = join(opts.dataRoot, FILE)
  let refs: InstanceRef[] = []

  /**
   * **唯一的路径构造函数** —— 所有「type + tag → 目录」都必须走这里。
   *
   * 里面做了形状校验（safeRuntimeType + safeSegment）与 resolve 边界断言，
   * 所以只要入口都经过 dirFor，就不可能有 tag 逃出 rootDir。
   *
   * 为什么把校验放在这一个函数里而不是每个入口各写一遍：
   * 原来 remove / register / isInstalled / dirFor 各自 `join(rootDir, SUB[type], tag)`，
   * 一共 4 处。要挡路径穿越就得改 4 处，将来加第 5 个入口还会漏。
   * 收口到一处之后，新增入口自动受保护 —— 这是这类防护能长期有效的关键。
   *
   * 代价：`dirFor` 现在可能**抛错**（原来只是纯字符串拼接，从不抛）。
   * 所以查询类接口（isInstalled）必须自己 catch —— 见那里的注释。
   */
  const dirForChecked = (type: RuntimeType, tag: string): string => {
    const t = safeRuntimeType(type)
    // `runtimes/<a|n>/<tag>`：先校验 type，再在 type 目录下安全解析 tag
    return safeJoin(join(rootDir, t), tag, { what: '版本号' })
  }

  const readManifest = (): ManifestFile => {
    try {
      if (!existsSync(file)) return { versions: [] }
      const j = readJsonFile<ManifestFile>(file)
      return { versions: Array.isArray(j.versions) ? j.versions : [] }
    } catch {
      return { versions: [] }
    }
  }

  const writeManifest = (m: ManifestFile): void => {
    mkdirSync(opts.dataRoot, { recursive: true })
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  /**
   * 这个版本目录里**真的有东西**吗？（不是安装失败留下的空壳）
   *
   * 单看「目录存在」会把半失败的安装当成可用版本 —— 用户会看到它、
   * 拿它建实例，然后启动失败且查不出原因（见 buildList 里的长注释）。
   *
   * 判据（满足任一即可，「或」而不是「与」）：
   *
   *   1. `mxbot-runtime.json` —— 安装流程**成功之后**才写的标记。
   *      最可靠的信号：有它就说明这个版本当初装成功过。
   *
   *   2. 本体文件（AstrBot 的 astrbot/__init__.py、NapCat 的
   *      NapCatWinBootMain.exe）—— 覆盖「外部拷入 / 手工解压」这类
   *      没有标记、但确实有货的目录。
   *
   *   3. 目录里有**不止一个**条目 —— 兜住测试和手工场景里
   *      「建个目录塞点东西」的普遍写法，同时仍然把「pip 刚开始就失败、
   *      只留下一个空目录」挡在外面。
   *
   * 为什么不能只靠本体文件：本机实测用户那些**装好的** AstrBot 运行时里，
   * `astrbot/__init__.py` 的 existsSync 返回 false（提权安装，普通权限
   * 读不了那个子目录）。只看本体会把用户装好的版本全藏起来 —— 比原 bug 更糟。
   */
  const hasSubstance = (type: RuntimeType, dir: string): boolean => {
    if (existsSync(join(dir, 'mxbot-runtime.json'))) return true
    if (type === 'a') {
      if (existsSync(join(dir, 'astrbot', '__init__.py'))) return true
    } else {
      // NapCat：认注入器；老包可能放在子目录里，两种都认
      if (
        existsSync(join(dir, 'NapCatWinBootMain.exe')) ||
        existsSync(join(dir, 'napcat', 'NapCatWinBootMain.exe'))
      ) {
        return true
      }
    }
    /*
     * 最后一条兜底：目录里是否有实际内容。
     * 空目录（pip 一失败就留下的那种）不算；有东西在就算。
     */
    try {
      return readdirSync(dir).length > 0
    } catch {
      // 读不了（提权安装的目录普通权限读不到）→ 保守当成有货，别把用户的版本藏了
      return true
    }
  }

  /** 磁盘扫描：补全清单里没有的（外部拷入 / 清单损坏） */
  /*
   * ★ 这些目录名**不是版本**，扫描时必须一律排除（四厂商审计抓出的真 bug）
   *
   * `.deleting-`：删版本时改名的临时名（原有机制）
   * `.stage-`    ：PyPI 安装的暂存目录 <dest>.stage-<rand>（ipc.ts runtime:install）
   * `.old-`      ：原子替换时被挪开的旧版本 <dest>.old-<rand>
   *
   * ## 为什么 `.old-` 不排除的话是个真事故
   *
   * 原子替换中途（旧→.old 完成、stage→dest 失败或进程被杀）会留下 `.old-<rand>`，
   * 而那里面是一个**内容完整**的运行时（mxbot-runtime.json + 本体都在）——
   * hasSubstance 会判 true，buildList 于是把它当成一个可用版本列出来。
   * 用户会看到 `v4.28.0.old-a3b2c1d4` 这种怪 tag，还能拿它建实例。
   * `.stage-` 同理（本体装完、标记也写好了，只差改名那一步）。
   *
   * 三类用的判定写在同一个谓词里：新增一种临时命名时这里必须同步，
   * 否则就会出现"又一种残留被当成版本"。
   */
  const isTrashLike = (n: string): boolean =>
    n.includes('.deleting-') || n.includes('.stage-') || n.includes('.old-')

  const scanDisk = (type: RuntimeType): string[] => {
    try {
      return readdirSync(join(rootDir, SUB[type])).filter((n) => {
        /*
         * 排除三类临时目录（见上面 isTrashLike 的说明）。
         * 不排除的话它们会被当成可用版本列出来 ——
         * 用户就会看到一堆 .deleting-xxx / .old-xxx 的怪版本。
         */
        if (isTrashLike(n)) return false
        try {
          return statSync(join(rootDir, SUB[type], n)).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      return []
    }
  }

  /**
   * 清掉遗留的 `.deleting-*` 垃圾目录。
   *
   * 它们是怎么留下的：删版本时先把目录改名叫 `<tag>.deleting-<stamp>`
   * （让列表立刻干净），再异步删文件。如果那时**有实例正在用这个版本**，
   * Windows 会因为文件被占用而删不掉，于是一个残缺目录就永久留下了。
   *
   * 实机后果（主人机器上就有一个）：
   *   runtimes\a\v4.27.0.deleting-mu0knsw0\   ← 占着几百 MB
   * 它永远不会自己消失，用户想重装同版本还得先手工清掉。
   *
   * 现在删版本时已经会拦住「正在运行」的情况（见 ipc 的 runtimes:remove），
   * 所以新的垃圾不会再产生。但**已经留下的必须有个归宿** ——
   * 启动时顺手清一次，删得掉就删，删不掉（还被占用）就留着下次再说。
   *
   * 刻意不 await、不抛错：这是打扫卫生，不该拖慢或影响启动。
   *
   * ## 但**失败必须报出来**
   *
   * 原来这里是 `.catch(() => {})` —— 失败完全静默。实机后果：
   * 用户机器上那个 `v4.27.0.deleting-mu0knsw0`（47 个顶层项、几百 MB，
   * `aiohttp` 子目录还是 Access denied）从 9:37 留到 10:00 之后，
   * 中间跨过一次启动（sweepTrash 跑过），**依然没删掉、也没有任何记录**。
   * 而失败原因（权限/占用）在下次启动时条件完全相同 → 永远删不掉、
   * 永远没人知道。用户只会觉得「删了还在，重装还说已存在」。
   *
   * 现在把失败也交给 onNote 上报，调用方记进日志。清不掉是事实，
   * 但至少能归因、能查。
   */
  const sweepTrash = (onNote?: (msg: string) => void): void => {
    for (const type of ['a', 'n'] as RuntimeType[]) {
      let names: string[]
      try {
        names = readdirSync(join(rootDir, SUB[type]))
      } catch {
        continue
      }
      for (const n of names) {
        /*
         * ★ 清三类残留，不再只清 .deleting-（四厂商审计抓出的漏洞）
         *
         * 新增 `.stage-`（安装暂存）与 `.old-`（原子替换挪开的旧版本）：
         * 原子替换被打断（进程被杀）时它们会留下，而且 .old- 里是
         * **内容完整**的运行时 —— 不清的话，scanDisk 虽已把它们排除
         * （看不到了），但它们会**永久占着几百 MB 磁盘**没人管。
         * 顺手在这里清掉，机制和 .deleting- 完全一样。
         */
        if (!isTrashLike(n)) continue
        const p = join(rootDir, SUB[type], n)
        // 动态 import：这个模块被纯 node 单测加载，顶层 import fs/promises 没必要
        void import('fs/promises')
          .then((fsp) => fsp.rm(p, { recursive: true, force: true, maxRetries: 2 }))
          .then(() => onNote?.(`清掉了遗留的待删运行时目录 ${type}\\${n}`))
          .catch((e: unknown) => {
            const why = e instanceof Error ? e.message : String(e)
            onNote?.(
              `清不掉遗留的待删目录 ${type}\\${n}（${why}）——`
                + `多半还有程序占着里面的文件，重启电脑后再打开本软件会自动重试`
            )
          })
      }
    }
  }

  const buildList = (type: RuntimeType): RuntimeVersion[] => {
    const m = readManifest()
    const known = new Map(m.versions.filter((v) => v.type === type).map((v) => [v.tag, v]))
    const tags = new Set<string>([...known.keys(), ...scanDisk(type)])
    const out: RuntimeVersion[] = []
    for (const tag of tags) {
      const dir = join(rootDir, SUB[type], tag)
      if (!existsSync(dir)) continue
      /*
       * ══════════════════════════════════════════════════════════════════════════
       * ★★ 「装完了没有」不能只看目录里有没有东西
       *   （主人 2026-09-27 实测：
       *     「v4.28.0 还在安装中，但是已装列表已经显示了」）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * ## 现场
       *
       * 界面同时显示两行**互相矛盾**的信息：
       *     顶部：v4.28.0  正在安装依赖 · 已用 58 秒
       *     下面：已装版本 AstrBot 1 → v4.28.0
       *
       * 而磁盘上那个 v4.28.0：
       *     787 文件 / 27.1 MB，`astrbot/` 有，但 click / quart /
       *     aiohttp / aiocqhttp **一个都没有** —— 依赖根本没装
       *     而且 `runtimes.json` 里**没有**它的记录
       *
       * ## 为什么会被列出来
       *
       * 安装顺序是「解压（目录先落地）→ pip 装依赖（几分钟）→ register」。
       * 这行判据是：
       *     if (!known.has(tag) && !hasSubstance(type, dir)) continue
       * 而 `hasSubstance` 的**最后一条兜底**是"目录里有东西就算"——
       * 解压落地的 `astrbot/` 正好让它通过。
       *
       * ## 为什么不能简单地把兜底删掉
       *
       * 那条兜底是有来历的（见它的注释）：提权安装的目录**普通权限读不到**，
       * 此时 `existsSync(astrbot/__init__.py)` 会是 false ——
       * 只看本体文件会把用户**装好的**版本全藏起来，比原 bug 更糟。
       *
       * ## 所以判据改成"依赖装没装齐"（可验证、不依赖权限之外的假设）
       *
       * 对 AstrBot：**必须有依赖目录的证据**。用 pip 一定会留下的
       * `*.dist-info` 判 —— 它是 metadata 目录，只要有包被装进去就存在，
       * 而且**不依赖 astrbot/ 那个子目录的权限**（dist-info 在根目录下）。
       *
       *   · 有 dist-info        → 装过东西了（即便只有一部分）
       *   · 一个 dist-info 都没有  → **pip 从来没跑成功过** → 是半成品
       *
       * 手动导入的 whl 也走 pip（见 ipc 的 installAstrbotDeps），所以
       * 同样会留下 dist-info —— 两种安装路径一致。
       *
       * ## 为什么不用"内存里记一笔"（我第一版的做法，已撤）
       *
       * 那需要 true/false 严格配对，任何一条路径漏掉 `false`（抛错、
       * 进程被杀）都会让那个版本**永久不显示**，且无法自愈。
       * 磁盘状态天然自愈 —— 装完 dist-info 就在那儿了。
       */
      /*
       * ══════════════════════════════════════════════════════════════════════════
       * ★★ 判据的最终结论：**别在磁盘上猜"装没装完"**
       * ══════════════════════════════════════════════════════════════════════════
       *
       * 目标（主人 2026-09-27）：「v4.28.0 还在安装中，但已装列表已经显示了」
       * 我为此试了三种判据，**全被实测/测试否掉**：
       *
       * ## ① 内存集合 `markInstalling`（已撤）
       *
       * `true`/`false` 必须严格配对，而 `false` 写在会抛错的路径上
       *（`register` 同 try、`store` 未创建处）—— 漏一次就**永久**不显示、
       * 且无法自愈（只有重启才清）。**代价远大于它解决的问题。**
       *
       * ## ② 查 `*.dist-info`（不成立）
       *
       * 以为"pip 装过就有 metadata"。实测：上游 whl 包**自带**
       * `astrbot-4.28.0.dist-info/`，解压出来就在 —— 与依赖无关。
       *
       * ## ③ 查 `click`/`quart` 目录（太严）
       *
       * `runtime-store.spec.ts` 的「清单损坏自愈」「外部拷入」两条测试
       * 造的是"目录里有个 astrbot.py"—— **那是真场景**，却被我拦了。
       * 而且手动导入的 whl / 用户自己拷的运行时未必有这两个包。
       *
       * ## 所以：磁盘上**无法区分**这几种情况，就别硬分
       *
       *   未登记 + 有实质  = 「清单损坏自愈」/「外部拷入」/「装到一半」
       *                       三种情况的**形状完全相同**
       *
       * 硬分必然误伤前两种（把用户**已经装好**的版本藏起来，
       * 那比"多显示一个坏的"严重得多 —— `hasSubstance` 的注释里
       * 早就写着这条取舍）。
       *
       * **"能不能用"交给启动时判断**：缺依赖会报
       * `ModuleNotFoundError: No module named 'click'`，
       * 那是**真实反馈**，比任何静态猜测都准；而启动失败的提示
       * 已经会告诉用户"重新下载这个版本"。
       *
       * 换句话说：**静态判据只做"是不是一个运行时目录"，
       * 不做"它完不完整"** —— 后者不是看一眼目录能知道的。
       */
      if (!known.has(tag) && !hasSubstance(type, dir)) continue
      const rec = known.get(tag)
      out.push({
        type,
        tag,
        dir,
        from: rec?.from,
        /*
         * ★ sizeMB 不再在这里算（主进程冻结的第一元凶，主人 0.1.3 实测）
         *
         * 原来 `sizeMB: dirSizeMB(dir)` —— 那是**逐文件读统计数**的同步递归
         * （readdirSync + statSync，深度 8）。实测 2 万个小文件 ≈950ms，
         * AstrBot 运行时 49133 个文件 → 单跑步 4 秒级；而 `runtimes:list /
         * instance:list / latest()` 全都走 buildList，用户"开机卡半分钟、
         * 点什么卡几下"的直接根源就是它。
         *
         * 修法（与指导书"主进程零同步阻塞"一致）：
         *   · 列表页只读**清单里存过的大小**（install/import 后台补写，
         *     见 register 里 recomputeSize 的 fire-and-forget）
         *   · 没有存过就暂缺 —— UI 所有 size 展示点全有 `v-if`/三元兜底
         *     （grep 确认 6 处消费者都判 provides），缺一格不炸界面
         *   · 后台算好写回清单后，下一次刷新自然带上（SWR：先见内容、
         *      再见大小）
         *
         * dirSizeMB（同步版）保留给 register/测试的**一次性**局部使用；
         * 列表路径严禁再调它。
         */
        installedAt: rec?.installedAt ?? new Date(statSync(dir).mtime).toISOString(),
        sizeMB: rec?.sizeMB
      })
    }
    return out.sort((x, y) => cmpTag(y.tag, x.tag))
  }

  /**
   * 单个版本的体积后台补算（供 register 与 recomputeSizes 共用）。
   *
   * 竞态保护：readdirSync 拿目录 → 计算期间它可能被删（remove 的
   * `.deleting-` 改名直谈起）——重算完重新读清单，条目不在就直接丢弃，
   * **绝不给已被摘除的 tag 复活清单记录**。
   */
  async function recomputeOneSize(type: RuntimeType, tag: string): Promise<void> {
    const dir = dirForChecked(type, tag)
    if (!existsSync(dir)) return
    const mb = await dirSizeMBAsync(dir)
    const m = readManifest()
    const hit = m.versions.find((v) => v.type === type && v.tag === tag)
    if (!hit) return // 算完已经被删了：值作废，不许复活
    if (hit.sizeMB === mb) return // 没变化就不写盘：避免反复重写清单
    hit.sizeMB = mb
    writeManifest(m)
  }

  return {
    dirFor: (type, tag) => dirForChecked(type, tag),

    list: (type) => buildList(type),

    all: () => [...buildList('a'), ...buildList('n')],

    register({ type, tag, from }) {
      const dir = dirForChecked(type, tag)
      mkdirSync(dir, { recursive: true })
      const m = readManifest()
      const existing = m.versions.find((v) => v.type === type && v.tag === tag)
      if (existing) {
        if (from) existing.from = from
      } else {
        m.versions.push({ type, tag, from, installedAt: new Date().toISOString() })
      }
      writeManifest(m)
      /*
       * ★ 大小**后台**补算（fire-and-forget）
       *
       * register 的调用方在 install/import 完成的同步路径上 —— 在这里
       * 同步 walk 几万文件会把现场冻结一瞬（pip 刚跑完 4 分钟，
       * 用户正盯着界面，此时绝不允许再卡一秒）。
       * fs.promises 版走线程池，完成后把 sizeMB（若变化）patch 进清单 ——
       * 下一次 buildList 就从清单里读到，列表路径全程零扫盘。
       */
      void recomputeOneSize(type, tag).catch(() => {
        /* 补算是锦上添花：失败下次再算，绝不能影响安装结果 */
      })
      const hit = buildList(type).find((v) => v.tag === tag)
      return hit ?? { type, tag, dir, from, installedAt: new Date().toISOString() }
    },

    /**
     * 把**清单里没记过大小**的存量版本在后台补算 + 回填清单。
     *
     * 背景：老用户的 runtimes.json 是旧版写的，没有 sizeMB 字段 ——
     * 列表路径已经不再同步算了（那是冻结主进程的根源），大小于是空白。
     * 这个方法对缺失的项逐个走异步计算、patch 清单；调用方（IPC 的
     * runtimes:list）fire-and-forget —— 用户第一次打开就触发，
     * 几秒后的大小就自己长回来了，主进程全程无感。
     *
     * 有界：一次最多补 MAX_RECOMPUTE 个（防手滑全量×几万文件挤线程池），
     * 剩下的留给下一次调用 —— 大小本来就不是要紧信息。
     */
    recomputeSizes(limit = 6) {
      const missing: Array<{ type: RuntimeType; tag: string }> = []
      const m = readManifest()
      for (const type of ['a', 'n'] as RuntimeType[]) {
        for (const tag of scanDisk(type)) {
          /*
           * ★ 只补"清单里**有**记录、但缺 sizeMB"的项（修一个死循环）
           *
           * 原来的判断是「清单里没有一条带 sizeMB 的记录」→ 就补。
           * 可是 recomputeOneSize 遇到**清单里根本没有这个 tag 的记录**时
           * 会直接 return（算出来也没地方写）。于是这种"目录在、清单记录没了"
           * 的版本（用户卸载重装后非常常见）会**每次列表刷新都被判为缺失**，
           * 每次都把整棵运行时目录重扫一遍（几万个文件）——
           * 实测表现：同一批 tag 在日志里连刷十几次，主进程被 IO 占死，
           * 连 `config:moving` 这种只读状态的轮询接口都要排队几秒。
           *
           * 现在：清单里没有记录的 tag **不补**（没地方存），
           * 并且用 attemptedSizes 记住"本进程试过的"，同一 tag 只试一次。
           */
          const rec = m.versions.find((v) => v.type === type && v.tag === tag)
          if (!rec) continue // 清单里没记录 → 无处可写，跳过（别做无用功）
          if (typeof rec.sizeMB === 'number') continue // 已经有了
          const key = `${type}:${tag}`
          if (attemptedSizes.has(key)) continue // 本进程试过了，别再扫
          missing.push({ type, tag })
          if (missing.length >= limit) break
        }
        if (missing.length >= limit) break
      }
      for (const it of missing) {
        const key = `${it.type}:${it.tag}`
        attemptedSizes.add(key)
        void recomputeOneSize(it.type, it.tag).catch(() => {
          /* 同上，尽力而为 */
        })
      }
      return missing.map((x) => `${x.type}:${x.tag}`)
    },

    /**
     * 摘掉某个版本的记录，并**立刻把它从目录扫描里藏起来**（重命名成临时名），
     * 返回新路径交给调用方去异步删（见 removeDirAsync）。
     *
     * 为什么不能只摘记录就完事（这里踩过一个坑）：
     *   buildList 会把「清单里的记录」和「磁盘上的目录」**合并**展示
     *   （为了兜住外部拷入 / 清单损坏的情况）。所以如果只删记录、
     *   把目录留在原地等异步删，那么目录还在的这段时间里
     *   **这个版本会立刻从列表里消失……然后又被 scanDisk 找回来**，
     *   用户看到「点了删除，列表里还在」。
     *
     * 解决办法：先同步改名（rename 是元数据操作，几万个文件也是一瞬间），
     * 名字带 `.deleting-` 前缀后就不再满足 scanDisk 的匹配，
     * 列表立即干净；然后再异步删真正的文件，主进程全程不卡。
     * 就算异步删除失败了，留下的也只是个 `.deleting-*` 垃圾目录，
     * 不会再冒充可用版本。
     */
    remove(type, tag) {
      const dir = dirForChecked(type, tag)
      if (!existsSync(dir)) throw new Error(`没有安装 ${tag} 这个版本`)

      /*
       * **先改名，成功之后才摘清单** —— 顺序反了会「假成功」。
       *
       * 原来写的是先 writeManifest 摘记录、再 renameSync。审计实跑抓到后果：
       *
       *   1. 用户点删版本，而实例正在用它跑（NapCat 注入的 QQ 占着文件）
       *   2. 清单先被摘掉（磁盘没动）
       *   3. renameSync 被占用 → 失败 → catch 里**返回原路径 dir**，假装成功
       *   4. 调用方拿原路径去异步删，也失败，只记一条 WARN（界面与审计都显示「成功」）
       *   5. 下次 buildList：清单里没有它，但 scanDisk 扫到目录、
       *      hasSubstance 为真（NapCatWinBootMain.exe 在）→ **版本又冒出来了**
       *   6. 用户再删一次 → 又「成功」→ 文件依旧在
       *
       * 用户机器上的审计日志里 NapCat v4.18.19 被删了 **3 次**、
       * 每次都记「成功」，而 runtimes.json 已经是空的、目录还在 —— 就是这么来的。
       *
       * 现在：rename 失败就**直接抛**，清单一个字都不动。
       * 用户看到的是「删不掉，因为文件被占用」，这是**真话**，
       * 也比「说成功但没删」强得多。调用方（ipc）已经在删之前挡了
       * 「有实例正在运行」的情况，所以这条抛错基本只会出现在
       * 用户手工开的 NapCat/QQ 占着文件时。
       */
      /*
       * ★ 加随机后缀（独立审查抓出的碰撞点）
       *
       * `Date.now().toString(36)` 只有**毫秒**精度。同一毫秒内删两次同一个 tag
       * （用户连点删除、或界面重试逻辑）会生成**同一个 trash 名**，
       * 于是 `renameSync` 的目标已存在 —— Windows 上这会抛 EPERM/EEXIST，
       * 而下面那个 catch 把它归因成「文件正被其它程序占用」。
       *
       * 那是**错误归因**：用户被引去关 QQ，而实际上只是名字撞了，
       * 再点一次就能成功。归因错了比报错本身更费时间 ——
       * 所以这里加随机后缀，让碰撞不可能发生。
       */
      const trash = `${dir}.deleting-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
      try {
        renameSync(dir, trash)
      } catch (e) {
        const code = (e as { code?: string }).code
        throw new Error(
          `删不掉 ${tag}：文件正被其它程序占用（${code ?? '未知原因'}）。`
            + `先把使用这个版本的实例和它相关的程序（比如 QQ）完全退出，再试一次。`
        )
      }

      // 改名成功（列表已经不认它了）之后再摘清单，两边一致
      const m = readManifest()
      m.versions = m.versions.filter((v) => !(v.type === type && v.tag === tag))
      writeManifest(m)

      return trash
    },

    /**
     * 注意：这里**故意吞掉** dirForChecked 抛出的非法参数错误。
     *
     * 原因：isInstalled 是给界面轮询用的查询接口。如果渲染层某个版本号
     * 脏了（历史数据、手改的 json），抛错会让调用它的那个 IPC 直接失败，
     * 而界面往往在一个循环里查多个版本 —— 一个脏数据就把整屏拖垮
     * （这和之前 `ERR_SOCKET_BAD_PORT` 一个坏端口把实例列表整个弄白
     * 是同一类事故）。
     *
     * 语义上「不认识的名字」本来就等于「没装」，返回 false 是**诚实**的，
     * 不是掩盖问题：真正想让它报错的是 remove/register 那种**会改磁盘**的
     * 操作，那些地方不 catch。
     */
    isInstalled(type, tag) {
      try {
        return existsSync(dirForChecked(type, tag))
      } catch {
        return false
      }
    },

    latest(type) {
      return buildList(type)[0]
    },

    setInstanceRefs(next) {
      refs = next
    },

    refsFor(type, tag) {
      return refs.filter((r) => r.type === type && r.tag === tag)
    },


    /** 清掉遗留的 `.deleting-*` 垃圾目录（启动时调一次即可，见函数注释） */
    sweepTrash
  }
}
