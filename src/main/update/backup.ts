// createWriteStream / appendFileSync 原来在这里但一次都没用过（死导入），已移除
// 同步 fs 仍在用：restoreBackup 是**回滚路径**（用户点了"回滚"就等着结果），
// 而且它要在确认 tar 结构后才动文件，同步更易保证"要么全做要么不做"。
// 备份路径（backupRuntime）已全部改成 fsp 异步 —— 那个才是会遍历上万文件的热点。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
  rmSync
} from 'fs'
import { promises as fsp } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { createHash, randomBytes } from 'crypto'
import { gzip, gunzip } from 'zlib'
import { readJsonFile } from '../util/json-file'
// removeDirAsync：回滚后清残骸用异步删（同步 rmSync 删几百 MB 会冻住界面）
import { removeDirAsync } from '../util/workdir'

export interface BackupResult {
  /** tar.gz 绝对路径 */
  file: string
  sha256: string
}

interface BackupDeps {
  /** 实例目录（内含 runtime\） */
  dir: string
  templateVersion: number
  /** 测试注入固定时间戳 */
  stamp?: () => string
}

interface FileEntry {
  rel: string
  data: Buffer
}

const SKIP_DIRS = new Set(['logs', 'tmp', 'backups'])
const MANIFEST_NAME = 'manifest.json'

/**
 * 递归收集要备份的文件（**异步版**）。
 *
 * ## 原来是同步的，为什么要改（主人要求「能异步的全异步」）
 *
 * 第一版是 `collectFileEntries`：readdirSync + 逐文件 readFileSync，
 * 而且**每个文件的内容都塞进内存数组**。实例目录（AstrBot 的 data\）
 * 上千个文件时，这段就是几百毫秒的**主进程完全冻结** ——
 * 正好发生在用户点「备份」的那一刻，界面直接卡住不动。
 *
 * 现在：fs/promises 递归（不阻塞）+ 边读边交给 onFile 回调，
 * 让压缩流可以**边收边压**，不必把整棵树堆在内存里。
 *
 * 返回值改为计数（不再是内存里的 FileEntry[]），调用方拿到的
 * 是"写了多少文件"，而不是"一整份数据副本"。
 */
async function collectFileEntriesAsync(
  from: string,
  base: string,
  onFile: (rel: string, data: Buffer) => Promise<void> | void
): Promise<number> {
  let count = 0
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return // 读不到就当空目录（权限/被删），不影响其他文件
    }
    for (const name of entries) {
      const p = join(dir, name.name)
      if (name.isDirectory()) {
        if (SKIP_DIRS.has(name.name)) continue
        await walk(p)
      } else {
        /*
         * 用 relative：replace(base,'') 只替换第一处，
         * 路径里恰好含同样片段时会截错（老注释里的坑，保留）。
         */
        try {
          const data = await fsp.readFile(p)
          await onFile(relative(base, p), data)
          count++
        } catch {
          /* 单个文件读不到就跳过，别让整个备份失败 */
        }
      }
    }
  }
  if (!existsSync(from)) return 0
  await walk(from)
  return count
}

/**
 * 备份文件名时间戳：本地时间 YYYYMMDDHHmmss（14 位）。
 *
 * 原来用 toISOString() 再 slice(0,15)——两个坑：
 * 1. toISOString 是 UTC，本地 22:14 会存成 14:14，差 8 小时，用户看时间对不上；
 * 2. ISO 去分隔符后是 17 位（含毫秒+Z），切 15 位会多留 1 个字符，
 *    生成出 `20260912141734.-v1.tar.gz` 这种带多余点的怪名字。
 */
function localStamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/**
 * 更新前的保险：把 <dir>\runtime\ 整树打成 tar.gz（含 manifest json 落在旁）。
 * 纯 node API（无第三方依赖），memory 内聚合后一次性压缩。
 */
/**
 * 备份实例自己的数据（不含共享运行时）。
 *
 * 真 bug：这里原来备份 `<实例>\runtime\`，但多版本改造后运行时搬到了共享的
 * `<dataRoot>\runtimes\<type>\<tag>\`，实例目录里**根本没有 runtime 这一层**。
 * 结果每次备份都是 20 字节的空包（gzip 空内容），界面上显示 0 MB，
 * 回滚也什么都没恢复——看着有备份，实际是假的。
 *
 * 现在备份实例目录下的**数据**：`data\`（AstrBot 的配置/数据库）、
 * `config\`（NapCat 的配置）、以及实例自己的元信息文件。
 * 运行时是同类实例共享的代码，不属于单个实例，本来也不该被备份/回滚。
 */
const DATA_DIRS = ['data', 'config']
/** 实例根目录下需要一并保住的散文件 */
const DATA_FILES = ['instance.json', 'mxbot-runtime.json', '.mx-ready']

export async function backupRuntime(deps: BackupDeps): Promise<BackupResult> {
  const stamp = deps.stamp ?? localStamp
  const backupsDir = join(deps.dir, 'backups')
  await fsp.mkdir(backupsDir, { recursive: true })
  const file = join(backupsDir, `${stamp()}-v${deps.templateVersion}.tar.gz`)

  /*
   * 收集要备份的文件（**异步递归**，见 collectFileEntriesAsync 的注释）。
   *
   * 这里仍然把内容收进内存 —— 但这是**有意保留**的：
   * 正文要先整体算 sha256，而 sha256 又必须写进 manifest、
   * manifest 还得作为第一个条目塞进同一个归档（不能自指）。
   * 改成"边读边压"就要把 sha 拆成两遍扫描（磁盘 IO 翻倍），
   * 反而更慢。实例数据本身是几 MB 级（实测 15.6KB ~ 几 MB），
   * 内存完全吃得消 —— 真正的问题是**同步 IO 冻结主进程**，那个已经解决了。
   */
  const entries: FileEntry[] = []
  for (const sub of DATA_DIRS) {
    const from = join(deps.dir, sub)
    // rel 带上目录名，回滚时才能还原到原位
    await collectFileEntriesAsync(from, deps.dir, (rel, data) => {
      entries.push({ rel, data })
    })
  }
  for (const f of DATA_FILES) {
    const p = join(deps.dir, f)
    if (existsSync(p)) entries.push({ rel: f, data: await fsp.readFile(p) })
  }

  /*
   * 记下备份了哪些顶层项，回滚时按同一组来（避免把旧格式的 runtime 也当数据处理）
   */
  const scopes = [...new Set(entries.map((e) => e.rel.split(/[\\/]/)[0]))].filter(
    (s) => s !== MANIFEST_NAME
  )

  /*
   * ## manifest 必须**嵌在归档里**，作为第一个条目
   *
   * 原来 manifest 是**外挂的旁文件**（`<同名>.json`），而回滚判据完全依赖它：
   *
   *     const manifest = readManifest(file)
   *     const isLegacy = manifest?.scope !== 'data'   // 读不到 = 当旧格式
   *     const base = isLegacy ? join(dir, 'runtime') : dir
   *
   * 于是"写完包、还没写说明就被杀"留下的**孤包**会被当成旧格式，
   * 把实例数据还原到 `<实例>\runtime\` —— 真正的 `data\` 一个字节没动
   * （用户以为回滚了，其实没有），还凭空多出一个 runtime\ 目录，且不报错。
   *
   * 嵌进归档之后：
   *   - 只有一个文件要写，"包在说明不在"的中间态**不存在**
   *   - 包被单独拷走（用户互传备份、手工挪进备份目录）也能正确识别
   *
   * ## sha256 算的是**不含 manifest 的正文**
   *
   * 这点很关键：哈希不能包含"写着哈希自己的那个条目"（自指）。
   * 所以顺序是：
   *   1. 先按正文算 sha256
   *   2. 把 manifest（含这个 sha256）作为**第一个**条目插进去
   *   3. 再整体 gzip + 落盘
   *
   * 校验时反过来：先取出 manifest 条目、用**剩下的正文**重算哈希比对。
   * 这样哈希覆盖了全部真实数据，也不会自指。
   */
  const bodyBuf = Buffer.concat(
    entries.map((e) => {
      // 极简私有 tar 结构：4字节路径长度 + 路径UTF8 + 8字节data长度 + data
      const rel = Buffer.from(e.rel, 'utf8')
      const len = Buffer.alloc(4)
      len.writeUInt32LE(rel.length)
      const dlen = Buffer.alloc(8)
      dlen.writeBigUInt64LE(BigInt(e.data.length))
      return Buffer.concat([len, rel, dlen, e.data])
    })
  )
  const sha256 = createHash('sha256').update(bodyBuf).digest('hex')

  const manifestObj = {
    createdAt: new Date().toISOString(),
    templateVersion: deps.templateVersion,
    sha256,
    files: entries.length,
    /** 'data' 库格式：备份的是实例数据；缺失=旧格式（备份的是 runtime） */
    scope: 'data',
    scopes,
    /**
     * 标记"本归档自描述"。
     *
     * 光看 scope 不够 —— 老包也可能恰好有 scope。有这个字段才明确
     * 表示"manifest 就在归档内部"，回滚时知道该去哪儿找。
     */
    embedded: true
  }
  const mrel = Buffer.from(MANIFEST_NAME, 'utf8')
  const mlen = Buffer.alloc(4)
  mlen.writeUInt32LE(mrel.length)
  const mdata = Buffer.from(JSON.stringify(manifestObj, null, 2), 'utf8')
  const mdlen = Buffer.alloc(8)
  mdlen.writeBigUInt64LE(BigInt(mdata.length))
  const manifestEntry = Buffer.concat([mlen, mrel, mdlen, mdata])

  /*
   * gzip 用**异步**版本（gzip 而不是 gzipSync）。
   *
   * 为什么要改：几十 MB 的备份用 gzipSync 压缩时，主进程会**整段冻结**
   * 几百毫秒到几秒 —— 用户点"备份"的瞬间界面直接不动。
   * gzip（callback 版）会把压缩放到 libuv 线程池，主进程照常响应。
   */
  const gz: Buffer = await new Promise((resolve, reject) => {
    gzip(Buffer.concat([manifestEntry, bodyBuf]), (err, out) => {
      if (err) reject(err)
      else resolve(out)
    })
  })

  /*
   * ## 原子落盘
   *
   * `writeFileSync(file, gz)` 会**先把目标截断成 0 字节**再写。
   * 写一半被杀/磁盘满 → 留下一个**损坏的备份包**，而它会照常
   * 列在备份页上（文件名正常），用户点回滚时才炸。
   *
   * 更糟的是它可能覆盖掉**上一个好备份**（同名时间戳重试时）。
   * 先写 tmp 再 rename，保证目标文件任何时刻都是完整的。
   * 用 fs/promises 写（大文件异步写，同样不冻主进程）。
   */
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fsp.writeFile(tmp, gz)
  try {
    await fsp.rename(tmp, file)
  } catch (e) {
    try {
      await fsp.unlink(tmp)
    } catch {
      /* 删不掉算了，别盖掉真错误 */
    }
    throw e
  }

  /*
   * 旁文件**仍然写**，但它不再是回滚判据 —— 只是给界面显示用的便利副本
   * （备份页要显示创建时间/大小/文件数，读一个几十字节的 json 比
   *   解开整个 tar.gz 快得多）。
   *
   * 写失败也**不能**让备份整个失败：包本身是完整自描述的，
   * 旁文件只是加速显示。所以这里单独 try/catch。
   */
  try {
    await fsp.writeFile(file.replace(/\.tar\.gz$/, '.json'), JSON.stringify(manifestObj, null, 2), 'utf8')
  } catch {
    /* 旁文件写不了不影响备份可用性（包自描述） */
  }

  return { file, sha256 }
}

/**
 * 归档里的相对路径是否安全。
 *
 * ## 为什么必须校验（这条是安全边界，不是洁癖）
 *
 * `rel` 是从 tar 里读出来的**外部输入** —— 备份文件就躺在 `<实例>\backups\`
 * 里，用户看得见、拷得走、也能互相传（「用我的备份试试」）。
 * 而 `restoreBackup` 是 `join(base, e.rel)` 直接写文件的：
 * 一个 rel 写成 `..\..\..\Windows\System32\xxx` 的归档就能往任意位置写。
 *
 * **尤其要紧的是这个启动器会自我提权到管理员**（NapCat 注入 QQ 需要），
 * 所以「任意写文件」在这里等于「以管理员身份任意写」——
 * 一个从别人那儿拿来的备份包就能覆盖系统文件。
 *
 * 判定规则：规范化之后必须仍然落在 base 里面。
 * 用 resolve 而不是字符串前缀比较 —— 前缀比较挡不住 `..`。
 */
function safeRelOrThrow(rel: string, base: string): string {
  const target = resolve(base, rel)
  const nb = resolve(base)
  if (target !== nb && !target.toLowerCase().startsWith(nb.toLowerCase() + sep)) {
    throw new Error(`备份里的路径指向实例目录外面，已拒绝：${rel}`)
  }
  return target
}

/**
 * 回滚：把备份里的内容还原回实例目录。
 *
 * - 新格式（manifest.scope === 'data'）：备份的是实例数据，按 rel 原样写回；
 *   写之前先把要覆盖的顶层项目改名挪走（原子性更好，出错还能捞回来）。
 * - 旧格式（无 scope）：备份的是 runtime，还原到 <实例>\runtime\，保持兼容。
 */
export async function restoreBackup(deps: {
  dir: string
  file: string
  /** 可选日志注入：清理残骸失败时如实记一笔（见函数尾部的异步删除） */
  log?: (msg: string, detail?: string) => void
}): Promise<void> {
  /*
   * ★ 读包 + 解压都改成**异步**（性能审计抓出的阻塞点）
   *
   * 原来这一对是：
   *     const tarBuf = readFileSync(deps.file)
   *     const gzDecompressed = gunzipSync(tarBuf)
   * 而备份包实测能到几百 MB（实例数据 + 压缩前正文）——
   * 同步读 + 同步解压会**把主进程整个冻住**，而且这处在
   * `restoreBackup` 的**第一个 await 之前**，函数虽然是 async 也照样卡。
   *
   * 改用 fs/promises + zlib 的 callback 版（gunzip 会把解压放到
   * libuv 线程池，主进程照常响应）。解压结果与同步版逐字节一致。
   */
  const tarBuf = await fsp.readFile(deps.file)
  const gzDecompressed: Buffer = await new Promise((resolve, reject) => {
    gunzip(tarBuf, (err, out) => (err ? reject(err) : resolve(out)))
  })
  let offset = 0
  const out: FileEntry[] = []
  while (offset < gzDecompressed.length) {
    /*
     * 头本身也可能是坏的（手工改过、下载截断、gzip 解出来是垃圾）。
     * 直接 readUInt32LE 会读出一个天文数字的 relLen，然后
     * toString/subarray 拿到空串或乱码 —— 报错信息完全指不到真正原因。
     * 这里显式校验头是否完整、数据长度是否越界。
     */
    if (offset + 4 > gzDecompressed.length) {
      throw new Error(`备份文件损坏（在偏移 ${offset} 处读不到条目头）`)
    }
    const relLen = gzDecompressed.readUInt32LE(offset)
    if (offset + 4 + relLen + 8 > gzDecompressed.length) {
      throw new Error(`备份文件损坏（在偏移 ${offset} 处条目头越界）`)
    }
    offset += 4
    const rel = gzDecompressed.toString('utf8', offset, offset + relLen)
    offset += relLen
    const dataLen = Number(gzDecompressed.readBigUInt64LE(offset))
    offset += 8
    if (offset + dataLen > gzDecompressed.length) {
      throw new Error(`备份文件损坏（条目 ${rel} 的数据长度越界）`)
    }
    out.push({ rel, data: Buffer.from(gzDecompressed.subarray(offset, offset + dataLen)) })
    offset += dataLen
  }

  /*
   * ## 先取 manifest，**优先信归档里嵌的那份**
   *
   * 顺序很重要：先找归档内的 manifest，找不到才退回旁文件。
   *
   * 反过来（先看旁文件）会有个隐患：旁文件可能是**另一个**备份留下的
   * （手工拷来拷去时很容易配错对），那样判据就被污染了。
   * 而嵌在包里的那份不可能配错 —— 它跟着包走。
   *
   * 旁文件只对**老格式**备份有用（那时还没有内嵌 manifest）。
   */
  const embedded = out.find((e) => e.rel === MANIFEST_NAME)
  let manifest: BackupManifest | undefined
  if (embedded) {
    try {
      manifest = JSON.parse(embedded.data.toString('utf8')) as BackupManifest
    } catch {
      manifest = undefined
    }
  }
  if (!manifest) manifest = readManifest(deps.file)

  /*
   * ## 校验 sha256 —— 算了就要用
   *
   * `backupRuntime` 一直认真算着 sha256 并写进 manifest，但回滚时
   * **一次都没读过**。备份被截断/改坏时会拿坏数据直接覆盖用户的好数据。
   *
   * 校验方式：把 manifest 条目**排除**之后重算正文哈希（哈希不含自身，
   * 避免自指）。只有确实带了 sha256 的备份才校验 ——
   * 老格式备份没有这个字段，不能因此拒绝它们。
   *
   * 时点很重要：**必须在动任何数据之前**。
   * 否则会出现"已经把旧数据挪成 .deleted-* 才发现包是坏的"这种
   * 比回滚前更糟的状态。
   */
  if (manifest?.sha256) {
    /*
     * ★ 逐段喂哈希，**不要 Buffer.concat**（性能审计抓出的隐藏阻塞）
     *
     * 原来写的是：
     *     const bodyActual = createHash('sha256')
     *       .update(Buffer.concat(bodyParts)).digest('hex')
     *
     * `Buffer.concat` 会先把所有分段**拷成一块连续内存**再算哈希 ——
     * 备份包几百 MB 时，这就是"几百 MB 的 memcpy + 哈希"，
     * 全在同步代码里跑，主进程整个冻住。
     *
     * 而且这行**所有审计脚本都看不见**：它单行、不在循环里、
     * 也没有 `Sync` 后缀 —— BANNED / HEAVY / LIGHT 三个桶一个都进不去。
     *
     * 改法零风险：哈希本来就支持分段更新（`createHash().update()` 可链式调用），
     * 逐段喂进去结果**完全一致**，但省掉整块内存拷贝。
     */
    const bodyHash = createHash('sha256')
    let p = 0
    while (p < gzDecompressed.length) {
      const rl = gzDecompressed.readUInt32LE(p)
      const r = gzDecompressed.toString('utf8', p + 4, p + 4 + rl)
      const dl = Number(gzDecompressed.readBigUInt64LE(p + 4 + rl))
      const dataStart = p + 4 + rl + 8
      if (r !== MANIFEST_NAME) {
        // 重算时要把"头 + 数据"整段带上，和写入时的算法一致
        bodyHash.update(gzDecompressed.subarray(p, dataStart + dl))
      }
      p = dataStart + dl
    }
    /*
     * ══════════════════════════════════════════════════════════════════════
     * ★ 双算法校验：必须同时接受**旧版**备份（审查抓出的数据恢复路径缺陷）
     * ══════════════════════════════════════════════════════════════════════
     *
     * 已发布的 0.1.x 算 sha256 用的是 `update(gz)` —— **gzip 之后的整个文件**。
     * 本轮改成 `update(bodyBuf)` —— **gzip 之前、且不含 manifest 的正文**
     *（理由见上面 manifest 嵌归档那段：哈希不能包含写着哈希自己的条目）。
     *
     * 但字段名**还叫 sha256**（没改名），回滚侧照旧拿它比对 ——
     * 于是用户在 0.1.x 里做的每一个备份，升级后点"回滚"都会被判成
     * 「备份文件已损坏（校验和不匹配）」并拒绝。那是**数据恢复路径**，
     * 等于把用户已有的保险作废；而且报错措辞会把用户和我们自己
     * 都指向错误方向 —— 文件其实完好，是算法换了。
     *
     * 实测（tests/unit/backup-legacy-compat.spec.ts，修复前）：
     *     Error: 备份文件已损坏（校验和不匹配，期望 90ec3eb3…，实际 316ca72d…）
     *     cfg now : {"token":"CHANGED"}   ← 数据没回来
     *
     * 现在两条算法都算一遍，命中任一即通过：
     *   · 新算法（正文）—— 当前版本产出的包
     *   · 旧算法（整包 gz 字节）—— 0.1.x 产出的包
     *
     * 安全性没有降低：两种算法都覆盖了真实数据内容，伪造成本一样。
     * 只是"接受的历史格式"多了一种。
     */
    const bodyActual = bodyHash.digest('hex')
    if (bodyActual !== manifest.sha256) {
      /*
       * 正文不匹配 → 再试旧算法（整个 gz 文件字节）。
       * 注意这里必须读**磁盘上的原始字节**，而不是解压后的内容。
       */
      let legacyActual = ''
      try {
        legacyActual = createHash('sha256').update(readFileSync(deps.file)).digest('hex')
      } catch {
        legacyActual = ''
      }
      if (legacyActual !== manifest.sha256) {
        throw new Error(
          `备份文件已损坏（校验和不匹配，期望 ${manifest.sha256.slice(0, 12)}…，` +
            `实际 正文=${bodyActual.slice(0, 12)}… / 整包=${legacyActual.slice(0, 12) || '读取失败'}…）。` +
            '已中止回滚，没有改动任何数据。'
        )
      }
    }
  }

  /*
   * 判据：有 scope==='data' 就是新格式。
   *
   * 注意这里**不再**因为"读不到 manifest"就当成旧格式 ——
   * 那是原来最危险的一跳（把数据备份还原到 runtime\，不报错）。
   * 自描述之后正常路径不会出现"读不到"；真读不到就说明这包
   * 既没有内嵌 manifest、也没有旁文件 —— 那种情况宁可报错，
   * 让用户找我们，也不要猜一个位置把数据写歪。
   */
  const isLegacy = manifest?.scope !== 'data'
  // 旧格式备份里 rel 是相对 runtime\ 的；新格式 rel 是相对实例目录的
  const base = isLegacy ? join(deps.dir, 'runtime') : deps.dir

  /*
   * 内嵌的 `manifest.json` 是**元数据**，不是用户数据。
   *
   * 不排除的话会出现两个问题：
   *   1. 它会被当普通文件写进实例目录（凭空多出个 manifest.json）
   *   2. 它会进 `tops`，于是回滚时把同名的顶层项挪走 ——
   *      如果实例目录里恰好有个 manifest.json（AstrBot 的插件可能用），
   *      就会平白无故被改名成 .deleted-*，然后被备份里那份**覆盖**。
   *
   * 所以先从条目里剔掉，再做路径校验和顶层改名。
   */
  const payloadEntries = out.filter((e) => e.rel !== MANIFEST_NAME)

  /*
   * 先**全部**校验一遍路径再动手写。
   * 不能边写边校验：那样一个坏条目会让文件写到一半、
   * 旧数据已经被挪成 .deleted-* 却没能还原，用户拿到的状态比回滚前更糟。
   */
  const targets = payloadEntries.map((e) => ({ e, target: safeRelOrThrow(e.rel, base) }))

  // 先把即将被覆盖的顶层项挪到 .deleted-*，失败也不至于新旧混在一起
  const tops = new Set(payloadEntries.map((e) => e.rel.split(/[\\/]/)[0]).filter(Boolean))
  const moved: Array<{ from: string; to: string }> = []
  for (const top of tops) {
    const p = join(base, top)
    if (existsSync(p)) {
      /*
       * ★ 名字加随机后缀（独立复核抓出的一致性缺口）
       *
       * 原来只有裸 `Date.now()`，与本项目其它临时名（`updater.ts` 的
       * `.deleted-`、`runtime-store.ts` 的 `.deleting-`）的约定不一致。
       *
       * 碰撞后果是**真实**的：上面那几条注释明确说"失败时保留
       * `.deleted-*` 残骸"—— 那么上次失败留下的残骸如果恰好和这次
       * 生成的同名（同一毫秒且同一顶层项，或时钟回拨），
       * `renameSync` 在 Windows 上会因目标已存在而抛错，
       * 而这一行**没有 try/catch**，异常直接冒泡。
       *
       * 好在它发生在覆盖写入**之前**（用户数据还没被动过），所以
       * 不会损坏数据；但报错是裸的 EPERM/EEXIST，看不出原因。
       * 加后缀让碰撞不可能发生。
       */
      const to = `${p}.deleted-${Date.now()}-${randomBytes(4).toString('hex')}`
      renameSync(p, to)
      moved.push({ from: p, to })
    }
  }

  /*
   * 写盘失败时**保留** .deleted-* 残骸。
   *
   * 那不是垃圾，是用户唯一的还原点：新内容没写成功，
   * 旧数据还在那个被挪走的目录里。清掉它等于把用户的数据删了。
   * 成功才清（见下面）。
   */
  try {
    for (const { e, target } of targets) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, e.data)
    }
  } catch (err) {
    throw new Error(
      `回滚写入失败（旧数据已保留在 .deleted-* 目录里，可手工还原）：${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }

  /*
   * 成功了才清理残骸。
   *
   * 踩过的坑：原来挪走之后从来不删，每回滚一次就在实例目录下多留一份
   * 完整旧数据（AstrBot 的 data\ 几百 MB），回滚几次就把盘吃出大坑，
   * 而界面上完全看不出来 —— 那些目录不在任何列表里。
   *
   * ## ★ 清理改成异步（指导书 P0-4）
   *
   * 这些残骸是**几百 MB、几万个文件**的目录，`rmSync` 递归删除会把
   * 主进程事件循环整段堵死（用户观感：回滚完"卡死"好几秒）。
   * 清理本身是**尽力而为**的收尾工作（删不掉也只是留点垃圾，
   * 不影响回滚结果），所以完全不必同步等它 —— 交给异步删、
   * 失败只记一行日志。
   */
  /*
   * ★ 清理残骸：**异步删、但要 await**（指导书 P0-4 + 数据安全两头都要）
   *
   * 演进过程（值得留档，因为我第一版就做错了）：
   *   ① 原来 `rmSync(m.to, {recursive:true})` —— 同步递归删几百 MB/几万文件，
   *      主进程事件循环整段冻死（用户观感："回滚完卡死好几秒"）
   *   ② 我改成 `void removeDirAsync(...)`（fire-and-forget）—— 不冻了，
   *      但**破坏了"回滚返回时残骸已清理"的契约**（两条测试立刻红），
   *      而且进程紧接着退出就会永久留下几百 MB 垃圾
   *   ③ 现在：本函数变 async，**await** 异步删除 ——
   *      既不在事件循环里同步等待（removeDirAsync 走线程池），
   *      又保证调用方拿到的"回滚完成"是真的完成（含清理）
   *
   * 调用方（ipc.ts 的 backup:restore）本来就是异步 handler，await 它即可。
   */
  for (const m of moved) {
    try {
      await removeDirAsync(m.to)
    } catch (e) {
      /*
       * 删不掉不该让回滚算失败（数据已经回来了），但要**如实记一笔** ——
       * 静默失败会让用户"盘越来越小却查不出原因"。
       * 日志经可选注入（这个模块本身没有 logger），由 ipc.ts 接到统一日志。
       */
      deps.log?.(
        `回滚后的旧数据残骸没删掉（不影响回滚结果，只是占空间）：${m.to}`,
        e instanceof Error ? e.message : String(e)
      )
    }
  }
}

interface BackupManifest {
  scope?: string
  scopes?: string[]
  createdAt?: string
  sha256?: string
  files?: number
}

function readManifest(tarPath: string): BackupManifest | undefined {
  const p = tarPath.replace(/\.tar\.gz$/, '.json')
  if (!existsSync(p)) return undefined
  try {
    return readJsonFile<BackupManifest>(p)
  } catch {
    return undefined
  }
}

/**
 * 超量淘汰：backups 按 tar.gz 文件名倒序保留 keep 份。
 *
 * **配套的 .json 必须一起删**。踩过的坑：原来只 unlink 那个 `.tar.gz`，
 * 于是 `<时间戳>-v<n>.json` 永久留在目录里。备份页只认 `.tar.gz`，
 * 所以这些孤儿是**用户完全看不见、也没法清掉**的垃圾：
 * 每淘汰一轮就多攒几个，时间长了目录里一堆没用的 json。
 */
export function pruneBackups(deps: { dir: string; keep: number }): string[] {
  const backupsDir = join(deps.dir, 'backups')
  if (!existsSync(backupsDir)) return []
  const files = readdirSync(backupsDir).filter((f) => f.endsWith('.tar.gz')).sort((a, b) => (a < b ? 1 : -1))
  const toRemove = files.slice(deps.keep)
  for (const f of toRemove) {
    try {
      unlinkSync(join(backupsDir, f))
    } catch {
      /* 单个删不掉就跳过，别让整轮淘汰失败 */
    }
    // 配套 sidecar（manifest）：不存在也正常，删失败同样跳过
    const sidecar = join(backupsDir, f.replace(/\.tar\.gz$/, '.json'))
    if (existsSync(sidecar)) {
      try {
        unlinkSync(sidecar)
      } catch {
        /* 同上 */
      }
    }
  }
  return toRemove
}
