/*
 * 「上次用的数据目录是哪个」——一个放在安装目录旁的指针文件。
 *
 * ============================================================================
 * 为什么需要它
 * ============================================================================
 *
 * 数据默认住在 `<安装目录>\data`（见 ipc.ts 的 defaultDataRoot）。但用户可以
 * 在设置里把它迁到别处，比如 `D:\MXData`。
 *
 * 迁移是**复制**（旧目录留着，用户自己确认没问题再删，见 relocate.ts）。
 * 于是重启之后会撞上这个死结：
 *
 *   1. 启动时主进程去读 `<安装目录>\data\config.json`
 *      （ipc.ts 里就是 `readAppConfig(await defaultDataRoot())`）
 *   2. 那份**旧** config.json 还在（迁移只复制不删），里面 dataRoot 还是旧路径
 *   3. 于是软件"回到"旧目录：
 *        - 实例列表是空的（新目录里的数据没人看）
 *        - runtimes / python 也找不到
 *        - 用户看到的现象就是「迁移完重启，全没了」
 *   4. 更糟的是：如果用户听提示把旧目录删了，读到 undefined →
 *      首启向导又冒出来（"为什么每次都让我选数据目录"）
 *
 * 迁移功能本身没错，错的是**下次启动不知道该去哪找 config**。
 *
 * ============================================================================
 * 做法
 * ============================================================================
 *
 * 在**安装目录旁**（不在 data 里，因为它要指向 data）放一个纯文本指针：
 *
 *   <安装目录>\data-root.txt    内容 = 上次用的数据目录绝对路径
 *
 * 为什么是纯文本而不是 JSON：这里只存一个路径，用 JSON 反而引入
 * BOM/引号/转义这些解析坑（config.json 就为 BOM 吃过一次亏，见 json-file.ts）。
 * 读的时候 trim 一下就行，连解析都不会失败。
 *
 * 为什么不放进环境变量/注册表：注册表已经有一个 `HKCU\Software\MXBot\DataRoot`
 * 了，但那是**给卸载器读的**（卸载时决定删哪个目录），语义不同 ——
 * 卸载器要的是"该删谁"，这里要的是"该读谁"。混用会让两件事互相绑死。
 * 而且注册表在便携使用（拷走整个目录）时不会跟着走，指针文件会。
 *
 * ============================================================================
 * 容错
 * ============================================================================
 *
 * 指针文件是**尽力而为**的：
 *   - 写不进去（安装目录只读、被安全软件拦）→ 不影响迁移本身，只是下次
 *     启动要重新选一次目录。绝不能因为这样一个辅助文件让迁移失败。
 *   - 指针指向的目录已经不存在/不可读 → resolveStartupDataRoot 退回默认，
 *     由首启向导接管。绝不能因为一个过期的指针把软件卡死。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'fs'
import { randomBytes } from 'crypto'
// 只需要 join：原来还导入过 dirname，是 installDirOf() 的遗留，
// 那个函数已经删掉了（它假设的"安装目录"推导方式在便携版下不成立）。
import { join } from 'path'

/** 指针文件名（放在安装目录旁） */
export const ROOT_POINTER_FILE = 'data-root.txt'

/** 指针文件的完整路径 */
export function pointerPath(installDir: string): string {
  return join(installDir, ROOT_POINTER_FILE)
}

/**
 * 读出上次用过的数据目录。
 *
 * @param installDir 安装目录（打包后 = process.execPath 所在目录）
 * @returns 上次的数据目录；没有指针/指针为空/指针失效时返回 undefined
 */
export function readRootPointer(installDir: string): string | undefined {
  const f = pointerPath(installDir)
  try {
    if (!existsSync(f)) return undefined
    const raw = readFileSync(f, 'utf8')
    // BOM 也要吃掉：用户可能用记事本另存过（config.json 就为这个吃过亏）
    const p = raw.replace(/^\uFEFF/, '').trim()
    if (!p) return undefined
    /*
     * 指针里的目录必须**真的存在**才认。
     *
     * 什么时候会不在了：用户手动删了新目录、U 盘/移动硬盘拔了、
     * 盘符变了。这时如果还认这个指针，启动就会去读一个不存在的目录、
     * 拿到 undefined、再弹首启向导 —— 和没有指针是一样的结果，
     * 但多了「指针是坏的」这个中间状态。直接判失效更干净。
     *
     * 用 statSync 而不是 existsSync：要确认是**目录**，
     * 指针里可能被误写成一个文件路径。
     */
    if (!existsSync(p)) return undefined
    try {
      if (!statSync(p).isDirectory()) return undefined
    } catch {
      return undefined
    }
    return p
  } catch {
    // 读不动（权限、编码）→ 当作没有指针
    return undefined
  }
}

/**
 * 记下「现在用的数据目录是哪个」。
 *
 * 时机：每次 config 落盘时（首启向导选完目录、设置里迁移完）都要写一次。
 *
 * **绝不抛错**：这是辅助信息，写不进去只是下次启动要重选目录，
 * 而让它把「迁移」或「保存配置」整个搞失败是不划算的。
 *
 * @returns 是否写成功（调用方可以记一条日志，但不必据此改变行为）
 */
export function writeRootPointer(installDir: string, dataRoot: string): boolean {
  if (!dataRoot || !dataRoot.trim()) return false
  try {
    mkdirSync(installDir, { recursive: true })
    const f = pointerPath(installDir)
    /*
     * 原子写：先写临时文件再改名。
     *
     * 直接覆盖的话，写到一半断电/被杀会留下一个**半截路径** ——
     * 而半截路径大概率指向一个不存在的目录，于是启动时指针失效、
     * 用户莫名其妙又被要求选一次数据目录。改名是原子的，要么旧要么新。
     */
    const tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, dataRoot, 'utf8')
    renameSync(tmp, f)
    return true
  } catch {
    return false
  }
}

/**
 * 启动时该读哪个 config.json —— 把「指针优先」这条判据收在一处。
 *
 * 顺序：
 *   1. 指针指向的目录（用户迁移过）
 *   2. `<安装目录>\data`（默认位置；全新安装或指针失效）
 *
 * 注意**不检查第二步是否存在** —— 那由调用方 readAppConfig 返回 undefined
 * 来表达（"没配置过"），从而让首启向导正常介入。这里只回答"去哪找"。
 */
export function resolveStartupDataRoot(installDir: string): string {
  return readRootPointer(installDir) ?? join(installDir, 'data')
}
