/*
 * 原子落盘 JSON —— 一个所有"我自己维护的小状态文件"都该用的工具。
 *
 * ## 为什么需要它（不是洁癖，是真的出过问题）
 *
 * 项目里有好几个自己维护的 JSON 状态文件（instances.json、mirrors.json、
 * config.json、每个实例目录下的 instance.json、runtimes.json …）。
 * 它们的写法原本**各自为政**：有的用了 tmp+rename，有的直接 writeFileSync。
 *
 * 直接 writeFileSync 的问题不是"理论上可能断电"这么虚 —— 它是：
 *
 *   1. `writeFileSync` 打开目标文件时会**先截断成 0 字节**，再往里写。
 *      所以哪怕只是"写到一半磁盘满了/进程被杀"，目标文件已经是**残缺**的。
 *   2. 读的那一头几乎都写成了 `try { read } catch { 用默认值 }`。
 *      于是"文件坏了"被**静默**当成"文件不存在"。
 *   3. 默认值往往是个**空集合**（`[]` / `{}`）。
 *
 * 第 3 点才是真正致命的地方：一个写入失败会把用户的**全部自定义设置
 * 抹成空**，而且没有任何报错。mirrors.json 就是这么个例子 ——
 * 它是"用户自己加过哪些镜像源、首选哪个"的唯一记录，
 * 一旦被截断，readJsonFile 抛错 → catch → `raw = {}` → 用户加的源全没了，
 * 界面上看起来就像"这软件把我配的源吃了"。
 *
 * ## 为什么 rename 就够
 *
 * `renameSync(tmp, target)` 在同一卷上是**原子替换**
 * （Windows 走 MoveFileEx，POSIX 走 rename(2)）：
 * 任何时刻去读目标文件，要么看到完整的旧内容，要么看到完整的新内容，
 * 不存在"读了一半"的中间态。断电最坏的结果是**丢这次写入**，
 * 而不会损坏已有的好数据。
 *
 * 临时文件带随机后缀：并发/重入不会互踩；写完立刻换名，
 * 失败了把 tmp 清掉，不留垃圾。
 *
 * ## 顺带：写失败要能被上层知道
 *
 * 这个函数**不吞异常**。写不进去（磁盘满、权限、被占用）应该让调用方知道，
 * 由它决定是报错还是记日志 —— 静默吞掉写入失败正是上面第 2、3 步灾难的起点。
 */
import { writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { dirname, join, basename } from 'path'

/**
 * 原子写入文本文件。
 *
 * @param file    目标路径
 * @param text    要写入的内容
 * @param ensureDir  是否自动创建父目录（默认 false —— 调用方通常已经建好，
 *                   自动创建会掩盖"dataRoot 配错了"这类问题）
 */
export function writeFileAtomic(file: string, text: string, ensureDir = false): void {
  if (ensureDir) {
    const d = dirname(file)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (e) {
    // 换名失败：清掉 tmp 再抛，别在用户目录里留一地垃圾
    try {
      unlinkSync(tmp)
    } catch {
      /* 删不掉也只能算了，不要把真正的错误盖掉 */
    }
    throw e
  }
}

/** 原子写入 JSON（2 空格缩进，和项目其它状态文件保持一致） */
export function writeJsonAtomic(file: string, data: unknown, ensureDir = false): void {
  writeFileAtomic(file, JSON.stringify(data, null, 2), ensureDir)
}
