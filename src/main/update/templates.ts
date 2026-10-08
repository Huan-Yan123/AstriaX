import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { readJsonFile } from '../util/json-file'

export interface TemplateInfo {
  dir: string
  version: number
  ready: boolean
}

const READY_MARKER = '.mx-ready'
const MANIFEST = 'manifest.json'

/**
 * 模板注册表：templatesRoot 下 astrbot/ 与 napcat/ 各一个子树。
 * ready=含 .mx-ready 标记（下载并校验后写入）。
 */
export function getTemplates(deps: { templatesRoot: string }): { a: TemplateInfo; n: TemplateInfo } {
  const mk = (sub: string): TemplateInfo => {
    const dir = join(deps.templatesRoot, sub)
    const marker = join(dir, READY_MARKER)
    let version = 1
    const mf = join(dir, MANIFEST)
    if (existsSync(mf)) {
      try {
        version = readJsonFile<{ version?: number }>(mf).version ?? 1
      } catch {
        /* 损坏 manifest 当 v1 */
      }
    }
    return { dir, version, ready: existsSync(marker) }
  }
  return { a: mk('astrbot'), n: mk('napcat') }
}

/**
 * 初始化实例目录。
 *
 * **不再复制整个运行时** —— 这是修掉的一个真 bug，代价很大。
 *
 * 原来这里把共享运行时整树复制进实例目录。多版本改造后运行时已经搬到
 * `<dataRoot>\runtimes\<type>\<tag>\` 并且**同类实例共享**，启动时读的也是
 * 运行时目录（见 ipc.ts 的 defaultCommandFor：`src = store.dirFor(...)`）。
 * 所以复制出来的那份**从头到尾没有任何代码读它**，纯属白占空间：
 *
 *   实测（2026-09-13）：
 *     AstrBot v4.28.0 运行时  565.4 MB / 49133 个文件
 *     NapCat  v4.18.19 运行时  90.1 MB /   692 个文件
 *   建一个 AstrBot 实例就白复制 565 MB，建 5 个就是 2.8 GB。
 *
 * 而且实测证明根本不需要那份副本：
 *   NapCat 用**完全空的工作目录**启动成功（端口通、只生成 config\webui.json
 *   和二维码两个文件）—— 它靠 NAPCAT_WORKDIR 定位数据、靠运行时目录找代码；
 *   AstrBot 同理，数据落 cwd、代码靠 MXBOT_SITE。
 *
 * 现在只做两件事：建出实例目录骨架，写一个自证标记。
 * 数据目录（AstrBot 的 data\、NapCat 的 config\）由各自程序首次启动时创建，
 * 我们不预建空目录 —— 免得用户以为「有 data 目录了但里面空的」是坏了。
 */
export function instantiateFromTemplate(deps: { src: string; dest: string }): void {
  const { dest } = deps
  mkdirSync(dest, { recursive: true })
  // 实例自证已初始化的标记
  writeFileSync(join(dest, READY_MARKER), 'instance', 'utf8')
}

/** sha256 校验（下载完成后的完整性门槛） */
export function verifyArchive(path: string, expectedSha256: string): boolean {
  if (!existsSync(path)) return false
  const got = createHash('sha256').update(readFileSync(path)).digest('hex')
  return got.toLowerCase() === expectedSha256.toLowerCase()
}

/** 侧载模板（本地目录→模板目录登记 .mx-ready + manifest） */
export function ensureTemplate(deps: { src: string; version: number }): TemplateInfo {
  mkdirSync(join(deps.src, '.'), { recursive: true })
  writeFileSync(join(deps.src, MANIFEST), JSON.stringify({ version: deps.version }), 'utf8')
  writeFileSync(join(deps.src, READY_MARKER), 'template', 'utf8')
  const { getTemplates: _ref } = { getTemplates }
  void _ref
  return { dir: deps.src, version: deps.version, ready: true }
}
