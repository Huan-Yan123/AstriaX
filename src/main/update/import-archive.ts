import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { copyFile, readFile as readFileAsync } from 'fs/promises'
import { basename, join } from 'path'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { inflateRawSync } from 'zlib'
import { expandArchive } from '../util/async-exec'
import { makeStage, removeDirAsync } from '../util/workdir'
import type { RuntimeType } from './runtime-store'

/**
 * 手动导入运行时压缩包。
 *
 * 场景：镜像源全都慢、或者用户手上已经有一个从别处下好的包，
 * 让他直接把 zip 拖进来用，不必再走网络。
 *
 * 这个模块的核心不是「解压」，而是**校验它到底是不是我们要的东西**。
 * 用户可能拖进来任何一个 zip，如果只校验「能解开」，
 * 最后会装出一个跑不起来的运行时，而且报错会跑偏到几百行之外
 * （比如「找不到 NapCatWinBootMain.exe」），非常难查。
 * 所以在**解压之前**先看压缩包里的文件清单，认出来是什么、版本多少。
 *
 * 识别依据来自两个包的**真实结构**（实测解包确认过，不是猜的）：
 *
 * NapCat.Shell.zip（29MB）顶层 18 个条目，关键的有：
 *   NapCatWinBootMain.exe   注入器（缺它根本起不来）
 *   NapCatWinBootHook.dll   注入钩子
 *   napcat.mjs              NapCat 主体
 *   qqnt.json               补丁包描述
 *   package.json            里面有 version 字段
 *
 * AstrBot 的 PyPI wheel（astrbot-<ver>-py3-none-any.whl，7.4MB）：
 *   astrbot/__init__.py     包根
 *   astrbot/cli/__main__.py CLI 入口
 *   astrbot-<ver>.dist-info/METADATA   里面有 Version: 字段
 *
 * 注意 AstrBot 的 dashboard.zip（5.75MB）**只有 dist/ 前端，没有后端**，
 * 是个装上去跑不起来的坏包 —— 必须明确识别出来并拒绝，别让它混过去。
 */

export interface ImportProbe {
  /** 认出来的类型；null = 这不是我们要的包 */
  kind: RuntimeType | null
  /** 从包里读出的版本号（没有就留空） */
  version: string
  /** 给人看的说明：为什么接受 / 为什么拒绝 */
  reason: string
  /** 压缩包里的顶层条目（诊断用） */
  entries: string[]
  sizeBytes: number
  sha256: string
}

/** 流式算 sha256：包可能有几百 MB，一次性读进内存不划算 */
export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * 列出 zip 里的条目（纯 Node 解析中央目录，**不启动 PowerShell**）。
 *
 * 为什么不用 PowerShell 的 ZipFile.OpenRead：
 *   每次调用要起一个 PowerShell 进程并 Add-Type 加载程序集，
 *   实测光「列个文件名」就要 8 秒多 —— 用户选了包之后要干等，
 *   而我们只是想看一眼清单。zip 的中央目录格式很简单，
 *   自己解析只要几毫秒，还省掉一次进程启动。
 *
 * zip 结构（只读我们需要的那部分）：
 *   文件尾部有 EOCD（End Of Central Directory，签名 0x06054b50），
 *   里面记着中央目录的偏移和条目数；
 *   中央目录每条（签名 0x02014b50）含文件名长度、压缩前后大小等，
 *   文件名紧跟在这条记录之后。
 * 注释里可能有假的 EOCD 签名，所以**从后往前**找第一个合法的。
 */
export function listZipEntriesSync(zip: string, archiveBuffer?: Buffer): string[] {
  const buf = archiveBuffer ?? readFileSync(zip)

  // 从尾部往前找 EOCD
  const EOCD_SIG = 0x06054b50
  let eocd = -1
  const minEocd = 22 // EOCD 最小长度
  for (let i = buf.length - minEocd; i >= 0 && i >= buf.length - minEocd - 65535; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('这不是一个有效的 zip 文件（找不到目录结构）')

  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)

  const out: string[] = []
  const CD_SIG = 0x02014b50
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CD_SIG) break
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    // zip 里的路径分隔符统一是 /，转成 \ 方便和 Windows 侧逻辑一致
    out.push(name.replace(/\//g, '\\'))
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * 读 zip 里**某一个文件的内容**（只支持 stored / deflate 两种压缩方式）。
 *
 * 为什么需要它：判断包是什么、版本多少，光看**文件名清单**是不够的 ——
 * NapCat 的版本号写在 `package.json` 的 `version` 字段里，文件名叫
 * `package.json`，正则路径名一个数字都匹配不到（这个 bug 见 classifyArchive）。
 *
 * 实现上仍然走中央目录（跟 listZipEntriesSync 同一套解析），
 * 但要多读一个「本地文件头」才能定位到真实数据偏移：
 * 中央目录里的 relativeOffset 指向本地头，本地头的 filename/extra
 * 两个长度字段**可能和中央目录里的不一样**（zip 规范允许），
 * 所以必须按本地头重新算数据起点，不能直接拿中央目录的长度相加。
 *
 * 找不到、压缩方式不认识、或解压失败都返回 undefined ——
 * 调用方的语义是「读到了就用，读不到就退回别的办法」，不该因为
 * 一个附带的元信息读取失败就把整个导入流程打断。
 */
export function readZipEntrySync(zip: string, wantName: string, archiveBuffer?: Buffer): string | undefined {
  let buf: Buffer
  try {
    buf = archiveBuffer ?? readFileSync(zip)
  } catch {
    return undefined
  }

  const EOCD_SIG = 0x06054b50
  let eocd = -1
  const minEocd = 22
  for (let i = buf.length - minEocd; i >= 0 && i >= buf.length - minEocd - 65535; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return undefined

  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const want = wantName.replace(/\\/g, '/').toLowerCase()

  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return undefined
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')

    if (name.replace(/\\/g, '/').toLowerCase() === want) {
      // 按**本地头**重新算数据起点（本地头的 extra 长度常与中央目录不同）
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) return undefined
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      /*
       * compSize 为 0 且没设 data descriptor 的流式 zip 拿不到边界；
       * 这种情况直接放弃（读元信息而已，不值得为它写一套流式解析）。
       */
      // 这里只读取 package.json / NapCat 元信息。拒绝异常大的元数据项，
      // 避免恶意 ZIP 通过超大压缩项造成主进程内存/CPU耗尽。
      const MAX_METADATA_BYTES = 16 * 1024 * 1024
      const uncompressedSize = buf.readUInt32LE(off + 24)
      if (!compSize || compSize > MAX_METADATA_BYTES || uncompressedSize > MAX_METADATA_BYTES || dataStart + compSize > buf.length) return undefined
      const raw = buf.subarray(dataStart, dataStart + compSize)
      try {
        if (method === 0) return raw.toString('utf8')
        if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_METADATA_BYTES }).toString('utf8')
      } catch {
        return undefined
      }
      return undefined
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return undefined
}

/** 从条目清单里判断这是什么包、版本多少 */
export function classifyArchive(
  entries: string[],
  /**
   * 可选：按需读取条目内容（键是条目名，值取不到返回 undefined）。
   * 不传就退化成「只看文件名」——老行为，NapCat 版本会读不出来。
   */
  readEntry?: (name: string) => string | undefined
): { kind: RuntimeType | null; version: string; reason: string } {
  const lower = entries.map((e) => e.toLowerCase().replace(/\\/g, '/'))
  const has = (name: string): boolean => lower.some((e) => e.endsWith(name) || e.includes(`/${name}`))

  // ---- NapCat Shell 包 ----
  const isNapcat =
    has('napcatwinbootmain.exe') || has('napcatwinboothook.dll') || has('napcat.mjs')
  if (isNapcat) {
    // 必需件缺一不可，缺了就是残包
    const need = [
      ['NapCatWinBootMain.exe', has('napcatwinbootmain.exe')],
      ['NapCatWinBootHook.dll', has('napcatwinboothook.dll')],
      ['napcat.mjs', has('napcat.mjs')]
    ] as const
    const missing = need.filter(([, ok]) => !ok).map(([n]) => n)
    if (missing.length) {
      return {
        kind: null,
        version: '',
        reason: `这是 NapCat 包但缺少必需文件：${missing.join('、')} —— 包不完整，装了也起不来`
      }
    }
    /*
     * 版本号从哪儿来（顺序不能反，每一条都是实测出来的）：
     *
     * ① **`napcat.mjs` 里的构建注入版本** —— 最可信。
     *    实测 v4.18.19 的包里有这么一行（minify 后的版本常量）：
     *        const Oj = {}, Vu = typeof Oj < "u" && "4.18.19" || "1.0.0-dev"
     *    `typeof X < "u"` 是压缩器判断 undefined 的写法，
     *    真版本是构建时塞进去的字面量。
     *
     * ② **路径名里的版本** —— 第三方重打包常见形态
     *    （`NapCat-v4.18.19/package.json`）。
     *
     * ③ **`package.json` 的 version** —— 只能当最后的补充，而且**要排除占位符**。
     *    这是个陷阱：官方包的 package.json 写的是：
     *        { "name": "napcat", "private": true, "type": "module", "version": "0.0.1" }
     *    `private: true` + `0.0.1` —— 那是**源码仓库的占位符**，
     *    真版本 4.18.19 根本不在里面（实测全包扫过，只有 napcat.mjs 有）。
     *
     *    为什么这条必须排在最后、还要过滤：这个函数原来只做了「正则
     *    package.json 的**路径名**」，`pkg` 是字符串 "package.json"，
     *    一个数字都匹配不到，于是版本恒为空 → ipc.ts 那边 tag 退化成
     *    `imported-<时间戳>`，用户导入 NapCat 会得到一个叫
     *    `imported-mf3k2a` 的版本，在列表里看不出是什么。
     *
     *    我第一版修法是「去读 package.json 的 version」，结果读出了
     *    `0.0.1` —— **这比读不出来更糟**：读不出来会老实地标成
     *    `imported-xxx`，而假版本 `v0.0.1` 看起来像真版本，
     *    会让「实例在用哪个版本」这类判断全错（ipc.ts 的注释里
     *    明确写了「绝不能编一个假版本号」）。所以占位符一律丢弃。
     *
     * NapCat 只能靠手动导入（版本清单里没有它的自动来源），
     * 所以这条路径是主路径 —— 这个 bug 影响的是每一次导入。
     */
    let version = ''

    // ① napcat.mjs 的构建注入版本
    const mainJs = entries.find((e) => /(^|[\\/])napcat\.mjs$/i.test(e))
    if (mainJs) {
      const raw = readEntry?.(mainJs)
      if (raw) {
        /*
         * 匹配 `... < "u" && "<版本>" || ...` 这个注入模式。
         * 只认这种「跟 undefined 比较后接字面量」的形状，
         * 不能满文件抓第一个 x.y.z —— napcat.mjs 里还有
         * 1.0.0、3.2.12、6.9.53、9.9.15 等一堆依赖版本号，
         * 随便抓一个就是错的。
         */
        const m = /<\s*["']u["']\s*&&\s*["'](\d+\.\d+\.\d+)["']/.exec(raw)
        if (m) version = m[1]
      }
    }

    // ② 路径名里带版本（第三方重打包）
    if (!version) {
      const pkg = entries.find((e) => /(^|\/)package\.json$/i.test(e))
      const m = /(\d+\.\d+\.\d+)/.exec(pkg ?? '')
      if (m) version = m[1]
    }

    // ③ package.json 的 version，排除占位符
    if (!version) {
      /*
       * 只认**顶层**的 package.json（以及"唯一一层目录里的那份"）。
       * 不能随便挑 —— 这个包的 node_modules 下有 70 多个 package.json，
       * 挑到 express 的就会把版本读成 4.21.2。
       */
      const topPkg = entries.find((e) => /^package\.json$/i.test(e))
      const nestedPkg = entries.find((e) => /^[^/\\]+[\\/]package\.json$/i.test(e))
      for (const cand of [topPkg, nestedPkg].filter(Boolean) as string[]) {
        const raw = readEntry?.(cand)
        if (!raw) continue
        const m = /"version"\s*:\s*"([^"]+)"/.exec(raw) ?? /"version"\s*:\s*'([^']+)'/.exec(raw)
        if (!m) continue
        const core = /(\d+\.\d+\.\d+)/.exec(m[1])
        if (!core) continue
        const v = core[1]
        /*
         * 丢掉占位符。0.0.0 / 0.0.1 / 0.1.0 这类是脚手架留下的，
         * 真正的发行包不会用它们做版本号。
         */
        if (/^0\.0\.\d+$/.test(v)) continue
        version = v
        break
      }
    }

    return { kind: 'n', version, reason: 'NapCat Shell 包（含注入器和主体，可直接使用）' }
  }

  // ---- AstrBot ----
  const isWheel = lower.some((e) => e.includes('astrbot/__init__.py') || e.includes('astrbot-') && e.includes('.dist-info/'))
  const isAstrBotSrc = lower.some((e) => e.includes('astrbot/core/')) || has('main.py')
  /*
   * dashboard.zip 的识别要放在「认成 AstrBot」**之前**，否则它会先被当成
   * AstrBot 包收下 —— 那个包里只有前端 dist/，装上去后端根本不存在。
   * 特征：有 dist/ 但没有 astrbot/ 包目录。
   */
  const looksDashboard = lower.some((e) => e.startsWith('dist/')) && !lower.some((e) => e.includes('astrbot/'))
  if (looksDashboard && !isWheel) {
    return {
      kind: null,
      version: '',
      reason:
        '这是 dashboard 前端包（只有 dist/ 网页文件，不含后端）—— 装上跑不起来。'
        + 'AstrBot 后端要从 PyPI 安装，或手动导入它的 wheel 包（astrbot-<版本>-py3-none-any.whl）'
    }
  }

  if (isWheel || isAstrBotSrc) {
    let version = ''
    /*
     * 版本号从 wheel 文件名里读：astrbot-4.28.0-py3-none-any.whl
     * 正则只吃到「-py3」或「.dist-info」之前为止 ——
     * 之前写成 `[^-]*` 会把 `.dist` 也吞进去（得到 "4.28.0.dist"），
     * 那个版本号拿去当目录名就脏了。这里用「数字点数字」精确匹配，
     * 允许后面跟 a1/b2 之类的预发布后缀。
     */
    const fromName = /astrbot-(\d+\.\d+\.\d+[0-9a-z]*)(?=[-.]|$)/i.exec(entries.join(' '))
    if (fromName) version = fromName[1]
    return {
      kind: 'a',
      version,
      reason: isWheel ? 'AstrBot 的 wheel 包（含完整后端，可直接使用）' : 'AstrBot 源码包（含后端）'
    }
  }

  return {
    kind: null,
    version: '',
    reason:
      '认不出这是什么包。需要的是 NapCat.Shell.zip（含 NapCatWinBootMain.exe）'
      + '或 AstrBot 的 wheel（astrbot-<版本>-py3-none-any.whl）'
  }
}

/** 探测一个压缩包：识别类型 + 算哈希，不改动任何东西 */
export async function probeArchive(file: string): Promise<ImportProbe> {
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`)
  const st = statSync(file)
  if (!st.isFile()) throw new Error(`不是文件：${file}`)
  const MAX_IMPORT_ARCHIVE_BYTES = 512 * 1024 * 1024
  if (st.size > MAX_IMPORT_ARCHIVE_BYTES) {
    throw new Error(`压缩包超过 512 MiB，无法安全导入（当前 ${(st.size / 1024 / 1024).toFixed(0)} MiB）`)
  }
  if (!/\.(zip|whl)$/i.test(file)) {
    throw new Error('只支持 .zip 和 .whl 压缩包（NapCat 是 zip，AstrBot 是 whl 或 zip）')
  }
  // 大文件由异步 API 读取一次，再复用同一 buffer 解析清单和元数据。
  // 旧的 Sync 导出保留供兼容调用，但用户触发的导入探测不再同步读盘数次。
  const archiveBuffer = await readFileAsync(file)
  const entries = listZipEntriesSync(file, archiveBuffer)
  /*
   * 把「读条目内容」的能力接上 —— 版本号写在 package.json 里，
   * 只看文件名清单是读不到的（见 classifyArchive 的注释）。
   * 每次读都重新解析一遍 zip 头：这些包最大也就几十 MB，
   * 而我们只读一两个小文件，比解压整个包便宜得多。
   */
  const cls = classifyArchive(entries, (name) => readZipEntrySync(file, name, archiveBuffer))
  const sha256 = await sha256OfFile(file)
  return {
    kind: cls.kind,
    version: cls.version,
    reason: cls.reason,
    entries: entries.slice(0, 60),
    sizeBytes: st.size,
    sha256
  }
}

/**
 * 这个目录看起来像一个**运行时根**吗（不看 mxbot-runtime.json）？
 *
 * 专门给"要不要把顶层目录提上来"这个判断用，所以
 * **不能**依赖 `detectLayout`（它要求 marker 存在，而此刻还没写）。
 * 这里只看内容形态：
 *
 *   AstrBot（PyPI 形态）→ 有 `astrbot` 子目录
 *   AstrBot（源码形态）→ 有 `main.py`
 *   NapCat（Shell 版）  → 有 `napcat.mjs`
 *
 * 用于区分：
 *   `astrbot/`                  是根（不要动它）
 *   `astrbot-4.28.0/astrbot/`   外层不是根、内层是 → 提上来
 *
 * 返回 false 时调用方才会考虑"往下钻一层"，所以宁可严格一点：
 * 拿不准就当它不是根，让原来的解包结构保留（最坏也只是多一层目录，
 * 用户能看出来；而**错误地拆掉包本体**会让它彻底不可用）。
 */
function looksLikeRuntimeRoot(dir: string, type: RuntimeType): boolean {
  try {
    if (type === 'a') {
      return existsSync(join(dir, 'astrbot')) || existsSync(join(dir, 'main.py'))
    }
    // NapCat：Shell 版看 napcat.mjs，旧的 Windows.Node 版看 index.js
    return (
      existsSync(join(dir, 'napcat.mjs')) ||
      existsSync(join(dir, 'NapCatWinBootMain.exe')) ||
      existsSync(join(dir, 'index.js'))
    )
  } catch {
    return false
  }
}

/**
 * 把压缩包解出来并装成指定的运行时版本。
 *
 * 关键：**先探测再解压**。认不出类型就直接拒绝，不浪费几百 MB 的磁盘和时间，
 * 也不会留下一个装了一半的坏目录。
 */
export async function importArchive(deps: {
  dataRoot: string
  file: string
  type: RuntimeType
  /** 目标版本目录（调用方决定，通常是探测出的版本或用户指定） */
  destDir: string
  /**
   * 已经探测过的结果（可选）。
   * 调用方往往为了拿版本号已经探过一次，传进来可以省掉一次全文件 sha256 ——
   * 29MB 的包算两遍是白等的。
   */
  probe?: ImportProbe
}): Promise<ImportProbe> {
  const probe = deps.probe ?? (await probeArchive(deps.file))
  if (probe.kind === null) {
    // 报错里带上具体原因，用户才知道自己拖错了什么
    throw new Error(probe.reason)
  }
  if (probe.kind !== deps.type) {
    throw new Error(
      `包类型对不上：这个包是 ${probe.kind === 'a' ? 'AstrBot' : 'NapCat'} 的，`
        + `但你要装的是 ${deps.type === 'a' ? 'AstrBot' : 'NapCat'}`
    )
  }

  const stage = makeStage(deps.dataRoot, 'import')
  try {
    /*
     * `.whl` 必须先复制成 `.zip` 再解压。
     *
     * 踩过的坑：wheel 本质就是 zip，但 PowerShell 的 Expand-Archive
     * **按扩展名白名单校验**，只认 .zip。直接把 .whl 交给它会报
     *   「.whl 不是支持的存档文件格式。只有 .zip 才是支持的存档文件格式。」
     * 于是「手动导入 AstrBot wheel」这条**唯一的** AstrBot 人工兜底路径
     * （AstrBot 在版本清单里只有 pypi 一种来源）100% 失败。
     *
     * 而单测只造 .zip，从没测过 .whl —— 所以整套测试一直是绿的。
     *
     * 复制而不是改名：用户选的那个文件可能还要留着，不能动它。
     * 复制到 stage 里，stage 本来就归我们管、收尾会一起删掉。
     */
    let toExpand = deps.file
    if (/\.whl$/i.test(deps.file)) {
      toExpand = join(stage, 'payload.zip')
      await copyFile(deps.file, toExpand)
    }

    const expand = await expandArchive(toExpand, stage, { timeoutMs: 900000 })
    if (expand.status !== 0) {
      throw new Error(`解压失败：${String(expand.stderr).slice(0, 300)}`)
    }
    /*
     * 有些包会多一层顶层目录（比如解压出 NapCat/ 而不是直接铺开）。
     * 这种情况要把里面那层提上来，否则运行时目录结构不对、识别不了。
     *
     * ## 但"只有一个顶层目录就提上来"是**错的** —— 会把包本体拆掉
     *
     * 原判据只看"stage 下是不是只有一个条目"，于是遇到这种包就出事：
     *
     *     astrbot-4.28.0.zip
     *       └── astrbot/            ← 唯一的顶层条目
     *             ├── __init__.py
     *             └── cli/...
     *
     * 唯一的顶层条目恰好就是**包目录本身**（`astrbot/`）。
     * 把它提上来之后，destDir 里变成 `__init__.py` + `cli/`，
     * **`astrbot/` 这层没了** —— 而 detectLayout 对 PyPI 形态的判据
     * 正是"有 astrbot 目录"，于是一样认不出来。
     *
     * 这个坑和 .whl 缺 marker 是**两个独立的** bug，都会导致
     * "导入成功但永远起不来"；只修一个的话换成 zip 包又会复现。
     *
     * ## 现在的判据：看"提上来之后是不是一个像样的运行时根"
     *
     * 先判断 stage 本身是不是已经是运行时根；是就别动。
     * 不是的话，再看里面那层是不是 —— 是才提上来。
     *
     * 这样三种形态都对：
     *   - `astrbot/`（包本体）      → stage 已是根（有 astrbot 子目录）→ 不提
     *   - `astrbot-4.28.0/astrbot/` → stage 不是根，内层是 → 提上来
     *   - `NapCat-4.8/xxx.exe...`   → stage 不是根，内层是 → 提上来
     *
     * 判据**不能依赖 mxbot-runtime.json** —— 那个标记要等搬运完才写，
     * 此刻还不存在。所以这里只看内容形态。
     */
    const top = readdirSync(stage)
    let srcDir = stage
    if (!looksLikeRuntimeRoot(stage, deps.type) && top.length === 1) {
      const inner = join(stage, top[0])
      try {
        if (statSync(inner).isDirectory() && looksLikeRuntimeRoot(inner, deps.type)) {
          srcDir = inner
        }
      } catch {
        /* 不是目录就用 stage */
      }
    }

    mkdirSync(deps.destDir, { recursive: true })
    /*
     * 搬运时**必须跳过中转文件**。
     *
     * `.whl` 会被复制成 stage 里的 `payload.zip` 才能解压（见上面的注释）。
     * 而下面这段是"把 srcDir 下的**所有**条目 rename 过去" ——
     * 当包是"没有顶层目录"的形态时 `srcDir` 恰好就是 stage 本身，
     * 于是 `payload.zip` 也跟着进了正式运行时目录：
     *
     *   - 它没有任何用处（只是为了让 Expand-Archive 肯认扩展名）
     *   - 大小等于整个 wheel（几十 MB），纯占地方
     *   - 而且用户能看见，会以为"装了两份"
     *
     * 以前没暴露是因为单测只造 .zip 包（不会产生 payload.zip），
     * 而 AstrBot 的真实形态正是 .whl。
     */
    const TRANSIENT = new Set(['payload.zip', 'payload.whl'])
    // 用重命名把内容搬过去（同盘 rename 是元数据操作，比逐文件复制快得多）
    for (const name of readdirSync(srcDir)) {
      if (TRANSIENT.has(name.toLowerCase())) continue
      const from = join(srcDir, name)
      const to = join(deps.destDir, name)
      const { renameSync } = await import('fs')
      try {
        renameSync(from, to)
      } catch {
        /*
         * 跨设备等情况 rename 会失败，退回复制。
         *
         * ★ 必须用**异步** cp（指导书 P0-4）：
         * 这里搬的是一整棵运行时树（几万个文件、几百 MB），
         * `cpSync` 会把主进程事件循环整段堵死 —— 用户看到的就是
         * "导入时界面卡住好几秒到几十秒"。`fsp.cp` 走 libuv 线程池，
         * 复制期间界面照常响应。
         */
        const fsp = await import('fs/promises')
        await fsp.cp(from, to, { recursive: true, force: true })
      }
    }

    /*
     * 写我们的运行时标记 —— **这一步不能少，否则导入的运行时永远起不来**。
     *
     * ## 为什么必须有
     *
     * `detectLayout` 判断"PyPI 形态的 AstrBot"用的是（layout.ts:54）：
     *
     *     if (existsSync(join(dir, 'astrbot')) && readRuntimeKind(dir) === 'pypi')
     *       return 'astrbot'
     *
     * 而 `readRuntimeKind` **只**读 `mxbot-runtime.json`。
     * 正规下载路径（ipc.ts 的 runtimes:install）装完会写它，
     * 手动导入这条路原来**没写** —— 于是：
     *
     *   有 astrbot 包目录 → 但 readRuntimeKind() = undefined
     *   → 判据不成立 → detectLayout = 'unknown'
     *   → resolveLaunchSpec 抛「AstrBot 运行时结构不对，重新下载这个版本」
     *
     * 用户看到那句"重新下载这个版本"就会一直重装/重导，
     * 而每次结果都一样 —— 这是最消耗人耐心的一类错误提示。
     *
     * 标记内容和正规路径**逐字一致**（kind=pypi、entry=astrbot），
     * 这样两条路径产出的运行时完全等价，后续逻辑不用区分来源。
     *
     * `tag` 用目标目录名（调用方就是按版本号建的目录），
     * 保持和 ipc.ts 那边同样的写法。
     */
    const tag = basename(deps.destDir)
    writeFileSync(
      join(deps.destDir, 'mxbot-runtime.json'),
      JSON.stringify(
        {
          tag,
          kind: probe.kind === 'a' ? 'pypi' : 'node',
          entry: probe.kind === 'a' ? 'astrbot' : 'napcat'
        },
        null,
        2
      ),
      'utf8'
    )
    return probe
  } finally {
    await removeDirAsync(stage).catch(() => undefined)
  }
}

/** 弹系统文件选择框，让用户挑压缩包 */
export async function pickArchiveFile(): Promise<string | null> {
  const { dialog } = await import('electron')
  const r = await dialog.showOpenDialog({
    title: '选择运行时压缩包',
    properties: ['openFile'],
    filters: [
      { name: '压缩包', extensions: ['zip', 'whl'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  if (r.canceled || !r.filePaths.length) return null
  return r.filePaths[0]
}
