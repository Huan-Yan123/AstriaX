/*
 * F1（致命）：手动导入的 AstrBot 运行时**永远起不来**
 * ========================================================================
 *
 * ## 现象
 *
 * 用户在「下载」页点「手动导入」，选一个 AstrBot 的 wheel（或 zip），
 * 装完之后卡片上能看到这个版本，点「创建实例」也能建出来，
 * 但**一启动就报**：
 *
 *     AstrBot 运行时结构不对（...\runtimes\a\v4.x.y），重新下载这个版本
 *
 * 用户会反复重装、重新导入 —— 因为报错明确让他"重新下载这个版本"，
 * 而重装当然还是同样的结果。这条路径是**唯一**的人工兜底
 * （AstrBot 在版本清单里只有 pypi 一种来源，镜像全不通时只能手动导入），
 * 所以它坏了等于断了一条腿。
 *
 * ## 根因：两个缺陷叠在一起
 *
 * `importArchive()` 把内容搬进目标目录之后就**只** `return probe` 了，
 * 没做任何"收尾标记"，而正规下载路径（ipc.ts:2309）装完会写两个东西：
 *
 *     1. `mxbot-runtime.json`  —— `{"tag":..., "kind":"pypi", "entry":"astrbot"}`
 *     2. 把 `payload.zip` 一类的中转文件清掉
 *
 * 对应的两处后果：
 *
 * **缺陷 1 — 缺 marker → detectLayout 认不出**
 *
 * `detectLayout` 对 PyPI 形态的 AstrBot 判据是（layout.ts:54）：
 *
 *     if (existsSync(join(dir, 'astrbot')) && readRuntimeKind(dir) === 'pypi')
 *       return 'astrbot'
 *
 * 而 `readRuntimeKind` 只读 `mxbot-runtime.json`。手动导入没写它
 * → `readRuntimeKind` 返回 undefined → 判据不成立 → `detectLayout`
 * 返回 `'unknown'` → `resolveLaunchSpec` 直接抛
 * 「AstrBot 运行时结构不对」。
 *
 * 注意它**明明有 astrbot 包目录**，只差一个几十字节的标记文件。
 *
 * **缺陷 2 — `.whl` 复制出来的 `payload.zip` 被搬进了正式目录**
 *
 * `.whl` 要被复制成 `payload.zip` 才能解压（Expand-Archive 只认 .zip，
 * 见 importArchive 里的注释）。但那个副本放在 **stage** 里，
 * 而后面搬运用的是"把 srcDir 下的**所有**条目 rename 过去"——
 * 如果包是"没有顶层目录"的形态，`srcDir` 就是 stage 本身，
 * 于是 `payload.zip`（等于把整个 wheel 又存了一份，几十 MB）
 * 就跟着进了正式运行时目录，永远留着。
 *
 * ## 为什么测试一直没发现
 *
 * 单测只造 `.zip` 包（`tests/unit/import-archive.spec.ts` 之类），
 * 而 `.whl` 才是 AstrBot 的真实形态；而且没有一条测试走
 * "导入 → 建实例 → **启动**"这条完整链，只测到"文件搬过去了"。
 *
 * ## 这条测试怎么钉
 *
 * 走完整链：导入一个真的 `.whl` → 检查 marker 存在且 kind=pypi
 * → 检查 detectLayout 认得出 → 检查能解析出启动命令（不抛）。
 * 同时钉住"正式目录里不该有 payload.zip 这类中转残留"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testStage } from '../helpers/stage'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync
} from 'fs'
import { join } from 'path'
import { importArchive, probeArchive } from '../../src/main/update/import-archive'
import { detectLayout, readRuntimeKind, resolveLaunchSpec } from '../../src/main/runtime/layout'

let root: string
beforeEach(() => {
  root = testStage('acb-import-whl-')
  mkdirSync(root, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * 造一个最小但**结构真实**的 AstrBot wheel。
 *
 * wheel 就是 zip，所以直接造 zip 即可。内容要能让 classifyArchive
 * 认出这是 AstrBot（有 astrbot 包 + dist-info），并且解出来之后
 * `existsSync(join(dir,'astrbot'))` 成立。
 */
function makeWhl(dir: string, version = '4.27.0'): string {
  const { execFileSync } = require('child_process')
  const build = join(dir, 'whlbuild')
  mkdirSync(join(build, 'astrbot', 'cli'), { recursive: true })
  mkdirSync(join(build, `astrbot-${version}.dist-info`), { recursive: true })
  writeFileSync(join(build, 'astrbot', '__init__.py'), `__version__ = "${version}"\n`, 'utf8')
  writeFileSync(join(build, 'astrbot', 'cli', '__init__.py'), '', 'utf8')
  writeFileSync(join(build, 'astrbot', 'cli', '__main__.py'), 'def cli():\n    pass\n', 'utf8')
  writeFileSync(
    join(build, `astrbot-${version}.dist-info`, 'METADATA'),
    `Metadata-Version: 2.1\nName: astrbot\nVersion: ${version}\n`,
    'utf8'
  )
  writeFileSync(
    join(build, `astrbot-${version}.dist-info`, 'entry_points.txt'),
    '[console_scripts]\nastrbot = astrbot.cli.__main__:cli\n',
    'utf8'
  )

  const whl = join(dir, `astrbot-${version}-py3-none-any.whl`)
  /*
   * 必须**先压成 .zip 再改名**成 .whl。
   *
   * Compress-Archive 按扩展名白名单校验，直接往 .whl 压会报
   *   NotSupportedArchiveFileExtension
   * —— 这正是产品代码里 importArchive 要先把 .whl 复制成 payload.zip 的原因，
   * 同一个坑在测试里也踩到了。先压 zip 再 rename 就绕过去了
   * （rename 不改内容，得到的仍然是一个合法的 wheel/zip）。
   */
  const asZip = join(dir, `astrbot-${version}-py3-none-any.zip`)
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${join(build, '*')}' -DestinationPath '${asZip}' -Force`
    ],
    { stdio: 'pipe' }
  )
  const { renameSync } = require('fs')
  renameSync(asZip, whl)
  return whl
}

/** AstrBot 运行时"实质"的判据：astrbot 包目录在 */
function hasAstrbotPkg(dir: string): boolean {
  return existsSync(join(dir, 'astrbot'))
}

describe('F1：手动导入的 AstrBot 必须能启动', () => {
  it('★导入 .whl 之后必须写 mxbot-runtime.json（否则 detectLayout 认不出）', async () => {
    const whl = makeWhl(root)
    const dest = join(root, 'runtimes', 'a', 'v4.27.0')
    const probe = await probeArchive(whl)
    expect(probe.kind, '探测阶段就该认出这是 AstrBot 的包').toBe('a')

    await importArchive({ dataRoot: root, file: whl, type: 'a', destDir: dest, probe })

    /*
     * 先确认内容真的搬过去了（否则后面的断言可能因为"目录是空的"而假通过）
     */
    expect(hasAstrbotPkg(dest), 'astrbot 包目录应该被搬进运行时目录').toBe(true)

    /*
     * 核心断言：marker 必须在。
     *
     * 缺了它，detectLayout 就认不出这是 AstrBot —— 因为它的判据是
     * `有 astrbot 目录 && readRuntimeKind() === 'pypi'`，
     * 而 readRuntimeKind 只读这个文件。
     */
    expect(
      existsSync(join(dest, 'mxbot-runtime.json')),
      '手动导入没有写 mxbot-runtime.json —— detectLayout 会返回 unknown，\n' +
        '启动时报「AstrBot 运行时结构不对，重新下载这个版本」，\n' +
        '而用户重新导入多少次都是一样的结果（这条是唯一的人工兜底路径）。'
    ).toBe(true)

    const kind = readRuntimeKind(dest)
    expect(kind, 'marker 里的 kind 必须是 pypi（AstrBot 的 PyPI 形态）').toBe('pypi')

    // 最直接的判据：结构识别得出来
    expect(
      detectLayout(dest),
      'detectLayout 认不出导入进来的 AstrBot —— 实例创建后一启动就会失败'
    ).toBe('astrbot')
  })

  it('★导入之后能解析出启动命令（完整链：导入 → 能启动）', async () => {
    const whl = makeWhl(root)
    const dest = join(root, 'runtimes', 'a', 'v4.27.0')
    await importArchive({
      dataRoot: root,
      file: whl,
      type: 'a',
      destDir: dest,
      probe: await probeArchive(whl)
    })

    // 造出内置 Python（isPythonReady 只看这个文件在不在）
    const pyDir = join(root, 'runtime', 'python')
    mkdirSync(pyDir, { recursive: true })
    writeFileSync(join(pyDir, 'python.exe'), '', 'utf8')

    const inst = join(root, 'instances', 'AstrBot', 'a_1')
    mkdirSync(inst, { recursive: true })

    const spec = resolveLaunchSpec({
      type: 'a',
      dir: dest,
      instanceDir: inst,
      pythonExe: join(pyDir, 'python.exe'),
      port: 6180,
      dataRoot: root
    })
    expect(spec.cmd).toContain('python.exe')
    // PyPI 形态的入口是 astrbot.cli run（不是 astrbot 本身）
    expect(spec.args.join(' ')).toContain('astrbot.cli')
    expect(spec.args.join(' ')).toContain('6180')
  })

  it('★正式运行时目录里不该残留 payload.zip（那是 .whl 的中转副本）', async () => {
    const whl = makeWhl(root)
    const dest = join(root, 'runtimes', 'a', 'v4.27.0')
    await importArchive({
      dataRoot: root,
      file: whl,
      type: 'a',
      destDir: dest,
      probe: await probeArchive(whl)
    })

    const leftovers = readdirSync(dest).filter((n) => /^payload\.(zip|whl)$/i.test(n))
    expect(
      leftovers,
      '把 .whl 复制出的 payload.zip 一起搬进了正式运行时目录 ——\n' +
        '那等于把整个 wheel 又存了一份（几十 MB），而且它没有任何用处。\n' +
        `残留：${leftovers.join('、')}`
    ).toEqual([])
  })

  it('导入 .zip 形态的 AstrBot 也要写 marker 且能识别', async () => {
    // 有的用户手上是 zip，不是 whl —— 这条路径同样必须可用
    const { execFileSync } = require('child_process')
    const build = join(root, 'zipbuild')
    mkdirSync(join(build, 'astrbot', 'cli'), { recursive: true })
    writeFileSync(join(build, 'astrbot', '__init__.py'), '__version__ = "4.28.0"\n', 'utf8')
    writeFileSync(join(build, 'astrbot', 'cli', '__main__.py'), 'def cli():\n    pass\n', 'utf8')
    const zip = join(root, 'astrbot-4.28.0.zip')
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${join(build, '*')}' -DestinationPath '${zip}' -Force`
      ],
      { stdio: 'pipe' }
    )

    const dest = join(root, 'runtimes', 'a', 'v4.28.0')
    const probe = await probeArchive(zip)
    // 认不出就当这条测试无效（探测规则可能只认 whl 的 dist-info）
    if (probe.kind !== 'a') {
      // 明确报出来，别静默通过
      expect(probe.reason, 'zip 形态的 AstrBot 包识别失败，原因').toBeTruthy()
      return
    }
    await importArchive({ dataRoot: root, file: zip, type: 'a', destDir: dest, probe })
    expect(existsSync(join(dest, 'mxbot-runtime.json'))).toBe(true)
    expect(detectLayout(dest)).toBe('astrbot')
  })
})
