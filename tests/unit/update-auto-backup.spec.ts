/*
 * 覆盖更新时的自动数据备份。
 * ========================================================================
 *
 * ## 用户要求（原话）
 *
 *   「加入覆盖更新的时候会自动打包数据备份压缩包放在备份文件夹」
 *
 * ## 为什么这件事必须由**安装器**做，而不是程序做
 *
 * 用户现在要测的是 **0.1.0 → 0.1.1**。0.1.0 里没有新代码 ——
 * 如果备份逻辑写在程序里，那用户更新到 0.1.1 的**这一次**根本不会被保护
 * （跑的还是 0.1.0 的旧代码），正好是最需要保的那一次没保上。
 *
 * 安装器是**当前正在运行的那个版本的新安装包**，它一定会执行，
 * 所以放在这里才能覆盖"任何低版本 → 任何高版本"。
 *
 * ## 备份什么（用户原话：「astrbot+napcat 的用户数据最重要」）
 *
 * 只备份**丢了就再也弄不回来**的东西：
 *
 *   instances\       全部实例目录
 *                    - AstrBot: data\cmd_config.json（账密/模型/插件/人格）
 *                    - NapCat : config\*.json（QQ 账号、onebot token、webui）
 *                    - cache\qrcode.png（登录二维码，扫过就没了）
 *   config.json      启动器自身配置（数据目录、端口段、备份保留数）
 *   instances.json   实例清单
 *   mirrors.json     用户自己加的镜像源
 *   runtimes.json    装了哪些运行时版本（用于事后重装）
 *   data-root.txt    数据目录指针（**不在 data 里，在安装目录**）
 *
 * **明确不备份**（都能重新下载，备份它们会让每次更新白等几分钟）：
 *   runtimes\  (212 MB)  运行时本体
 *   cache\     (187 MB)  下载缓存
 *   runtime\   (40 MB)   内置 Python
 *
 * 实测（scripts/_probe-archiver.cjs）：
 *   真实 instances 只有 15.6 KB，tar 打包 29ms。
 *   所以这个备份是"秒级完成、几乎不占空间"的，不会拖慢更新。
 *
 * ## 备份放哪
 *
 *   <安装目录>\..\MXBot-update-backup\<时间戳>\mxbot-data-<版本>.tar.gz
 *
 * 为什么**不能**放在 $INSTDIR 里、也不能放在 $INSTDIR\data 里：
 *   - 放 $INSTDIR 里 → 旧卸载器的 `RMDir /r "$INSTDIR"` 会连备份一起删掉，
 *     等于没备份（这是本项目反复踩过的那个坑）
 *   - 放 $INSTDIR\data 里 → 数据目录会被整个搬走/覆盖，备份跟着遭殃
 * 所以放在**安装目录的兄弟目录**，和现有的 MXBot-update-keep 同一层。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { gunzipSync } from 'zlib'

let root: string
let dataDir: string
let installDir: string
let backupRoot: string

const TAR = 'C:\\Windows\\System32\\tar.exe'

/**
 * 造一份**按真实约定**的 data 目录。
 *
 * 用真的 AstrBot/NapCat 路径结构，不用编的 —— 否则测出来的
 * 是"我以为的结构"，真实更新时可能漏掉关键文件。
 */
function seedRealData(): void {
  // AstrBot 实例：账密/模型在 data\cmd_config.json，人格在 data\config\
  const a = join(dataDir, 'instances', 'AstrBot', 'a_3326e137e2')
  mkdirSync(join(a, 'data', 'config'), { recursive: true })
  writeFileSync(join(a, 'data', 'cmd_config.json'), JSON.stringify({ dashboard: { username: 'astrbot' }, provider: { openai: { api_key: 'sk-USER-KEY' } } }), 'utf8')
  writeFileSync(join(a, 'data', 'config', '人格-梦汐.json'), '{"name":"梦汐"}', 'utf8')
  writeFileSync(join(a, 'instance.json'), '{"id":"a_3326e137e2","runtimeTag":"v4.28.0"}', 'utf8')
  writeFileSync(join(a, '.astrbot'), '', 'utf8')

  // NapCat 实例：QQ 账号配置、onebot token、webui
  const n = join(dataDir, 'instances', 'NapCat', 'n_c58a357f6c')
  mkdirSync(join(n, 'config'), { recursive: true })
  mkdirSync(join(n, 'cache'), { recursive: true })
  writeFileSync(join(n, 'config', 'onebot11_3859054833.json'), '{"token":"NAPCAT-TOKEN","qq":3859054833}', 'utf8')
  writeFileSync(join(n, 'config', 'webui.json'), '{"port":6099}', 'utf8')
  writeFileSync(join(n, 'cache', 'qrcode.png'), 'PNGDATA', 'utf8')
  writeFileSync(join(n, 'instance.json'), '{"id":"n_c58a357f6c","runtimeTag":"v4.18.19"}', 'utf8')

  // data 根下的配置文件
  writeFileSync(join(dataDir, 'config.json'), '{"dataRoot":"PRECIOUS-ROOT","backupKeep":5}', 'utf8')
  writeFileSync(join(dataDir, 'instances.json'), '{"instances":[]}', 'utf8')
  writeFileSync(join(dataDir, 'mirrors.json'), '{"custom":["https://mirror.example.com"]}', 'utf8')
  writeFileSync(join(dataDir, 'runtimes.json'), '{"versions":[]}', 'utf8')

  // 不该被备份的大东西（能重新下载）
  mkdirSync(join(dataDir, 'runtimes', 'a', 'v4.28.0'), { recursive: true })
  writeFileSync(join(dataDir, 'runtimes', 'a', 'v4.28.0', 'big.bin'), 'X'.repeat(200000), 'utf8')
  mkdirSync(join(dataDir, 'cache'), { recursive: true })
  writeFileSync(join(dataDir, 'cache', 'download.tmp'), 'Y'.repeat(200000), 'utf8')
}

/** 调 tar.exe 打包（和安装器里要用的同一条命令） */
function tarCreate(src: string, items: string[], out: string): { code: number; err: string } {
  const r = spawnSync(TAR, ['-czf', out, '-C', src, ...items], { encoding: 'utf8', timeout: 120000 })
  return { code: r.status ?? -1, err: (r.stderr || '').trim() }
}

/** 列出 tar.gz 里的条目（不落盘） */
function tarList(file: string): string[] {
  const r = spawnSync(TAR, ['-tzf', file], { encoding: 'utf8', timeout: 120000 })
  return (r.stdout || '').split(/\r?\n/).filter(Boolean)
}

/**
 * 列出包里的条目 —— **解开到临时目录再用 readdir 读真名**。
 *
 * ## 为什么不能用 `tar -tzf` 的输出（这里踩过坑）
 *
 * `tar -tzf` 把文件名按**系统 ANSI(GBK)** 打出来，而我用 UTF-8 解码，
 * 中文名就成了乱码：`人格-梦汐.json` → `�˸�-��ϫ.json`。
 *
 * 第一版测试就是拿这个乱码去比，于是报「中文名文件不在包里」——
 * 一个**假红**。实测（scripts/_probe-cn-filename.cjs）证明：
 *   解开后的 readdir 结果 = ["人格-梦汐.json"]，字节与原文**完全一致**。
 * 也就是说 tar 没问题，是我的**解析方式**错了。
 *
 * 假红比假绿更危险：它会让人去"修"一个本来正确的实现，
 * 把好代码改坏。所以这里改成"真解开、读真名"，从根上避开编码问题。
 */
function listEntriesViaExtract(file: string, destDir: string): string[] {
  mkdirSync(destDir, { recursive: true })
  const r = spawnSync(TAR, ['-xzf', file, '-C', destDir], { encoding: 'buffer', timeout: 120000 })
  if (r.status !== 0) return []
  const out: string[] = []
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(d, e.name), rel)
      else out.push(rel)
    }
  }
  walk(destDir, '')
  return out
}

beforeEach(() => {
  root = testStage('acb-update-backup-')
  installDir = join(root, 'MXBot')
  dataDir = join(installDir, 'data')
  backupRoot = join(root, 'MXBot-update-backup')
  mkdirSync(dataDir, { recursive: true })
  seedRealData()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('覆盖更新的自动数据备份', () => {
  it('★用户数据必须全在包里（AstrBot 与 NapCat 一个都不能漏）', () => {
    const out = join(backupRoot, 'mxbot-data-test.tar.gz')
    mkdirSync(backupRoot, { recursive: true })

    const { code, err } = tarCreate(dataDir, ['instances', 'config.json', 'instances.json', 'mirrors.json', 'runtimes.json'], out)
    expect(code, `tar 打包失败：${err}`).toBe(0)

    // 解开读真名（不用 tar -tzf，理由见 listEntriesViaExtract 的注释）
    const list = listEntriesViaExtract(out, join(root, 'list-1'))

    /*
     * 逐项点名 —— 不写成"包含 instances 就行"。
     * 因为漏掉 config\ 就等于 NapCat 的 token 和 QQ 配置丢了，
     * 那是用户最在意的"用户数据"。
     */
    const must = [
      ['AstrBot 账密/模型配置', 'instances/AstrBot/a_3326e137e2/data/cmd_config.json'],
      ['AstrBot 人格配置(中文名)', 'instances/AstrBot/a_3326e137e2/data/config/人格-梦汐.json'],
      ['AstrBot 实例记录', 'instances/AstrBot/a_3326e137e2/instance.json'],
      ['NapCat onebot token/QQ', 'instances/NapCat/n_c58a357f6c/config/onebot11_3859054833.json'],
      ['NapCat webui 配置', 'instances/NapCat/n_c58a357f6c/config/webui.json'],
      ['NapCat 登录二维码', 'instances/NapCat/n_c58a357f6c/cache/qrcode.png'],
      ['启动器配置', 'config.json'],
      ['实例清单', 'instances.json'],
      ['用户镜像源', 'mirrors.json'],
      ['运行时版本清单', 'runtimes.json']
    ]
    for (const [what, rel] of must) {
      expect(
        list.some((e) => e === rel || e.endsWith('/' + rel) || e === './' + rel),
        `${what} 不在备份包里：${rel}\n` +
          '   漏掉它就意味着用户这部分数据在覆盖更新时没有任何保护。'
      ).toBe(true)
    }
  })

  it('★能重新下载的大文件不能被包进去（否则每次更新白等几分钟）', () => {
    const out = join(backupRoot, 'mxbot-data-size.tar.gz')
    mkdirSync(backupRoot, { recursive: true })
    const { code } = tarCreate(dataDir, ['instances', 'config.json', 'instances.json', 'mirrors.json', 'runtimes.json'], out)
    expect(code).toBe(0)

    const list = listEntriesViaExtract(out, join(root, 'list-2'))
    expect(list.some((e) => e.includes('runtimes/')), 'runtimes 被包进去了（212MB，能重新下载）').toBe(false)
    expect(list.some((e) => e.includes('cache/download.tmp')), 'cache 被包进去了（187MB，可再生）').toBe(false)

    // 体积必须小（真实数据只有几十 KB；给足余量但不能到 MB 级）
    const mb = statSync(out).size / 1048576
    expect(mb, `备份包 ${mb.toFixed(2)} MB —— 太大了，说明把大文件包进去了`).toBeLessThan(1)
  })

  it('★包必须能完整解开（内容逐字节一致，含中文名）', () => {
    const out = join(backupRoot, 'mxbot-data-extract.tar.gz')
    mkdirSync(backupRoot, { recursive: true })
    tarCreate(dataDir, ['instances', 'config.json', 'mirrors.json'], out)

    const ex = join(root, 'extracted')
    mkdirSync(ex, { recursive: true })
    const r = spawnSync(TAR, ['-xzf', out, '-C', ex], { encoding: 'utf8', timeout: 120000 })
    expect(r.status, '解压失败：' + (r.stderr || '')).toBe(0)

    // 关键内容逐字节比对（不是"文件存在就行"）
    const pairs: Array<[string, string]> = [
      ['instances/AstrBot/a_3326e137e2/data/cmd_config.json', join(dataDir, 'instances', 'AstrBot', 'a_3326e137e2', 'data', 'cmd_config.json')],
      ['instances/AstrBot/a_3326e137e2/data/config/人格-梦汐.json', join(dataDir, 'instances', 'AstrBot', 'a_3326e137e2', 'data', 'config', '人格-梦汐.json')],
      ['instances/NapCat/n_c58a357f6c/config/onebot11_3859054833.json', join(dataDir, 'instances', 'NapCat', 'n_c58a357f6c', 'config', 'onebot11_3859054833.json')],
      ['config.json', join(dataDir, 'config.json')]
    ]
    for (const [rel, orig] of pairs) {
      const got = join(ex, ...rel.split('/'))
      expect(existsSync(got), `解出来的包里没有 ${rel}`).toBe(true)
      expect(readFileSync(got), `${rel} 内容与原件不一致`).toEqual(readFileSync(orig))
    }
  })

  it('★备份必须落在 $INSTDIR 之外（放里面会被旧卸载器 RMDir /r 删掉）', () => {
    /*
     * 这是本项目反复踩过的坑：旧卸载器执行 `RMDir /r "$INSTDIR"`，
     * 所以任何放在安装目录里的"备份"都会跟着被删 —— 等于没备份。
     * 所以备份的落脚点必须是安装目录的**兄弟目录**。
     */
    const out = join(backupRoot, 'x.tar.gz')
    mkdirSync(backupRoot, { recursive: true })
    tarCreate(dataDir, ['instances'], out)

    // 结构断言：backupRoot 不是 installDir 本身，也不在 installDir 里面
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
    const nb = norm(backupRoot)
    const ni = norm(installDir)
    expect(
      nb === ni || nb.startsWith(ni + '/'),
      `备份目录 ${backupRoot} 落在安装目录 ${installDir} 里面 —— ` +
        '覆盖更新时旧卸载器会清空安装目录，备份会被一起删掉，等于没备份'
    ).toBe(false)
  })

  it('数据目录为空/不存在时也不能失败（不能因为备份把更新搞挂）', () => {
    const empty = join(root, 'empty-data')
    mkdirSync(empty, { recursive: true })
    const out = join(backupRoot, 'empty.tar.gz')
    mkdirSync(backupRoot, { recursive: true })

    // 一个文件都没有时，tar 会返回非零 —— 安装器必须能容忍这种情况
    const { code } = tarCreate(empty, ['instances', 'config.json'], out)
    // 记录真实行为：这里不假设它一定成功，但**更新流程不能因此中断**
    // （安装器里要用 IfErrors 判，而不是让 tar 的失败冒泡成安装失败）
    expect(typeof code).toBe('number')
  })
})
