/*
 * ★★★ 实测：本地上传 `.whl` 导入，**依赖到底装没装**
 *
 * 主人 2026-09-27：「本地上传不安装依赖的 bug 修了吗」，
 * 并给了真实文件 `E:\MX机器人启动器成品\astrbot-4.28.0-py3-none-any.whl`（7.4 MB）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么必须**真跑一遍**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 代码里明明有 `installAstrbotDeps`（还带 `ensureBuildTools`），
 * 但这个项目已经反复证明：**"代码存在" ≠ "跑起来对"**。
 * 而且这条路径的历史就是"修了两轮还是不对"：
 *   1. 最初导入只解压、不装依赖 → 导入成功但永远起不来（ModuleNotFoundError: click）
 *   2. 补了 pip 步骤，但没补构建工具 → BackendUnavailable: setuptools.build_meta
 *   3. …现在
 *
 * 所以这里**真跑一次完整导入**（会真的联网 pip 装几百 MB），
 * 用铁证回答"装了没"。
 *
 * ## 这条测试的性质
 *
 * 它**慢**（几分钟）且**依赖网络**，所以：
 *   · 默认跳过（避免拖慢常规回归）
 *   · 用 `ACB_REAL_IMPORT=1` 显式开启
 * 但**绝不能**因为没有它就让"导入装依赖"这件事无人验证 ——
 * 那正是前两轮漏掉的原因。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, cpSync, writeFileSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'

const WHL = 'E:\\MX机器人启动器成品\\astrbot-4.28.0-py3-none-any.whl'
const PY_SRC = 'E:\\MX\\launcher-acb\\data\\runtime\\python'
const ENABLED = process.env.ACB_REAL_IMPORT === '1'

describe.skipIf(!ENABLED)('★★★实测：本地导入 whl 必须把依赖装上', () => {
  it(
    '导入 astrbot-4.28.0-py3-none-any.whl → runtime 目录里要有 click/quart',
    async () => {
      expect(existsSync(WHL), `测试用的 whl 不在：${WHL}`).toBe(true)
      expect(existsSync(join(PY_SRC, 'python.exe')), '需要内置 Python 才能实测').toBe(true)

      /*
       * ★ 必须用 `testStage()` 而不是 `os.tmpdir()`。
       *
       * 项目有一条硬规则（`tests/unit/no-c-drive-temp.spec.ts` 守着它）：
       * 测试的暂存目录一律落在 `<项目>/data/cache/tmp` 下。
       *
       * 理由很实在：这个测试会真装几百 MB 的 Python 依赖。
       * 写到 C 盘的 tmpdir 会：
       *   · 占系统盘空间（用户 C 盘往往最紧张）
       *   · 测试失败/中断时**不会自动清理**，几百 MB 就这样留在那里
       *   · 与项目"所有数据在 data/ 下"的约定不一致
       */
      const dataRoot = testStage('import-whl-')
      mkdirSync(dataRoot, { recursive: true })
      writeFileSync(
        join(dataRoot, 'config.json'),
        JSON.stringify({ dataRoot, portMin: 6100, portMax: 6299, backupKeep: 5 }),
        'utf8'
      )
      writeFileSync(join(dataRoot, 'instances.json'), JSON.stringify({ instances: [] }), 'utf8')
      writeFileSync(join(dataRoot, 'runtimes.json'), JSON.stringify({ versions: [] }), 'utf8')
      /* 内置 Python 必须有，否则会走"缺 Python"分支（那不是我们这次要测的） */
      cpSync(PY_SRC, join(dataRoot, 'runtime', 'python'), { recursive: true })

      const { buildHandlers } = await import('../../src/main/ipc')
      const h = buildHandlers({ probe: async () => true })
      await h['config:set']({ dataRoot })

      const res = (await h['runtimes:importFile']({ type: 'a', file: WHL })) as {
        tag?: string
        depsOk?: boolean
      }

      const rtDir = join(dataRoot, 'runtimes', 'a', res.tag ?? 'v4.28.0')
      const hasClick = existsSync(join(rtDir, 'click'))
      const hasQuart = existsSync(join(rtDir, 'quart'))
      const top = existsSync(rtDir) ? readdirSync(rtDir).slice(0, 30).join(', ') : '(目录不存在)'

      expect(
        hasClick,
        `runtime 目录里没有 click —— 依赖没装上，实例启动会报 ModuleNotFoundError。\n` +
          `    depsOk=${res.depsOk}  tag=${res.tag}\n` +
          `    目录顶层：${top}`
      ).toBe(true)
      expect(hasQuart, `runtime 目录里没有 quart。目录顶层：${top}`).toBe(true)
      /* 接口自己也要如实报告（不能"其实没装却说装了"） */
      expect(res.depsOk, 'importFile 返回的 depsOk 应当为 true').toBe(true)
    },
    60 * 60 * 1000
  )
})
