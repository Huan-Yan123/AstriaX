import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { probeArchive, importArchive } from '../../src/main/update/import-archive'
import { testStage } from '../helpers/stage'

/**
 * 手动导入的**真实链路**测试：造一个真的 zip，走真的解压，看真的结果。
 *
 * 前面 import-archive.spec.ts 测的是「识别逻辑」；这里测的是
 * 「探测 → 解压 → 落到目录」整条路真能跑通，包括读 zip 条目、算 sha256、
 * 解压并搬到目标目录，以及拒绝时**不留下垃圾目录**。
 *
 * 用 PowerShell 造 zip：这本来就是应用依赖的系统能力，
 * 用同一套东西造包，测的才是真实路径。
 */
let root: string
beforeEach(() => {
  root = testStage('acb-import-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 真实解压要起 PowerShell 的 Expand-Archive，慢是正常的，别用默认 5 秒 */
const T = 120_000

/** 用 PowerShell 把一批文件打成 zip */
function makeZip(srcDir: string, zipPath: string): void {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -Force`
    ],
    { stdio: 'ignore' }
  )
}

/** 造一个结构完整的 NapCat Shell 包 */
function makeNapcatZip(zipPath: string): void {
  const src = join(root, 'nc-src')
  mkdirSync(join(src, 'plugins'), { recursive: true })
  writeFileSync(join(src, 'NapCatWinBootMain.exe'), 'MZ fake injector', 'utf8')
  writeFileSync(join(src, 'NapCatWinBootHook.dll'), 'MZ fake hook', 'utf8')
  writeFileSync(join(src, 'napcat.mjs'), 'export default {}', 'utf8')
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'napcat', version: '4.18.19' }), 'utf8')
  mkdirSync(zipPath.replace(/[^\\/]+$/, ''), { recursive: true })
  makeZip(src, zipPath)
}

/**
 * 造一个 AstrBot wheel（内容上就是个 zip，只是扩展名是 .whl —— 真实 wheel 就是这样）。
 * 结构照真实包来：`astrbot/` 包目录 + `astrbot-<ver>.dist-info/`。
 */
function makeAstrbotWheel(whlPath: string, ver = '4.28.0'): void {
  const src = join(root, 'whl-src')
  mkdirSync(join(src, 'astrbot', 'core'), { recursive: true })
  mkdirSync(join(src, `astrbot-${ver}.dist-info`), { recursive: true })
  writeFileSync(join(src, 'astrbot', '__init__.py'), '', 'utf8')
  writeFileSync(join(src, 'astrbot', 'core', 'utils.py'), 'x = 1', 'utf8')
  writeFileSync(join(src, `astrbot-${ver}.dist-info`, 'METADATA'), `Name: astrbot\nVersion: ${ver}`, 'utf8')
  const zip = whlPath.replace(/\.whl$/i, '.zip')
  makeZip(src, zip)
  // 真实 wheel 就是 zip 改扩展名 —— 这一步保证了测的是真实现状
  execFileSync('cmd.exe', ['/c', 'ren', zip, whlPath.split('\\').pop() as string], { stdio: 'ignore' })
}

describe('手动导入：真实压缩包走完整链路', () => {
  it('探测真实的 NapCat zip：认得出类型、算得出哈希、列得出条目', async () => {
    const zip = join(root, 'NapCat.Shell.zip')
    makeNapcatZip(zip)

    const probe = await probeArchive(zip)
    expect(probe.kind, '要认出这是 NapCat').toBe('n')
    expect(probe.reason).toContain('NapCat Shell')
    expect(probe.sizeBytes).toBeGreaterThan(0)
    expect(probe.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(probe.entries.some((e) => e.includes('NapCatWinBootMain.exe'))).toBe(true)
  })

  it('哈希对同一个文件稳定（同一份文件算两次结果一致）', async () => {
    const a = join(root, 'a.zip')
    makeNapcatZip(a)
    const p1 = await probeArchive(a)
    const p2 = await probeArchive(a)
    expect(p1.sha256).toBe(p2.sha256)

    /*
     * 注意：**不能**断言「两份内容相同的 zip 哈希相同」。
     * zip 格式会在每条记录里写入修改时间，两次 Compress-Archive
     * 即使源文件一模一样，打出来的字节流也不同（实测确认）。
     * 所以换个内容再比。
     */
    const src = join(root, 'nc-src')
    writeFileSync(join(src, 'napcat.mjs'), 'export default { changed: 1 }', 'utf8')
    const c = join(root, 'c.zip')
    makeZip(src, c)
    expect((await probeArchive(c)).sha256).not.toBe(p1.sha256)
  })

  it(
    '真的解压并落到目标目录，文件都在',
    { timeout: T },
    async () => {
      const zip = join(root, 'NapCat.Shell.zip')
      makeNapcatZip(zip)
      const dest = join(root, 'runtimes', 'n', 'v4.18.19')

      const probe = await importArchive({ dataRoot: root, file: zip, type: 'n', destDir: dest })
      expect(probe.kind).toBe('n')
      expect(existsSync(join(dest, 'NapCatWinBootMain.exe'))).toBe(true)
      expect(existsSync(join(dest, 'NapCatWinBootHook.dll'))).toBe(true)
      expect(existsSync(join(dest, 'napcat.mjs'))).toBe(true)
      expect(existsSync(join(dest, 'package.json'))).toBe(true)
    }
  )

  it('类型对不上要拒绝，而且**不留垃圾目录**', async () => {
    const zip = join(root, 'NapCat.Shell.zip')
    makeNapcatZip(zip)
    const dest = join(root, 'runtimes', 'a', 'v4.28.0')

    await expect(importArchive({ dataRoot: root, file: zip, type: 'a', destDir: dest })).rejects.toThrow(
      /类型对不上/
    )
    expect(existsSync(dest), '拒绝了就不该创建目标目录').toBe(false)
  })

  it('认不出的包要拒绝，并说清应该给什么', async () => {
    const src = join(root, 'junk')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'readme.txt'), 'nothing useful', 'utf8')
    const zip = join(root, 'junk.zip')
    makeZip(src, zip)

    await expect(
      importArchive({ dataRoot: root, file: zip, type: 'n', destDir: join(root, 'runtimes', 'n', 'vX') })
    ).rejects.toThrow(/认不出|NapCat\.Shell\.zip/)
  })

  it('dashboard.zip 必须拒绝（这是「AstrBot 装了没法用」的根因）', async () => {
    const src = join(root, 'dash')
    mkdirSync(join(src, 'dist', 'assets'), { recursive: true })
    writeFileSync(join(src, 'dist', 'index.html'), '<html></html>', 'utf8')
    writeFileSync(join(src, 'dist', 'assets', 'app.js'), 'console.log(1)', 'utf8')
    const zip = join(root, 'AstrBot-v4.28.0-dashboard.zip')
    makeZip(src, zip)

    await expect(
      importArchive({ dataRoot: root, file: zip, type: 'a', destDir: join(root, 'runtimes', 'a', 'v4.28.0') })
    ).rejects.toThrow(/dashboard|不含后端/)
  })

  it(
    '解压完不留临时目录（cache\\tmp 要干净）',
    { timeout: T },
    async () => {
      const zip = join(root, 'NapCat.Shell.zip')
      makeNapcatZip(zip)
      await importArchive({
        dataRoot: root,
        file: zip,
        type: 'n',
        destDir: join(root, 'runtimes', 'n', 'v4.18.19')
      })
      const tmp = join(root, 'cache', 'tmp')
      const left = existsSync(tmp) ? readdirSync(tmp) : []
      expect(left, `临时目录要清空，实际剩：${left.join(',')}`).toEqual([])
    }
  )

  it('不存在的文件报错可读', async () => {
    await expect(probeArchive(join(root, 'nope.zip'))).rejects.toThrow(/文件不存在/)
  })

  it('非压缩包后缀要拒绝（别让用户选到 exe）', async () => {
    const f = join(root, 'setup.exe')
    writeFileSync(f, 'MZ', 'utf8')
    await expect(probeArchive(f)).rejects.toThrow(/只支持/)
  })
})

/*
 * AstrBot 的 wheel：**手动导入唯一的 AstrBot 兜底路径**。
 *
 * 这条测试是补上一个真实事故的缺口：`importArchive` 原来把用户选的 `.whl`
 * 原样交给 PowerShell 的 `Expand-Archive`，而它**按扩展名白名单校验**，
 * 只认 `.zip` —— 报「.whl 不是支持的存档文件格式」，exit 1。
 * 也就是说「手动导入 AstrBot」100% 失败，而当时的测试只造 `.zip`，
 * 所以整套测试一直是绿的。
 *
 * 所以这里必须用**真的 .whl 扩展名**（内容上是 zip，真实 wheel 也是这样），
 * 走真的解压。用 zip 名字测就永远发现不了这个 bug。
 */
describe('手动导入 AstrBot wheel（.whl 扩展名，曾经 100% 失败）', () => {
  it('探测 .whl：认得出是 AstrBot，读得出版本', async () => {
    const whl = join(root, 'astrbot-4.28.0-py3-none-any.whl')
    makeAstrbotWheel(whl, '4.28.0')

    const probe = await probeArchive(whl)
    expect(probe.kind, '要认出这是 AstrBot').toBe('a')
    expect(probe.version, '版本要从 dist-info 目录名里读出来').toBe('4.28.0')
    expect(probe.entries.some((e) => e.includes('astrbot'))).toBe(true)
  })

  it('解压 .whl 能成功落盘（Expand-Archive 只认 .zip，必须先复制改名）', async () => {
    const whl = join(root, 'astrbot-4.28.0-py3-none-any.whl')
    makeAstrbotWheel(whl, '4.28.0')
    const dest = join(root, 'runtimes', 'a', 'v4.28.0')

    await importArchive({
      dataRoot: root,
      file: whl,
      type: 'a',
      destDir: dest
    })

    // 这条断言在修复前必然失败（解压报「不是支持的存档文件格式」→ 抛错）
    expect(existsSync(join(dest, 'astrbot', '__init__.py')), '后端包要真的落盘').toBe(true)
    expect(
      existsSync(join(dest, 'astrbot-4.28.0.dist-info', 'METADATA')),
      'dist-info 也要在'
    ).toBe(true)
  }, T)

  it('解压 .whl 后不留暂存垃圾', async () => {
    const whl = join(root, 'astrbot-4.29.0-py3-none-any.whl')
    makeAstrbotWheel(whl, '4.29.0')
    await importArchive({
      dataRoot: root,
      file: whl,
      type: 'a',
      destDir: join(root, 'runtimes', 'a', 'v4.29.0')
    })
    const tmp = join(root, 'cache', 'tmp')
    const left = existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith('import-')) : []
    expect(left, `暂存要清干净，实际剩：${left.join(',')}`).toEqual([])
  }, T)

  it('用户选的那个 .whl 本身不能被改动（复制改名，不是原地改名）', async () => {
    const whl = join(root, 'astrbot-4.28.0-py3-none-any.whl')
    makeAstrbotWheel(whl, '4.28.0')
    const before = readFileSync(whl)
    await importArchive({
      dataRoot: root,
      file: whl,
      type: 'a',
      destDir: join(root, 'runtimes', 'a', 'v4.28.0')
    })
    expect(existsSync(whl), '原文件要还在').toBe(true)
    expect(readFileSync(whl).equals(before), '内容也不能变').toBe(true)
  }, T)
})

/*
 * 直接测**解析器本身**。
 * 为什么单独测这一层：classifyArchive 的测试喂的是手写的字符串数组，
 * 完全不经过真实解析 —— 也就是说 listZipEntriesSync 就算返回垃圾，
 * 那些测试照样全绿。反向验证时确认了这个洞：
 * 把 EOCD 签名判断改成恒假，整套测试竟然还是绿的。
 * 而「装的是不是正确的包」全靠这一层认出来，必须直接锁住。
 */
describe('zip 条目解析器（listZipEntriesSync 本身）', () => {
  it('真的解出条目，且内容对得上', async () => {
    const { listZipEntriesSync } = await import('../../src/main/update/import-archive')
    const zip = join(root, 'p.zip')
    makeNapcatZip(zip)
    const entries = listZipEntriesSync(zip)
    /*
     * 4 个，不是 5 个：Compress-Archive **不写入空目录**，
     * 所以那个空的 plugins/ 不会出现在包里（实测确认）。
     * 这里断言实际数量，别按「应该有几个」猜。
     */
    expect(entries.length, '解出的条目数要和包里的实际文件数一致').toBe(4)
    const names = entries.map((e) => e.split('\\').pop())
    expect(names).toContain('NapCatWinBootMain.exe')
    expect(names).toContain('NapCatWinBootHook.dll')
    expect(names).toContain('napcat.mjs')
    expect(names).toContain('package.json')
  })

  it('路径分隔符统一成反斜杠（识别逻辑靠它判断层级）', async () => {
    const { listZipEntriesSync } = await import('../../src/main/update/import-archive')
    // 造一个真有子目录的包（Compress-Archive 不写空目录，所以要放文件进去）
    const src = join(root, 'nested')
    mkdirSync(join(src, 'sub', 'deep'), { recursive: true })
    writeFileSync(join(src, 'sub', 'deep', 'x.js'), 'x', 'utf8')
    const zip = join(root, 'nested.zip')
    makeZip(src, zip)

    const entries = listZipEntriesSync(zip)
    // zip 里存的是 /，输出必须统一成 \，否则 endsWith 之类的判断会漏
    expect(entries.every((e) => !e.includes('/')), '不该残留正斜杠').toBe(true)
    const nested = entries.find((e) => e.includes('x.js'))
    expect(nested, '要能找到子目录里的文件').toBeTruthy()
    expect(nested, '子目录要用反斜杠').toContain('\\')
  })

  it('不是 zip 的文件要抛错，而不是返回空数组', async () => {
    /*
     * 返回空数组是很危险的「安静失败」：上层会以为这个包里没有任何
     * 可用文件，报出「认不出这是什么包」，而真实原因是文件根本不是 zip。
     * 用户拿着一个损坏的下载文件，会得到完全误导的提示。
     */
    const { listZipEntriesSync } = await import('../../src/main/update/import-archive')
    const f = join(root, 'notzip.bin')
    writeFileSync(f, 'this is definitely not a zip file, no EOCD here', 'utf8')
    expect(() => listZipEntriesSync(f)).toThrow(/zip/)
  })

  it('只有一个文件的包也能解出来，不崩', async () => {
    const { listZipEntriesSync } = await import('../../src/main/update/import-archive')
    const src = join(root, 'tiny')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'a.txt'), 'x', 'utf8')
    const zip = join(root, 'tiny.zip')
    makeZip(src, zip)
    const entries = listZipEntriesSync(zip)
    expect(entries.some((e) => e.endsWith('a.txt'))).toBe(true)
  })
})
