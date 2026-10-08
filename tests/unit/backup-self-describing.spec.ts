/*
 * Bug E：备份必须**自描述 + 原子落盘 + 校验哈希**
 * ========================================================================
 *
 * ## 三处缺陷，一个后果：静默回滚到错误的地方
 *
 * 现在一次备份要写**两个**文件：
 *
 *     writeFileSync(`<时间戳>-v1.tar.gz`, gz)          // 先写包
 *     writeFileSync(`<时间戳>-v1.json`, manifest)      // 再写说明
 *
 * 而回滚时靠 `.json` 里的 `scope` 决定**往哪儿还原**：
 *
 *     const manifest = readManifest(file)
 *     const isLegacy = manifest?.scope !== 'data'      // 读不到 = 当成旧格式
 *     const base = isLegacy ? join(dir, 'runtime') : dir
 *
 * 于是三处独立的毛病叠成一次数据事故：
 *
 * **缺陷 1 — 两个文件不是一次原子操作**
 *
 * 写完 tar.gz、还没来得及写 .json 就被杀（或者磁盘满）→ 留下一个
 * **没有说明的孤包**。回滚时 `readManifest` 返回 undefined
 * → `isLegacy = true` → 把**实例数据**还原到 `<实例>\runtime\`。
 *
 * 结果是：真正的 `data\` 一个字节没动（用户以为回滚了，其实没有），
 * 而凭空多出一个装着数据的 `runtime\` 目录。
 * **没有任何报错** —— 因为从代码视角看这是一次"成功的旧格式回滚"。
 *
 * **缺陷 2 — 归档不是自描述的**
 *
 * 说明文件丢在外面，所以"这个包是什么"依赖一个**可能不在的旁文件**。
 * 包被单独拷走（用户之间传备份、手动挪进备份目录）之后就必然被误判。
 *
 * **缺陷 3 — 算了 sha256 却从不校验**
 *
 * `backupRuntime` 认真算了 sha256 写进说明，`restoreBackup` 却
 * **一次都没读过它**。备份文件被截断/改坏时，回滚会拿损坏的内容
 * 去覆盖好数据 —— 而哈希明明就在手边。
 *
 * ## 正确的形状
 *
 * 让**包自己说明自己**：manifest 作为归档里的第一个条目写进去，
 * 整个文件一次 `writeFileSync(tmp)+rename` 落盘。这样：
 *   - 只有一个文件，不存在"包在说明不在"的中间态
 *   - 包拷到哪儿都能正确识别（自描述）
 *   - 旁文件仍然写（给界面显示用），但**不再是回滚判据**
 *
 * 哈希校验则放在解包之后、真正动数据之前：不匹配就拒绝，
 * 并明确告诉用户"备份文件损坏"，而不是拿坏数据去覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import { gunzipSync, gzipSync } from 'zlib'
import { backupRuntime, restoreBackup } from '../../src/main/update/backup'

let inst: string
beforeEach(() => {
  inst = testStage('acb-backup-e-')
  mkdirSync(join(inst, 'data'), { recursive: true })
  writeFileSync(join(inst, 'data', 'cfg.json'), '{"hello":"world"}', 'utf8')
  writeFileSync(join(inst, 'instance.json'), '{"id":"a_1"}', 'utf8')
})
afterEach(() => {
  rmSync(inst, { recursive: true, force: true })
})

/**
 * 去掉注释再返回源码。
 *
 * **必须做这一步**：backup.ts 的注释里为了讲清楚问题，**逐字引用**了
 * 出问题的代码，比如「`writeFileSync(file, gz)` 会先把目标截断成 0 字节」。
 * 直接在原文上做正则匹配会命中那句**注释**，于是：
 *   - "还有没有裸 writeFileSync" → 永远报 true（假红）
 *   - 反过来也可能假绿
 * 我第一版就是被这个坑到，报的"非原子"其实是注释里的引文。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')
}

/**
 * 取函数体（**跳过参数列表里的类型注解**）。
 *
 * 直接用"签名后第一个 `{`"是错的：
 *   export function restoreBackup(deps: { dir: string; file: string }): void {
 *                                          ↑ 参数类型里的 `{` 在前面！
 * 会把函数体认成 `{ dir: string; file: string }`，只有二十几个字符，
 * 于是里面当然找不到 createHash → 报"没校验 sha256"的**假红**。
 *
 * 正确做法：先按括号配平找到参数列表的收尾 `)`，再从它后面找第一个 `{`。
 */
function fnBody(src: string, signature: string): string {
  const s = stripComments(src)
  const i = s.indexOf(signature)
  if (i < 0) return ''
  const open = s.indexOf('(', i)
  let depth = 0
  let close = -1
  for (let k = open; k < s.length; k++) {
    if (s[k] === '(') depth++
    else if (s[k] === ')') {
      depth--
      if (depth === 0) {
        close = k
        break
      }
    }
  }
  if (close < 0) return ''
  const bodyOpen = s.indexOf('{', close)
  depth = 0
  for (let k = bodyOpen; k < s.length; k++) {
    if (s[k] === '{') depth++
    else if (s[k] === '}') {
      depth--
      if (depth === 0) return s.slice(bodyOpen, k + 1)
    }
  }
  return ''
}

function backupSrc(): string {
  return readFileSync(join(process.cwd(), 'src', 'main', 'update', 'backup.ts'), 'utf8')
}

describe('Bug E：备份自描述 / 原子 / 校验', () => {
  it('★manifest 必须**嵌在归档里**（第一个条目就是它）', async () => {
    /*
     * 这条用**行为**验证，不猜源码结构。
     *
     * 旧的旁文件方案下，归档的第一个条目是 `data/cfg.json` 之类；
     * 自描述之后第一个条目必须是 `manifest.json`。
     * 这个判据既精确又不会因为重命名变量而误报。
     */
    const r = await backupRuntime({ dir: inst, templateVersion: '4.27.0' })
    const buf = gunzipSync(readFileSync(r.file))

    const relLen = buf.readUInt32LE(0)
    const firstRel = buf.toString('utf8', 4, 4 + relLen)

    expect(
      firstRel,
      '归档的第一个条目不是 manifest.json —— 说明 manifest 仍然是**外挂的旁文件**。\n' +
        '后果：写完包、还没写说明就被杀 → 包没有说明 →\n' +
        'restoreBackup 把它当旧格式 → 数据被还原到 <实例>\\runtime\\ 而不是 data\\，\n' +
        '真正的 data\\ 没变（用户以为回滚了其实没有），而且不报任何错。'
    ).toBe('manifest.json')

    // 内容也要是那份说明，且带 embedded 标记。
    // 头结构：4字节路径长度 + 路径 + 8字节数据长度 + 数据
    // 小心偏移算错（第一版就是，导致 JSON.parse 读到后面条目的字节）
    let p = 0
    const rl = buf.readUInt32LE(p)
    p += 4
    const rel = buf.toString('utf8', p, p + rl)
    p += rl
    const dl = Number(buf.readBigUInt64LE(p))
    p += 8
    expect(rel).toBe('manifest.json')
    const m = JSON.parse(buf.toString('utf8', p, p + dl)) as {
      scope?: string
      embedded?: boolean
    }
    expect(m.scope).toBe('data')
    expect(m.embedded, '内嵌 manifest 应该带 embedded 标记').toBe(true)
  })

  it('★备份文件必须原子落盘（先写 tmp 再 rename，不能直接写目标）', async () => {
    const body = fnBody(backupSrc(), 'export async function backupRuntime(')
    expect(body, '取不到 backupRuntime 的函数体').not.toBe('')

    /*
     * ★ 断言"语义"而不是"同步 API 名"（2026-09-26 修正）
     *
     * 原来断言的是 `renameSync(tmp, file)` —— 而 backupRuntime 已经改成
     * **异步**（主人要求「能异步的全异步」，因为它要递归读上万文件 + gzip，
     * 同步会把主进程冻住几百毫秒）。实现变成 `await fsp.rename(tmp, file)`，
     * 原子性**完全一样**（先写 tmp 再改名，目标文件任何时刻都是完整的），
     * 但按同步 API 名写的断言就红了。
     *
     * 现在按语义判：只要出现"把 tmp 改名成 file"这个动作（同步/异步都行），
     * 且没有直接写目标文件，就算合格。这样**换实现不会产生假红**，
     * 而真的丢掉原子性（直接写 file）仍然会被抓住。
     */
    expect(
      /(?:renameSync|fsp\.rename|\brename)\s*\(\s*tmp\s*,\s*file\s*\)/.test(body),
      '备份没有原子落盘 —— 写一半被杀就是一个**损坏的包**，\n' +
        '而它会被当成正常备份列在界面上，回滚时才炸（或更糟：静默写入坏数据）。'
    ).toBe(true)

    /*
     * 不允许裸写目标文件（同步或异步都不行）。
     * 注意这里是**去过注释**的正文 —— 注释里逐字引用了那句坏代码，
     * 不去注释会永远报红（我第一版就栽在这）。
     */
    expect(
      /(?:writeFileSync|fsp\.writeFile)\s*\(\s*file\s*,/.test(body),
      '仍然直接写备份目标文件 —— 非原子'
    ).toBe(false)
  })

  it('★回滚必须校验 sha256（算了却不用等于没算）', async () => {
    const body = fnBody(backupSrc(), 'export async function restoreBackup(')
    expect(body, '取不到 restoreBackup 的函数体').not.toBe('')

    expect(
      /createHash\s*\(\s*['"]sha256['"]\s*\)/.test(body),
      'restoreBackup 里没有算 sha256 —— backupRuntime 明明算了并写进了 manifest，\n' +
        '但回滚时一次都不校验。备份被截断/改坏时会拿坏数据直接覆盖好数据。'
    ).toBe(true)
    expect(/sha256/.test(body), 'restoreBackup 里根本没提 sha256').toBe(true)
  })

  it('★丢了旁文件（.json）的备份仍然要正确回滚到 data\\，不能猜测成旧格式', async () => {
    const r = await backupRuntime({ dir: inst, templateVersion: '4.27.0' })
    expect(existsSync(r.file), '备份文件应该生成了').toBe(true)

    // 模拟"包写完了、说明没写成"（被杀 / 磁盘满 / 用户只拷走了 .tar.gz）
    const sidecar = r.file.replace(/\.tar\.gz$/, '.json')
    expect(existsSync(sidecar), '旁文件正常应该存在').toBe(true)
    unlinkSync(sidecar)

    // 改掉原数据，才能看出回滚到底有没有生效
    writeFileSync(join(inst, 'data', 'cfg.json'), '{"hello":"CHANGED"}', 'utf8')

    await restoreBackup({ dir: inst, file: r.file })

    // 必须还原到 data\（包自己说了它是 data 备份）
    expect(
      JSON.parse(readFileSync(join(inst, 'data', 'cfg.json'), 'utf8')),
      '丢了旁文件就没还原成功 —— 说明包不是自描述的'
    ).toEqual({ hello: 'world' })

    // 而且绝对不能凭空造出一个 runtime\ 来
    expect(
      existsSync(join(inst, 'runtime')),
      '把数据备份误判成旧格式，还原到了 <实例>\\runtime\\ —— 真正的 data\\ 没动，\n' +
        '用户以为回滚成功了其实没有，而且不报错'
    ).toBe(false)
  })

  it('★备份内容被改坏时回滚必须拒绝，而不是拿坏数据覆盖', async () => {
    const r = await backupRuntime({ dir: inst, templateVersion: '4.27.0' })

    /*
     * ## 关键：篡改之后必须**重新 gzip**，否则测的不是 sha256
     *
     * 我第一版是直接翻转压缩后的字节。那样 `gunzipSync` 会先抛
     * "incorrect header check" —— gzip 自己有 CRC32。
     * 于是测试"通过"了，但**根本没走到 sha256 校验**，
     * 把 sha256 那段整个删掉它照样绿（反向验证时抓到了这一点：
     * 去掉校验后 0 条红）。
     *
     * 正确做法：解开 → 改**正文**里的字节 → 重新 gzip（CRC 自然对得上）。
     * 这样唯一能发现篡改的就是 sha256。
     */
    const raw = gunzipSync(readFileSync(r.file))
    const text = raw.toString('latin1')
    const at = text.indexOf('"hello":"world"')
    expect(at, '在归档里找不到原始数据，本用例无效').toBeGreaterThan(0)
    // 只改一个字符（保持长度不变，结构不破坏）
    const tampered = Buffer.from(raw)
    tampered[at + 5] = 'H'.charCodeAt(0) // "hello" → "Hello"
    writeFileSync(r.file, gzipSync(tampered))

    writeFileSync(join(inst, 'data', 'cfg.json'), '{"hello":"PRECIOUS"}', 'utf8')

    let err: Error | undefined
    try {
      await restoreBackup({ dir: inst, file: r.file })
    } catch (e) {
      err = e as Error
    }

    /*
     * 必须被拒绝。
     *
     * 因为"静默成功"就意味着用户的好数据被垃圾覆盖了，而他完全不知道。
     * sha256 就在 manifest 里，没有任何理由不查。
     */
    expect(
      err,
      '被篡改的备份没有被拒绝 —— 回滚会拿坏数据覆盖用户的好数据，而且不报错'
    ).toBeDefined()
    expect(
      err?.message ?? '',
      '报错信息应该说清楚是"校验和不匹配"，而不是一句看不懂的内部错误'
    ).toMatch(/校验和|损坏/)

    // 而且拒绝时**不能已经动过数据**（校验必须先于一切写操作）
    expect(
      readFileSync(join(inst, 'data', 'cfg.json'), 'utf8'),
      '拒绝之前就已经改了数据 —— 应该先校验、后动手'
    ).toContain('PRECIOUS')
  })

  it('正常备份 → 回滚，数据能回来（回归）', async () => {
    const r = await backupRuntime({ dir: inst, templateVersion: '4.27.0' })
    writeFileSync(join(inst, 'data', 'cfg.json'), '{"hello":"CHANGED"}', 'utf8')
    await restoreBackup({ dir: inst, file: r.file })
    expect(JSON.parse(readFileSync(join(inst, 'data', 'cfg.json'), 'utf8'))).toEqual({
      hello: 'world'
    })
    // 回滚成功之后不该留 .deleted-* 残骸
    const leftovers = readdirSync(inst).filter((n) => n.includes('.deleted-'))
    expect(leftovers, `留下了残骸：${leftovers.join('、')}`).toEqual([])
  })
})
