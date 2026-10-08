import { cpSync, mkdirSync, existsSync, writeFileSync, renameSync } from 'fs'
import * as fsp from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { readJsonFile } from '../util/json-file'
import type { InstanceRepo } from './instance-repo'

export interface RelocateOptions {
  /** 目标数据根目录 */
  target: string
}

/**
 * <dataRoot> 下**所有**需要跟着搬的东西。
 *
 * 这是这个模块最容易出事的地方，所以写成显式清单而不是「遍历一遍全搬」：
 * 遍历会把 cache\tmp 里的下载中转文件、pip 缓存（能到 GB 级）也一起搬，
 * 那种搬运毫无意义还很慢。清单化则保证「该搬的一个不少、纯垃圾一个不多」。
 *
 * 踩过的坑（很重）：原来这里只搬 instances\ 和 instances.json，
 * 而实际住着的还有 runtimes\ / python\ / mirrors.json / logs\ / templates\。
 * 用户点「迁移数据目录」以为东西都跟过去了，实际搬完：
 *   - runtimes\ 没了 → 每个实例启动都报「运行时文件不完整」
 *   - python\ 没了 → AstrBot 报「需要先装好 Python」
 *   - mirrors.json 没了 → 自己加的镜像源凭空消失
 *   - logs\ 没了 → 排查问题的现场没了
 * 等于**一次迁移把软件搬成半废**，而界面还告诉他成功。
 *
 * 关于 cache\：**刻意不搬**。那里面是版本列表缓存和 pip 下载缓存
 * （实测能到 6.8GB），纯粹是可再生的中间产物 —— 搬它只会让一次迁移
 * 慢上几分钟并且要求目标盘有同等空闲空间，而重新联网拉一遍只要几秒。
 * 搬完缓存自然失效，软件会重新拉。
 *
 * ## 'runtime' 而不是 'python'（这个写错过，代价是迁移把软件搬成半废）
 *
 * 原来这里写的是 'python'，因为"内置 Python 嘛，目录当然叫 python"。
 * 但真实位置是 `<dataRoot>\runtime\python\`（见 python-runtime.ts 的
 * `pythonDirFor`：`join(dataRoot, 'runtime', 'python')`）。
 *
 * 后果很隐蔽：`<dataRoot>\python` **从来不创建**，所以搬运时
 * `existsSync(src)` 为假、静默跳过 —— 迁移"成功"，而真解释器留在原地。
 * 用户在新根启动 AstrBot 就报「需要先装好 Python」。
 *
 * 实机确认：用户机器 `E:\MXBot\data\` 下是 `runtime/`，**没有** `python/`。
 *
 * 搬 `runtime\` 整个目录（它目前只装 python，将来放别的东西也一起走）。
 *
 * ## logs-export 也搬
 *
 * 用户导出的日志包（`<dataRoot>\logs-export\`）是**用户主动产生的成果**，
 * 不是可再生的中间物，跟 logs\ 一个性质。原来漏了它。
 */
const MOVE_DIRS = [
  'instances',
  'runtimes',
  'runtime',
  'logs',
  'logs-export',
  'templates',
  /*
   * ★ backups 必须跟着走（四厂商审计确认的 HIGH）
   *
   * `<dataRoot>\backups\update\` 是**覆盖更新前自动打的整库备份**
   * （mxbot-data.tar.gz，update-backups.ts 写死了这个路径）。
   * 原来的清单漏了它 —— 迁移之后：
   *   · 用户在新根的备份页看不到这些归档（update:backupsList 按
   *     新根的 updateBackupsRoot() 扫）
   *   · 它们只存在于旧根；哪天用户按提示把旧根删了，
   *     **救命备份一起消失** —— 而当初做它的目的就是"万一更新失败能救"
   */
  'backups'
] as const
/**
 * 单文件也要搬的。
 *
 * ## 为什么 runtimes.json 必须在这个清单里（审计抓出来的遗漏）
 *
 * `MOVE_DIRS` 里有 `runtimes`（**目录**，装的是运行时本体），
 * 但 `runtimes.json` 是**数据根根目录下的一个单文件**
 *（见 update/runtime-store.ts:94  `join(opts.dataRoot, FILE)`，`FILE = 'runtimes.json'`）——
 * 它不在任何被搬的目录里面，所以必须单独列出来。
 *
 * 漏掉的后果：迁移之后新根里有 `runtimes/` 目录、却没有清单。
 * 好在 `scanDisk` 会自愈（版本仍可见可用，**运行时不会丢**），
 * 但丢的是：
 *   · `from`（这个版本是从哪个源装的）
 *   · `installedAt`（退化成目录 mtime）
 * 属于**静默降级** —— 不报错、不丢可用性，但用户看不到装上时间了。
 * 这正是那种"没人会去查、查了也说不清"的丢失，所以补上。
 *
 * mirrors.json 里存着用户自己加的源与首选源；config.json / instances.json
 * 是"整个仓库的地基"，同样必须跟着走。
 */
const MOVE_FILES = [
  'mirrors.json',
  'config.json',
  'instances.json',
  'runtimes.json'
] as const

/**
 * 迁移前挡住两种会**真的出事**的入参。
 *
 * 这个入参来自用户在设置里手选的目录，选重、选到自己里层都是很自然的手滑：
 *
 *   1. 目标 === 当前数据根
 *      `cpSync(src, dest, {recursive:true})` 在两者相同时直接抛
 *      `ERR_FS_CP_EINVAL: src and dest cannot be the same`，
 *      用户看到一句英文报错，完全不知道该怎么办。
 *
 *   2. 目标在**某个要被递归复制的子目录里面**
 *      （例如当前 `D:\data`，目标选了 `D:\data\logs\bak`）
 *      复制 `logs\` 时源和目标互相包含，cpSync 会边读边往自己里面写 ——
 *      目录无限长下去，直到路径超长或磁盘写满。
 *
 * 注意**不是**「目标在数据根里层就一律拒绝」：`D:\data` → `D:\data\data2`
 * 是安全且合理的用法（子目录之间不互相包含），拦掉它属于误伤。
 */
function assertRelocatable(from: string, to: string): void {
  const a = normPath(from)
  const b = normPath(to)
  if (a === b) {
    throw new Error('目标目录和当前数据目录是同一个地方，不用迁移')
  }
  for (const name of MOVE_DIRS) {
    if (name === 'instances') continue
    if (b.startsWith(`${a}\\${name}\\`)) {
      throw new Error(
        `目标目录在 ${name}\\ 里面，复制时会没完没了。换一个 ${name}\\ 外面的目录`
      )
    }
  }
}

/**
 * 路径规范化，只用来**比较**是否同一个地方。
 *
 * 只统一分隔符、去掉结尾斜杠、折成小写（Windows 路径不区分大小写）。
 * 刻意不 resolve：resolve 会把相对路径拍成绝对路径、还会吃掉 `..`，
 * 那样反而看不出用户到底选了什么。
 */
function normPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function isSamePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b)
}

/**
 * 数据根迁移：
 * 1. 复制每个实例目录到 <target>/instances/<type>/<id>（复制而非剪切——旧目录保留，用户自行清理）
 * 2. 把 runtimes / runtime / logs / templates / mirrors.json 等**全部**家当一并复制
 * 3. 把仓库索引写入目标根
 * 4. 更新记录的 dir 字段
 * 运行中的实例由调用方负责先停止。
 *
 * ## 返回值：搬失败的项要能报出去
 *
 * 原来这些 try 全是空的 `catch {}`，注释写着"单项失败不致命，下次再迁一次会补上"。
 * 问题是**用户不知道要再迁一次**，界面直接报「迁移成功」，
 * 而新根其实是残缺的（比如 runtime\python 里几个 .pyd 被占着没拷过去）
 * → 用户在新根启动实例莫名其妙失败，回头也想不到是迁移没搬全。
 *
 * 现在把失败项收集起来返回，由调用方决定怎么提示。
 * 单项失败仍然**不抛**（不能因为一个日志文件把整个迁移回滚掉）。
 */
export async function relocateDataRoot(
  repo: InstanceRepo,
  opts: RelocateOptions
): Promise<{ moved: string[]; failed: Array<{ item: string; reason: string }> }> {
  /*
   * ## 为什么从同步改成 async（四厂商审计确认的 HIGH）
   *
   * 这里链着 copyInto 的异步化：主进程是单线程的，几百 MB~几 GB 的目录
   * 同步复制会把事件循环**整段冻结**——窗口「无响应」、IPC 全部排队。
   * 改成 async 后调用方（config:moveDataRoot）也要跟着 await，
   * 返回值语义不变（仍是 moved/failed 清单）。
   *
   * assertRelocatable 保持**同步抛**：它是参数校验，坏入参（目标=源 /
   * 目标在内部子目录）应当在进入任何 IO 之前就被拦住；校验读取的都是
   * 元数据（existsSync/isSamePath），没有阻塞问题。
   */
  const from = repo.dataRoot
  assertRelocatable(from, opts.target)

  const moved: string[] = []
  const failed: Array<{ item: string; reason: string }> = []

  const records = repo.list()
  const newInstancesDir = join(opts.target, 'instances')
  mkdirSync(newInstancesDir, { recursive: true })
  for (const rec of records) {
    // 与 repo.create 同规则：按类型分两个文件夹
    const dest = join(newInstancesDir, rec.type === 'a' ? 'AstrBot' : 'NapCat', rec.id)
    mkdirSync(dest, { recursive: true })
    /*
     * 源和目标已经是同一个地方就跳过。
     *
     * 什么时候会这样：**重复迁移**。第一次迁移后记录的 dir 已经指向新根，
     * 再点一次「迁移」时 dest 算出来正好等于 rec.dir，而
     * `cpSync(p, p)` 会抛 ERR_FS_CP_EINVAL —— 用户看到一句英文报错，
     * 以为迁移坏了，其实数据早就搬好了。
     * 迁移本来就该是幂等的：多按一次不该出事。
     */
    if (existsSync(rec.dir) && !isSamePath(rec.dir, dest)) {
      try {
        await copyInto(rec.dir, dest)
        moved.push(`instances/${rec.type}/${rec.id}`)
      } catch (e) {
        /*
         * 实例数据搬不过去是最重的一种失败，必须报出去。
         *
         * ## 而且**绝对不能**改 dir（这里原来有个真缺陷）
         *
         * `repo.setRecordDir()` 原来写在这个 try/catch **外面**，
         * 于是无论复制成功还是失败，记录里的 dir 都会被改写成新根。
         *
         * `dir` 是「实例数据在哪」的唯一真相。复制失败（Windows 上最常见：
         * 文件被正在跑的实例占着）之后：
         *   1. 新根下那个 dest 只是 mkdirSync 建出来的**空目录**；
         *   2. 记录却已经指过去了；
         *   3. 用户在新根打开软件 → 实例卡片还在，数据全空；
         *   4. 旧根里那份**完好的**数据再也没人引用，
         *      用户以为迁移把数据搞丢了。
         *
         * 也就是说：一次「有失败的迁移」会**静默地把实例指向空目录**，
         * 而界面显示的是「迁移成功（1 项失败）」—— 那 1 项看起来无关紧要。
         *
         * 实测复现（tests/unit/relocate-faildir.spec.ts）：
         *   Expected: ...\old\instances\NapCat\n_xxx   ← 数据真的在这
         *   Received: ...\new\instances\NapCat\n_xxx   ← 记录却指到这
         *
         * 现在：失败就 continue，dir 保持指向旧位置（数据还在那儿，能用）。
         * 失败项照旧收集上报，用户能看到哪个实例没搬过去。
         */
        failed.push({ item: `实例「${rec.name}」的数据`, reason: msgOf(e) })
        continue
      }
    }
    /*
     * 只有走到这里才改记录 —— 要么复制成功，要么源本来就不存在
     * （那种情况下 dest 已经建好，指过去是正确的：没有数据可丢）。
     */
    repo.setRecordDir(rec.id, dest)
  }

  /*
   * 其余家当：逐项复制。
   *
   * 每一项都独立 try —— 比如日志文件正被别的进程占着（Windows 上很常见），
   * 不该因为「日志搬不过去」就让整个迁移失败、把实例记录全留在半路。
   * 真正要紧的（实例数据、索引）在前面已经做完了。
   */
  for (const name of MOVE_DIRS) {
    if (name === 'instances') continue // 上面已按类型分流处理
    const src = join(from, name)
    if (!existsSync(src)) continue
    try {
      await copyInto(src, join(opts.target, name))
      moved.push(name)
    } catch (e) {
      failed.push({ item: `${name}\\`, reason: msgOf(e) })
    }
  }
  for (const f of MOVE_FILES) {
    if (f === 'instances.json') continue // 下面统一落盘
    const src = join(from, f)
    if (!existsSync(src)) continue
    try {
      cpSync(src, join(opts.target, f))
      moved.push(f)
    } catch (e) {
      failed.push({ item: f, reason: msgOf(e) })
    }
  }

  /*
   * 索引落到目标根。
   *
   * **必须重新 list 一次**，不能用上面那个 `records` 变量。
   * 原因很隐蔽：`repo.list()` 每次都是重新解析磁盘文件、返回**新数组**，
   * 而 `repo.setRecordDir()` 内部也是自己 readAll 一份、改完写回 ——
   * 它改的不是我手里这个数组。所以循环结束后 `records` 里的 dir
   * 仍然全是**旧路径**，拿它序列化出来的新索引会全部指回旧根。
   *
   * （原来的实现是「源文件存在就直接抄原文」，恰好抄到的是
   * setRecordDir 刚写好的新路径，于是"碰巧对"；一旦改动这个顺序就坏。
   * 这里显式重新读一遍，不再依赖那种巧合。）
   */
  const finalRecords = repo.list()
  const tmp = join(opts.target, `.instances.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmp, JSON.stringify({ instances: finalRecords }, null, 2), 'utf8')
  renameSync(tmp, join(opts.target, 'instances.json'))

  /*
   * 顺带把 config.json 里的 dataRoot 改到新根。
   * 调用方（ipc.ts）后面也会写一次，但那是**内存里的 cfg** ——
   * 如果这一步没做、调用方又出了岔子，新根里的 config.json 会留着旧路径，
   * 下次启动按旧路径读，用户会发现"迁移完又回去了"。
   */
  const cfgPath = join(opts.target, 'config.json')
  if (existsSync(cfgPath)) {
    try {
      /*
       * 必须走 readJsonFile，不能自己裸 parse 读出来的文本：
       * config.json 有可能带 BOM（用户手工编辑过、或用记事本另存过），
       * 而 JSON.parse 不认 BOM，会直接抛 —— 于是「迁移完 dataRoot 没改过来」。
       * 这条约束有专门的守卫测试按着（见 tests/unit/json-file.spec.ts），
       * 它按字面匹配那种写法，所以这里连注释里都不要写出那个函数调用。
       */
      const cfg = readJsonFile<Record<string, unknown>>(cfgPath)
      cfg.dataRoot = opts.target
      const ctmp = `${cfgPath}.${randomBytes(4).toString('hex')}.tmp`
      writeFileSync(ctmp, JSON.stringify(cfg, null, 2), 'utf8')
      renameSync(ctmp, cfgPath)
    } catch (e) {
      /* 配置读不动就算了，调用方还会写一遍 */
      failed.push({ item: 'config.json 里的 dataRoot', reason: msgOf(e) })
    }
  }

  return { moved, failed }
}

/** 把异常压成一行能读的话（给最终用户看的，不暴露堆栈） */
function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 把 src 的内容复制到 dest。
 *
 * ## 为什么必须用 fs.promises.cp 而不是 cpSync（四厂商审计确认的 HIGH）
 *
 * 要搬的目录是 `instances\`（每个实例的 data\ 里可能整库几十万文件）、
 * `runtimes\`（AstrBot 实测 49133 个文件）。cpSync 是**同步**的 ——
 * 主进程只有一个事件循环，复制一开始，所有 IPC 就都排队：
 * 窗口「无响应」、进度点不动。项目里更早就见识过同类问题
 * （runtime 删除用 removeDirAsync 就是为了这个，见 util/workdir.ts 的注释）。
 *
 * fs.promises.cp 走 libuv 线程池，复制期间事件循环照样转 ——
 * 界面保持响应（"期间所有 IPC 排队"从根上消失）。
 *
 * 语义与 cpSync 相同（recursive + force 覆盖）：旧目录留着，
 * 重复迁移安全 —— 这是迁移本来的约定（旧目录留着，用户确认后再删）。
 */
async function copyInto(src: string, dest: string): Promise<void> {
  try {
    mkdirSync(dest, { recursive: true })
    await fsp.cp(src, dest, { recursive: true, force: true })
  } catch (e) {
    // 把路径带出来，否则用户只看到一句没头没尾的 EPERM
    const code = (e as { code?: string }).code
    if (code === 'ERR_FS_CP_EINVAL') {
      throw new Error(`无法复制 ${src}：源和目标指向同一个地方`)
    }
    throw new Error(`复制失败（${code ?? '未知'}）：${src} → ${dest}`)
  }
}
